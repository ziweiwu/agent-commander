//! How a tool call ended, and what it returned, read from its result record.
//!
//! A `tool_result` used to be read for its id and nothing else, so a row in the
//! chat said what the agent *asked* to do and never what happened: an edit was
//! a path, and a call auto mode refused looked exactly like one that ran.
//!
//! Everything here is read from fields Claude Code writes for this purpose —
//! `permissionDecision`, `is_error`, `toolUseResult.structuredPatch` — and
//! never from the words of an error message (INV-11). Those two record-level
//! fields sit beside `message`, not inside a block, so they are only ever
//! attributed to a record's *only* result: on this machine's transcripts no
//! record that answers several calls at once carries a decision, and one that
//! did could not say which call it was about.

use std::path::Path;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::transcript::{record_time, records_from_the_end};
use crate::types::{Hunk, Outcome, RefusedBy, ToolOutcome, ToolResultView};

/// How far back from the end a `toolResult` request looks for its record.
///
/// An edit's record carries the whole file it edited (`originalFile`), so a
/// handful of edits to a large file is megabytes; this reaches well past the
/// calls on screen without making a tap re-read a 48 MiB transcript (INV-4).
pub const RESULT_SCAN_BYTES: u64 = 8 * 1024 * 1024;

/// About how much of one result is sent. A diff or an output tail past this is
/// cut, and the reply says by how much.
pub const RESULT_CAP_BYTES: usize = 32 * 1024;

/// A `tool_use` id longer than this is not one Claude Code wrote (INV-12).
pub const MAX_TOOL_USE_ID: usize = 128;

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// The `tool_result` blocks a record carries.
pub fn result_blocks(rec: &Value) -> Vec<&Value> {
    rec.get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks.iter().filter(|block| text(block, "type") == Some("tool_result")).collect()
        })
        .unwrap_or_default()
}

/// Who a rejecting decision names, or nobody where it names no one this app
/// has a word for — a deny rule or a safety check is neither auto mode nor
/// the user, and calling it either would be a guess.
fn refused_by(decision: &Value) -> Option<RefusedBy> {
    let reason = text(decision, "reasonType");
    let source = text(decision, "source");
    if reason == Some("hook") || source == Some("hook") {
        return Some(RefusedBy::Hook);
    }
    if source.is_some_and(|source| source.starts_with("user")) {
        return Some(RefusedBy::You);
    }
    (reason == Some("classifier")).then_some(RefusedBy::AutoMode)
}

/// The recorded hunks of an edit, when the record carries any.
fn hunks_of(rec: &Value) -> Option<Vec<Hunk>> {
    let patch = rec.get("toolUseResult")?.get("structuredPatch")?.as_array()?;
    let hunks: Vec<Hunk> = patch
        .iter()
        .map(|hunk| Hunk {
            old_start: hunk.get("oldStart").and_then(Value::as_i64).unwrap_or(0),
            new_start: hunk.get("newStart").and_then(Value::as_i64).unwrap_or(0),
            lines: hunk
                .get("lines")
                .and_then(Value::as_array)
                .map(|lines| lines.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default(),
        })
        .collect();
    (!hunks.is_empty()).then_some(hunks)
}

/// Lines added and removed, from the prefixes the hunks' lines carry.
fn counts(hunks: &[Hunk]) -> (u32, u32) {
    let lines = || hunks.iter().flat_map(|hunk| hunk.lines.iter());
    let added = lines().filter(|line| line.starts_with('+')).count();
    let removed = lines().filter(|line| line.starts_with('-')).count();
    (u32::try_from(added).unwrap_or(u32::MAX), u32::try_from(removed).unwrap_or(u32::MAX))
}

/// How the call `block` answers ended. `rec` is the record when this block is
/// its only result, which is the only case its record-level fields describe.
pub fn outcome_of(block: &Value, id: &str, rec: Option<&Value>) -> ToolOutcome {
    let mut outcome = ToolOutcome {
        tool_use_id: id.to_string(),
        outcome: Outcome::Ok,
        by: None,
        category: None,
        added: None,
        removed: None,
    };
    let decision = rec.and_then(|rec| rec.get("permissionDecision")).filter(|d| d.is_object());
    if let Some(decision) = decision.filter(|d| text(d, "decision") == Some("reject")) {
        outcome.outcome = Outcome::Refused;
        outcome.by = refused_by(decision);
        outcome.category = text(decision, "classifierCategory").map(str::to_string);
        return outcome;
    }
    if block.get("is_error").and_then(Value::as_bool) == Some(true) {
        outcome.outcome = Outcome::Failed;
        return outcome;
    }
    if let Some(hunks) = rec.and_then(hunks_of) {
        let (added, removed) = counts(&hunks);
        outcome.added = Some(added);
        outcome.removed = Some(removed);
    }
    outcome
}

/// What a result block says, as the agent was shown it: a string, or text
/// blocks joined a line apart.
fn output_of(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(said)) => said.clone(),
        Some(Value::Array(parts)) => {
            parts.iter().filter_map(|part| text(part, "text")).collect::<Vec<_>>().join("\n")
        }
        _ => String::new(),
    }
}

/// The last `cap` bytes of `output`, starting on a character, and how many
/// bytes came before them.
fn tail_of(output: &str, cap: usize) -> (String, u64) {
    let mut start = output.len().saturating_sub(cap);
    while !output.is_char_boundary(start) {
        start += 1;
    }
    (output[start..].to_string(), start as u64)
}

/// The hunks from the top, as many lines as fit in `cap` bytes, and how many
/// bytes of line were left out after them.
fn hunks_within(hunks: Vec<Hunk>, cap: usize) -> (Vec<Hunk>, u64) {
    let mut room = cap;
    let mut omitted = 0u64;
    let mut kept = Vec::new();
    for mut hunk in hunks {
        let lines = std::mem::take(&mut hunk.lines);
        for line in lines {
            let cost = line.len() + 1;
            if cost <= room && omitted == 0 {
                room -= cost;
                hunk.lines.push(line);
            } else {
                omitted += cost as u64;
            }
        }
        if !hunk.lines.is_empty() {
            kept.push(hunk);
        }
    }
    (kept, omitted)
}

/// The view of one call's result, if `rec` answers `id`.
pub fn result_view(rec: &Value, id: &str, recorded_at: i64) -> Option<ToolResultView> {
    let blocks = result_blocks(rec);
    let block = *blocks.iter().find(|block| text(block, "tool_use_id") == Some(id))?;
    let only = (blocks.len() == 1).then_some(rec);
    let user_modified = only
        .and_then(|rec| rec.get("toolUseResult"))
        .and_then(|result| result.get("userModified"))
        .and_then(Value::as_bool)
        .filter(|modified| *modified);
    let mut view = ToolResultView { at: recorded_at, hunks: None, output: None, omitted: 0, user_modified };
    match only.and_then(hunks_of) {
        Some(hunks) => {
            let (kept, omitted) = hunks_within(hunks, RESULT_CAP_BYTES);
            view.hunks = Some(kept);
            view.omitted = omitted;
        }
        None => {
            let (tail, omitted) = tail_of(&output_of(block), RESULT_CAP_BYTES);
            view.output = Some(tail);
            view.omitted = omitted;
        }
    }
    Some(view)
}

/// Find the record that answers `id` in `buf`, newest first.
///
/// `from` is where in the file the buffer starts: past zero it opened
/// mid-file, so its first record is a fragment and is not read. A record still
/// being written past the last newline is left out the same way the tail holds
/// one back.
pub fn find_result(buf: &[u8], from: u64, id: &str) -> Option<ToolResultView> {
    let needle = format!("\"{id}\"");
    records_from_the_end(buf)
        .take_while(|(start, _)| *start > 0 || from == 0)
        .filter_map(|(_, record)| std::str::from_utf8(record).ok())
        .filter(|line| line.contains(&needle))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find_map(|rec| result_view(&rec, id, record_time(&rec)))
}

/// Read back from the end of the transcript at `path`, at most
/// [`RESULT_SCAN_BYTES`] of it, for the result of `id`.
pub async fn read_result(path: &Path, id: &str) -> Option<ToolResultView> {
    let size = tokio::fs::metadata(path).await.ok()?.len();
    let from = size.saturating_sub(RESULT_SCAN_BYTES);
    let mut file = tokio::fs::File::open(path).await.ok()?;
    file.seek(std::io::SeekFrom::Start(from)).await.ok()?;
    let mut buf = Vec::with_capacity((size - from) as usize);
    file.take(size - from).read_to_end(&mut buf).await.ok()?;
    find_result(&buf, from, id)
}
