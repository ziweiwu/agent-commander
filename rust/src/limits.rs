//! Account-level quota, read from the file the statusLine bridge writes.
//!
//! Port of `src/server/limits.ts`.
//!
//! The 5-hour and 7-day windows are not in the transcripts — Claude Code hands
//! them to a statusLine command and nowhere else — so the flow is:
//! `scripts/statusline-bridge.mjs` (running inside every live Claude session)
//! writes `~/.claude/agent-commander/rate-limits.json`, and this watches it.
//!
//! `RateLimits.at` is when the *bridge* last wrote, never when we last looked.
//! The UI dims the meters once that timestamp is old, which is the whole
//! mechanism by which a stale reading stays distinguishable from a fresh one
//! (INV-11). Nothing in here may refresh `at` on its own behalf.

use crate::registry::Listeners;
use crate::sources::{LimitsApi, Unsubscribe};
use crate::types::{RateLimits, UsageWindow};
use notify::{RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::task::JoinHandle;

/// `~/.claude/agent-commander/rate-limits.json`.
///
/// The bridge and the watcher must agree on this path forever; `test/limits.test.ts`
/// asserts it against `CACHE_FILE` in the bridge, and there is no equivalent
/// cross-language assertion available here, so the literal is spelled out to be
/// greppable from the `.mjs` side.
pub fn limits_file() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("agent-commander").join("rate-limits.json")
}

/// Filesystem watches fire a burst per write on some platforms, and the bridge
/// itself runs once per statusline render across every live session, so
/// coalesce before doing any reading.
const DEBOUNCE: Duration = Duration::from_millis(200);

/// Backstop poll, and not an optional one.
///
/// macOS silently drops change notifications for writes that land within a few
/// ms of the watch being registered — measured on the Node side at about one
/// run in three, with a second independent watcher on the same directory seeing
/// nothing either. That is exactly our shape: the server starts, and a live
/// Claude session writes immediately. The hazard is in the platform's FSEvents
/// layer rather than in Node, so `notify` inherits it: its macOS backend is
/// FSEvents too, and it additionally coalesces on its own latency window. So
/// the poll is the correctness guarantee and the watch is only the low-latency
/// path on top of it.
///
/// The cost is one `stat` every two seconds on a file of a few hundred bytes,
/// matching the cadence the session list already runs at (INV-4). The file is
/// read only when its mtime has actually moved.
const POLL: Duration = Duration::from_secs(2);

/// Read one window, rejecting anything that is not a real number.
///
/// The TS uses `Number.isFinite`, not `typeof === 'number'`, and the reason
/// carries over: JSON cannot express NaN but it *can* express `1e999`, which in
/// JS parses to Infinity, passes a typeof check, and then renders as an
/// `Infinity%` bar width. Rust's parser rejects that overflow outright, so the
/// document fails earlier and yields the same `None` — but the `is_finite`
/// guard stays, because it is the property we actually depend on and not every
/// path into here is the parser.
fn read_window(v: Option<&serde_json::Value>) -> Option<UsageWindow> {
    let obj = v?.as_object()?;
    let pct = obj.get("pct").and_then(|p| p.as_f64())?;
    if !pct.is_finite() {
        return None;
    }
    let resets_at = obj
        .get("resetsAt")
        .and_then(|r| r.as_f64())
        .filter(|r| r.is_finite())
        .map(|r| r as i64);
    Some(UsageWindow { pct: pct.clamp(0.0, 100.0), resets_at })
}

/// Parse defensively. This file is written by a separate short-lived process, so
/// a torn or hand-edited read must yield `None` rather than propagate an error
/// into the server.
pub fn parse_limits(text: &str) -> Option<RateLimits> {
    let raw: serde_json::Value = serde_json::from_str(text).ok()?;
    let rec = raw.as_object()?;
    // `at` is mandatory and must be a finite number: without it the UI has no
    // way to tell a fresh reading from an hour-old one.
    let at = rec.get("at").and_then(|a| a.as_f64()).filter(|a| a.is_finite())?;
    let five_hour = read_window(rec.get("fiveHour"));
    let seven_day = read_window(rec.get("sevenDay"));
    // A document with a timestamp and no windows is not a reading.
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    Some(RateLimits { at: at as i64, five_hour, seven_day })
}

/// `RateLimits` has no `PartialEq` (it is a wire type), and the TS compared with
/// `JSON.stringify`. Comparing the fields directly is the same test without the
/// allocation, and keeps the "only notify when the reading actually moved" rule
/// honest.
fn same_window(a: Option<&UsageWindow>, b: Option<&UsageWindow>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => x.pct == y.pct && x.resets_at == y.resets_at,
        _ => false,
    }
}

fn same(a: Option<&RateLimits>, b: &RateLimits) -> bool {
    match a {
        None => false,
        Some(x) => {
            x.at == b.at
                && same_window(x.five_hour.as_ref(), b.five_hour.as_ref())
                && same_window(x.seven_day.as_ref(), b.seven_day.as_ref())
        }
    }
}

#[derive(Default)]
struct State {
    limits: Option<RateLimits>,
    /// Cheap gate for the poll path: the file is only opened when this moves.
    mtime: Option<SystemTime>,
    tasks: Vec<JoinHandle<()>>,
    /// The watcher stops watching the moment it is dropped, so it has to live
    /// here rather than inside `start`.
    watcher: Option<notify::RecommendedWatcher>,
}

struct Inner {
    file: PathBuf,
    poll: Duration,
    state: Mutex<State>,
    listeners: Listeners<Option<RateLimits>>,
}

impl Inner {
    /// Read, and tell listeners only when the reading actually moved.
    fn reload(&self) {
        let next = {
            let mut st = self.state.lock().unwrap();
            // Cheap gate: on the poll path this is the only syscall most of
            // the time.
            let Ok(mtime) = std::fs::metadata(&self.file).and_then(|m| m.modified()) else {
                // A failed read leaves the last good value in place. The
                // alternative — blanking on a transient ENOENT during the
                // bridge's rename — would make the meters flicker out several
                // times a second while agents are working.
                return;
            };
            if st.mtime == Some(mtime) {
                return;
            }
            st.mtime = Some(mtime);
            let Ok(text) = std::fs::read_to_string(&self.file) else {
                return;
            };
            let Some(next) = parse_limits(&text) else {
                // Torn write or junk: keep what we had, same reasoning.
                return;
            };
            if same(st.limits.as_ref(), &next) {
                return;
            }
            st.limits = Some(next.clone());
            next
        };
        // Fan out with the lock released: a listener writes to a WebSocket, and
        // holding the state lock across that would let one slow client stall
        // every reload.
        self.listeners.emit(&Some(next));
    }
}

/// Watches the bridge's cache file. The `LimitsApi` the real server runs on.
pub struct FileLimits {
    inner: Arc<Inner>,
}

impl FileLimits {
    /// The shipped configuration: the bridge's path, the 2s backstop poll.
    #[allow(clippy::new_ret_no_self)]
    pub fn new() -> Arc<dyn LimitsApi> {
        Self::with_file(limits_file(), POLL)
    }

    /// Same watcher pointed somewhere else, and optionally polling faster.
    ///
    /// Tests use this so they can assert the poll is doing the work without
    /// waiting two seconds per assertion — and, more importantly, so a test
    /// cannot pass merely because the filesystem watch happened to fire.
    pub fn with_file(file: PathBuf, poll: Duration) -> Arc<FileLimits> {
        Arc::new(FileLimits {
            inner: Arc::new(Inner {
                file,
                poll,
                state: Mutex::new(State::default()),
                listeners: Listeners::new(),
            }),
        })
    }
}

impl LimitsApi for FileLimits {
    fn current(&self) -> Option<RateLimits> {
        self.inner.state.lock().unwrap().limits.clone()
    }

    fn on_change(&self, f: Box<dyn Fn(Option<RateLimits>) + Send + Sync>) -> Unsubscribe {
        self.inner.listeners.add(f)
    }

    fn start(&self) {
        // Synchronous first read, so `current()` is already true by the time
        // `start()` returns — the first HTTP response must not have to race a
        // background task.
        self.inner.reload();

        let mut st = self.inner.state.lock().unwrap();

        // Watch the *directory*, not the file. The bridge writes to a temp file
        // and renames over the target, which swaps the inode — a watch bound to
        // the file goes deaf after the very first update.
        let dir = self
            .inner
            .file
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if res.is_ok() {
                // Unbounded and non-blocking on purpose: this runs on the
                // watcher's own OS thread, and blocking it would back up every
                // other event the platform is trying to deliver.
                let _ = tx.send(());
            }
        });
        if let Ok(mut w) = watcher {
            if w.watch(&dir, RecursiveMode::NonRecursive).is_ok() {
                st.watcher = Some(w);
                let inner = Arc::clone(&self.inner);
                st.tasks.push(tokio::spawn(async move {
                    while rx.recv().await.is_some() {
                        tokio::time::sleep(DEBOUNCE).await;
                        // Swallow the rest of the burst so one write costs one
                        // read, not one read per event the platform emitted.
                        while rx.try_recv().is_ok() {}
                        inner.reload();
                    }
                }));
            }
        }
        // A watch that could not be established (the directory does not exist
        // yet, because the bridge is not installed) is not an error: the poll
        // below picks it up if that changes. It will not start watching later,
        // which only costs latency, never correctness.

        let inner = Arc::clone(&self.inner);
        let poll = self.inner.poll;
        st.tasks.push(tokio::spawn(async move {
            // Re-arms *after* the read completes rather than on a fixed
            // interval (INV-4). A `tokio::time::interval` would queue up missed
            // ticks and fire them back to back on a machine that stalled, which
            // is the failure mode this shape exists to make impossible.
            loop {
                tokio::time::sleep(poll).await;
                inner.reload();
            }
        }));
    }

    fn stop(&self) {
        let mut st = self.inner.state.lock().unwrap();
        for t in st.tasks.drain(..) {
            t.abort();
        }
        st.watcher = None;
        drop(st);
        self.inner.listeners.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Poll rather than sleep a fixed span. The chain under test is watch ->
    /// 200ms debounce -> read, with the backstop poll underneath it, so a
    /// hardcoded wait is how this test would start failing on a busy box for
    /// reasons that have nothing to do with the code.
    async fn wait_for(mut check: impl FnMut() -> bool) {
        let until = std::time::Instant::now() + Duration::from_secs(8);
        while std::time::Instant::now() < until {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("condition not met in time");
    }

    /// Write the way the bridge does: temp file, then rename over the target.
    /// The inode swap is the thing a naive file watch cannot survive.
    fn persist(dir: &Path, file: &Path, body: &str) {
        let tmp = dir.join("rate-limits.json.tmp");
        std::fs::write(&tmp, body).unwrap();
        std::fs::rename(&tmp, file).unwrap();
    }

    #[test]
    fn accepts_a_document_with_one_window() {
        let l = parse_limits(r#"{"at":5,"fiveHour":{"pct":10}}"#).expect("parsed");
        assert_eq!(l.at, 5);
        assert_eq!(l.five_hour.unwrap().pct, 10.0);
        assert!(l.seven_day.is_none());
    }

    #[test]
    fn rejects_a_non_finite_percentage_and_clamps_an_out_of_range_one() {
        // `1e999` is the shape Infinity actually arrives in: JSON has no
        // Infinity literal, but an overflowing exponent produces one.
        assert!(parse_limits(r#"{"at":5,"fiveHour":{"pct":1e999}}"#).is_none());
        assert!(parse_limits(r#"{"at":1e999,"fiveHour":{"pct":10}}"#).is_none());
        assert_eq!(
            parse_limits(r#"{"at":5,"fiveHour":{"pct":103}}"#).unwrap().five_hour.unwrap().pct,
            100.0
        );
        assert_eq!(
            parse_limits(r#"{"at":5,"fiveHour":{"pct":-4}}"#).unwrap().five_hour.unwrap().pct,
            0.0
        );
        let l = parse_limits(r#"{"at":5,"fiveHour":{"pct":10,"resetsAt":1e999}}"#);
        // The window survives; only the unusable reset time is dropped.
        match l {
            Some(l) => assert!(l.five_hour.unwrap().resets_at.is_none()),
            // Rust's parser refuses the overflowing literal outright, which is
            // an acceptable stricter answer: either way no Infinity escapes.
            None => {}
        }
    }

    #[test]
    fn rejects_junk_rather_than_erroring() {
        // A truncated read is the failure the atomic rename exists to prevent;
        // if it happens anyway it must degrade, not take down the server.
        assert!(parse_limits(r#"{"at":5,"fiveHo"#).is_none());
        assert!(parse_limits("null").is_none());
        assert!(parse_limits(r#"{"fiveHour":{"pct":10}}"#).is_none());
        assert!(parse_limits(r#"{"at":5}"#).is_none());
        assert!(parse_limits("").is_none());
        assert!(parse_limits(r#"{"at":"5","fiveHour":{"pct":10}}"#).is_none());
    }

    #[tokio::test]
    async fn reads_the_file_on_start_and_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rate-limits.json");
        std::fs::write(&file, r#"{"at":7,"sevenDay":{"pct":42}}"#).unwrap();
        let w = FileLimits::with_file(file, POLL);
        w.start();
        let got = w.current().expect("a reading");
        assert_eq!(got.at, 7);
        assert_eq!(got.seven_day.unwrap().pct, 42.0);
        w.stop();
    }

    #[tokio::test]
    async fn starts_empty_and_does_not_fail_when_the_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let w = FileLimits::with_file(dir.path().join("nope").join("rate-limits.json"), POLL);
        w.start();
        assert!(w.current().is_none());
        w.stop();
    }

    #[tokio::test]
    async fn notifies_on_a_rename_swapped_write_and_only_when_the_value_moves() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rate-limits.json");
        persist(dir.path(), &file, r#"{"at":1,"fiveHour":{"pct":10}}"#);
        let w = FileLimits::with_file(file.clone(), Duration::from_millis(50));
        w.start();

        let seen = Arc::new(AtomicUsize::new(0));
        let last = Arc::new(Mutex::new(None::<RateLimits>));
        {
            let (seen, last) = (Arc::clone(&seen), Arc::clone(&last));
            // Kept, not dropped: the handle is the subscription's lifetime
            // in name only — `Unsubscribe` is a call, not a guard — but
            // discarding it silently is exactly the mistake the `must_use` on
            // it exists to catch, so say so.
            let _keep = w.on_change(Box::new(move |l| {
                seen.fetch_add(1, Ordering::SeqCst);
                *last.lock().unwrap() = l;
            }));
        }

        persist(dir.path(), &file, r#"{"at":2,"fiveHour":{"pct":20}}"#);
        wait_for(|| seen.load(Ordering::SeqCst) > 0).await;
        assert_eq!(last.lock().unwrap().as_ref().unwrap().at, 2);

        // Same content again: mtime moves, the reading does not, so no second
        // notification reaches the client.
        persist(dir.path(), &file, r#"{"at":2,"fiveHour":{"pct":20}}"#);
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        w.stop();
    }

    /// The poll is the correctness guarantee, not a nicety: macOS drops change
    /// events for writes landing within a few ms of the watch being registered.
    /// Polling fast here means the test cannot be passed by the watch path
    /// alone happening to be lucky.
    #[tokio::test]
    async fn picks_up_a_write_the_directory_watch_never_reported() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rate-limits.json");
        persist(dir.path(), &file, r#"{"at":1,"fiveHour":{"pct":10}}"#);
        let w = FileLimits::with_file(file.clone(), Duration::from_millis(50));
        w.start();
        // Deliberately no listener registered before the write: this asserts
        // the *state* caught up, which only the poll can guarantee.
        persist(dir.path(), &file, r#"{"at":9,"fiveHour":{"pct":90}}"#);
        let w2 = Arc::clone(&w);
        wait_for(move || w2.current().map(|l| l.at) == Some(9)).await;
        w.stop();
    }

    /// A transient ENOENT during the bridge's rename must not blank the meters —
    /// that would make them flicker out several times a second while agents work.
    #[tokio::test]
    async fn keeps_the_last_good_reading_when_the_file_disappears() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rate-limits.json");
        persist(dir.path(), &file, r#"{"at":1,"fiveHour":{"pct":10}}"#);
        let w = FileLimits::with_file(file.clone(), Duration::from_millis(50));
        w.start();
        std::fs::remove_file(&file).unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(w.current().unwrap().at, 1);
        w.stop();
    }

    /// A half-written document must not replace a good one either.
    #[tokio::test]
    async fn keeps_the_last_good_reading_when_the_file_is_torn() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rate-limits.json");
        persist(dir.path(), &file, r#"{"at":1,"fiveHour":{"pct":10}}"#);
        let w = FileLimits::with_file(file.clone(), Duration::from_millis(50));
        w.start();
        std::fs::write(&file, r#"{"at":2,"fiveHo"#).unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(w.current().unwrap().at, 1);
        w.stop();
    }

    /// `at` is the bridge's clock, carried through untouched. If this ever
    /// became "now", the UI could never tell a live meter from a dead one.
    #[tokio::test]
    async fn never_rewrites_the_bridges_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rate-limits.json");
        persist(dir.path(), &file, r#"{"at":1000,"fiveHour":{"pct":10}}"#);
        let w = FileLimits::with_file(file, Duration::from_millis(50));
        w.start();
        assert_eq!(w.current().unwrap().at, 1000);
        w.stop();
    }

    #[tokio::test]
    async fn unsubscribing_stops_delivery() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rate-limits.json");
        persist(dir.path(), &file, r#"{"at":1,"fiveHour":{"pct":10}}"#);
        let w = FileLimits::with_file(file.clone(), Duration::from_millis(50));
        w.start();
        let seen = Arc::new(AtomicUsize::new(0));
        let s = Arc::clone(&seen);
        let off = w.on_change(Box::new(move |_| {
            s.fetch_add(1, Ordering::SeqCst);
        }));
        off();
        persist(dir.path(), &file, r#"{"at":2,"fiveHour":{"pct":20}}"#);
        let w2 = Arc::clone(&w);
        wait_for(move || w2.current().map(|l| l.at) == Some(2)).await;
        assert_eq!(seen.load(Ordering::SeqCst), 0);
        w.stop();
    }
}
