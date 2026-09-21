//! Per-session context-window usage and cost, read from the files the
//! statusLine bridge writes.
//!
//! `tokens` on a card is output tokens only, accumulated from a capped
//! transcript tail — the app has said so since INV-11 caught it being shown as
//! spend, and `ARCHITECTURE.md` lists it as a fragility. The honest numbers
//! exist: Claude Code hands its statusLine command a `context_window` with a
//! real denominator (`context_window_size`) and a `cost.total_cost_usd`, per
//! `session_id`, on every footer render. The bridge spills those to one file
//! per session under `~/.claude/agent-commander/sessions/`, and this reads them.
//!
//! The same rules as `limits.rs`, in miniature. The file is `stat`-ed before it
//! is read and opened only when its mtime moved (INV-4: this runs inside the
//! enrichment pass, once per Claude agent per tick, and a `stat` is what that
//! can afford). A read that fails or parses to junk keeps the last good value,
//! because the bridge's `rename(2)` makes a transient miss ordinary and a card
//! that blanked for one tick would assert an absence nobody observed (INV-5,
//! INV-11). There is no watcher: the pass is already the cadence.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use crate::types::SessionUsage;

/// Where the bridge writes one file per session. Spelled out in full so it is
/// greppable from the `.mjs` side, which has to hold the identical path.
pub fn usage_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("agent-commander")
        .join("sessions")
}

/// A session id that can be a file name. The bridge refuses anything else, and
/// so does this, because the id came out of a session file this app did not
/// write and a `..` in it would read somewhere else entirely.
fn safe_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !session_id.starts_with('.')
}

fn finite(value: Option<&serde_json::Value>) -> Option<f64> {
    value.and_then(serde_json::Value::as_f64).filter(|n| n.is_finite())
}

/// The bridge's document, or nothing for anything that is not one.
///
/// `at` is mandatory: a reading with no time is not a reading this app can
/// caption, and every figure here is captioned with when it was read (INV-11).
pub fn parse_usage(text: &str) -> Option<SessionUsage> {
    let doc: serde_json::Value = serde_json::from_str(text).ok()?;
    let at = doc.get("at")?.as_i64()?;
    let usage = SessionUsage {
        context_pct: finite(doc.get("contextPct")).map(|p| p.clamp(0.0, 100.0)),
        context_size: doc.get("contextSize").and_then(serde_json::Value::as_i64),
        cost_usd: finite(doc.get("costUsd")).filter(|c| *c >= 0.0),
        at,
    };
    (usage.context_pct.is_some() || usage.cost_usd.is_some()).then_some(usage)
}

/// Reads the per-session files, remembering each one's mtime and last good value.
pub struct UsageReader {
    dir: PathBuf,
    cache: Mutex<HashMap<String, (SystemTime, SessionUsage)>>,
}

impl UsageReader {
    pub fn new() -> Self {
        Self::in_dir(usage_dir())
    }

    pub fn in_dir(dir: PathBuf) -> Self {
        Self { dir, cache: Mutex::new(HashMap::new()) }
    }

    fn file_of(&self, session_id: &str) -> Option<PathBuf> {
        safe_id(session_id).then(|| self.dir.join(format!("{session_id}.json")))
    }

    /// The session's latest reading, or the last good one, or nothing.
    pub fn read(&self, session_id: &str) -> Option<SessionUsage> {
        let file = self.file_of(session_id)?;
        let mut cache = self.cache.lock().unwrap();
        let known = cache.get(session_id).cloned();
        let Ok(mtime) = std::fs::metadata(&file).and_then(|m| m.modified()) else {
            // Missing or unreadable: the last good reading stands (INV-5).
            return known.map(|(_, usage)| usage);
        };
        if let Some((seen, usage)) = &known {
            if *seen == mtime {
                return Some(usage.clone());
            }
        }
        match read_fresh(&file) {
            Some(usage) => {
                cache.insert(session_id.to_string(), (mtime, usage.clone()));
                Some(usage)
            }
            // Torn write or junk: keep what we had, same reasoning.
            None => known.map(|(_, usage)| usage),
        }
    }

    /// Forget sessions that are gone, so the cache is bounded by the fleet.
    pub fn retain(&self, live: &[String]) {
        self.cache.lock().unwrap().retain(|id, _| live.iter().any(|l| l == id));
    }
}

impl Default for UsageReader {
    fn default() -> Self {
        Self::new()
    }
}

fn read_fresh(file: &Path) -> Option<SessionUsage> {
    std::fs::read_to_string(file).ok().and_then(|text| parse_usage(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, id: &str, text: &str) {
        std::fs::write(dir.join(format!("{id}.json")), text).unwrap();
    }

    #[test]
    fn inv11_a_reading_needs_a_time_and_at_least_one_figure() {
        assert!(parse_usage(r#"{"contextPct": 42}"#).is_none(), "no time to caption it with");
        assert!(parse_usage(r#"{"at": 1}"#).is_none(), "nothing to show");
        let both = parse_usage(r#"{"at": 5, "contextPct": 42.5, "contextSize": 200000, "costUsd": 1.25}"#)
            .unwrap();
        assert_eq!(both.context_pct, Some(42.5));
        assert_eq!(both.context_size, Some(200_000));
        assert_eq!(both.cost_usd, Some(1.25));
        assert_eq!(both.at, 5);
        // A figure out of range is clamped, a nonsensical one dropped.
        let odd = parse_usage(r#"{"at": 5, "contextPct": 103, "costUsd": -2}"#).unwrap();
        assert_eq!(odd.context_pct, Some(100.0));
        assert_eq!(odd.cost_usd, None);
        assert!(parse_usage("not json").is_none());
    }

    #[test]
    fn inv4_the_file_is_stated_and_only_reread_when_it_moved() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "s1", r#"{"at": 1, "contextPct": 10}"#);
        let reader = UsageReader::in_dir(dir.path().to_path_buf());
        assert_eq!(reader.read("s1").unwrap().context_pct, Some(10.0));
        // Same mtime: served from the cache, whatever the bytes now say.
        // (Written through the cache's back so the mtime does not move — a
        // rename in the same second on a coarse filesystem looks like this.)
        let seen = std::fs::metadata(dir.path().join("s1.json")).unwrap().modified().unwrap();
        reader.cache.lock().unwrap().get_mut("s1").unwrap().0 = seen;
        assert_eq!(reader.read("s1").unwrap().context_pct, Some(10.0));
        // A moved mtime is read again.
        write(dir.path(), "s1", r#"{"at": 2, "contextPct": 55}"#);
        let later = seen + std::time::Duration::from_secs(5);
        std::fs::File::open(dir.path().join("s1.json")).unwrap().set_modified(later).unwrap();
        assert_eq!(reader.read("s1").unwrap().context_pct, Some(55.0));
    }

    #[test]
    fn inv5_a_missing_or_torn_file_keeps_the_last_good_reading() {
        let dir = tempfile::tempdir().unwrap();
        let reader = UsageReader::in_dir(dir.path().to_path_buf());
        assert!(reader.read("s1").is_none(), "nothing ever written is nothing");
        write(dir.path(), "s1", r#"{"at": 1, "costUsd": 0.5}"#);
        assert_eq!(reader.read("s1").unwrap().cost_usd, Some(0.5));
        let later = SystemTime::now() + std::time::Duration::from_secs(5);
        write(dir.path(), "s1", r#"{"at": 2, "cos"#);
        std::fs::File::open(dir.path().join("s1.json")).unwrap().set_modified(later).unwrap();
        assert_eq!(reader.read("s1").unwrap().cost_usd, Some(0.5), "junk keeps the last value");
        std::fs::remove_file(dir.path().join("s1.json")).unwrap();
        assert_eq!(reader.read("s1").unwrap().cost_usd, Some(0.5), "so does a vanished file");
        reader.retain(&[]);
        assert!(reader.read("s1").is_none(), "until the session itself is gone");
    }

    #[test]
    fn inv9_a_session_id_that_is_not_a_file_name_reads_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let reader = UsageReader::in_dir(dir.path().to_path_buf());
        for id in ["../token", "a/b", "", ".hidden", "tmux:term-1"] {
            assert!(reader.read(id).is_none(), "{id:?} must not become a path");
        }
    }
}
