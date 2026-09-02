//! Turns a session's JSONL transcript into a readable timeline.
//!
//! Port of `src/server/transcript.ts`.
//!
//! INV-4: reads are incremental. The file is tailed by byte offset and never
//! re-read; a live transcript is already 1.6 MB after a few hours, and the
//! corpus on a working machine is 413 files / 303 MB / 98k records, so
//! re-parsing from the top on every tick would be the single most expensive
//! thing this process does.
#![allow(dead_code)]

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::sources::{AgentPatch, TailApi, TailRead};
use crate::types::{
    now_ms, Agent, GoalState, NoticeKind, PendingPrompt, PromptOption, TimelineEvent, TimelineKind,
};

/// On first read, only this much history is loaded.
const BACKFILL_BYTES: u64 = 256 * 1024;

/// Bytes of the transcript tail scanned when reading current session state.
const STATE_TAIL_BYTES: u64 = 128 * 1024;

/// Record types that carry no timeline meaning.
const META_TYPES: &[&str] = &[
    "attachment",
    "mode",
    "file-history-delta",
    "file-history-snapshot",
    "summary",
    "system",
];

/// Records that are not conversation, but do carry session state the fleet view
/// needs: which permission mode the agent is in, and the title it generated for
/// itself — far more use than an auto-derived name like `ziweiwu-35`.
const STATE_TYPES: &[&str] = &["permission-mode", "ai-title", "last-prompt"];

/// Tools that mean this agent has delegated work to subagents.
const SUBAGENT_TOOLS: &[&str] = &["Task", "Agent", "Workflow"];

/// `~/.claude/projects`, where Claude Code files transcripts by project.
pub fn projects_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("projects")
}

/*
 * Records are walked as `serde_json::Value` rather than through typed structs.
 * That is deliberate: the TS reads them with optional chaining, so a record
 * whose `usage` is an unexpected shape still yields its `gitBranch` and its
 * text. A `#[derive(Deserialize)]` struct fails the whole line instead, which
 * would silently drop real records from a 98k-record corpus we do not control
 * the schema of. The helpers below are the optional-chaining equivalents.
 */

/// `rec[key]` as a non-empty string — the equivalent of JS's `if (rec.key)`.
fn text_field<'a>(rec: &'a Value, key: &str) -> Option<&'a str> {
    rec.get(key)
        .and_then(Value::as_str)
        .filter(|found| !found.is_empty())
}

/// `rec[key]` as a number — the equivalent of `typeof rec.key === 'number'`.
///
/// JSON has one number type, so a count written as `28634.0` is the same value
/// TS reads as a number and must not be dropped for being spelled as a float.
fn number_field(rec: &Value, key: &str) -> Option<i64> {
    let value = rec.get(key)?;
    value.as_i64().or_else(|| value.as_f64().map(|as_float| as_float as i64))
}

/// The first line of a value, trimmed — `value.split('\n')[0].trim()`.
fn first_line(value: &str) -> String {
    value.split('\n').next().unwrap_or("").trim().to_string()
}

/// Epoch ms for a record's `timestamp`, falling back to now.
///
/// The TS does `Date.parse(...)` and falls back to `Date.now()` on NaN. This
/// parser is narrower than `Date.parse` — it accepts the RFC 3339 shape Claude
/// Code actually writes (`2026-08-14T00:57:52.725Z`, plus `+HH:MM` offsets) —
/// and takes the same fallback for anything else.
fn record_time(rec: &Value) -> i64 {
    rec.get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso8601_ms)
        .unwrap_or_else(now_ms)
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
///
/// The constants are the algorithm's own and are not arbitrary: it counts in
/// 400-year eras, which is the period over which the Gregorian calendar repeats
/// exactly, and shifts the year to start in March so that February's leap day
/// falls at the end and needs no special case. Leave them as Hinnant wrote them.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    /// The Gregorian calendar repeats exactly this often.
    const ERA_YEARS: i64 = 400;
    /// Days in one such era, leap years included.
    const DAYS_PER_ERA: i64 = 146_097;
    const DAYS_PER_COMMON_YEAR: i64 = 365;
    /// From 0000-03-01, where the shifted year begins, to 1970-01-01.
    const EPOCH_SHIFT: i64 = 719_468;
    const FEBRUARY: i64 = 2;
    const MARCH: i64 = 3;
    /// January and February belong to the previous shifted year, nine months on
    /// from its March.
    const MONTHS_AFTER_MARCH: i64 = 9;
    /// `(153 * m + 2) / 5` is the exact day the `m`th month after March starts:
    /// the months from March run 31,30,31,30,31,31,30,31,30,31,31,28.
    const MONTH_LENGTH_NUMERATOR: i64 = 153;
    const MONTH_LENGTH_DENOMINATOR: i64 = 5;
    const LEAP_EVERY: i64 = 4;
    const SKIPPING_EVERY: i64 = 100;

    let year = if month <= FEBRUARY { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - (ERA_YEARS - 1) } / ERA_YEARS;
    let year_of_era = year - era * ERA_YEARS;
    let shifted_month =
        if month > FEBRUARY { month - MARCH } else { month + MONTHS_AFTER_MARCH };
    let day_of_year =
        day - 1 + (MONTH_LENGTH_NUMERATOR * shifted_month + 2) / MONTH_LENGTH_DENOMINATOR;
    let day_of_era = year_of_era * DAYS_PER_COMMON_YEAR + year_of_era / LEAP_EVERY
        - year_of_era / SKIPPING_EVERY
        + day_of_year;
    era * DAYS_PER_ERA + day_of_era - EPOCH_SHIFT
}

/// The fixed-width head of the shape, `YYYY-MM-DDTHH:MM:SS`. Everything after
/// it — a fraction, a zone — is optional, so it is where the parse begins.
const ISO_HEAD_LEN: usize = 19;
/// Where each field sits in that head. Claude Code's timestamps never vary in
/// width, so they are read by position; splitting on the separators would
/// accept shapes `Date.parse` does not.
const YEAR_AT: std::ops::Range<usize> = 0..4;
const MONTH_AT: std::ops::Range<usize> = 5..7;
const DAY_AT: std::ops::Range<usize> = 8..10;
const HOUR_AT: std::ops::Range<usize> = 11..13;
const MINUTE_AT: std::ops::Range<usize> = 14..16;
const SECOND_AT: std::ops::Range<usize> = 17..19;
/// The separators, and the one position that may be either `T` or a space.
const SEPARATORS_AT: [(usize, u8); 4] = [(4, b'-'), (7, b'-'), (13, b':'), (16, b':')];
const DATE_TIME_SPLIT_AT: usize = 10;

/// Calendar bounds. A second of 60 is a leap second, which the shape carries and
/// `Date.parse` accepts.
const LAST_MONTH: i64 = 12;
const LAST_DAY: i64 = 31;
const LAST_HOUR: i64 = 23;
const LAST_MINUTE: i64 = 59;
const LAST_SECOND: i64 = 60;

/// Milliseconds are three digits: a longer fraction is truncated to them and a
/// shorter one padded out ('.7' is 700ms).
const MILLIS_DIGITS: usize = 3;

/// A zone offset is `±HH:MM`, six characters.
const ZONE_LEN: usize = 6;
const ZONE_HOUR_AT: std::ops::Range<usize> = 1..3;
const ZONE_MINUTE_AT: std::ops::Range<usize> = 4..6;

const MINUTES_PER_HOUR: i64 = 60;
const SECONDS_PER_MINUTE: i64 = 60;
const SECONDS_PER_HOUR: i64 = 3_600;
const SECONDS_PER_DAY: i64 = 86_400;
const MILLIS_PER_SECOND: i64 = 1_000;

/// The date and clock time read out of the fixed-width head.
struct IsoHead {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
}

fn separators_in_place(bytes: &[u8]) -> bool {
    let split = bytes[DATE_TIME_SPLIT_AT];
    SEPARATORS_AT.iter().all(|(at, separator)| bytes[*at] == *separator)
        && (split == b'T' || split == b' ')
}

fn parse_iso_head(text: &str) -> Option<IsoHead> {
    let bytes = text.as_bytes();
    if bytes.len() < ISO_HEAD_LEN || !separators_in_place(bytes) {
        return None;
    }
    let num = |at: std::ops::Range<usize>| -> Option<i64> { text.get(at)?.parse::<i64>().ok() };
    let head = IsoHead {
        year: num(YEAR_AT)?,
        month: num(MONTH_AT)?,
        day: num(DAY_AT)?,
        hour: num(HOUR_AT)?,
        minute: num(MINUTE_AT)?,
        second: num(SECOND_AT)?,
    };
    let in_range = head.hour <= LAST_HOUR
        && head.minute <= LAST_MINUTE
        && head.second <= LAST_SECOND
        && (1..=LAST_MONTH).contains(&head.month)
        && (1..=LAST_DAY).contains(&head.day);
    in_range.then_some(head)
}

/// The optional `.fff`, and whatever is left for the zone to read.
fn take_fraction(rest: &str) -> Option<(i64, &str)> {
    let Some(fraction) = rest.strip_prefix('.') else {
        return Some((0, rest));
    };
    let digits: String = fraction.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let mut millis: String = digits.chars().take(MILLIS_DIGITS).collect();
    while millis.len() < MILLIS_DIGITS {
        millis.push('0');
    }
    Some((millis.parse().ok()?, &rest[1 + digits.len()..]))
}

/// The zone, in minutes east of UTC.
///
/// A bare timestamp with no zone is read as UTC, which is what Claude Code
/// writes; `Date.parse` would agree for this (date-time) shape.
fn zone_offset_minutes(rest: &str) -> Option<i64> {
    let sign = match rest.as_bytes().first() {
        None | Some(b'Z') | Some(b'z') => return Some(0),
        Some(sign @ (b'+' | b'-')) => *sign,
        _ => return None,
    };
    if rest.len() < ZONE_LEN {
        return None;
    }
    let hours: i64 = rest.get(ZONE_HOUR_AT)?.parse().ok()?;
    let minutes: i64 = rest.get(ZONE_MINUTE_AT)?.parse().ok()?;
    let magnitude = hours * MINUTES_PER_HOUR + minutes;
    Some(if sign == b'-' { -magnitude } else { magnitude })
}

/// Parse `YYYY-MM-DDTHH:MM:SS[.fff][Z|±HH:MM]` to epoch milliseconds.
pub fn parse_iso8601_ms(text: &str) -> Option<i64> {
    let head = parse_iso_head(text)?;
    let (millis, rest) = take_fraction(&text[ISO_HEAD_LEN..])?;
    let offset_min = zone_offset_minutes(rest)?;
    let days = days_from_civil(head.year, head.month, head.day);
    let seconds = days * SECONDS_PER_DAY + head.hour * SECONDS_PER_HOUR
        + head.minute * SECONDS_PER_MINUTE
        + head.second
        - offset_min * SECONDS_PER_MINUTE;
    Some(seconds * MILLIS_PER_SECOND + millis)
}

/// Locate a session's transcript by scanning project directories for the
/// session id, rather than deriving the directory name from cwd — a session
/// that changed directory still resolves correctly.
pub async fn find_transcript(session_id: &str, root: &Path) -> Option<PathBuf> {
    let file = format!("{session_id}.jsonl");
    let mut dirs = tokio::fs::read_dir(root).await.ok()?;
    while let Ok(Some(entry)) = dirs.next_entry().await {
        let candidate = entry.path().join(&file);
        if tokio::fs::metadata(&candidate).await.is_ok() {
            return Some(candidate);
        }
    }
    None
}

/// Blocking twin of [`find_transcript`], for the synchronous [`tail_for`] probe.
pub fn find_transcript_blocking(session_id: &str, root: &Path) -> Option<PathBuf> {
    let file = format!("{session_id}.jsonl");
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let candidate = entry.path().join(&file);
        if std::fs::metadata(&candidate).is_ok() {
            return Some(candidate);
        }
    }
    None
}

/// When a subagent of this session last wrote, or None if none is running.
///
/// A delegated run writes to `<project>/<sessionId>/subagents/*.jsonl` while the
/// session's own transcript sits still, so this is the only evidence that the
/// agent is working rather than stuck.
///
/// The directory is stat-ed before it is read: most agents never delegate, and
/// that keeps the common case at one syscall per poll (INV-4).
pub async fn subagent_activity_at(transcript_path: &Path, session_id: &str) -> Option<i64> {
    let dir = transcript_path
        .parent()?
        .join(session_id)
        .join("subagents");
    tokio::fs::metadata(&dir).await.ok()?;
    let mut entries = tokio::fs::read_dir(&dir).await.ok()?;
    let mut newest = 0i64;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        if !name.to_string_lossy().ends_with(".jsonl") {
            continue;
        }
        // Vanished between readdir and stat: nothing to learn from it.
        let Ok(meta) = entry.metadata().await else { continue };
        let Ok(modified) = meta.modified() else { continue };
        let Ok(since) = modified.duration_since(UNIX_EPOCH) else { continue };
        let ms = since.as_millis() as i64;
        if ms > newest {
            newest = ms;
        }
    }
    (newest > 0).then_some(newest)
}

/// One-line description of a tool call, chosen per tool.
pub fn summarize_tool(name: &str, input: Option<&Value>) -> String {
    let text_of = |key: &str| -> Option<String> {
        input
            .and_then(|value| value.get(key))
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
    };
    match name {
        "Bash" => text_of("description").unwrap_or_else(|| first_line(&text_of("command").unwrap_or_default())),
        "Read" | "Edit" | "Write" | "NotebookEdit" => text_of("file_path").unwrap_or_default(),
        "Grep" | "Glob" => text_of("pattern").unwrap_or_default(),
        "Task" | "Agent" => {
            text_of("description").unwrap_or_else(|| first_line(&text_of("prompt").unwrap_or_default()))
        }
        "WebFetch" | "WebSearch" => text_of("url").or_else(|| text_of("query")).unwrap_or_default(),
        _ => {
            let described = text_of("description")
                .or_else(|| text_of("file_path"))
                .or_else(|| text_of("pattern"))
                .or_else(|| text_of("command"));
            described.map(|text| first_line(&text)).unwrap_or_default()
        }
    }
}

/// Build the prompt a still-unanswered tool call is asking, where it says one.
///
/// Only three shapes carry anything worth showing, and they carry different
/// amounts. `AskUserQuestion` states the question and every option, so the
/// interface may label buttons with them. `ExitPlanMode` states the plan but
/// not the approval choices, which the CLI composes at the terminal. Anything
/// else is a tool waiting on permission: its input says what it would do, and
/// nothing on disk says what the numbered list will look like.
///
/// Whatever is not on disk stays absent here rather than being guessed at, and
/// the interface offers keys where it has no labels (INV-16).
pub fn pending_prompt(name: &str, input: Option<&Value>) -> PendingPrompt {
    let mut prompt = PendingPrompt {
        tool: name.to_string(),
        question: None,
        options: Vec::new(),
        multi_select: None,
        more_questions: None,
        detail: None,
        id: String::new(),
    };
    match name {
        "AskUserQuestion" => fill_from_questions(&mut prompt, input),
        "ExitPlanMode" => {
            prompt.detail = text_field_of(input, "plan").map(str::to_string);
        }
        _ => {
            // What it would do, in the words the tool itself used.
            let summary = summarize_tool(name, input);
            if !summary.is_empty() {
                prompt.detail = Some(summary);
            }
        }
    }
    prompt
}

/// The first question of an `AskUserQuestion` set, as the card will show it.
///
/// The picker asks them one at a time, so the first is the one on screen.
/// Saying how many follow is honest about what one answer finishes; pretending
/// they are all answerable at once is not.
fn fill_from_questions(prompt: &mut PendingPrompt, input: Option<&Value>) {
    let questions = input.and_then(|v| v.get("questions")).and_then(Value::as_array);
    let Some(questions) = questions else { return };
    let Some(first) = questions.first() else { return };
    prompt.question = text_field(first, "question").map(str::to_string);
    prompt.multi_select =
        first.get("multiSelect").and_then(Value::as_bool).filter(|on| *on).map(|_| true);
    if questions.len() > 1 {
        prompt.more_questions = Some(questions.len() - 1);
    }
    prompt.options = options_of(first);
}

/// Every option with a label. One without cannot be drawn, so it is not offered.
fn options_of(question: &Value) -> Vec<PromptOption> {
    let Some(options) = question.get("options").and_then(Value::as_array) else {
        return Vec::new();
    };
    options
        .iter()
        .filter_map(|option| {
            let label = text_field(option, "label")?;
            Some(PromptOption {
                label: label.to_string(),
                description: text_field(option, "description").map(str::to_string),
            })
        })
        .collect()
}

fn text_field_of<'a>(input: Option<&'a Value>, key: &str) -> Option<&'a str> {
    input.and_then(|v| v.get(key)).and_then(Value::as_str).filter(|t| !t.is_empty())
}

/// Read a goal record, if this line is one.
///
/// Returned rather than assigned so both the tailer and the one-shot reader
/// below agree on what a `goal_status` record means, down to the timestamp.
///
/// Three shapes exist, and the newest record is the current state:
///   * `sentinel: true, met: false` — written when `/goal` set it, unevaluated.
///   * `met: false` with a `reason` — an evaluation that rejected it.
///   * `met: true` — the verdict that ended the goal. A met goal is finished,
///     not running, and the UI has to be able to tell those apart.
pub fn goal_from_record(rec: &Value) -> Option<GoalState> {
    if rec.get("type").and_then(Value::as_str) != Some("attachment") {
        return None;
    }
    let att = rec.get("attachment")?;
    if att.get("type").and_then(Value::as_str) != Some("goal_status") {
        return None;
    }
    let condition = text_field(att, "condition")?.to_string();
    Some(GoalState {
        condition,
        met: att.get("met").and_then(Value::as_bool) == Some(true),
        at: record_time(rec),
        reason: text_field(att, "reason").map(str::to_string),
        // Only ever set, never set to `false`: absent means "has been evaluated".
        fresh: (att.get("sentinel").and_then(Value::as_bool) == Some(true)).then_some(true),
    })
}

/// What one batch of lines said: timeline events plus a fleet-card patch.
pub struct ParseResult {
    pub events: Vec<TimelineEvent>,
    pub patch: AgentPatch,
    /// Tool calls this batch opened, in order, with what each one is asking.
    ///
    /// A call is "open" from the moment it is written until its `tool_result`
    /// arrives. During ordinary work something is nearly always open — a tool
    /// that is merely *running* looks exactly like one waiting to be allowed —
    /// so an open call is never on its own a claim that the agent is blocked.
    /// The registry's `waiting` status is the other half, and the client shows
    /// a prompt only when both agree (INV-16).
    pub opened: Vec<(String, PendingPrompt)>,
    /// `tool_use` ids answered by a `tool_result` in this batch.
    pub answered: Vec<String>,
}

impl ParseResult {
    fn empty() -> Self {
        ParseResult {
            events: Vec::new(),
            patch: AgentPatch::default(),
            opened: Vec::new(),
            answered: Vec::new(),
        }
    }
}

/// The record-type sets, built once per batch rather than once per record: this
/// is the hot path INV-4's incremental read exists to keep cheap, and the corpus
/// on a working machine is 98k records.
struct RecordSets {
    meta: HashSet<&'static str>,
    state: HashSet<&'static str>,
    subagent_tools: HashSet<&'static str>,
}

impl RecordSets {
    fn new() -> Self {
        RecordSets {
            meta: META_TYPES.iter().copied().collect(),
            state: STATE_TYPES.iter().copied().collect(),
            subagent_tools: SUBAGENT_TOOLS.iter().copied().collect(),
        }
    }
}

/// The two things every event from one record shares: when it happened, and
/// whether it belongs to a sidechain — a subagent's own conversation — rather
/// than to the one the user is reading.
#[derive(Clone, Copy)]
struct EventContext {
    at: i64,
    sidechain: Option<bool>,
}

/// What one batch of lines accumulates: the result being built, the running
/// counts, and the generator that names each event.
struct Batch<'a> {
    out: ParseResult,
    tokens: i64,
    subagents: i64,
    seq: &'a mut dyn FnMut() -> String,
}

impl Batch<'_> {
    /// Read one record into the batch.
    fn read(&mut self, rec: &Value, sets: &RecordSets) {
        let kind = rec.get("type").and_then(Value::as_str).unwrap_or("");
        if sets.state.contains(kind) {
            self.read_session_state(rec);
            return;
        }
        // Attachments carry no timeline meaning, but this one carries session
        // state: the goal the session is working towards. Last write wins, the
        // same way permission mode does.
        if let Some(goal) = goal_from_record(rec) {
            self.out.patch.goal = Some(Some(goal));
        }
        if is_compaction(rec, kind) {
            self.push_compaction(rec);
            return;
        }
        if sets.meta.contains(kind) {
            return;
        }
        self.read_where_it_ran(rec);
        self.read_conversation(rec, kind, sets);
    }

    /// Records that are not conversation but do carry session state. They are
    /// emitted repeatedly and the newest is current, so last write wins.
    fn read_session_state(&mut self, rec: &Value) {
        if let Some(mode) = text_field(rec, "permissionMode") {
            self.out.patch.permission_mode = Some(mode.to_string());
        }
        if let Some(title) = text_field(rec, "aiTitle") {
            self.out.patch.ai_title = Some(title.to_string());
        }
        if let Some(prompt) = text_field(rec, "lastPrompt") {
            self.out.patch.last_prompt = Some(prompt.to_string());
        }
    }

    /*
     * A compaction, read before the `system` records are skipped as meta.
     *
     * This is the only thing this app can ever know about `/compact`. The
     * request itself is unobservable — it is text pasted into a prompt —
     * and the work runs for minutes (`durationMs: 157676` in the one real
     * sample), so the button that asks for it cannot wait and does not
     * claim it happened. This record is Claude Code saying it did, with the
     * numbers.
     *
     * `trigger` is kept because the two are different news: one the user
     * asked for, and one the CLI did on its own because the window filled.
     * The second is exactly the sort of thing a dashboard exists to
     * surface. A boundary that carries no metadata still marks the
     * conversation; it just cannot say by how much, and must not invent a
     * number to fill the gap (INV-11).
     */
    fn push_compaction(&mut self, rec: &Value) {
        let compact = rec.get("compactMetadata");
        let manual =
            compact.and_then(|meta| meta.get("trigger")).and_then(Value::as_str) == Some("manual");
        let notice = if manual { NoticeKind::Compacted } else { NoticeKind::CompactedAuto };
        self.out.events.push(TimelineEvent {
            id: (self.seq)(),
            at: record_time(rec),
            kind: TimelineKind::Notice,
            text: String::new(),
            tool: None,
            sidechain: None,
            notice: Some(notice),
            tokens_before: compact.and_then(|meta| number_field(meta, "preTokens")),
            tokens_after: compact.and_then(|meta| number_field(meta, "postTokens")),
        });
    }

    fn read_where_it_ran(&mut self, rec: &Value) {
        // 'HEAD' is what a non-repo or detached checkout reports; it tells the
        // user nothing, so it is not worth a slot on the card.
        if let Some(branch) = text_field(rec, "gitBranch") {
            if branch != "HEAD" {
                self.out.patch.git_branch = Some(branch.to_string());
            }
        }
        // Applying this re-derives `folder` too: the card header renders the
        // basename, and the two must never disagree.
        if let Some(cwd) = text_field(rec, "cwd") {
            self.out.patch.cwd = Some(cwd.to_string());
        }
    }

    /// What a conversation record contributes: the tokens it spent, the model
    /// it names, and the events it carries.
    fn read_conversation(&mut self, rec: &Value, kind: &str, sets: &RecordSets) {
        let message = rec.get("message");
        if let Some(output) = message
            .and_then(|msg| msg.get("usage"))
            .and_then(|usage| usage.get("output_tokens"))
            .and_then(Value::as_i64)
        {
            self.tokens += output;
        }
        // The model can change mid-session via /model, so the latest wins.
        if let Some(model) = message.and_then(|msg| text_field(msg, "model")) {
            self.out.patch.model = Some(model.to_string());
        }
        let content = message.and_then(|msg| msg.get("content"));
        let context = EventContext {
            at: record_time(rec),
            sidechain: (rec.get("isSidechain").and_then(Value::as_bool) == Some(true))
                .then_some(true),
        };
        if kind == "user" {
            self.push_user_prompt(content, context);
        } else if kind == "assistant" {
            self.push_assistant_blocks(content, context, sets);
        }
    }

    fn push_user_prompt(&mut self, content: Option<&Value>, context: EventContext) {
        // Array content on a user record is tool_result plumbing; not shown as
        // a message, but it is exactly what closes an open call.
        if let Some(blocks) = content.and_then(Value::as_array) {
            for block in blocks {
                if let Some(id) = text_field(block, "tool_use_id") {
                    self.out.answered.push(id.to_string());
                }
            }
        }
        let Some(text) = content.and_then(Value::as_str) else { return };
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        self.out.events.push(TimelineEvent {
            id: (self.seq)(),
            at: context.at,
            kind: TimelineKind::User,
            text: text.to_string(),
            tool: None,
            sidechain: context.sidechain,
            notice: None,
            tokens_before: None,
            tokens_after: None,
        });
    }

    fn push_assistant_blocks(
        &mut self,
        content: Option<&Value>,
        context: EventContext,
        sets: &RecordSets,
    ) {
        let Some(blocks) = content.and_then(Value::as_array) else { return };
        for block in blocks {
            // 'thinking' blocks are intentionally omitted from the timeline.
            match block.get("type").and_then(Value::as_str).unwrap_or("") {
                "text" => self.push_assistant_text(block, context),
                "tool_use" => self.push_tool_call(block, context, sets),
                _ => {}
            }
        }
    }

    fn push_assistant_text(&mut self, block: &Value, context: EventContext) {
        let text = block.get("text").and_then(Value::as_str).unwrap_or("").trim();
        if text.is_empty() {
            return;
        }
        self.out.events.push(TimelineEvent {
            id: (self.seq)(),
            at: context.at,
            kind: TimelineKind::Assistant,
            text: text.to_string(),
            tool: None,
            sidechain: context.sidechain,
            notice: None,
            tokens_before: None,
            tokens_after: None,
        });
    }

    fn push_tool_call(&mut self, block: &Value, context: EventContext, sets: &RecordSets) {
        let Some(name) = text_field(block, "name") else { return };
        /*
         * A sidechain's calls belong to a delegate's own conversation. The user
         * is not the one being asked, and answering into this agent's prompt
         * would go to the wrong session entirely.
         */
        if context.sidechain != Some(true) {
            if let Some(id) = text_field(block, "id") {
                self.out.opened.push((id.to_string(), pending_prompt(name, block.get("input"))));
            }
        }
        let delegated = sets.subagent_tools.contains(name);
        if delegated {
            self.subagents += 1;
        }
        self.out.events.push(TimelineEvent {
            id: (self.seq)(),
            at: context.at,
            kind: if delegated { TimelineKind::Subagent } else { TimelineKind::Tool },
            text: summarize_tool(name, block.get("input")),
            tool: Some(name.to_string()),
            sidechain: context.sidechain,
            notice: None,
            tokens_before: None,
            tokens_after: None,
        });
    }

    /// The running totals, applied to the patch once the last line is read.
    fn finish(mut self) -> ParseResult {
        if let Some(last) = self.out.events.last() {
            self.out.patch.activity = Some(describe(last));
            self.out.patch.last_activity_at = Some(last.at);
        }
        if self.tokens > 0 {
            self.out.patch.tokens = Some(self.tokens);
        }
        if self.subagents > 0 {
            self.out.patch.subagents = Some(self.subagents);
        }
        self.out
    }
}

fn is_compaction(rec: &Value, kind: &str) -> bool {
    kind == "system" && rec.get("subtype").and_then(Value::as_str) == Some("compact_boundary")
}

/// Convert raw JSONL lines into timeline events plus a fleet-card patch.
pub fn parse_lines(lines: &[&str], seq: &mut dyn FnMut() -> String) -> ParseResult {
    let sets = RecordSets::new();
    let mut batch = Batch { out: ParseResult::empty(), tokens: 0, subagents: 0, seq };
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        // A torn final line is normal when tailing a file being appended to;
        // the tailer re-reads it once it is complete (INV-5).
        let Ok(rec) = serde_json::from_str::<Value>(line) else { continue };
        batch.read(&rec, &sets);
    }
    batch.finish()
}

/// The one-line "what is it doing" string shown on a fleet card.
///
/// The 80 is counted in `char`s where the TS counts UTF-16 code units. They
/// agree for everything in the BMP, which is all of the Latin and CJK text this
/// line ever holds; an astral character (an emoji) counts as one here and two
/// there, so a heavily-emoji line trims one or two characters later.
pub fn describe(event: &TimelineEvent) -> String {
    /// The card has room for this many characters; a longer line keeps its
    /// first `MAX_CHARS - 1` of them and ends in an ellipsis.
    fn trim(line: &str) -> String {
        const MAX_CHARS: usize = 80;
        if line.chars().count() > MAX_CHARS {
            let head: String = line.chars().take(MAX_CHARS - 1).collect();
            format!("{head}…")
        } else {
            line.to_string()
        }
    }
    let tool = event.tool.as_deref().unwrap_or("");
    match event.kind {
        TimelineKind::Tool => trim(&if event.text.is_empty() {
            if tool.is_empty() { "tool".to_string() } else { tool.to_string() }
        } else {
            format!("{tool}: {}", event.text)
        }),
        TimelineKind::Subagent => trim(&if event.text.is_empty() {
            "delegating to subagent".to_string()
        } else {
            format!("{tool} → {}", event.text)
        }),
        TimelineKind::User => trim(&format!("you: {}", event.text)),
        // The card has no room for the token pair and no i18n; the timeline
        // carries the detail.
        TimelineKind::Notice => match event.notice {
            Some(NoticeKind::CompactedAuto) => "compacted automatically".to_string(),
            _ => "compacted".to_string(),
        },
        _ => trim(&event.text),
    }
}

/// Holds back a multi-byte character that a read stopped in the middle of.
///
/// The tailer's offset is a byte count and a poll lands wherever the writer
/// happened to have got to, so a three-byte character gets split across two
/// reads sooner or later. Decoding each chunk on its own turned that into two
/// U+FFFD replacements: "检查一下" came back as "\u{FFFD}\u{FFFD}查一下" for any
/// conversation not written in ASCII, and this app ships a Chinese locale. This
/// is the `StringDecoder` the TS uses, by hand: complete sequences are emitted,
/// an incomplete tail waits for the rest of its bytes.
#[derive(Default)]
struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    fn write(&mut self, chunk: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(chunk);
        let mut out = String::with_capacity(buf.len());
        let mut input: &[u8] = &buf;
        // Decoded once per slice: the result is carried out of the loop rather
        // than the bytes being validated a second time to get it.
        let mut decoded = std::str::from_utf8(input);
        while let Err(err) = decoded {
            let valid = err.valid_up_to();
            // Safe by construction: `valid_up_to` is a UTF-8 boundary.
            out.push_str(std::str::from_utf8(&input[..valid]).unwrap_or(""));
            // Truncated at the end of the chunk: keep the tail for next time.
            let Some(invalid) = err.error_len() else {
                self.pending.extend_from_slice(&input[valid..]);
                return out;
            };
            // Genuinely invalid bytes; replace as StringDecoder does.
            out.push('\u{FFFD}');
            input = &input[valid + invalid..];
            decoded = std::str::from_utf8(input);
        }
        out.push_str(decoded.unwrap_or(""));
        out
    }

    fn reset(&mut self) {
        self.pending.clear();
    }
}

/// Incremental byte-offset tailer for one transcript file.
pub struct TranscriptTail {
    session_id: String,
    /// Where to look for the transcript; overridden by tests.
    root: PathBuf,
    path: Option<PathBuf>,
    /// When this agent itself last wrote, as opposed to a subagent of it.
    last_event_at: i64,
    offset: u64,
    partial: String,
    decoder: Utf8Decoder,
    counter: u64,
    total_tokens: i64,
    total_subagents: i64,
    /// Whether a full backfill has been handed over yet.
    ///
    /// `first` tells the client to replace what it has rather than append, so it
    /// must not be raised again by a transcript that has merely gone missing —
    /// that would blank a conversation the user is reading, once per poll.
    backfilled: bool,
    /// Tool calls written but not yet answered, oldest first.
    ///
    /// Kept here rather than per batch because the read is incremental (INV-4):
    /// the call and the result that closes it are usually in different reads,
    /// often minutes apart — an unanswered question sat for eleven of them in
    /// the sample this was built against.
    open_calls: Vec<(String, PendingPrompt)>,
    /// The prompt the last read reported, so a change can be noticed.
    reported_prompt: Option<PendingPrompt>,
}

impl TranscriptTail {
    pub fn new(session_id: impl Into<String>, root: impl Into<PathBuf>) -> Self {
        TranscriptTail {
            session_id: session_id.into(),
            root: root.into(),
            path: None,
            last_event_at: 0,
            offset: 0,
            partial: String::new(),
            decoder: Utf8Decoder::default(),
            counter: 0,
            total_tokens: 0,
            total_subagents: 0,
            backfilled: false,
            open_calls: Vec::new(),
            reported_prompt: None,
        }
    }

    /// The call this agent is most likely blocked on, if any is still open.
    ///
    /// The newest, because a dialog raised while another was open is the one on
    /// screen. This says only what the transcript said; whether the agent is
    /// actually waiting is the registry's to decide, and the client requires
    /// both before it offers to answer anything (INV-16).
    pub fn pending_prompt(&self) -> Option<&PendingPrompt> {
        self.open_calls.last().map(|(_, prompt)| prompt)
    }

    /// The prompt to report now, and whether it differs from last time.
    fn report_prompt(&mut self) -> (Option<PendingPrompt>, bool) {
        let now = self.pending_prompt().cloned();
        let changed = now != self.reported_prompt;
        self.reported_prompt = now.clone();
        (now, changed)
    }

    /// Fold one batch's opened and answered calls into the running set.
    fn track_calls(&mut self, result: &ParseResult) {
        for id in &result.answered {
            self.open_calls.retain(|(open, _)| open != id);
        }
        for (id, prompt) in &result.opened {
            // A result can precede its call within one batch only if the file
            // is out of order, but re-opening an answered call would strand it.
            if result.answered.contains(id) {
                continue;
            }
            self.open_calls.push((id.clone(), prompt.clone()));
        }
    }

    /// A tailer over the real `~/.claude/projects` tree.
    pub fn for_session(session_id: impl Into<String>) -> Self {
        Self::new(session_id, projects_dir())
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Whether a subagent is working while this agent waits, and a last-activity
    /// time that says so.
    ///
    /// Without this the clock freezes at the moment work was handed off, so a
    /// healthy delegated run reads as "18m ago" and looks exactly like an agent
    /// that has silently died — the one thing this dashboard exists to catch.
    async fn delegation(&self) -> AgentPatch {
        let mut patch = AgentPatch::default();
        let Some(path) = self.path.as_deref() else { return patch };
        match subagent_activity_at(path, &self.session_id).await {
            Some(at) if at > self.last_event_at => {
                patch.delegating = Some(true);
                patch.last_activity_at = Some(at);
            }
            _ => patch.delegating = Some(false),
        }
        patch
    }

    /// Read whatever is new. The first call backfills only the tail of the file
    /// so that opening a long-running agent stays cheap.
    pub async fn read_next(&mut self) -> TailRead {
        let Some(path) = self.resolve_path().await else {
            return self.nothing_yet();
        };
        let Some(size) = self.size_of(&path).await else {
            return Self::nothing_read();
        };

        let first = self.seek_to_start(size);
        // Checked even when the transcript has not grown by a byte: that
        // silence is exactly what a delegated run looks like from here.
        if size == self.offset {
            self.backfilled |= first;
            let (prompt, prompt_changed) = self.report_prompt();
            return TailRead {
                events: Vec::new(),
                patch: self.delegation().await,
                first,
                prompt,
                prompt_changed,
            };
        }

        let start = self.offset;
        let Some(buf) = self.read_new_bytes(&path, size).await else {
            return Self::nothing_read();
        };

        let text = self.decode(&buf);
        let mut lines: Vec<&str> = text.split('\n').collect();
        // The last element is either "" (clean boundary) or a torn record.
        self.partial = lines.pop().unwrap_or("").to_string();
        // A backfill starts mid-file, so the first line is almost certainly torn.
        if first && !lines.is_empty() && start > 0 {
            lines.remove(0);
        }

        let mut result = {
            let mut seq = || self.next_id();
            parse_lines(&lines, &mut seq)
        };
        self.apply_batch(&mut result).await;
        self.backfilled |= first;
        let (prompt, prompt_changed) = self.report_prompt();
        TailRead { events: result.events, patch: result.patch, first, prompt, prompt_changed }
    }

    /// Nothing to read yet, and the client has never been sent a backfill
    /// either, so the next successful read is still its first.
    fn nothing_yet(&self) -> TailRead {
        TailRead {
            events: Vec::new(),
            patch: AgentPatch::default(),
            first: !self.backfilled,
            prompt: None,
            prompt_changed: false,
        }
    }

    /// Nothing was read, and this is not a replacement of what the client holds.
    fn nothing_read() -> TailRead {
        TailRead {
            events: Vec::new(),
            patch: AgentPatch::default(),
            first: false,
            prompt: None,
            prompt_changed: false,
        }
    }

    /// Where the transcript is, resolved on first use and cached after that.
    async fn resolve_path(&mut self) -> Option<PathBuf> {
        if self.path.is_none() {
            self.path = find_transcript(&self.session_id, &self.root).await;
        }
        self.path.clone()
    }

    /// How big the file is now, or `None` when it could not be stat-ed.
    ///
    /// The file moved, was rotated, or is briefly unreadable. The path was
    /// resolved once and cached, so holding on to it meant every later read
    /// failed the same way and that agent's timeline was dead for the life of
    /// the process. Dropping it costs one directory scan and lets the next read
    /// find where the transcript went.
    async fn size_of(&mut self, path: &Path) -> Option<u64> {
        match tokio::fs::metadata(path).await {
            Ok(meta) => Some(meta.len()),
            Err(_) => {
                self.path = None;
                None
            }
        }
    }

    /// Point the offset at where this read should start, and say whether what
    /// comes back replaces the client's copy rather than appending to it.
    ///
    /// A first read of a long file starts near its end: opening a long-running
    /// agent must not cost a re-parse of its whole history (INV-4). A file
    /// smaller than the offset was truncated or replaced, and starting over is
    /// the only way not to emit garbage — but it is a replacement, not a
    /// continuation, and without saying so the client appends the whole file to
    /// the copy it already has.
    fn seek_to_start(&mut self, size: u64) -> bool {
        let mut first = self.offset == 0;
        if first && size > BACKFILL_BYTES {
            self.offset = size - BACKFILL_BYTES;
        }
        if size < self.offset {
            self.offset = 0;
            self.partial.clear();
            self.decoder.reset();
            // The file this tracked has been replaced, so every call it was
            // holding open belongs to a transcript that no longer exists.
            self.open_calls.clear();
            first = true;
        }
        first
    }

    /// Everything between the offset and `size`, with the offset advanced by
    /// what actually arrived.
    ///
    /// The TS advances to `size` regardless of how much it got back. Advancing
    /// by what was actually read cannot skip bytes if the file shrank between
    /// the stat and the read, and is identical whenever it did not.
    async fn read_new_bytes(&mut self, path: &Path, size: u64) -> Option<Vec<u8>> {
        let start = self.offset;
        let mut buf = vec![0u8; (size - start) as usize];
        let Ok(read) = self.read_at(path, start, &mut buf).await else {
            self.path = None;
            return None;
        };
        buf.truncate(read);
        self.offset = start + read as u64;
        Some(buf)
    }

    /// The new bytes as text, behind whatever the last read held back.
    ///
    /// Decoded through the tailer's own decoder, so a character split across
    /// this read and the next survives it.
    fn decode(&mut self, buf: &[u8]) -> String {
        format!("{}{}", self.partial, self.decoder.write(buf))
    }

    /// `<session>:<n>`, unique for the life of this tailer.
    fn next_id(&mut self) -> String {
        let id = format!("{}:{}", self.session_id, self.counter);
        self.counter += 1;
        id
    }

    /// Fold one batch into the tailer's running totals, then overlay what a
    /// subagent of this session is doing.
    async fn apply_batch(&mut self, result: &mut ParseResult) {
        self.track_calls(result);
        self.total_tokens += result.patch.tokens.unwrap_or(0);
        self.total_subagents += result.patch.subagents.unwrap_or(0);
        if self.total_tokens > 0 {
            result.patch.tokens = Some(self.total_tokens);
        }
        if self.total_subagents > 0 {
            result.patch.subagents = Some(self.total_subagents);
        }
        if let Some(at) = result.patch.last_activity_at {
            self.last_event_at = at;
        }
        // Overlays `delegating`, and `lastActivityAt` with it when a subagent is
        // the thing still moving.
        let delegation = self.delegation().await;
        if let Some(delegating) = delegation.delegating {
            result.patch.delegating = Some(delegating);
        }
        if let Some(at) = delegation.last_activity_at {
            result.patch.last_activity_at = Some(at);
        }
    }

    async fn read_at(&self, path: &Path, offset: u64, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut file = tokio::fs::File::open(path).await?;
        file.seek(std::io::SeekFrom::Start(offset)).await?;
        let mut filled = 0usize;
        while filled < buf.len() {
            let n = file.read(&mut buf[filled..]).await?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        Ok(filled)
    }
}

#[async_trait]
impl TailApi for TranscriptTail {
    async fn read(&mut self) -> anyhow::Result<TailRead> {
        Ok(self.read_next().await)
    }
}

/// Build a tail reader for one session's transcript, or None when it has no
/// transcript file yet.
///
/// The probe is one directory scan, and it is deliberately not cached: a
/// session that has not written its transcript yet gets a tail on the next
/// tick, once it has.
pub fn tail_for(agent: &Agent) -> Option<Box<dyn TailApi>> {
    let root = projects_dir();
    find_transcript_blocking(&agent.session_id, &root)?;
    Some(Box::new(TranscriptTail::new(agent.session_id.clone(), root)))
}

/// Read the tail of a session's transcript, split into lines.
///
/// Only the tail is scanned: the state records below are written on every turn,
/// so the newest is always near the end. The head of the window is very likely
/// a torn line — and, decoded as bytes, a torn character; both are skipped by
/// the callers, which parse each line and ignore the ones that fail.
async fn read_state_tail(session_id: &str, root: &Path) -> Vec<String> {
    let Some(path) = find_transcript(session_id, root).await else { return Vec::new() };
    let Ok(meta) = tokio::fs::metadata(&path).await else { return Vec::new() };
    let size = meta.len();
    let start = size.saturating_sub(STATE_TAIL_BYTES);
    let length = (size - start) as usize;
    if length == 0 {
        return Vec::new();
    }
    let Ok(mut file) = tokio::fs::File::open(&path).await else { return Vec::new() };
    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return Vec::new();
    }
    let mut buf = vec![0u8; length];
    let mut filled = 0usize;
    while filled < length {
        match file.read(&mut buf[filled..]).await {
            Ok(0) | Err(_) => break,
            Ok(n) => filled += n,
        }
    }
    buf.truncate(filled);
    String::from_utf8_lossy(&buf)
        .split('\n')
        .map(str::to_string)
        .collect()
}

/// Read the permission mode a session reports right now.
///
/// Used to verify a mode switch landed, so it reads the file directly rather
/// than waiting for the 5s enrichment tick.
pub async fn read_permission_mode_in(session_id: &str, root: &Path) -> Option<String> {
    for line in read_state_tail(session_id, root).await.iter().rev() {
        if !line.contains("\"permission-mode\"") {
            continue;
        }
        // A torn line at the head of the window; keep looking backwards.
        let Ok(rec) = serde_json::from_str::<Value>(line) else { continue };
        if rec.get("type").and_then(Value::as_str) == Some("permission-mode") {
            if let Some(mode) = text_field(&rec, "permissionMode") {
                return Some(mode.to_string());
            }
        }
    }
    None
}

pub async fn read_permission_mode(session_id: &str) -> Option<String> {
    read_permission_mode_in(session_id, &projects_dir()).await
}

/// Read the goal a session reports right now.
///
/// Used to verify that a `/goal` actually landed, so — like the mode reader —
/// it goes to the file rather than waiting for the 5s enrichment tick. Only
/// `goal_status` records are parsed, and only the newest one counts: it is
/// either the set-sentinel, the latest rejection, or the verdict that ended
/// this run of work.
pub async fn read_goal_in(session_id: &str, root: &Path) -> Option<GoalState> {
    for line in read_state_tail(session_id, root).await.iter().rev() {
        if !line.contains("\"goal_status\"") {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<Value>(line) else { continue };
        if let Some(goal) = goal_from_record(&rec) {
            return Some(goal);
        }
    }
    None
}

pub async fn read_goal(session_id: &str) -> Option<GoalState> {
    read_goal_in(session_id, &projects_dir()).await
}

#[cfg(test)]
mod tests {
    //! Mirrors `test/transcript.test.ts`, `test/transcript-tail.test.ts` and
    //! `test/delegation.test.ts`.
    //!
    //! INV-4 makes this a byte-offset tail — a live transcript is megabytes and
    //! re-reading it every second would be the most expensive thing this app
    //! does — and every bug here comes from that offset landing somewhere
    //! awkward: in the middle of a line, in the middle of a character, or on a
    //! file that has since moved.
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::io::Write as _;

    fn seq() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            let id = format!("e{n}");
            n += 1;
            id
        }
    }

    fn parse(lines: &[&str]) -> ParseResult {
        let mut s = seq();
        parse_lines(lines, &mut s)
    }

    /// Output tokens on every assistant fixture, so a test that adds them up
    /// across records has a round number to add up to.
    const FIXTURE_TOKENS: i64 = 40;

    fn assistant(blocks: Value) -> String {
        json!({
            "type": "assistant",
            "timestamp": "2026-08-14T00:57:52.725Z",
            "gitBranch": "main",
            "message": { "content": blocks, "usage": { "output_tokens": FIXTURE_TOKENS } },
        })
        .to_string()
    }

    /* ---- parse_lines: compaction ---- */

    /*
     * A compaction is the only observable trace `/compact` ever leaves. The
     * request itself is text pasted into a prompt, and the work runs for
     * minutes — the real sample this was written against reports
     * `durationMs: 157676` — so nothing waits for it and this record is what
     * tells the user it happened.
     *
     * `system` records are otherwise skipped as meta, which is why this is read
     * before that filter rather than after it.
     */
    #[test]
    fn turns_a_compaction_boundary_into_a_notice_with_its_token_counts() {
        // The counts from the one real sample this was written against.
        const BEFORE: i64 = 886_876;
        const AFTER: i64 = 28_634;
        let line = json!({
            "type": "system",
            "subtype": "compact_boundary",
            "content": "Conversation compacted",
            "timestamp": "2026-08-27T14:01:53.941Z",
            "compactMetadata": { "trigger": "manual", "preTokens": BEFORE, "postTokens": AFTER },
        })
        .to_string();
        let out = parse(&[&line]);
        assert_eq!(out.events.len(), 1);
        assert_eq!(out.events[0].kind, TimelineKind::Notice);
        assert_eq!(out.events[0].notice, Some(NoticeKind::Compacted));
        assert_eq!(out.events[0].tokens_before, Some(BEFORE));
        assert_eq!(out.events[0].tokens_after, Some(AFTER));
    }

    /*
     * A compaction the CLI did on its own because the window filled is
     * different news from one the user asked for, and telling them apart is the
     * only thing `trigger` is for.
     */
    #[test]
    fn distinguishes_an_automatic_compaction_from_a_requested_one() {
        // A context window full enough that the CLI compacted on its own.
        const FULL_WINDOW: i64 = 700_000;
        let line = json!({
            "type": "system",
            "subtype": "compact_boundary",
            "timestamp": "2026-08-27T14:01:53.941Z",
            "compactMetadata": { "trigger": "auto", "preTokens": FULL_WINDOW, "postTokens": 20_000 },
        })
        .to_string();
        let out = parse(&[&line]);
        assert_eq!(out.events[0].notice, Some(NoticeKind::CompactedAuto));
    }

    /// INV-11: a boundary with no metadata still marks the conversation; it
    /// just cannot say by how much, and must not invent a number to fill the
    /// gap.
    #[test]
    fn inv11_keeps_a_compaction_boundary_that_carries_no_numbers() {
        let line = json!({
            "type": "system",
            "subtype": "compact_boundary",
            "timestamp": "2026-08-27T14:01:53.941Z",
        })
        .to_string();
        let out = parse(&[&line]);
        assert_eq!(out.events[0].kind, TimelineKind::Notice);
        assert_eq!(out.events[0].tokens_before, None);
        assert_eq!(out.events[0].tokens_after, None);
    }

    #[test]
    fn ignores_system_records_that_are_not_a_compaction() {
        let a = json!({
            "type": "system", "subtype": "turn_duration",
            "timestamp": "2026-08-27T14:01:53.941Z",
        })
        .to_string();
        let b = json!({
            "type": "system", "subtype": "local_command",
            "timestamp": "2026-08-27T14:01:53.941Z",
        })
        .to_string();
        assert!(parse(&[&a, &b]).events.is_empty());
    }

    /// The card names the notice in words rather than in numbers, because the
    /// pair has no room there and the timeline already carries it.
    #[test]
    fn a_compaction_names_itself_on_the_activity_line() {
        let manual = json!({
            "type": "system", "subtype": "compact_boundary",
            "timestamp": "2026-08-27T14:01:53.941Z",
            "compactMetadata": { "trigger": "manual" },
        })
        .to_string();
        assert_eq!(parse(&[&manual]).patch.activity.as_deref(), Some("compacted"));

        let auto = json!({
            "type": "system", "subtype": "compact_boundary",
            "timestamp": "2026-08-27T14:01:53.941Z",
            "compactMetadata": { "trigger": "auto" },
        })
        .to_string();
        assert_eq!(
            parse(&[&auto]).patch.activity.as_deref(),
            Some("compacted automatically")
        );
    }

    /* ---- parse_lines ---- */

    #[test]
    fn extracts_assistant_text_and_tool_calls() {
        let a = assistant(json!([{ "type": "text", "text": "Getting oriented." }]));
        let b = assistant(json!([{
            "type": "tool_use", "name": "Bash",
            "input": { "command": "ls -la", "description": "List root" },
        }]));
        let out = parse(&[&a, &b]);
        assert_eq!(out.events.len(), 2);
        assert_eq!(out.events[0].kind, TimelineKind::Assistant);
        assert_eq!(out.events[0].text, "Getting oriented.");
        assert_eq!(out.events[1].kind, TimelineKind::Tool);
        assert_eq!(out.events[1].tool.as_deref(), Some("Bash"));
        assert_eq!(out.events[1].text, "List root");
    }

    #[test]
    fn classifies_task_as_a_subagent_and_counts_it() {
        let a = assistant(json!([{
            "type": "tool_use", "name": "Task", "input": { "description": "Audit tokens" },
        }]));
        let out = parse(&[&a]);
        assert_eq!(out.events[0].kind, TimelineKind::Subagent);
        assert_eq!(out.events[0].tool.as_deref(), Some("Task"));
        assert_eq!(out.patch.subagents, Some(1));
    }

    #[test]
    fn omits_thinking_blocks_and_tool_result_plumbing() {
        let a = assistant(json!([{ "type": "thinking", "thinking": "hmm" }]));
        let b = json!({
            "type": "user", "timestamp": "2026-08-14T00:00:00Z",
            "message": { "content": [{ "type": "tool_result" }] },
        })
        .to_string();
        assert!(parse(&[&a, &b]).events.is_empty());
    }

    #[test]
    fn keeps_a_real_user_prompt() {
        let line = json!({
            "type": "user", "timestamp": "2026-08-14T00:00:00Z",
            "message": { "content": "  add dark mode  " },
        })
        .to_string();
        let out = parse(&[&line]);
        assert_eq!(out.events[0].kind, TimelineKind::User);
        assert_eq!(out.events[0].text, "add dark mode");
    }

    #[test]
    fn skips_meta_record_types_the_transcript_interleaves() {
        let metas = [
            "attachment",
            "mode",
            "permission-mode",
            "ai-title",
            "last-prompt",
            "file-history-delta",
        ];
        let lines: Vec<String> = metas
            .iter()
            .map(|t| json!({ "type": t, "timestamp": "2026-08-14T00:00:00Z" }).to_string())
            .collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        assert!(parse(&refs).events.is_empty());
    }

    /// INV-5: a torn final line is normal when tailing a file being appended to.
    #[test]
    fn inv5_ignores_malformed_json_instead_of_panicking() {
        let good = assistant(json!([{ "type": "text", "text": "ok" }]));
        let out = parse(&[r#"{"type":"assistant","message":{"content":[{"type":"tex"#, &good]);
        assert_eq!(out.events.len(), 1);
        assert_eq!(out.events[0].text, "ok");
    }

    #[test]
    fn a_partial_line_does_not_kill_the_rest_of_the_batch() {
        let good = assistant(json!([{ "type": "text", "text": "after" }]));
        let out = parse(&["not json at all", "", "   ", "{", &good]);
        assert_eq!(out.events.len(), 1);
        assert_eq!(out.events[0].text, "after");
    }

    #[test]
    fn accumulates_tokens_and_reports_git_branch() {
        let a = assistant(json!([{ "type": "text", "text": "a" }]));
        let b = assistant(json!([{ "type": "text", "text": "b" }]));
        let out = parse(&[&a, &b]);
        assert_eq!(out.patch.tokens, Some(FIXTURE_TOKENS * 2));
        assert_eq!(out.patch.git_branch.as_deref(), Some("main"));
    }

    #[test]
    fn derives_the_activity_line_from_the_last_event() {
        let a = assistant(json!([{ "type": "text", "text": "first" }]));
        let b = assistant(json!([{
            "type": "tool_use", "name": "Read", "input": { "file_path": "/tmp/x.ts" },
        }]));
        let out = parse(&[&a, &b]);
        assert_eq!(out.patch.activity.as_deref(), Some("Read: /tmp/x.ts"));
        assert_eq!(out.patch.last_activity_at, out.events.last().map(|e| e.at));
    }

    #[test]
    fn ignores_a_head_branch_which_carries_no_information() {
        let line = json!({
            "type": "assistant", "timestamp": "2026-08-14T00:00:00Z", "gitBranch": "HEAD",
            "message": { "content": [{ "type": "text", "text": "hi" }] },
        })
        .to_string();
        assert_eq!(parse(&[&line]).patch.git_branch, None);
    }

    #[test]
    fn state_records_carry_mode_title_and_prompt() {
        let lines = [
            json!({ "type": "permission-mode", "permissionMode": "plan" }).to_string(),
            json!({ "type": "permission-mode", "permissionMode": "auto" }).to_string(),
            json!({ "type": "ai-title", "aiTitle": "Port the backend" }).to_string(),
            json!({ "type": "last-prompt", "lastPrompt": "keep going" }).to_string(),
        ];
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let out = parse(&refs);
        // Last write wins.
        assert_eq!(out.patch.permission_mode.as_deref(), Some("auto"));
        assert_eq!(out.patch.ai_title.as_deref(), Some("Port the backend"));
        assert_eq!(out.patch.last_prompt.as_deref(), Some("keep going"));
        assert!(out.events.is_empty());
    }

    #[test]
    fn the_newest_model_wins_because_slash_model_can_change_it() {
        let a = json!({
            "type": "assistant", "timestamp": "2026-08-14T00:00:00Z",
            "message": { "model": "claude-opus-4", "content": [{ "type": "text", "text": "a" }] },
        })
        .to_string();
        let b = json!({
            "type": "assistant", "timestamp": "2026-08-14T00:00:01Z",
            "message": { "model": "claude-sonnet-4", "content": [{ "type": "text", "text": "b" }] },
        })
        .to_string();
        assert_eq!(parse(&[&a, &b]).patch.model.as_deref(), Some("claude-sonnet-4"));
    }

    #[test]
    fn marks_sidechain_events_and_leaves_the_flag_off_otherwise() {
        let sub = json!({
            "type": "assistant", "timestamp": "2026-08-14T00:00:00Z", "isSidechain": true,
            "message": { "content": [{ "type": "text", "text": "from a subagent" }] },
        })
        .to_string();
        let main = assistant(json!([{ "type": "text", "text": "from the agent" }]));
        let out = parse(&[&sub, &main]);
        assert_eq!(out.events[0].sidechain, Some(true));
        // Omitted rather than `false`, so the wire shape matches the TS client.
        assert_eq!(out.events[1].sidechain, None);
    }

    #[test]
    fn a_record_with_an_odd_shaped_field_still_yields_the_rest() {
        // Optional-chaining semantics: a `usage` that is not an object costs the
        // token count, not the whole record.
        let line = json!({
            "type": "assistant", "timestamp": "2026-08-14T00:00:00Z", "gitBranch": "topic",
            "message": { "usage": "nonsense", "content": [{ "type": "text", "text": "still here" }] },
        })
        .to_string();
        let out = parse(&[&line]);
        assert_eq!(out.events.len(), 1);
        assert_eq!(out.patch.git_branch.as_deref(), Some("topic"));
        assert_eq!(out.patch.tokens, None);
    }

    /* ---- summarize_tool ---- */

    #[test]
    fn prefers_a_bash_description_over_the_raw_command() {
        let input = json!({ "command": "rm -rf x", "description": "Clean build" });
        assert_eq!(summarize_tool("Bash", Some(&input)), "Clean build");
    }

    #[test]
    fn falls_back_to_the_first_line_of_a_command() {
        let input = json!({ "command": "echo one\necho two" });
        assert_eq!(summarize_tool("Bash", Some(&input)), "echo one");
    }

    #[test]
    fn uses_file_path_for_file_tools_and_pattern_for_search_tools() {
        assert_eq!(summarize_tool("Edit", Some(&json!({ "file_path": "/a/b.ts" }))), "/a/b.ts");
        assert_eq!(summarize_tool("Grep", Some(&json!({ "pattern": "TODO" }))), "TODO");
        assert_eq!(summarize_tool("Glob", Some(&json!({ "pattern": "**/*.rs" }))), "**/*.rs");
    }

    #[test]
    fn returns_empty_rather_than_failing_on_unknown_tools() {
        assert_eq!(summarize_tool("MysteryTool", None), "");
        assert_eq!(summarize_tool("MysteryTool", Some(&json!({ "description": "x\ny" }))), "x");
    }

    #[test]
    fn web_tools_prefer_the_url_then_the_query() {
        assert_eq!(summarize_tool("WebSearch", Some(&json!({ "query": "ratatui" }))), "ratatui");
        assert_eq!(
            summarize_tool("WebFetch", Some(&json!({ "url": "https://x", "query": "q" }))),
            "https://x"
        );
    }

    /* ---- describe ---- */

    fn event(kind: TimelineKind, text: &str, tool: Option<&str>) -> TimelineEvent {
        TimelineEvent {
            id: "a".into(),
            at: 0,
            kind,
            text: text.into(),
            tool: tool.map(str::to_string),
            sidechain: None,
            notice: None,
            tokens_before: None,
            tokens_after: None,
        }
    }

    #[test]
    fn truncates_long_activity_lines() {
        // The card's limit, and a line comfortably past it.
        const ACTIVITY_CHARS: usize = 80;
        const OVERLONG_CHARS: usize = 200;
        let long = "x".repeat(OVERLONG_CHARS);
        let out = describe(&event(TimelineKind::Assistant, &long, None));
        assert!(out.chars().count() <= ACTIVITY_CHARS);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn prefixes_tool_events_with_the_tool_name() {
        assert_eq!(describe(&event(TimelineKind::Tool, "build", Some("Bash"))), "Bash: build");
        assert_eq!(describe(&event(TimelineKind::Tool, "", Some("Bash"))), "Bash");
        assert_eq!(
            describe(&event(TimelineKind::Subagent, "audit", Some("Task"))),
            "Task → audit"
        );
        assert_eq!(
            describe(&event(TimelineKind::Subagent, "", Some("Task"))),
            "delegating to subagent"
        );
        assert_eq!(describe(&event(TimelineKind::User, "go", None)), "you: go");
    }

    /* ---- goal records ---- */

    fn goal_line(fields: Value, timestamp: &str) -> String {
        let mut attachment = json!({ "type": "goal_status" });
        for (key, value) in fields.as_object().unwrap() {
            attachment[key] = value.clone();
        }
        json!({ "type": "attachment", "timestamp": timestamp, "attachment": attachment })
            .to_string()
    }

    const AT: &str = "2026-08-15T03:42:57.797Z";

    #[test]
    fn reads_the_record_written_when_a_goal_is_set() {
        let line = goal_line(json!({ "met": false, "sentinel": true, "condition": "the tests pass" }), AT);
        let goal = parse(&[&line]).patch.goal.flatten().expect("goal");
        assert_eq!(goal.condition, "the tests pass");
        assert!(!goal.met);
        assert_eq!(goal.fresh, Some(true));
        assert_eq!(goal.reason, None);
    }

    #[test]
    fn reads_an_evaluation_that_rejected_the_goal() {
        let line = goal_line(
            json!({ "met": false, "condition": "the tests pass", "reason": "Two still fail." }),
            AT,
        );
        let goal = parse(&[&line]).patch.goal.flatten().expect("goal");
        assert!(!goal.met);
        assert_eq!(goal.reason.as_deref(), Some("Two still fail."));
        // Absent, not false: it has been evaluated.
        assert_eq!(goal.fresh, None);
    }

    /// A met goal is finished, not running: the UI has to be able to tell those
    /// apart, because one of them means the session is still working.
    #[test]
    fn reads_the_verdict_that_ended_the_goal() {
        let line = goal_line(json!({ "met": true, "condition": "ship it" }), AT);
        let goal = parse(&[&line]).patch.goal.flatten().expect("goal");
        assert!(goal.met);
        assert_eq!(goal.condition, "ship it");
    }

    #[test]
    fn keeps_the_newest_record_when_several_are_in_one_batch() {
        let a = goal_line(
            json!({ "met": false, "sentinel": true, "condition": "ship it" }),
            "2026-08-15T01:00:00.000Z",
        );
        let b = goal_line(json!({ "met": true, "condition": "ship it" }), "2026-08-15T02:00:00.000Z");
        let goal = parse(&[&a, &b]).patch.goal.flatten().expect("goal");
        assert!(goal.met);
        assert_eq!(goal.fresh, None);
    }

    #[test]
    fn leaves_the_timeline_alone_a_goal_record_is_not_a_message() {
        let line = goal_line(json!({ "met": true, "condition": "ship it" }), AT);
        assert!(parse(&[&line]).events.is_empty());
    }

    /// INV-5: other attachment types share the envelope and must not be read as goals.
    #[test]
    fn ignores_other_attachments() {
        let rec = json!({ "type": "attachment", "attachment": { "type": "hook_success", "condition": "x" } });
        assert!(goal_from_record(&rec).is_none());
    }

    #[test]
    fn ignores_a_goal_record_with_no_condition() {
        let rec = json!({ "type": "attachment", "attachment": { "type": "goal_status", "met": true } });
        assert!(goal_from_record(&rec).is_none());
    }

    #[test]
    fn a_goal_record_timestamp_is_the_records_own() {
        let line = goal_line(json!({ "met": true, "condition": "ship it" }), "2026-08-15T02:00:00.000Z");
        let rec: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(goal_from_record(&rec).unwrap().at, 1_786_759_200_000);
    }

    /* ---- timestamps ---- */

    #[test]
    fn parses_the_timestamp_shape_claude_code_writes() {
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso8601_ms("2026-08-14T00:57:52.725Z"), Some(1_786_669_072_725));
        // Same instant, expressed with an offset.
        assert_eq!(
            parse_iso8601_ms("2026-08-14T02:57:52.725+02:00"),
            parse_iso8601_ms("2026-08-14T00:57:52.725Z")
        );
        // No fraction, and no zone, are both legal in the wild.
        assert_eq!(parse_iso8601_ms("2026-08-14T00:00:00Z"), Some(1_786_665_600_000));
        assert_eq!(parse_iso8601_ms("2026-08-14T00:00:00"), Some(1_786_665_600_000));
        assert_eq!(parse_iso8601_ms("2026-08-14T00:00:00.7Z"), Some(1_786_665_600_700));
        assert_eq!(parse_iso8601_ms("nonsense"), None);
        assert_eq!(parse_iso8601_ms(""), None);
    }

    #[test]
    fn an_unparseable_timestamp_falls_back_to_now_rather_than_zero() {
        let line = json!({
            "type": "assistant", "timestamp": "whenever",
            "message": { "content": [{ "type": "text", "text": "hi" }] },
        })
        .to_string();
        let at = parse(&[&line]).events[0].at;
        assert!((now_ms() - at).abs() < 5_000, "expected ~now, got {at}");
    }

    /* ---- the incremental tailer ---- */

    const SESSION: &str = "sess-1";

    /// A projects root holding one empty transcript, as the real tree looks.
    fn projects() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().expect("tempdir");
        let dir = root.path().join("-Users-demo-project");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{SESSION}.jsonl"));
        fs::write(&file, "").unwrap();
        (root, file)
    }

    /// One user record, as Claude Code writes them.
    fn said(text: &str) -> String {
        format!(
            "{}\n",
            json!({
                "type": "user",
                "timestamp": "2026-08-14T00:57:52.725Z",
                "message": { "content": text },
            })
        )
    }

    fn append(path: &Path, bytes: &[u8]) {
        let mut f = fs::OpenOptions::new().append(true).open(path).unwrap();
        f.write_all(bytes).unwrap();
    }

    #[tokio::test]
    async fn tails_by_byte_offset_across_polls() {
        let (root, file) = projects();
        let mut tail = TranscriptTail::new(SESSION, root.path());
        assert!(tail.read_next().await.events.is_empty());

        append(&file, said("one").as_bytes());
        let a = tail.read_next().await;
        assert_eq!(a.events.len(), 1);
        assert_eq!(a.events[0].text, "one");

        // Only the new bytes: the record already delivered is not delivered twice.
        append(&file, said("two").as_bytes());
        let b = tail.read_next().await;
        assert_eq!(b.events.len(), 1);
        assert_eq!(b.events[0].text, "two");
        assert!(!b.first);

        // A poll that meets no new bytes reports nothing at all.
        assert!(tail.read_next().await.events.is_empty());

        // Ids stay unique across polls, so the client can key on them.
        assert_eq!(a.events[0].id, format!("{SESSION}:0"));
        assert_eq!(b.events[0].id, format!("{SESSION}:1"));
    }

    /*
     * The offset is a byte count and the poll lands wherever the writer has got
     * to, so a three-byte character straddles the boundary sooner or later.
     * Decoding each chunk as its own string turned that into two U+FFFD
     * replacements — and this app ships a Chinese locale, so it is not an
     * exotic case.
     */
    #[tokio::test]
    async fn reassembles_a_character_split_across_two_reads() {
        let (root, file) = projects();
        let mut tail = TranscriptTail::new(SESSION, root.path());
        tail.read_next().await;

        let record = said("检查一下这个目录");
        let bytes = record.as_bytes();
        // Cut inside the first character: one byte of it lands in each read.
        let cut = record.find('检').unwrap() + 1;
        append(&file, &bytes[..cut]);
        assert!(tail.read_next().await.events.is_empty());

        append(&file, &bytes[cut..]);
        let out = tail.read_next().await;
        assert_eq!(out.events.len(), 1);
        assert_eq!(out.events[0].text, "检查一下这个目录");
        assert!(!out.events[0].text.contains('\u{FFFD}'));
    }

    #[tokio::test]
    async fn handles_a_boundary_inside_every_byte_position_of_a_character() {
        for at in [1usize, 2] {
            let (root, file) = projects();
            let mut tail = TranscriptTail::new(SESSION, root.path());
            tail.read_next().await;

            let record = said("日本語のテスト");
            let bytes = record.as_bytes();
            let cut = record.find('日').unwrap() + at;
            append(&file, &bytes[..cut]);
            tail.read_next().await;
            append(&file, &bytes[cut..]);

            let out = tail.read_next().await;
            assert_eq!(out.events[0].text, "日本語のテスト", "cut at +{at}");
        }
    }

    #[tokio::test]
    async fn holds_a_torn_line_back_until_the_rest_arrives() {
        let (root, file) = projects();
        let mut tail = TranscriptTail::new(SESSION, root.path());
        tail.read_next().await;

        let record = said("finish the migration");
        append(&file, &record.as_bytes()[..20]);
        assert!(tail.read_next().await.events.is_empty());

        append(&file, &record.as_bytes()[20..]);
        assert_eq!(tail.read_next().await.events[0].text, "finish the migration");
    }

    /*
     * The path was resolved once and cached, so a rotated or relocated file left
     * every later read failing the same way: that agent's timeline was dead for
     * the life of the server, with nothing said about why.
     */
    #[tokio::test]
    async fn finds_a_moved_transcript_again_rather_than_going_dead() {
        let (root, file) = projects();
        let mut tail = TranscriptTail::new(SESSION, root.path());
        append(&file, said("before").as_bytes());
        assert_eq!(tail.read_next().await.events.len(), 1);

        let moved = root.path().join("-Users-demo-elsewhere");
        fs::create_dir_all(&moved).unwrap();
        let there = moved.join(format!("{SESSION}.jsonl"));
        fs::rename(&file, &there).unwrap();

        // The read that meets the gap reports nothing, and re-resolves for the next.
        assert!(tail.read_next().await.events.is_empty());
        append(&there, said("after").as_bytes());
        let out = tail.read_next().await;
        assert_eq!(out.events.last().map(|e| e.text.as_str()), Some("after"));
    }

    /*
     * `first` tells the browser to replace the conversation it is showing. A
     * transcript that has merely gone missing must not raise it again, or the
     * chat the user is reading is blanked once per poll.
     */
    #[tokio::test]
    async fn does_not_claim_a_fresh_backfill_once_one_has_been_delivered() {
        let (root, file) = projects();
        let mut tail = TranscriptTail::new(SESSION, root.path());
        append(&file, said("hello").as_bytes());
        assert!(tail.read_next().await.first);

        fs::remove_file(&file).unwrap();
        assert!(!tail.read_next().await.first);
        assert!(!tail.read_next().await.first);
    }

    #[tokio::test]
    async fn reports_a_truncated_file_as_a_replacement_not_a_continuation() {
        let (root, file) = projects();
        let mut tail = TranscriptTail::new(SESSION, root.path());
        append(&file, said("one").as_bytes());
        append(&file, said("two").as_bytes());
        assert_eq!(tail.read_next().await.events.len(), 2);

        // Shorter than what has already been read: a different file at the same path.
        fs::write(&file, said("fresh")).unwrap();
        let out = tail.read_next().await;
        assert!(out.first);
        assert_eq!(out.events.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["fresh"]);
    }

    #[tokio::test]
    async fn a_replacement_resets_the_decoder_so_a_stale_half_character_is_dropped() {
        let (root, file) = projects();
        let mut tail = TranscriptTail::new(SESSION, root.path());
        append(&file, said("one").as_bytes());
        let record = said("检查一下");
        let cut = record.find('检').unwrap() + 1;
        append(&file, &record.as_bytes()[..cut]);
        tail.read_next().await; // one orphaned byte is now held back

        fs::write(&file, said("fresh")).unwrap();
        let out = tail.read_next().await;
        assert!(out.first);
        assert_eq!(out.events.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["fresh"]);
    }

    #[tokio::test]
    async fn backfills_only_the_tail_of_a_long_transcript() {
        // ~600 KB, well past BACKFILL_BYTES, as a few hours of real work is.
        const RECORDS: usize = 1200;
        const PADDING_CHARS: usize = 500;
        let (root, file) = projects();
        let filler = "y".repeat(PADDING_CHARS);
        let mut all = String::new();
        for i in 0..RECORDS {
            all.push_str(&said(&format!("{i}-{filler}")));
        }
        fs::write(&file, &all).unwrap();
        assert!(all.len() as u64 > BACKFILL_BYTES * 2);

        let mut tail = TranscriptTail::new(SESSION, root.path());
        let out = tail.read_next().await;
        assert!(out.first);
        // Only the tail was read, and the torn first line of that window was
        // dropped rather than parsed as a truncated record.
        assert!(out.events.len() < RECORDS, "backfilled the whole file");
        assert!(out.events.len() > 100, "backfilled almost nothing");
        assert!(out.events.iter().all(|e| e.text.ends_with(&filler)));
        let last = RECORDS - 1;
        assert_eq!(out.events.last().unwrap().text, format!("{last}-{filler}"));

        // And the tail continues from there, incrementally.
        append(&file, said("next").as_bytes());
        let more = tail.read_next().await;
        assert!(!more.first);
        assert_eq!(more.events.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["next"]);
    }

    #[tokio::test]
    async fn a_short_first_read_keeps_its_whole_first_line() {
        let (root, file) = projects();
        fs::write(&file, said("only")).unwrap();
        let mut tail = TranscriptTail::new(SESSION, root.path());
        let out = tail.read_next().await;
        assert!(out.first);
        assert_eq!(out.events.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["only"]);
    }

    #[tokio::test]
    async fn tokens_and_subagents_accumulate_across_polls() {
        let (root, file) = projects();
        let mut tail = TranscriptTail::new(SESSION, root.path());
        tail.read_next().await;

        let call = format!(
            "{}\n",
            assistant(json!([{ "type": "tool_use", "name": "Task", "input": { "description": "d" } }]))
        );
        append(&file, call.as_bytes());
        let a = tail.read_next().await;
        assert_eq!(a.patch.tokens, Some(FIXTURE_TOKENS));
        assert_eq!(a.patch.subagents, Some(1));

        append(&file, call.as_bytes());
        let b = tail.read_next().await;
        // Running totals, not per-batch counts.
        assert_eq!(b.patch.tokens, Some(FIXTURE_TOKENS * 2));
        assert_eq!(b.patch.subagents, Some(2));
    }

    #[tokio::test]
    async fn a_session_with_no_transcript_yields_no_tail() {
        let root = tempfile::tempdir().unwrap();
        assert!(find_transcript_blocking("nobody", root.path()).is_none());
        assert!(find_transcript("nobody", root.path()).await.is_none());
        // And a root that does not exist at all is a None, not a panic.
        assert!(find_transcript_blocking("nobody", Path::new("/nonexistent/root")).is_none());
    }

    /* ---- delegation ---- */

    fn subagent(dir: &Path, session_id: &str, name: &str, at_ms: i64) {
        let subs = dir.join(session_id).join("subagents");
        fs::create_dir_all(&subs).unwrap();
        let file = subs.join(name);
        fs::write(&file, "{}\n").unwrap();
        set_mtime(&file, at_ms);
    }

    fn set_mtime(path: &Path, at_ms: i64) {
        let when = UNIX_EPOCH + Duration::from_millis(at_ms as u64);
        let times = fs::FileTimes::new().set_accessed(when).set_modified(when);
        fs::OpenOptions::new().write(true).open(path).unwrap().set_times(times).unwrap();
    }

    use std::time::Duration;

    #[tokio::test]
    async fn reports_nothing_for_an_agent_that_has_never_delegated() {
        let (root, file) = projects();
        let _ = &root;
        assert!(subagent_activity_at(&file, SESSION).await.is_none());
    }

    /// Several subagents can run at once; the fleet card only cares that *any*
    /// of them is still moving, so the newest wins.
    #[tokio::test]
    async fn takes_the_newest_of_several_subagents() {
        let (root, file) = projects();
        let dir = file.parent().unwrap().to_path_buf();
        let _ = &root;
        let older = now_ms() - 120_000;
        let newer = now_ms() - 5_000;
        subagent(&dir, SESSION, "agent-old.jsonl", older);
        subagent(&dir, SESSION, "agent-new.jsonl", newer);
        let seen = subagent_activity_at(&file, SESSION).await.expect("activity");
        assert!((seen - newer).abs() < 2_000, "got {seen}, wanted ~{newer}");
    }

    #[tokio::test]
    async fn ignores_files_that_are_not_transcripts() {
        let (root, file) = projects();
        let subs = file.parent().unwrap().join(SESSION).join("subagents");
        fs::create_dir_all(&subs).unwrap();
        fs::write(subs.join("notes.txt"), "scratch").unwrap();
        let _ = &root;
        assert!(subagent_activity_at(&file, SESSION).await.is_none());
    }

    /// INV-5: a directory that cannot be read downgrades this one signal, it
    /// does not take the fleet view down with it.
    #[tokio::test]
    async fn degrades_to_none_rather_than_failing_on_an_unreadable_path() {
        assert!(subagent_activity_at(Path::new("/nonexistent/path/s5.jsonl"), "s5").await.is_none());
    }

    #[tokio::test]
    async fn does_not_confuse_one_session_with_another() {
        let (root, file) = projects();
        let dir = file.parent().unwrap().to_path_buf();
        let _ = &root;
        subagent(&dir, "someone-else", "agent-aaa.jsonl", now_ms());
        assert!(subagent_activity_at(&file, SESSION).await.is_none());
    }

    /*
     * An agent that has handed work to a subagent goes completely quiet: its own
     * transcript stops growing until the subagent returns, which on a long run
     * is many minutes. On the evidence the card otherwise has, that is identical
     * to an agent that has silently died — and catching exactly that is what
     * this dashboard is for.
     */
    #[tokio::test]
    async fn a_quiet_transcript_with_a_live_subagent_reads_as_delegating() {
        let (root, file) = projects();
        let dir = file.parent().unwrap().to_path_buf();
        let mut tail = TranscriptTail::new(SESSION, root.path());
        append(&file, said("go").as_bytes());
        let first = tail.read_next().await;
        assert_eq!(first.patch.delegating, Some(false));
        let own_activity = first.patch.last_activity_at.expect("own activity");

        // The subagent writes; this transcript does not grow by a byte.
        let sub_at = own_activity + 60_000;
        subagent(&dir, SESSION, "agent-aaa.jsonl", sub_at);
        let quiet = tail.read_next().await;
        assert!(quiet.events.is_empty());
        assert_eq!(quiet.patch.delegating, Some(true));
        // The clock follows the only thing still moving.
        assert_eq!(quiet.patch.last_activity_at, Some(sub_at));
    }

    #[tokio::test]
    async fn a_subagent_older_than_this_agents_own_work_is_not_delegation() {
        let (root, file) = projects();
        let dir = file.parent().unwrap().to_path_buf();
        let mut tail = TranscriptTail::new(SESSION, root.path());
        append(&file, said("go").as_bytes());
        let first = tail.read_next().await;
        let own = first.patch.last_activity_at.unwrap();

        subagent(&dir, SESSION, "agent-aaa.jsonl", own - 60_000);
        let out = tail.read_next().await;
        assert_eq!(out.patch.delegating, Some(false));
        assert_eq!(out.patch.last_activity_at, None);
    }

    /* ---- one-shot state readers ---- */

    #[tokio::test]
    async fn reads_the_permission_mode_the_session_reports_now() {
        let (root, file) = projects();
        let mut body = String::new();
        body.push_str(&json!({ "type": "permission-mode", "permissionMode": "plan" }).to_string());
        body.push('\n');
        body.push_str(&said("work"));
        body.push_str(&json!({ "type": "permission-mode", "permissionMode": "auto" }).to_string());
        body.push('\n');
        fs::write(&file, body).unwrap();
        assert_eq!(read_permission_mode_in(SESSION, root.path()).await.as_deref(), Some("auto"));
    }

    #[tokio::test]
    async fn the_mode_reader_scans_only_the_tail_and_skips_the_torn_head() {
        let (root, file) = projects();
        let mut body = json!({ "type": "permission-mode", "permissionMode": "plan" }).to_string();
        body.push('\n');
        // Push it out of the 128 KB window.
        for _ in 0..3000 {
            body.push_str(&said(&"z".repeat(100)));
        }
        fs::write(&file, &body).unwrap();
        assert!(body.len() as u64 > STATE_TAIL_BYTES);
        assert_eq!(read_permission_mode_in(SESSION, root.path()).await, None);
    }

    #[tokio::test]
    async fn reads_the_goal_the_session_reports_now() {
        let (root, file) = projects();
        let mut body = goal_line(json!({ "met": false, "sentinel": true, "condition": "ship it" }), AT);
        body.push('\n');
        body.push_str(&goal_line(json!({ "met": true, "condition": "ship it" }), AT));
        body.push('\n');
        // A later non-goal record must not hide the goal.
        body.push_str(&said("more work"));
        fs::write(&file, body).unwrap();
        let goal = read_goal_in(SESSION, root.path()).await.expect("goal");
        assert!(goal.met);
        assert_eq!(goal.fresh, None);
    }

    #[tokio::test]
    async fn the_state_readers_report_nothing_for_a_missing_transcript() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(read_permission_mode_in("nobody", root.path()).await, None);
        assert!(read_goal_in("nobody", root.path()).await.is_none());
    }

    /* ---- the decoder, directly ---- */

    #[test]
    fn the_decoder_holds_back_only_the_incomplete_tail() {
        let mut d = Utf8Decoder::default();
        let bytes = "a检b".as_bytes();
        assert_eq!(d.write(&bytes[..2]), "a");
        assert_eq!(d.write(&bytes[2..3]), "");
        assert_eq!(d.write(&bytes[3..]), "检b");
        // Bytes that can never be valid are replaced, not held forever.
        assert_eq!(d.write(&[0xff, b'x']), "\u{FFFD}x");
    }
}

#[cfg(test)]
mod prompt_tests {
    use super::*;
    use serde_json::json;

    /* ---- INV-16: an answer names only what the transcript named ---- */

    fn ask(questions: Value) -> Value {
        json!({ "questions": questions })
    }

    /// The whole reason the chat window may draw labelled buttons at all: the
    /// options are *read*, not inferred from the terminal.
    #[test]
    fn inv16_reads_the_options_an_ask_user_question_states() {
        let prompt = pending_prompt(
            "AskUserQuestion",
            Some(&ask(json!([{
                "question": "Which migration should run first?",
                "multiSelect": false,
                "options": [
                    { "label": "Backfill the index", "description": "Slower, but safe." },
                    { "label": "Swap the table" },
                ],
            }]))),
        );
        assert_eq!(prompt.question.as_deref(), Some("Which migration should run first?"));
        assert_eq!(prompt.options.len(), 2);
        assert_eq!(prompt.options[0].label, "Backfill the index");
        assert_eq!(prompt.options[0].description.as_deref(), Some("Slower, but safe."));
        // Absent rather than invented: the second option carries no description.
        assert_eq!(prompt.options[1].description, None);
        assert_eq!(prompt.multi_select, None);
        assert_eq!(prompt.more_questions, None);
    }

    /// The picker asks one at a time, so one answer does not finish the call.
    /// Saying how many remain is honest; implying it is over is not.
    #[test]
    fn inv16_counts_the_questions_still_behind_the_first() {
        let prompt = pending_prompt(
            "AskUserQuestion",
            Some(&ask(json!([
                { "question": "First?", "options": [{ "label": "a" }] },
                { "question": "Second?", "options": [{ "label": "b" }] },
                { "question": "Third?", "options": [{ "label": "c" }] },
            ]))),
        );
        assert_eq!(prompt.question.as_deref(), Some("First?"));
        assert_eq!(prompt.more_questions, Some(2));
    }

    /// A digit cannot finish a multi-select, so the flag has to travel: the
    /// interface offers keys there instead of one-click answers.
    #[test]
    fn inv16_carries_multi_select_so_one_digit_is_not_offered_as_the_answer() {
        let prompt = pending_prompt(
            "AskUserQuestion",
            Some(&ask(json!([{
                "question": "Which of these?",
                "multiSelect": true,
                "options": [{ "label": "a" }, { "label": "b" }],
            }]))),
        );
        assert_eq!(prompt.multi_select, Some(true));
    }

    /// Claude Code writes the plan but composes the approval choices at the
    /// terminal, so this is the case where the app must show and not name.
    #[test]
    fn inv16_takes_the_plan_from_exit_plan_mode_and_invents_no_choices() {
        let prompt =
            pending_prompt("ExitPlanMode", Some(&json!({ "plan": "## Steps\n1. Do the thing" })));
        assert!(prompt.options.is_empty(), "named choices nothing wrote down");
        assert_eq!(prompt.detail.as_deref(), Some("## Steps\n1. Do the thing"));
    }

    /// A permission request writes the tool and its input, never the numbered
    /// list the dialog will draw.
    #[test]
    fn inv16_describes_a_permission_request_without_naming_its_options() {
        let prompt = pending_prompt(
            "Bash",
            Some(&json!({ "command": "rm -rf build", "description": "Clear the build tree" })),
        );
        assert!(prompt.options.is_empty(), "named choices nothing wrote down");
        assert_eq!(prompt.detail.as_deref(), Some("Clear the build tree"));
        assert_eq!(prompt.question, None);
    }

    /// A malformed or empty payload must degrade to "something is open" rather
    /// than to a confident empty question (INV-5, INV-11).
    #[test]
    fn inv16_says_nothing_it_cannot_read() {
        let prompt = pending_prompt("AskUserQuestion", Some(&json!({})));
        assert_eq!(prompt.question, None);
        assert!(prompt.options.is_empty());
        assert_eq!(prompt.tool, "AskUserQuestion");
    }

    /* ---- open and closed calls ---- */

    fn tail_with(lines: &[&str]) -> TranscriptTail {
        let mut tail = TranscriptTail::new("s", std::env::temp_dir());
        let mut n = 0;
        let mut seq = move || {
            n += 1;
            format!("e{n}")
        };
        let result = parse_lines(lines, &mut seq);
        tail.track_calls(&result);
        tail
    }

    fn call(id: &str, name: &str, input: Value) -> String {
        json!({
            "type": "assistant",
            "timestamp": "2026-08-14T00:57:52.725Z",
            "message": { "content": [
                { "type": "tool_use", "id": id, "name": name, "input": input },
            ] },
        })
        .to_string()
    }

    fn answer_for(id: &str) -> String {
        json!({
            "type": "user",
            "timestamp": "2026-08-14T00:58:52.725Z",
            "message": { "content": [{ "type": "tool_result", "tool_use_id": id }] },
        })
        .to_string()
    }

    #[test]
    fn inv16_holds_a_question_open_until_its_result_arrives() {
        let question = call("t1", "AskUserQuestion", json!({ "questions": [
            { "question": "Go ahead?", "options": [{ "label": "Yes" }] },
        ] }));
        let tail = tail_with(&[&question]);
        assert_eq!(tail.pending_prompt().and_then(|p| p.question.as_deref()), Some("Go ahead?"));

        let answered = tail_with(&[&question, &answer_for("t1")]);
        assert!(answered.pending_prompt().is_none(), "kept a question that was answered");
    }

    /// A dialog raised while another was open is the one on screen.
    #[test]
    fn inv16_reports_the_newest_open_call() {
        let first = call("t1", "Bash", json!({ "description": "older" }));
        let second = call("t2", "Bash", json!({ "description": "newer" }));
        let tail = tail_with(&[&first, &second]);
        assert_eq!(tail.pending_prompt().and_then(|p| p.detail.as_deref()), Some("newer"));
    }

    /// A subagent's question is asked of the subagent, and answering it into
    /// this agent's prompt would type into the wrong session entirely.
    #[test]
    fn inv16_ignores_a_call_from_a_sidechain() {
        let call = json!({ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "description": "d" } });
        let line = json!({
            "type": "assistant",
            "timestamp": "2026-08-14T00:57:52.725Z",
            "isSidechain": true,
            "message": { "content": [call] },
        })
        .to_string();
        let tail = tail_with(&[&line]);
        assert!(tail.pending_prompt().is_none(), "offered to answer a delegate's question");
    }

    /// Nothing open is the ordinary state, and it must read as nothing rather
    /// than as the last question all over again.
    #[test]
    fn inv16_reports_nothing_when_every_call_has_been_answered() {
        let a = call("t1", "Bash", json!({ "description": "one" }));
        let b = call("t2", "Bash", json!({ "description": "two" }));
        let tail = tail_with(&[&a, &b, &answer_for("t1"), &answer_for("t2")]);
        assert!(tail.pending_prompt().is_none());
    }
}
