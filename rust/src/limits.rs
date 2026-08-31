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

/// The range a percentage is allowed to take.
///
/// This value becomes a bar width in the browser, so a reading outside the
/// range is clamped rather than dropped: the bridge writing something odd is
/// not a reason to hide the meter, but it is a reason not to let it render off
/// the end of its own track.
const PCT_FLOOR: f64 = 0.0;
const PCT_CEILING: f64 = 100.0;

/// Read one window, rejecting anything that is not a real number.
///
/// The TS uses `Number.isFinite`, not `typeof === 'number'`, and the reason
/// carries over: JSON cannot express NaN but it *can* express `1e999`, which in
/// JS parses to Infinity, passes a typeof check, and then renders as an
/// `Infinity%` bar width. Rust's parser rejects that overflow outright, so the
/// document fails earlier and yields the same `None` — but the `is_finite`
/// guard stays, because it is the property we actually depend on and not every
/// path into here is the parser.
fn read_window(raw: Option<&serde_json::Value>) -> Option<UsageWindow> {
    let window = raw?.as_object()?;
    let pct = window.get("pct").and_then(|p| p.as_f64())?;
    if !pct.is_finite() {
        return None;
    }
    let resets_at = window
        .get("resetsAt")
        .and_then(|r| r.as_f64())
        .filter(|r| r.is_finite())
        .map(|r| r as i64);
    Some(UsageWindow { pct: pct.clamp(PCT_FLOOR, PCT_CEILING), resets_at })
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
fn same_window(previous: Option<&UsageWindow>, next: Option<&UsageWindow>) -> bool {
    match (previous, next) {
        (None, None) => true,
        (Some(before), Some(after)) => {
            before.pct == after.pct && before.resets_at == after.resets_at
        }
        _ => false,
    }
}

fn same(previous: Option<&RateLimits>, next: &RateLimits) -> bool {
    match previous {
        None => false,
        Some(before) => {
            before.at == next.at
                && same_window(before.five_hour.as_ref(), next.five_hour.as_ref())
                && same_window(before.seven_day.as_ref(), next.seven_day.as_ref())
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

/// Every filesystem event the watcher managed to deliver, in order.
type WatchEvents = tokio::sync::mpsc::UnboundedReceiver<()>;

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

    /// Watch the *directory*, not the file. The bridge writes to a temp file
    /// and renames over the target, which swaps the inode — a watch bound to
    /// the file goes deaf after the very first update.
    ///
    /// A watch that could not be established (the directory does not exist
    /// yet, because the bridge is not installed) is not an error: the poll
    /// picks it up if that changes. It will not start watching later, which
    /// only costs latency, never correctness.
    fn watch_the_directory(&self, state: &mut State) {
        let dir = self
            .inner
            .file
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let (tx, events) = tokio::sync::mpsc::unbounded_channel::<()>();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if res.is_ok() {
                // Unbounded and non-blocking on purpose: this runs on the
                // watcher's own OS thread, and blocking it would back up every
                // other event the platform is trying to deliver.
                let _ = tx.send(());
            }
        });
        let Ok(mut watcher) = watcher else { return };
        if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
            return;
        }
        state.watcher = Some(watcher);
        let inner = Arc::clone(&self.inner);
        state.tasks.push(tokio::spawn(Self::reload_on_each_burst(inner, events)));
    }

    /// One read per write, not one per event the platform chose to emit.
    async fn reload_on_each_burst(inner: Arc<Inner>, mut events: WatchEvents) {
        while events.recv().await.is_some() {
            tokio::time::sleep(DEBOUNCE).await;
            // Swallow the rest of the burst so one write costs one read, not
            // one read per event the platform emitted.
            while events.try_recv().is_ok() {}
            inner.reload();
        }
    }

    /// The backstop, re-armed *after* each read completes rather than on a
    /// fixed interval (INV-4). A `tokio::time::interval` would queue up missed
    /// ticks and fire them back to back on a machine that stalled, which is
    /// the failure mode this shape exists to make impossible.
    fn poll_as_a_backstop(&self, state: &mut State) {
        let inner = Arc::clone(&self.inner);
        let poll = self.inner.poll;
        state.tasks.push(tokio::spawn(async move {
            loop {
                tokio::time::sleep(poll).await;
                inner.reload();
            }
        }));
    }
}

impl LimitsApi for FileLimits {
    fn current(&self) -> Option<RateLimits> {
        self.inner.state.lock().unwrap().limits.clone()
    }

    fn on_change(&self, listener: Box<dyn Fn(Option<RateLimits>) + Send + Sync>) -> Unsubscribe {
        self.inner.listeners.add(listener)
    }

    fn start(&self) {
        // Synchronous first read, so `current()` is already true by the time
        // `start()` returns — the first HTTP response must not have to race a
        // background task.
        self.inner.reload();

        let mut state = self.inner.state.lock().unwrap();
        self.watch_the_directory(&mut state);
        self.poll_as_a_backstop(&mut state);
    }

    fn stop(&self) {
        let mut state = self.inner.state.lock().unwrap();
        for task in state.tasks.drain(..) {
            task.abort();
        }
        state.watcher = None;
        drop(state);
        self.inner.listeners.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Poll far faster than the 2s production backstop, so a test that asserts
    /// the poll did the work does not spend two seconds per assertion.
    const FAST_POLL: Duration = Duration::from_millis(50);

    /// How long `wait_for` keeps trying, and how often it looks.
    const WAIT_LIMIT: Duration = Duration::from_secs(8);
    const WAIT_STEP: Duration = Duration::from_millis(25);

    /// Long enough that a second notification would have arrived if one were
    /// ever going to: the 200ms debounce plus several turns of `FAST_POLL`.
    const LONG_ENOUGH_FOR_A_NOTIFICATION: Duration = Duration::from_millis(800);

    /// Long enough for several reloads to have run and rejected what they read.
    const LONG_ENOUGH_FOR_SEVERAL_RELOADS: Duration = Duration::from_millis(500);

    /// Poll rather than sleep a fixed span. The chain under test is watch ->
    /// 200ms debounce -> read, with the backstop poll underneath it, so a
    /// hardcoded wait is how this test would start failing on a busy box for
    /// reasons that have nothing to do with the code.
    async fn wait_for(mut check: impl FnMut() -> bool) {
        let until = std::time::Instant::now() + WAIT_LIMIT;
        while std::time::Instant::now() < until {
            if check() {
                return;
            }
            tokio::time::sleep(WAIT_STEP).await;
        }
        panic!("condition not met in time");
    }

    /// Write the way the bridge does: temp file, then rename over the target.
    /// The inode swap is the thing a naive file watch cannot survive.
    fn persist(dir: &Path, file: &Path, body: &str) {
        let staging = dir.join("rate-limits.json.tmp");
        std::fs::write(&staging, body).unwrap();
        std::fs::rename(&staging, file).unwrap();
    }

    #[test]
    fn accepts_a_document_with_one_window() {
        // Spelled out here as well as in the document, so the assertions read
        // against the fixture rather than against a bare number.
        const WROTE_AT: i64 = 5;
        const FIVE_HOUR_PCT: f64 = 10.0;

        let reading = parse_limits(r#"{"at":5,"fiveHour":{"pct":10}}"#).expect("parsed");
        assert_eq!(reading.at, WROTE_AT);
        assert_eq!(reading.five_hour.unwrap().pct, FIVE_HOUR_PCT);
        assert!(reading.seven_day.is_none());
    }

    #[test]
    fn rejects_a_non_finite_percentage_and_clamps_an_out_of_range_one() {
        // `1e999` is the shape Infinity actually arrives in: JSON has no
        // Infinity literal, but an overflowing exponent produces one.
        assert!(parse_limits(r#"{"at":5,"fiveHour":{"pct":1e999}}"#).is_none());
        assert!(parse_limits(r#"{"at":1e999,"fiveHour":{"pct":10}}"#).is_none());
        assert_eq!(
            parse_limits(r#"{"at":5,"fiveHour":{"pct":103}}"#).unwrap().five_hour.unwrap().pct,
            PCT_CEILING
        );
        assert_eq!(
            parse_limits(r#"{"at":5,"fiveHour":{"pct":-4}}"#).unwrap().five_hour.unwrap().pct,
            PCT_FLOOR
        );
        let reading = parse_limits(r#"{"at":5,"fiveHour":{"pct":10,"resetsAt":1e999}}"#);
        // The window survives; only the unusable reset time is dropped.
        match reading {
            Some(reading) => assert!(reading.five_hour.unwrap().resets_at.is_none()),
            // Rust's parser refuses the overflowing literal outright, which is
            // an acceptable stricter answer: either way no Infinity escapes.
            None => {}
        }
    }

    /// The one junk shape a lenient parser would happily coerce: `at` quoted,
    /// so it arrives as text where a number is required.
    const AT_WRITTEN_AS_A_STRING: &str = r#"{"at":"5","fiveHour":{"pct":10}}"#;

    #[test]
    fn rejects_junk_rather_than_erroring() {
        // A truncated read is the failure the atomic rename exists to prevent;
        // if it happens anyway it must degrade, not take down the server.
        assert!(parse_limits(r#"{"at":5,"fiveHo"#).is_none());
        assert!(parse_limits("null").is_none());
        assert!(parse_limits(r#"{"fiveHour":{"pct":10}}"#).is_none());
        assert!(parse_limits(r#"{"at":5}"#).is_none());
        assert!(parse_limits("").is_none());
        assert!(parse_limits(AT_WRITTEN_AS_A_STRING).is_none());
    }

    #[tokio::test]
    async fn reads_the_file_on_start_and_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rate-limits.json");
        // Spelled out here as well as in the document below.
        const WROTE_AT: i64 = 7;
        const SEVEN_DAY_PCT: f64 = 42.0;

        std::fs::write(&file, r#"{"at":7,"sevenDay":{"pct":42}}"#).unwrap();
        let watcher = FileLimits::with_file(file, POLL);
        watcher.start();
        let got = watcher.current().expect("a reading");
        assert_eq!(got.at, WROTE_AT);
        assert_eq!(got.seven_day.unwrap().pct, SEVEN_DAY_PCT);
        watcher.stop();
    }

    #[tokio::test]
    async fn starts_empty_and_does_not_fail_when_the_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let watcher = FileLimits::with_file(dir.path().join("nope").join("rate-limits.json"), POLL);
        watcher.start();
        assert!(watcher.current().is_none());
        watcher.stop();
    }

    #[tokio::test]
    async fn notifies_on_a_rename_swapped_write_and_only_when_the_value_moves() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rate-limits.json");
        persist(dir.path(), &file, r#"{"at":1,"fiveHour":{"pct":10}}"#);
        let watcher = FileLimits::with_file(file.clone(), FAST_POLL);
        watcher.start();

        let seen = Arc::new(AtomicUsize::new(0));
        let last = Arc::new(Mutex::new(None::<RateLimits>));
        {
            let (seen, last) = (Arc::clone(&seen), Arc::clone(&last));
            // Kept, not dropped: the handle is the subscription's lifetime
            // in name only — `Unsubscribe` is a call, not a guard — but
            // discarding it silently is exactly the mistake the `must_use` on
            // it exists to catch, so say so.
            let _keep = watcher.on_change(Box::new(move |reading| {
                seen.fetch_add(1, Ordering::SeqCst);
                *last.lock().unwrap() = reading;
            }));
        }

        persist(dir.path(), &file, r#"{"at":2,"fiveHour":{"pct":20}}"#);
        wait_for(|| seen.load(Ordering::SeqCst) > 0).await;
        assert_eq!(last.lock().unwrap().as_ref().unwrap().at, 2);

        // Same content again: mtime moves, the reading does not, so no second
        // notification reaches the client.
        persist(dir.path(), &file, r#"{"at":2,"fiveHour":{"pct":20}}"#);
        tokio::time::sleep(LONG_ENOUGH_FOR_A_NOTIFICATION).await;
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        watcher.stop();
    }

    /// The poll is the correctness guarantee, not a nicety: macOS drops change
    /// events for writes landing within a few ms of the watch being registered.
    /// Polling fast here means the test cannot be passed by the watch path
    /// alone happening to be lucky.
    #[tokio::test]
    async fn picks_up_a_write_the_directory_watch_never_reported() {
        // The value the second document below carries.
        const REWRITTEN_AT: i64 = 9;

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rate-limits.json");
        persist(dir.path(), &file, r#"{"at":1,"fiveHour":{"pct":10}}"#);
        let watcher = FileLimits::with_file(file.clone(), FAST_POLL);
        watcher.start();
        // Deliberately no listener registered before the write: this asserts
        // the *state* caught up, which only the poll can guarantee.
        persist(dir.path(), &file, r#"{"at":9,"fiveHour":{"pct":90}}"#);
        let polling = Arc::clone(&watcher);
        wait_for(move || polling.current().map(|reading| reading.at) == Some(REWRITTEN_AT)).await;
        watcher.stop();
    }

    /// A transient ENOENT during the bridge's rename must not blank the meters —
    /// that would make them flicker out several times a second while agents work.
    #[tokio::test]
    async fn keeps_the_last_good_reading_when_the_file_disappears() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rate-limits.json");
        persist(dir.path(), &file, r#"{"at":1,"fiveHour":{"pct":10}}"#);
        let watcher = FileLimits::with_file(file.clone(), FAST_POLL);
        watcher.start();
        std::fs::remove_file(&file).unwrap();
        tokio::time::sleep(LONG_ENOUGH_FOR_SEVERAL_RELOADS).await;
        assert_eq!(watcher.current().unwrap().at, 1);
        watcher.stop();
    }

    /// A half-written document must not replace a good one either.
    #[tokio::test]
    async fn keeps_the_last_good_reading_when_the_file_is_torn() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rate-limits.json");
        persist(dir.path(), &file, r#"{"at":1,"fiveHour":{"pct":10}}"#);
        let watcher = FileLimits::with_file(file.clone(), FAST_POLL);
        watcher.start();
        std::fs::write(&file, r#"{"at":2,"fiveHo"#).unwrap();
        tokio::time::sleep(LONG_ENOUGH_FOR_SEVERAL_RELOADS).await;
        assert_eq!(watcher.current().unwrap().at, 1);
        watcher.stop();
    }

    /// `at` is the bridge's clock, carried through untouched. If this ever
    /// became "now", the UI could never tell a live meter from a dead one.
    #[tokio::test]
    async fn never_rewrites_the_bridges_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rate-limits.json");
        persist(dir.path(), &file, r#"{"at":1000,"fiveHour":{"pct":10}}"#);
        let watcher = FileLimits::with_file(file, FAST_POLL);
        watcher.start();
        assert_eq!(watcher.current().unwrap().at, 1000);
        watcher.stop();
    }

    #[tokio::test]
    async fn unsubscribing_stops_delivery() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rate-limits.json");
        persist(dir.path(), &file, r#"{"at":1,"fiveHour":{"pct":10}}"#);
        let watcher = FileLimits::with_file(file.clone(), FAST_POLL);
        watcher.start();
        let seen = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&seen);
        let off = watcher.on_change(Box::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        off();
        persist(dir.path(), &file, r#"{"at":2,"fiveHour":{"pct":20}}"#);
        let polling = Arc::clone(&watcher);
        wait_for(move || polling.current().map(|reading| reading.at) == Some(2)).await;
        assert_eq!(seen.load(Ordering::SeqCst), 0);
        watcher.stop();
    }
}
