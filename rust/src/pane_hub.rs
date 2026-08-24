//! One poll per pane, however many browser tabs are watching it.
//!
//! Two problems this solves, both of which got worse the more the app was used.
//!
//! The first is duplication. Polling used to hang off the viewer — one timer
//! per WebSocket — so two tabs open on the same agent asked tmux for the same
//! pane twice as often, and a phone and a laptop looking at the same blocked
//! agent doubled the load on the one thing that was already the bottleneck.
//! Subscribers now share a single read and each still computes its own delta,
//! which is what keeps them independent: a tab that attached ten seconds ago
//! and one that attached just now need different frames from the same capture.
//!
//! The second is cadence. A fixed 140ms interval assumes the work fits in the
//! interval. It did not: two tmux round trips measured p50 141ms, so the timer
//! was permanently behind and the busy-guard silently dropped ticks — the
//! terminal ran at a rate nobody chose and nothing reported. The loop here
//! re-arms only *after* a read completes, so it cannot pile up, and it never
//! schedules the next read sooner than the last one took, which caps this app
//! at half the wall clock of whatever tmux can actually deliver.
//!
//! On top of that it backs off when nothing is happening. An agent thinking for
//! two minutes redraws a spinner; an agent waiting at a prompt redraws nothing
//! at all, and polling it seven times a second is pure waste. Any change at all
//! snaps the cadence back to full speed, so the backoff costs latency only on
//! the frame that ends a quiet spell.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(test)]
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use tokio::sync::Notify;

use crate::sources::{PaneApi, PaneSample, Unsubscribe};

/// One pane read: geometry and content, as the adapter returned it.
pub type Sample = PaneSample;

/// Full speed: the cadence the Attach view is designed to look live at.
pub const BASE_MS: u64 = 140;
/// The slowest a pane is polled once it has stopped changing.
pub const MAX_MS: u64 = 1_000;
/// How fast the backoff grows across consecutive unchanged reads.
const IDLE_GROWTH: f64 = 1.5;

/// How long a pane stays at full speed after this app writes to it.
///
/// A write and the redraw it causes are not simultaneous. tmux accepts the
/// paste, the program in the pane then decides to draw something, and a shell
/// or a TUI can take a few tens of milliseconds to get round to it. Without
/// this window the first read after a write usually lands *before* the echo,
/// finds the pane unchanged, and takes that as evidence the pane is quiet — so
/// it backs off, and the read that finally catches the echo is a whole extra
/// interval away. Measured end to end, that turned a ~90ms keystroke into a
/// ~224ms one, which is precisely the sluggishness this file exists to remove.
pub const HOT_MS: u64 = 1_000;

/// How often to look while an echo is expected.
///
/// Not [`BASE_MS`]. The steady cadence is chosen for a pane redrawing on its
/// own, where a seventh of a second is imperceptible; it is far too slow for
/// the one case where the user is watching for a specific character they just
/// typed. Measured through the browser, a keystroke's write finished in ~4ms
/// and the frame carrying its echo arrived at ~146ms — the whole of that gap
/// was this loop waiting out a full `BASE_MS` after the one read that was a
/// fraction too early to see it.
///
/// A read is cheap enough to afford this: ~0.4ms through the control client on
/// a quiet server. On a busy one the duty-cycle floor below — never re-read
/// sooner than the last read took — pulls the real rate back by itself, so this
/// is a ceiling on eagerness rather than a promise of 40Hz.
pub const HOT_INTERVAL_MS: u64 = 25;

/// What a subscriber is told after every read.
///
/// The sample is shared rather than cloned per listener: the read is one read,
/// and a 47-row capture handed to three tabs should be three pointers.
#[derive(Clone)]
pub enum HubEvent {
    Sample(Arc<Sample>),
    /// The read failed. Shared for the same reason, and kept as an
    /// `anyhow::Error` so the reason survives to the error frame.
    Error(Arc<anyhow::Error>),
}

impl HubEvent {
    pub fn sample(&self) -> Option<&Arc<Sample>> {
        match self {
            HubEvent::Sample(s) => Some(s),
            HubEvent::Error(_) => None,
        }
    }
    pub fn error(&self) -> Option<&Arc<anyhow::Error>> {
        match self {
            HubEvent::Error(e) => Some(e),
            HubEvent::Sample(_) => None,
        }
    }
}

pub type Listener = Arc<dyn Fn(&HubEvent) + Send + Sync>;

/// Nothing the viewer draws has changed.
///
/// Only the four numbers the frame carries plus the lines. `alternate` and
/// `pane_dead` are read in the same round trip but are deliberately not part of
/// this: they are answered from the pane's own flags rather than by diffing.
fn unchanged(a: &Sample, b: &Sample) -> bool {
    a.meta == b.meta && a.lines == b.lines
}

struct LoopState {
    stopped: bool,
    /// A tick chain exists — a read is in flight, or one is scheduled.
    ///
    /// Without this, `start` could not tell "no chain yet" from "a chain whose
    /// read is in flight". Every subscriber arriving during a read therefore
    /// began a *second* chain on the same loop, and since nothing cancels the
    /// others they all survived. The pane was then polled once per subscriber —
    /// exactly the duplication this type exists to remove, hidden behind a
    /// `size` of 1. Measured: three viewers on one pane cost three times the
    /// tmux traffic of one, while the hub reported a single loop.
    active: bool,
    interval_ms: u64,
    last: Option<Arc<Sample>>,
    /// While this is in the future, an unchanged read does not slow the loop.
    hot_until: Instant,
    listeners: Vec<(u64, Listener)>,
}

struct PaneLoop {
    pane_id: String,
    panes: Arc<dyn PaneApi>,
    state: Mutex<LoopState>,
    /// The wake signal, which also carries "a wake arrived mid-read".
    ///
    /// A `Notify` permit is exactly the `wakePending` flag the TS keeps by
    /// hand: `notify_one` while the loop is sleeping cancels the sleep, and
    /// `notify_one` while a read is in flight is stored and consumed by the
    /// wait that follows it, so the next read starts at once instead of
    /// waiting its turn.
    wake: Notify,
}

impl PaneLoop {
    fn new(pane_id: &str, panes: Arc<dyn PaneApi>) -> PaneLoop {
        PaneLoop {
            pane_id: pane_id.to_string(),
            panes,
            state: Mutex::new(LoopState {
                stopped: false,
                active: false,
                interval_ms: BASE_MS,
                last: None,
                hot_until: Instant::now(),
                listeners: Vec::new(),
            }),
            wake: Notify::new(),
        }
    }

    /// The most recent read, so a tab that attaches mid-flight paints at once.
    fn last(&self) -> Option<Arc<Sample>> {
        self.state.lock().unwrap().last.clone()
    }

    /// Go back to full speed now, cancelling any backoff already being slept off.
    ///
    /// Lowering the interval alone is not enough: a loop that has backed off to
    /// a second is *already* inside that second, so the next read would still
    /// be up to a second away. That is exactly the wrong moment to be slow —
    /// the two callers are a tab that has just opened the terminal and a user
    /// who has just typed into it, and both are waiting to see something
    /// happen.
    ///
    /// `hot` separates those two. A write is a promise that the pane is about
    /// to change, so for a moment afterwards an unchanged read means "not yet",
    /// not "quiet", and must not slow the loop down. A tab merely attaching
    /// promises nothing, so it gets the fast read it needs and then lets the
    /// pane's own behaviour decide the cadence.
    fn wake(&self, hot: bool) {
        {
            let mut st = self.state.lock().unwrap();
            if st.stopped {
                return;
            }
            st.interval_ms = BASE_MS;
            if hot {
                st.hot_until = Instant::now() + Duration::from_millis(HOT_MS);
            }
        }
        // A read already running is the awkward case, and the common one: reads
        // take tens of milliseconds and the loop is rarely idle, so a write very
        // often completes while one is in flight. That read was started before
        // the write landed, so it cannot contain the echo. The stored permit is
        // what makes the read that follows start immediately instead of waiting
        // out an interval. Measured end to end that was the difference between
        // a 37ms keystroke and a 224ms one, depending purely on where in the
        // cycle the keypress fell.
        self.wake.notify_one();
    }

    fn start(self: &Arc<Self>) {
        {
            let mut st = self.state.lock().unwrap();
            if st.stopped || st.active {
                return;
            }
            st.active = true;
        }
        let me = self.clone();
        tokio::spawn(async move { me.run().await });
    }

    fn stop(&self) {
        let mut st = self.state.lock().unwrap();
        st.stopped = true;
        st.active = false;
        st.listeners.clear();
        drop(st);
        // Wake the sleeping tick so the task notices and ends.
        self.wake.notify_one();
    }

    fn listener_live(&self, id: u64) -> bool {
        self.state.lock().unwrap().listeners.iter().any(|(i, _)| *i == id)
    }

    async fn run(self: Arc<Self>) {
        loop {
            if self.state.lock().unwrap().stopped {
                self.state.lock().unwrap().active = false;
                return;
            }
            let started = Instant::now();

            // `sample` is one tmux round trip and is what the real adapter
            // implements; the trait's default falls back to meta-then-capture
            // for the mocks and for tests that stand in their own pane API,
            // which have no round trip to save.
            let read = self.panes.sample(&self.pane_id).await;

            let event = {
                let mut st = self.state.lock().unwrap();
                match read {
                    Ok(sample) => {
                        let sample = Arc::new(sample);
                        let changed = match st.last.as_ref() {
                            None => true,
                            Some(prev) => !unchanged(prev, &sample),
                        };
                        if changed {
                            st.interval_ms = BASE_MS;
                            // The redraw this loop was hurrying for has
                            // arrived, so stop hurrying. Left running, every
                            // keystroke would buy a further second of fast
                            // polling that nothing is waiting on.
                            st.hot_until = Instant::now();
                        } else if Instant::now() >= st.hot_until {
                            // Unchanged, and nothing has been typed recently
                            // enough to expect a redraw. Only now is "quiet"
                            // the right conclusion.
                            st.interval_ms =
                                MAX_MS.min((st.interval_ms as f64 * IDLE_GROWTH).round() as u64);
                        }
                        st.last = Some(sample.clone());
                        HubEvent::Sample(sample)
                    }
                    // The loop keeps running. Whether a failure is fatal is the
                    // subscriber's call, not this loop's: a pane that has
                    // exited is over, but a tmux that could not be reached for
                    // one tick is not, and treating those the same is what used
                    // to stop a terminal for good over a transient EAGAIN.
                    Err(err) => HubEvent::Error(Arc::new(err)),
                }
            };

            if self.state.lock().unwrap().stopped {
                self.state.lock().unwrap().active = false;
                return;
            }

            // Delivered from a snapshot because a listener cannot be called
            // while the lock it might unsubscribe through is held — but each
            // one is re-checked first, so a listener that tears down a
            // *different* one mid-delivery (the tab that answers a dead pane by
            // releasing its neighbour) still stops that one being called. That
            // is what iterating a live `Set` gives the TS.
            let snapshot: Vec<(u64, Listener)> = self.state.lock().unwrap().listeners.clone();
            for (id, listener) in snapshot {
                if !self.listener_live(id) {
                    continue;
                }
                // One subscriber's failure is not the others' problem. A Rust
                // listener has no way to fail except by panicking, and under
                // `panic = "abort"` (the release profile) nothing can catch
                // that — so this holds in dev and test, and listeners are
                // expected not to panic in the first place.
                let _ = std::panic::catch_unwind(AssertUnwindSafe(|| listener(&event)));
            }

            let (delay, done) = {
                let mut st = self.state.lock().unwrap();
                if st.stopped || st.listeners.is_empty() {
                    // The chain ends here; the next `start` may begin a new one.
                    st.active = false;
                    (Duration::ZERO, true)
                } else {
                    // Never start the next read sooner than the last one took.
                    // Under load that is what stops the app adding to the
                    // congestion it is already waiting on. A wake that arrived
                    // mid-read is the one exception, and it is handled by the
                    // stored `Notify` permit below: the pane has just been
                    // written to, the user is watching for the echo, and this
                    // is a single catch-up read rather than a faster steady
                    // state.
                    let elapsed = started.elapsed().as_millis() as u64;
                    // While an echo is outstanding the loop runs at
                    // `HOT_INTERVAL_MS`; the duty-cycle floor still applies, so
                    // a slow tmux slows this down too.
                    let interval = if Instant::now() < st.hot_until {
                        HOT_INTERVAL_MS
                    } else {
                        st.interval_ms
                    };
                    (Duration::from_millis(interval.max(elapsed)), false)
                }
            };
            if done {
                return;
            }

            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = self.wake.notified() => {}
            }
        }
    }
}

struct HubInner {
    panes: Arc<dyn PaneApi>,
    loops: Mutex<HashMap<String, Arc<PaneLoop>>>,
    next_id: AtomicU64,
}

pub struct PaneHub {
    inner: Arc<HubInner>,
}

impl PaneHub {
    pub fn new(panes: Arc<dyn PaneApi>) -> PaneHub {
        PaneHub {
            inner: Arc::new(HubInner {
                panes,
                loops: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(0),
            }),
        }
    }

    /// How many panes are being polled. Read by the tests and the benchmark.
    pub fn size(&self) -> usize {
        self.inner.loops.lock().unwrap().len()
    }

    /// Poll this pane at full speed again, because something just changed it.
    ///
    /// Called when this app writes to a pane. The backoff assumes that a pane
    /// that has not changed in a while will go on not changing, and a keystroke
    /// is precisely the evidence that it is about to — without this, typing
    /// into an agent sitting quietly at its prompt waited out the idle interval
    /// before the character appeared, which is the latency this whole file
    /// exists to remove.
    pub fn wake(&self, pane_id: &str) {
        let loop_ = self.inner.loops.lock().unwrap().get(pane_id).cloned();
        if let Some(loop_) = loop_ {
            loop_.wake(true);
        }
    }

    pub fn subscribe(
        &self,
        pane_id: &str,
        listener: Box<dyn Fn(&HubEvent) + Send + Sync>,
    ) -> Unsubscribe {
        let listener: Listener = Arc::from(listener);
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);

        let loop_ = {
            let mut loops = self.inner.loops.lock().unwrap();
            loops
                .entry(pane_id.to_string())
                .or_insert_with(|| Arc::new(PaneLoop::new(pane_id, self.inner.panes.clone())))
                .clone()
        };
        loop_.state.lock().unwrap().listeners.push((id, listener.clone()));
        loop_.wake(false);

        // A tab joining a pane someone else is already watching gets the last
        // read immediately rather than waiting out the current interval.
        // Deferred onto a task, as the TS defers by a microtask, so the caller
        // holds this unsubscribe handle before its listener can run.
        if let Some(cached) = loop_.last() {
            let listener = listener.clone();
            tokio::spawn(async move { listener(&HubEvent::Sample(cached)) });
        }
        loop_.start();

        let inner = Arc::downgrade(&self.inner);
        let pane_id = pane_id.to_string();
        Box::new(move || {
            let Some(inner) = Weak::upgrade(&inner) else { return };
            let mut loops = inner.loops.lock().unwrap();
            let Some(current) = loops.get(&pane_id).cloned() else { return };
            let empty = {
                let mut st = current.state.lock().unwrap();
                st.listeners.retain(|(i, _)| *i != id);
                st.listeners.is_empty()
            };
            if !empty {
                return;
            }
            // The last watcher left. Drop the cache with the loop: whatever it
            // holds is about to go stale, and a later attach must repaint from
            // a fresh read rather than from whatever was on screen minutes ago.
            current.stop();
            loops.remove(&pane_id);
        })
    }

    pub fn stop(&self) {
        let mut loops = self.inner.loops.lock().unwrap();
        for loop_ in loops.values() {
            loop_.stop();
        }
        loops.clear();
    }
}

/* --------------------------------------------------------------------- tests */

#[cfg(test)]
mod tests {
    //! One poll per pane, whatever the cadence and however many tabs.
    //!
    //! Three properties, each of which was a real cost before:
    //!   - two tabs on one agent asked tmux for the same pane twice as often
    //!   - a fixed interval shorter than the work never kept its own schedule
    //!   - one failed read stopped the terminal for good
    //!
    //! Timers here are real rather than paused: the loop's whole job is to
    //! react to how long a read actually took, and a fake clock cannot express
    //! that.

    use super::*;
    use crate::sources::PaneMeta;
    use async_trait::async_trait;
    use std::sync::atomic::AtomicUsize;

    const META: PaneMeta = PaneMeta {
        cols: 80,
        rows: 3,
        cursor_x: 0,
        cursor_y: 0,
        alternate: false,
        dead: false,
    };

    fn lines(text: &str) -> Sample {
        Sample { meta: META, lines: vec![text.to_string(), "b".into(), "c".into()] }
    }

    /// A pane API whose reads are scripted and counted.
    struct FakePanes {
        reads: AtomicUsize,
        concurrent: AtomicUsize,
        peak: AtomicUsize,
        delay_ms: u64,
        script: Box<dyn Fn(usize) -> Result<Sample, String> + Send + Sync>,
    }

    impl FakePanes {
        fn new() -> Arc<FakePanes> {
            FakePanes::build(0, |_| Ok(lines("a")))
        }
        fn slow(delay_ms: u64) -> Arc<FakePanes> {
            FakePanes::build(delay_ms, |_| Ok(lines("a")))
        }
        fn scripted(f: impl Fn(usize) -> Result<Sample, String> + Send + Sync + 'static) -> Arc<FakePanes> {
            FakePanes::build(0, f)
        }
        fn build(
            delay_ms: u64,
            f: impl Fn(usize) -> Result<Sample, String> + Send + Sync + 'static,
        ) -> Arc<FakePanes> {
            Arc::new(FakePanes {
                reads: AtomicUsize::new(0),
                concurrent: AtomicUsize::new(0),
                peak: AtomicUsize::new(0),
                delay_ms,
                script: Box::new(f),
            })
        }
        fn reads(&self) -> usize {
            self.reads.load(Ordering::Relaxed)
        }
    }

    #[async_trait]
    impl PaneApi for Arc<FakePanes> {
        async fn meta(&self, _pane_id: &str) -> anyhow::Result<PaneMeta> {
            Ok(META)
        }
        async fn capture(&self, _pane_id: &str, _rows: usize) -> anyhow::Result<Vec<String>> {
            Ok(vec!["a".into(), "b".into(), "c".into()])
        }
        async fn sample(&self, _pane_id: &str) -> anyhow::Result<Sample> {
            let n = self.reads.fetch_add(1, Ordering::Relaxed);
            let live = self.concurrent.fetch_add(1, Ordering::Relaxed) + 1;
            self.peak.fetch_max(live, Ordering::Relaxed);
            if self.delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
            }
            self.concurrent.fetch_sub(1, Ordering::Relaxed);
            (self.script)(n).map_err(anyhow::Error::msg)
        }
        async fn paste(&self, _p: &str, _t: &str, _s: bool) -> anyhow::Result<()> {
            Ok(())
        }
        async fn key(&self, _p: &str, _k: &str) -> anyhow::Result<()> {
            Ok(())
        }
    }

    async fn tick(ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }

    fn counter() -> (Arc<AtomicUsize>, Box<dyn Fn(&HubEvent) + Send + Sync>) {
        let n = Arc::new(AtomicUsize::new(0));
        let mine = n.clone();
        (
            n,
            Box::new(move |e: &HubEvent| {
                if e.sample().is_some() {
                    mine.fetch_add(1, Ordering::Relaxed);
                }
            }),
        )
    }

    /* ---------------------------------------- sharing one read between tabs */

    #[tokio::test]
    async fn delivers_every_read_to_every_subscriber() {
        let panes = FakePanes::new();
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let mut counts = Vec::new();
        let mut offs = Vec::new();
        for _ in 0..3 {
            let (n, listener) = counter();
            counts.push(n);
            offs.push(hub.subscribe("%1", listener));
        }
        tick(BASE_MS * 5 / 2).await;
        for off in offs {
            off();
        }
        assert_eq!(hub.size(), 0);
        assert!(panes.reads() >= 2, "{}", panes.reads());
        let seen: Vec<usize> = counts.iter().map(|c| c.load(Ordering::Relaxed)).collect();
        assert_eq!(seen[0], seen[1]);
        assert_eq!(seen[1], seen[2]);
        assert!(seen[0] + 1 >= panes.reads());
    }

    /// The property the whole type exists for, asserted as a *comparison*.
    ///
    /// Checking only that all three subscribers saw the same events stayed true
    /// while the pane was being read three times as often: subscribing during
    /// an in-flight read started a second tick chain, each chain armed its own
    /// timer, and nothing cancelled the others — so three viewers cost three
    /// times the tmux traffic behind a `size` of 1.
    #[tokio::test]
    async fn costs_the_same_tmux_traffic_however_many_subscribers() {
        async fn reads_for(subscribers: usize) -> usize {
            let panes = FakePanes::slow(20);
            let hub = PaneHub::new(Arc::new(panes.clone()));
            let offs: Vec<Unsubscribe> = (0..subscribers)
                .map(|_| hub.subscribe("%1", Box::new(|_: &HubEvent| {})))
                .collect();
            tick(600).await;
            for off in offs {
                off();
            }
            panes.reads()
        }
        let one = reads_for(1).await;
        let three = reads_for(3).await;
        assert!(one > 1, "{one}");
        // Allowance for the extra first read each subscriber legitimately
        // triggers by waking the loop as it attaches — but nothing like a third
        // each.
        assert!(three <= one + 2, "one={one} three={three}");
    }

    #[tokio::test]
    async fn gives_a_tab_that_joins_late_the_last_read_at_once() {
        // Reads are slow here on purpose: it is the only way to show the first
        // frame came from the cache rather than from a read that happened to be
        // quick.
        let panes = FakePanes::slow(80);
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let first = hub.subscribe("%1", Box::new(|_: &HubEvent| {}));
        tick(120).await;

        let seen = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let mine = seen.clone();
        let second = hub.subscribe(
            "%1",
            Box::new(move |e: &HubEvent| {
                if let Some(s) = e.sample() {
                    mine.lock().unwrap().push(s.lines.clone());
                }
            }),
        );
        tick(10).await;
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert_eq!(seen.lock().unwrap()[0], vec!["a", "b", "c"]);
        first();
        second();
    }

    #[tokio::test]
    async fn stops_polling_once_the_last_tab_leaves() {
        let panes = FakePanes::new();
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let off = hub.subscribe("%1", Box::new(|_: &HubEvent| {}));
        tick(BASE_MS * 3 / 2).await;
        let at_stop = panes.reads();
        off();
        tick(BASE_MS * 3).await;
        assert_eq!(panes.reads(), at_stop);
        assert_eq!(hub.size(), 0);
    }

    #[tokio::test]
    async fn does_not_serve_a_stale_capture_to_the_next_attach() {
        let content = Arc::new(Mutex::new("old".to_string()));
        let reader = content.clone();
        let panes = FakePanes::scripted(move |_| Ok(lines(&reader.lock().unwrap())));
        let hub = PaneHub::new(Arc::new(panes.clone()));
        hub.subscribe("%1", Box::new(|_: &HubEvent| {}))();
        tick(20).await;
        *content.lock().unwrap() = "new".to_string();

        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let mine = seen.clone();
        let off = hub.subscribe(
            "%1",
            Box::new(move |e: &HubEvent| {
                if let Some(s) = e.sample() {
                    mine.lock().unwrap().push(s.lines[0].clone());
                }
            }),
        );
        tick(20).await;
        off();
        // Nothing survives a full release: what was on screen when the last tab
        // closed is not what this one should be told is current.
        let seen = seen.lock().unwrap().clone();
        assert!(!seen.is_empty());
        assert!(seen.iter().all(|l| l == "new"), "{seen:?}");
    }

    /* ---------------------------------------------------------- cadence */

    #[tokio::test]
    async fn never_starts_a_read_before_the_previous_one_finished() {
        let panes = FakePanes::slow(60);
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let off = hub.subscribe("%1", Box::new(|_: &HubEvent| {}));
        tick(500).await;
        off();
        // The old fixed-interval + busy-guard pair dropped ticks to achieve
        // this; re-arming after completion means there is nothing to drop.
        assert_eq!(panes.peak.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn backs_off_while_unchanged_and_snaps_back_when_it_moves() {
        let frozen = Arc::new(AtomicBool::new(true));
        let reader = frozen.clone();
        let panes = FakePanes::scripted(move |n| {
            Ok(if reader.load(Ordering::Relaxed) {
                lines("same")
            } else {
                lines(&format!("n{n}"))
            })
        });
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let off = hub.subscribe("%1", Box::new(|_: &HubEvent| {}));

        tick(700).await;
        let idle_reads = panes.reads();
        // Seven reads a second on a pane redrawing nothing is the waste this
        // removes; at BASE_MS it would have been about five in that window.
        assert!(idle_reads < (700 / BASE_MS) as usize, "{idle_reads}");

        // Left alone, the next read is up to a second away — that is the price
        // of the backoff, and it is paid once. What must not happen is paying
        // it after the user types, so `wake` is what the paste and key routes
        // call.
        frozen.store(false, Ordering::Relaxed);
        hub.wake("%1");
        tick(400).await;
        assert!(panes.reads() - idle_reads > 1);
        off();
    }

    #[tokio::test]
    async fn stays_at_full_speed_for_a_moment_after_a_wake() {
        // The echo is not instant. tmux takes the write, and the program in the
        // pane then decides when to redraw — so the first read after a
        // keystroke routinely finds the pane unchanged. Treating that as
        // "quiet" and backing off is what put a whole extra interval between a
        // keypress and seeing it.
        let panes = FakePanes::scripted(|_| Ok(lines("same")));
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let off = hub.subscribe("%1", Box::new(|_: &HubEvent| {}));
        tick(MAX_MS * 3 / 2).await; // let it back off properly
        hub.wake("%1");

        let before = panes.reads();
        tick(BASE_MS * 3).await;
        let during = panes.reads() - before;
        // At BASE_MS this is ~3 reads; with the backoff still applying it was 1.
        assert!(during >= 2, "{during}");
        off();
    }

    #[tokio::test]
    async fn goes_quiet_again_once_the_wake_window_has_passed() {
        let panes = FakePanes::scripted(|_| Ok(lines("same")));
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let off = hub.subscribe("%1", Box::new(|_: &HubEvent| {}));
        hub.wake("%1");
        tick(1_400).await; // past the hot window
        let settled = panes.reads();
        tick(1_200).await;
        // Back to roughly one read a second, not seven — and not 40Hz.
        assert!(panes.reads() - settled <= 3, "{}", panes.reads() - settled);
        off();
    }

    #[tokio::test]
    async fn reads_immediately_when_woken_rather_than_waiting_out_the_backoff() {
        let panes = FakePanes::scripted(|_| Ok(lines("same")));
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let off = hub.subscribe("%1", Box::new(|_: &HubEvent| {}));
        tick(MAX_MS * 3 / 2).await;
        let before = panes.reads();

        // A keystroke has just gone to this pane. The echo must not wait out an
        // interval that was chosen on the evidence that nothing was happening.
        hub.wake("%1");
        tick(20).await;
        assert_eq!(panes.reads(), before + 1);
        off();
    }

    #[tokio::test]
    async fn polls_a_newly_attached_tab_at_full_speed_even_on_a_quiet_pane() {
        let panes = FakePanes::scripted(|_| Ok(lines("same")));
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let first = hub.subscribe("%1", Box::new(|_: &HubEvent| {}));
        tick(MAX_MS).await;
        let before_join = panes.reads();

        let second = hub.subscribe("%1", Box::new(|_: &HubEvent| {}));
        tick(BASE_MS * 2).await;
        // Someone just opened the terminal. Whatever the pane was doing before,
        // they get the fast cadence rather than inheriting a second-long
        // backoff.
        assert!(panes.reads() - before_join >= 1);
        first();
        second();
    }

    /* ------------------------------------------------ a wake mid-read */

    /// The common case, not an edge one: reads take tens of milliseconds and
    /// the loop is rarely idle, so a write very often finishes while a read is
    /// already in flight. That read began before the write landed and cannot
    /// contain the echo, and there is no timer for `wake` to cancel — so
    /// without handling this it did nothing at all and the echo waited for the
    /// next scheduled read. End to end that was a keystroke taking 37ms or
    /// 224ms depending purely on where in the cycle it fell.
    #[tokio::test]
    async fn a_wake_mid_read_starts_the_next_read_immediately() {
        let panes = FakePanes::slow(60);
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let off = hub.subscribe("%1", Box::new(|_: &HubEvent| {}));

        tick(30).await; // a read is now in flight
        hub.wake("%1");
        let before = panes.reads();
        // The in-flight read finishes at ~60ms; the next must follow at once
        // rather than after BASE_MS.
        tick(110).await;
        assert!(panes.reads() > before);
        off();
    }

    /* --------------------------------------- while an echo is expected */

    /// The steady cadence is chosen for a pane redrawing on its own, where a
    /// seventh of a second goes unnoticed. It is the wrong cadence for the
    /// moment a user is watching for the character they just typed: measured
    /// through the browser, the write finished in ~4ms and the frame carrying
    /// its echo arrived at ~146ms, all of it this loop waiting out one full
    /// BASE_MS after a read that was a fraction too early to see it.
    #[tokio::test]
    async fn looks_far_more_often_than_the_steady_cadence() {
        let panes = FakePanes::scripted(|_| Ok(lines("same")));
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let off = hub.subscribe("%1", Box::new(|_: &HubEvent| {}));
        tick(50).await;
        let before = panes.reads();

        hub.wake("%1"); // a keystroke was just written
        tick(BASE_MS).await; // one steady interval's worth of time
        // At BASE_MS this window allows about one read. Hurrying, it is several.
        assert!(panes.reads() - before > 3, "{}", panes.reads() - before);
        off();
    }

    #[tokio::test]
    async fn stops_hurrying_as_soon_as_the_redraw_arrives() {
        let content = Arc::new(Mutex::new("before".to_string()));
        let reader = content.clone();
        let panes = FakePanes::scripted(move |_| Ok(lines(&reader.lock().unwrap())));
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let off = hub.subscribe("%1", Box::new(|_: &HubEvent| {}));
        tick(50).await;

        hub.wake("%1");
        *content.lock().unwrap() = "after".to_string(); // the echo lands on the very next read
        tick(60).await;
        let after_echo = panes.reads();
        tick(BASE_MS).await;
        // Back to the steady cadence rather than 40Hz for the rest of the
        // second: the thing it was hurrying for has been seen.
        assert!(panes.reads() - after_echo <= 3, "{}", panes.reads() - after_echo);
        off();
    }

    /* --------------------------------------------------------- failures */

    #[tokio::test]
    async fn keeps_polling_after_a_failed_read() {
        let panes = FakePanes::scripted(|n| {
            if n == 0 {
                Err("spawn tmux EAGAIN".to_string())
            } else {
                Ok(lines("recovered"))
            }
        });
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let mine = seen.clone();
        let off = hub.subscribe(
            "%1",
            Box::new(move |e: &HubEvent| {
                mine.lock().unwrap().push(match e {
                    HubEvent::Sample(s) => s.lines[0].clone(),
                    HubEvent::Error(err) => err.to_string(),
                });
            }),
        );
        tick(BASE_MS * 3).await;
        off();
        let seen = seen.lock().unwrap().clone();
        assert!(seen[0].contains("EAGAIN"), "{seen:?}");
        // The read after the failure still happened, which is the whole point:
        // a machine briefly out of process slots is not a terminal that has
        // ended.
        assert!(seen.iter().any(|l| l == "recovered"), "{seen:?}");
    }

    #[tokio::test]
    async fn reports_the_error_to_every_subscriber() {
        let panes = FakePanes::scripted(|_| Err("nope".to_string()));
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let a = Arc::new(AtomicUsize::new(0));
        let b = Arc::new(AtomicUsize::new(0));
        let (ca, cb) = (a.clone(), b.clone());
        let off_a = hub.subscribe("%1", Box::new(move |_: &HubEvent| {
            ca.fetch_add(1, Ordering::Relaxed);
        }));
        let off_b = hub.subscribe("%1", Box::new(move |_: &HubEvent| {
            cb.fetch_add(1, Ordering::Relaxed);
        }));
        tick(BASE_MS * 2).await;
        off_a();
        off_b();
        assert!(a.load(Ordering::Relaxed) > 0);
        assert_eq!(a.load(Ordering::Relaxed), b.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn one_loop_per_pane() {
        let panes = FakePanes::new();
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let offs = vec![
            hub.subscribe("%1", Box::new(|_: &HubEvent| {})),
            hub.subscribe("%2", Box::new(|_: &HubEvent| {})),
        ];
        assert_eq!(hub.size(), 2);
        tick(30).await;
        for off in offs {
            off();
        }
        assert_eq!(hub.size(), 0);
    }

    #[tokio::test]
    async fn stop_ends_every_loop() {
        let panes = FakePanes::new();
        let hub = PaneHub::new(Arc::new(panes.clone()));
        let _off = hub.subscribe("%1", Box::new(|_: &HubEvent| {}));
        tick(30).await;
        hub.stop();
        let at_stop = panes.reads();
        tick(BASE_MS * 3).await;
        assert_eq!(panes.reads(), at_stop);
        assert_eq!(hub.size(), 0);
    }

    /* ---------------------------------- adapters without a combined read */

    #[tokio::test]
    async fn falls_back_to_meta_then_capture() {
        // `sample` is one tmux round trip and is what the real adapter
        // implements; the pair is what the mocks and the test doubles offer,
        // and they have no round trip to save.
        struct SplitPanes(Mutex<Vec<&'static str>>);
        #[async_trait]
        impl PaneApi for Arc<SplitPanes> {
            async fn meta(&self, _p: &str) -> anyhow::Result<PaneMeta> {
                self.0.lock().unwrap().push("meta");
                Ok(META)
            }
            async fn capture(&self, _p: &str, _rows: usize) -> anyhow::Result<Vec<String>> {
                self.0.lock().unwrap().push("capture");
                Ok(vec!["x".into()])
            }
            async fn paste(&self, _p: &str, _t: &str, _s: bool) -> anyhow::Result<()> {
                Ok(())
            }
            async fn key(&self, _p: &str, _k: &str) -> anyhow::Result<()> {
                Ok(())
            }
        }
        let api = Arc::new(SplitPanes(Mutex::new(Vec::new())));
        let hub = PaneHub::new(Arc::new(api.clone()));
        let seen = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let mine = seen.clone();
        let off = hub.subscribe(
            "%1",
            Box::new(move |e: &HubEvent| {
                if let Some(s) = e.sample() {
                    mine.lock().unwrap().push(s.lines.clone());
                }
            }),
        );
        tick(30).await;
        off();
        assert_eq!(api.0.lock().unwrap()[..2], ["meta", "capture"]);
        assert_eq!(seen.lock().unwrap()[0], vec!["x"]);
    }
}
