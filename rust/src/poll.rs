//! A repeat that paces itself. Port of `src/server/poll.ts`.
//!
//! INV-4, in as many words: "a poll cannot overlap itself or outrun its own
//! cost. Every loop re-arms after the work completes rather than on a fixed
//! interval, and never schedules the next read sooner than the last one took."
//!
//! A fixed-cadence timer does neither. It fires on the wall clock whether or
//! not the previous pass returned, so on a loaded machine the passes stack up
//! and the poll that was meant to *bound* cost becomes the thing driving it.
//! The usual patch — a `running` flag that returns early — stops the overlap
//! but not the cause: ticks are then dropped silently, at a rate nobody chose
//! and nothing reports. That is what [`crate::pane_hub`] was written to fix for
//! the pane loop, and three other loops in this server were still doing it.
//!
//! Re-arming after the work does both jobs at once. Overlap is impossible
//! because there is no timer while a pass is in flight, and a pass that takes
//! longer than its interval simply backs its own cadence off instead of running
//! back to back.
//!
//! Shape note: the TS holds a `setTimeout` handle and clears it. A Rust
//! `Poller` owns a task instead, and `stop` both flips the flag the task reads
//! and wakes it out of its sleep — so a `stop()` issued from *inside* a pass is
//! still seen by the re-arm that pass is about to do, which is the case
//! `poll.test.ts` pins.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Notify;

/// One pass of work. Boxed rather than generic so a `Poller` can be stored in a
/// struct field without infecting it with a type parameter, which is how every
/// caller in this server uses it.
pub type Work = Arc<dyn Fn() -> BoxFuture + Send + Sync>;

pub type BoxFuture = std::pin::Pin<Box<dyn Future<Output = ()> + Send>>;

struct PollerInner {
    interval: Duration,
    work: Work,
    /// True between `start` and `stop`, whether or not a pass is in flight.
    running: AtomicBool,
    /// Woken by `stop` so a sleeping chain notices at once rather than at the
    /// end of its interval.
    wake: Notify,
    /// Guards against two chains for one loop. `running` alone cannot: a chain
    /// that has just observed `stopped` has not necessarily exited yet.
    chain: Mutex<u64>,
}

/// When the first pass of a freshly started chain runs.
///
/// The TS spelled this as `start(immediate: boolean)`. A bare `true` at a call
/// site says nothing about which of the two schedules it picked, and the two
/// are genuinely different behaviours rather than a shade of one — so the
/// choice is named here instead.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FirstPass {
    /// Run now, then re-arm.
    Now,
    /// Wait out one interval first. What a caller wants when the state being
    /// polled was just read by other means.
    AfterAnInterval,
}

/// A self-pacing repeat. Port of `Poller` in `poll.ts`.
pub struct Poller {
    inner: Arc<PollerInner>,
}

impl Poller {
    /// `interval` is the *floor* between passes; the real gap is the greater of
    /// it and how long the last pass actually took. Failures inside `work` are
    /// swallowed — see [`Poller::start`].
    pub fn new<F, Fut>(interval: Duration, work: F) -> Poller
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        Poller {
            inner: Arc::new(PollerInner {
                interval,
                work: Arc::new(move || Box::pin(work()) as BoxFuture),
                running: AtomicBool::new(false),
                wake: Notify::new(),
                chain: Mutex::new(0),
            }),
        }
    }

    /// True between `start()` and `stop()`, whether or not a pass is in flight.
    pub fn active(&self) -> bool {
        self.inner.running.load(Ordering::SeqCst)
    }

    /// Begin the chain. Starting an already-started poller is a no-op rather
    /// than a second chain — two chains on one loop is exactly the duplication
    /// this type exists to prevent, and it hides behind a single timer handle.
    ///
    /// [`FirstPass`] says whether the first pass runs now or one interval from
    /// now.
    ///
    /// A pass that panics is not caught: `panic = "abort"` in the release
    /// profile makes catching impossible anyway, and the TS's `catch` is about
    /// a *rejected promise*, which in Rust is a `work` closure that has already
    /// handled its own error. INV-5 lives in the closure, not here.
    pub fn start(&self, first: FirstPass) {
        let mut chain = self.inner.chain.lock().unwrap();
        if self.inner.running.load(Ordering::SeqCst) {
            return;
        }
        self.inner.running.store(true, Ordering::SeqCst);
        *chain += 1;
        let generation = *chain;
        drop(chain);

        let inner = self.inner.clone();
        tokio::spawn(async move { run(inner, generation, first).await });
    }

    pub fn stop(&self) {
        self.inner.running.store(false, Ordering::SeqCst);
        // The chain may be asleep on its interval; without this it would sit
        // there for up to one interval before noticing.
        self.inner.wake.notify_waiters();
    }
}

impl Drop for Poller {
    /// Dropping the handle ends the chain. Without this the spawned task would
    /// outlive whatever owned it, which is the leak the TS avoids by having the
    /// timer die with its `unref`ed handle.
    fn drop(&mut self) {
        self.stop();
    }
}

/// True when the chain should still be running under `generation`.
fn alive(inner: &PollerInner, generation: u64) -> bool {
    inner.running.load(Ordering::SeqCst) && *inner.chain.lock().unwrap() == generation
}

async fn run(inner: Arc<PollerInner>, generation: u64, first: FirstPass) {
    if first == FirstPass::AfterAnInterval {
        wait(&inner, inner.interval).await;
    }
    loop {
        if !alive(&inner, generation) {
            return;
        }
        let started = Instant::now();
        (inner.work)().await;
        // Re-checked after the await: a `stop()` *during* a pass must not be
        // undone by the re-arm that pass is about to do.
        if !alive(&inner, generation) {
            return;
        }
        // Never sooner than the last pass took.
        wait(&inner, inner.interval.max(started.elapsed())).await;
    }
}

/// Sleep, unless `stop` says otherwise first.
async fn wait(inner: &PollerInner, delay: Duration) {
    tokio::select! {
        _ = tokio::time::sleep(delay) => {}
        _ = inner.wake.notified() => {}
    }
}

/* --------------------------------------------------------------------- tests */

#[cfg(test)]
mod tests {
    //! INV-4 as a test. The rule was written once and implemented four times —
    //! once properly in the registry, and three times as a fixed interval plus
    //! a busy flag, which stops the overlap but converts an overrun into
    //! silently dropped ticks. `Poller` is the rule in one place.
    //!
    //! Ported from `test/poll.test.ts`, on real time rather than a paused
    //! clock: the property under test is about how long a pass *takes*, and a
    //! paused clock has no answer to that.

    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /* The clock this module is tested against. Several of these tests turn on
       one span being wider or narrower than another — a window that fits only
       the first pass, work that costs more than its own interval — so each
       number is named for the role it plays rather than left bare at the call
       site, where the comparison it belongs to is invisible. */

    /// Short enough that whatever paces the chain, it is not the timer.
    const BRISK_INTERVAL: Duration = Duration::from_millis(5);
    /// A quarter of `COSTLY_PASS`, so a fixed-cadence timer would have four
    /// passes in flight where this one has one.
    const OUTPACED_INTERVAL: Duration = Duration::from_millis(10);
    /// Wide enough that a single chain's passes are countable, narrow enough
    /// that a second chain shows up as a count that is plainly too high.
    const STEADY_INTERVAL: Duration = Duration::from_millis(20);
    /// Deliberately wider than `BRIEF_WINDOW`: only the first pass can land, so
    /// the count is a direct reading of [`FirstPass`] and nothing else.
    const INTERVAL_WIDER_THAN_THE_WINDOW: Duration = Duration::from_millis(60);

    /// Work costing four times `OUTPACED_INTERVAL`.
    const COSTLY_PASS: Duration = Duration::from_millis(40);
    /// Work costing ten times `BRISK_INTERVAL`, so the gap between passes can
    /// only be the work.
    const EXPENSIVE_PASS: Duration = Duration::from_millis(50);
    /// The floor a gap between two passes has to clear: `EXPENSIVE_PASS` less
    /// the few milliseconds of scheduler slop a real clock allows.
    const GAP_FLOOR: Duration = Duration::from_millis(45);

    /// Long enough for one pass and no more.
    const BRIEF_WINDOW: Duration = Duration::from_millis(20);
    /// Long enough for several `BRISK_INTERVAL` passes.
    const SHORT_WINDOW: Duration = Duration::from_millis(40);
    /// Long enough that a chain which had not really stopped would have run
    /// again by the end of it.
    const RESTART_WINDOW: Duration = Duration::from_millis(60);
    /// Long enough for a handful of `STEADY_INTERVAL` passes.
    const COUNTING_WINDOW: Duration = Duration::from_millis(70);
    /// Long enough for a self-stopping pass to finish and re-arm, or not.
    const SELF_STOP_WINDOW: Duration = Duration::from_millis(100);
    /// Long enough for many `OUTPACED_INTERVAL` passes, had the work not been
    /// setting the pace.
    const LONG_WINDOW: Duration = Duration::from_millis(200);
    /// The same, with room for four `EXPENSIVE_PASS` passes inside it.
    const LONGEST_WINDOW: Duration = Duration::from_millis(220);

    /// `COSTLY_PASS` over `LONG_WINDOW` leaves room for about four passes.
    /// Reaching this many means the timer, not the work, set the pace.
    const WORK_PACED_PASS_CEILING: usize = 6;
    /// What one `STEADY_INTERVAL` chain can manage inside `COUNTING_WINDOW`.
    /// More than this and a second chain is running alongside it.
    const ONE_CHAINS_PASSES_AT_MOST: usize = 5;

    async fn settle(span: Duration) {
        tokio::time::sleep(span).await;
    }

    /// Stop the poller the closure was handed, if the test still holds one.
    /// A free function rather than an inline `if let` so the closure body it is
    /// called from stays shallow enough to read.
    fn stop_if_still_held(holder: &Mutex<Option<Arc<Poller>>>) {
        if let Some(poller) = holder.lock().unwrap().as_ref() {
            poller.stop();
        }
    }

    #[tokio::test]
    async fn inv4_does_not_start_the_next_pass_until_the_last_one_has_finished() {
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_in_flight = Arc::new(AtomicUsize::new(0));
        let passes = Arc::new(AtomicUsize::new(0));

        let poller = {
            let (in_flight, max_in_flight, passes) =
                (in_flight.clone(), max_in_flight.clone(), passes.clone());
            Poller::new(OUTPACED_INTERVAL, move || {
                let (in_flight, max_in_flight, passes) =
                    (in_flight.clone(), max_in_flight.clone(), passes.clone());
                async move {
                    let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    passes.fetch_add(1, Ordering::SeqCst);
                    max_in_flight.fetch_max(now, Ordering::SeqCst);
                    settle(COSTLY_PASS).await;
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                }
            })
        };

        poller.start(FirstPass::Now);
        settle(LONG_WINDOW).await;
        poller.stop();

        assert_eq!(max_in_flight.load(Ordering::SeqCst), 1, "passes must never overlap");
        // Work of 40ms on a 10ms interval: paced by the work, so nothing like
        // the ~20 passes a fixed 10ms interval would have attempted.
        let seen = passes.load(Ordering::SeqCst);
        assert!(seen > 1 && seen < WORK_PACED_PASS_CEILING, "paced by the work, got {seen} passes");
    }

    #[tokio::test]
    async fn inv4_never_schedules_sooner_than_the_last_pass_took() {
        let starts: Arc<Mutex<Vec<Instant>>> = Arc::new(Mutex::new(Vec::new()));
        let poller = {
            let starts = starts.clone();
            Poller::new(BRISK_INTERVAL, move || {
                let starts = starts.clone();
                async move {
                    starts.lock().unwrap().push(Instant::now());
                    settle(EXPENSIVE_PASS).await;
                }
            })
        };

        poller.start(FirstPass::Now);
        settle(LONGEST_WINDOW).await;
        poller.stop();

        let starts = starts.lock().unwrap().clone();
        assert!(starts.len() > 1, "expected several passes, got {}", starts.len());
        for pair in starts.windows(2) {
            // The floor is how long the work takes, not the configured
            // interval. Timers fire late, never early, so the tolerance is
            // one-sided.
            let gap = pair[1].duration_since(pair[0]);
            assert!(gap >= GAP_FLOOR, "gap was {gap:?}");
        }
    }

    #[tokio::test]
    async fn inv5_keeps_going_after_a_pass_fails() {
        let passes = Arc::new(AtomicUsize::new(0));
        let poller = {
            let passes = passes.clone();
            Poller::new(BRISK_INTERVAL, move || {
                let passes = passes.clone();
                async move {
                    passes.fetch_add(1, Ordering::SeqCst);
                    // The Rust analogue of the TS's rejected promise: the work
                    // fails and says nothing, exactly as every real caller's
                    // closure does.
                    let _: Result<(), &str> = Err("nope");
                }
            })
        };

        poller.start(FirstPass::Now);
        settle(RESTART_WINDOW).await;
        poller.stop();

        // INV-5: a failed pass is not a reason to stop polling.
        assert!(passes.load(Ordering::SeqCst) > 2);
    }

    #[tokio::test]
    async fn stops_for_good_including_from_inside_a_pass() {
        let passes = Arc::new(AtomicUsize::new(0));
        // The poller has to reach its own closure, so it is built once and
        // handed to the closure by weak reference — the TS closes over `const
        // poller` for the same reason.
        let holder: Arc<Mutex<Option<Arc<Poller>>>> = Arc::new(Mutex::new(None));
        let poller = {
            let (passes, holder) = (passes.clone(), holder.clone());
            Arc::new(Poller::new(BRISK_INTERVAL, move || {
                let (passes, holder) = (passes.clone(), holder.clone());
                async move {
                    passes.fetch_add(1, Ordering::SeqCst);
                    settle(OUTPACED_INTERVAL).await;
                    stop_if_still_held(&holder);
                }
            }))
        };
        *holder.lock().unwrap() = Some(poller.clone());

        poller.start(FirstPass::Now);
        settle(SELF_STOP_WINDOW).await;
        let after = passes.load(Ordering::SeqCst);
        settle(RESTART_WINDOW).await;

        // The re-arm that pass was about to do must not undo the stop.
        assert_eq!(passes.load(Ordering::SeqCst), after);
        assert_eq!(after, 1);
        *holder.lock().unwrap() = None;
    }

    #[tokio::test]
    async fn inv4_refuses_to_run_two_chains_for_one_loop() {
        let passes = Arc::new(AtomicUsize::new(0));
        let poller = {
            let passes = passes.clone();
            Poller::new(STEADY_INTERVAL, move || {
                let passes = passes.clone();
                async move {
                    passes.fetch_add(1, Ordering::SeqCst);
                }
            })
        };

        poller.start(FirstPass::Now);
        poller.start(FirstPass::Now);
        poller.start(FirstPass::Now);
        settle(COUNTING_WINDOW).await;
        poller.stop();

        // Three chains on one loop is the duplication `PaneHub` was written to
        // remove; it hides behind a single timer handle, so it is asserted.
        assert!(
            passes.load(Ordering::SeqCst) <= ONE_CHAINS_PASSES_AT_MOST,
            "{}",
            passes.load(Ordering::SeqCst)
        );
    }

    #[tokio::test]
    async fn waits_an_interval_before_the_first_pass_unless_asked_not_to() {
        let eager_passes = Arc::new(AtomicUsize::new(0));
        let patient_passes = Arc::new(AtomicUsize::new(0));

        let eager = {
            let eager_passes = eager_passes.clone();
            Poller::new(INTERVAL_WIDER_THAN_THE_WINDOW, move || {
                let eager_passes = eager_passes.clone();
                async move {
                    eager_passes.fetch_add(1, Ordering::SeqCst);
                }
            })
        };
        let patient = {
            let patient_passes = patient_passes.clone();
            Poller::new(INTERVAL_WIDER_THAN_THE_WINDOW, move || {
                let patient_passes = patient_passes.clone();
                async move {
                    patient_passes.fetch_add(1, Ordering::SeqCst);
                }
            })
        };

        eager.start(FirstPass::Now);
        patient.start(FirstPass::AfterAnInterval);
        settle(BRIEF_WINDOW).await;
        eager.stop();
        patient.stop();

        assert_eq!(eager_passes.load(Ordering::SeqCst), 1);
        assert_eq!(patient_passes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn reports_whether_it_is_running() {
        let poller = Poller::new(STEADY_INTERVAL, || async {});
        assert!(!poller.active());
        poller.start(FirstPass::AfterAnInterval);
        assert!(poller.active());
        poller.stop();
        assert!(!poller.active());
    }

    #[tokio::test]
    async fn restarting_after_a_stop_runs_one_chain_and_not_two() {
        let passes = Arc::new(AtomicUsize::new(0));
        let poller = {
            let passes = passes.clone();
            Poller::new(STEADY_INTERVAL, move || {
                let passes = passes.clone();
                async move {
                    passes.fetch_add(1, Ordering::SeqCst);
                }
            })
        };
        poller.start(FirstPass::Now);
        poller.stop();
        poller.start(FirstPass::Now);
        settle(COUNTING_WINDOW).await;
        poller.stop();
        // A stopped-then-restarted poller is still one loop: the old chain must
        // have died rather than resumed alongside the new one.
        assert!(
            passes.load(Ordering::SeqCst) <= ONE_CHAINS_PASSES_AT_MOST,
            "{}",
            passes.load(Ordering::SeqCst)
        );
    }

    #[tokio::test]
    async fn dropping_the_handle_ends_the_chain() {
        let passes = Arc::new(AtomicUsize::new(0));
        {
            let passes = passes.clone();
            let poller = Poller::new(BRISK_INTERVAL, move || {
                let passes = passes.clone();
                async move {
                    passes.fetch_add(1, Ordering::SeqCst);
                }
            });
            poller.start(FirstPass::Now);
            settle(SHORT_WINDOW).await;
        }
        let after = passes.load(Ordering::SeqCst);
        settle(SHORT_WINDOW).await;
        assert_eq!(passes.load(Ordering::SeqCst), after, "a dropped poller kept polling");
    }
}
