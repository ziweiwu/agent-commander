//! Keeps every fleet card's "what is it doing" line current.
//!
//! Port of `src/server/enrich.ts`.
//!
//! The detail view tails only the agent you have open. Without this, every other
//! card would sit blank — which is the opposite of the point, since the whole
//! value of the list is seeing what agents you are *not* looking at are doing.
//!
//! INV-4: this runs on a slow tick and each read is an incremental byte-offset
//! tail, so the steady-state cost is a few hundred bytes per agent per cycle.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::agent_kinds::has_transcripts;
use crate::sources::{AgentPatch, AgentSource, TailApi};
use crate::types::Agent;

const TICK: Duration = Duration::from_millis(5000);

/// Builds a tail reader for one session, or None when it has no transcript yet.
pub type TailFactory = Arc<dyn Fn(&Agent) -> Option<Box<dyn TailApi>> + Send + Sync>;

pub struct FleetEnricher {
    source: Arc<dyn AgentSource>,
    tail_for: TailFactory,
    interval: Duration,
    tails: Mutex<HashMap<String, Box<dyn TailApi>>>,
    /// One tick at a time. The spawned loop is already serial, but `tick` is
    /// public and a slow filesystem must not let two passes interleave.
    running: AtomicBool,
    task: Mutex<Option<JoinHandle<()>>>,
    /// Whether anyone is looking at this. See [`watch`](Self::watch).
    watched: AtomicBool,
}

impl FleetEnricher {
    pub fn new(source: Arc<dyn AgentSource>, tail_for: TailFactory) -> Arc<Self> {
        Self::with_interval(source, tail_for, TICK)
    }

    pub fn with_interval(
        source: Arc<dyn AgentSource>,
        tail_for: TailFactory,
        interval: Duration,
    ) -> Arc<Self> {
        Arc::new(FleetEnricher {
            source,
            tail_for,
            interval,
            tails: Mutex::new(HashMap::new()),
            running: AtomicBool::new(false),
            task: Mutex::new(None),
            watched: AtomicBool::new(true),
        })
    }

    /// Tick now, then on the interval, until [`stop`](Self::stop).
    pub async fn start(self: &Arc<Self>) {
        self.start_loop().await;
    }

    /*
     * The loop re-arms after the work rather than on a wall clock.
     *
     * INV-4: "a poll cannot overlap itself or outrun its own cost. Every loop
     * re-arms after the work completes rather than on a fixed interval, and
     * never schedules the next read sooner than the last one took." One tick
     * tails every agent's transcript in turn, so its cost is a function of how
     * many agents are running — the one number this app has no say over. A
     * fixed `interval` does not slow down for a fleet large enough to overrun
     * it; it fires anyway and the `running` guard drops the tick silently, at a
     * rate nobody chose and nothing reports. Re-arming after the pass makes
     * overlap impossible by construction and turns an overrun into a cadence
     * that backs itself off.
     */
    async fn start_loop(self: &Arc<Self>) {
        let mut task = self.task.lock().await;
        // Starting an already-started loop is a no-op rather than a second
        // chain — two chains on one loop is exactly the duplication this
        // pacing exists to prevent, and it hides behind one handle.
        if task.is_some() {
            return;
        }
        let me = Arc::clone(self);
        *task = Some(tokio::spawn(async move {
            loop {
                let started = Instant::now();
                me.tick().await;
                tokio::time::sleep(me.interval.max(started.elapsed())).await;
            }
        }));
    }

    async fn stop_loop(&self) {
        if let Some(handle) = self.task.lock().await.take() {
            handle.abort();
        }
    }

    /// Nobody is looking any more: stop tailing.
    ///
    /// INV-4 opens with "nothing polls what nobody is watching", and this loop
    /// was the one place that ignored it: with no browser connected at all it
    /// still tailed every transcript on the machine every five seconds, feeding
    /// cards nobody was going to see. The fleet list itself keeps refreshing —
    /// that is the Registry's job and it is cheap — so what pauses here is only
    /// the per-agent transcript read.
    ///
    /// Already unwatched is a no-op, not a second stop.
    pub async fn unwatch(self: &Arc<Self>) {
        if !self.watched.swap(false, Ordering::SeqCst) {
            return;
        }
        self.stop_loop().await;
    }

    /// Someone is looking again: resume, with a pass right now.
    ///
    /// Immediately rather than one interval from now, because the tab that just
    /// connected is about to paint those cards. The tails themselves are kept
    /// across the pause, so resuming does not re-backfill every conversation.
    pub async fn watch(self: &Arc<Self>) {
        if self.watched.swap(true, Ordering::SeqCst) {
            return;
        }
        self.start_loop().await;
    }

    pub async fn stop(&self) {
        self.stop_loop().await;
        self.tails.lock().await.clear();
    }

    pub async fn tick(&self) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        self.run_once().await;
        self.running.store(false, Ordering::SeqCst);
    }

    async fn run_once(&self) {
        let agents = self.source.list();
        let mut tails = self.tails.lock().await;
        // Drop the tail for anything that has exited, so a session id that comes
        // back gets a fresh reader rather than a stale byte offset.
        tails.retain(|id, _| agents.iter().any(|a| &a.session_id == id));

        let mut changed = false;
        for agent in &agents {
            /*
             * INV-4: never open a tail that cannot resolve. `find_transcript`
             * stats every directory under ~/.claude/projects looking for a file
             * a Kiro session will never have, misses, caches nothing, and would
             * do it again for every such agent every five seconds forever.
             */
            if !has_transcripts(&agent.agent_kind) {
                continue;
            }
            if !tails.contains_key(&agent.session_id) {
                // No transcript on disk yet: try again next tick rather than
                // caching a reader that would never find one.
                let Some(tail) = (self.tail_for)(agent) else { continue };
                tails.insert(agent.session_id.clone(), tail);
            }
            let tail = tails.get_mut(&agent.session_id).expect("inserted above");
            // INV-5: one unreadable transcript must not stall the other agents.
            let Ok(read) = tail.read().await else { continue };
            let card = card_fields(read.patch);
            if !card.is_empty() && differs(agent, &card) {
                self.source.enrich(&agent.session_id, card);
                changed = true;
            }
        }
        drop(tails);
        if changed {
            self.source.notify();
        }
    }
}

/// Fields the fleet card needs; anything else the tail reports is ignored here.
///
/// Three of the things a tail can report are deliberately dropped. `status` and
/// `waitingFor` are the registry's to decide from the pane, not the
/// transcript's. `cwd` is read by the parser but is not a card field: the
/// registry owns it, and letting a historical record from before a `cd` rewrite
/// it would move the card header backwards.
fn card_fields(patch: AgentPatch) -> AgentPatch {
    AgentPatch {
        activity: patch.activity,
        last_activity_at: patch.last_activity_at,
        tokens: patch.tokens,
        subagents: patch.subagents,
        delegating: patch.delegating,
        ai_title: patch.ai_title,
        last_prompt: patch.last_prompt,
        permission_mode: patch.permission_mode,
        model: patch.model,
        goal: patch.goal,
        git_branch: patch.git_branch,
        status: None,
        waiting_for: None,
        cwd: None,
    }
}

/// Whether applying this patch would actually change the card.
///
/// INV-4: an unchanged fleet must not rebroadcast to every browser tab.
fn differs(agent: &Agent, patch: &AgentPatch) -> bool {
    fn text_differs(next: &Option<String>, cur: &Option<String>) -> bool {
        matches!(next, Some(v) if cur.as_deref() != Some(v.as_str()))
    }
    if text_differs(&patch.activity, &agent.activity)
        || text_differs(&patch.ai_title, &agent.ai_title)
        || text_differs(&patch.last_prompt, &agent.last_prompt)
        || text_differs(&patch.permission_mode, &agent.permission_mode)
        || text_differs(&patch.model, &agent.model)
        || text_differs(&patch.git_branch, &agent.git_branch)
    {
        return true;
    }
    if matches!(patch.last_activity_at, Some(v) if agent.last_activity_at != Some(v))
        || matches!(patch.tokens, Some(v) if agent.tokens != Some(v))
        || matches!(patch.subagents, Some(v) if agent.subagents != Some(v))
        || matches!(patch.delegating, Some(v) if agent.delegating != Some(v))
    {
        return true;
    }
    // `goal` is the one field here that is a struct. A fresh parse builds a new
    // one every tick, so comparing by identity would report a change on every
    // read and rebroadcast the whole fleet for nothing; compare by value.
    if let Some(next) = &patch.goal {
        let a = serde_json::to_value(next).unwrap_or(serde_json::Value::Null);
        let b = serde_json::to_value(&agent.goal).unwrap_or(serde_json::Value::Null);
        if a != b {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    //! Mirrors `test/enrich.test.ts`.
    use super::*;
    use crate::agent_kinds::CLAUDE_KIND;
    use crate::sources::{TailRead, Unsubscribe};
    use crate::types::{AgentStatus, GoalState};
    use async_trait::async_trait;
    use std::sync::Mutex as StdMutex;

    /// A token count the fake tail keeps reporting, so a tick that reads it
    /// finds nothing new to say. Any number will do; it has to be the same one
    /// on the agent and in the patch.
    const UNCHANGED_TOKENS: i64 = 5;

    /// The cadence tests drive the loop far faster than the five seconds
    /// production uses, and the sleeps around it are deliberately loose: this
    /// file is one of the two AGENTS.md names as flaky under load, and every
    /// margin here is there so a busy machine fails a regression rather than a
    /// stopwatch.
    const BRISK_TICK: Duration = Duration::from_millis(5);
    const SEVERAL_TICKS: Duration = Duration::from_millis(30);
    /// Long enough for the loop to have run several passes before it is judged.
    const LOOP_WARMUP: Duration = Duration::from_millis(60);
    /// Long enough for a pass already in flight when the pause landed to finish.
    const PAUSE_SETTLES: Duration = Duration::from_millis(20);
    /// Long enough that a loop still running would have read many times over.
    const WHILE_PAUSED: Duration = Duration::from_millis(80);
    /// A resumed loop reads at once, so barely any wait is needed to see it.
    const RESUME_GRACE: Duration = Duration::from_millis(5);
    /// A pass slow enough to overrun the interval it was scheduled on.
    const OVERRUNNING_PASS: Duration = Duration::from_millis(50);
    /// The window the pacing is measured over.
    const PACING_WINDOW: Duration = Duration::from_millis(160);
    /// Passes that fit in that window once each one is paced by its own cost.
    /// Generous on purpose — see the note on the timings above.
    const MOST_PASSES_THAT_FIT: usize = 4;

    fn agent(session_id: &str) -> Agent {
        Agent {
            session_id: session_id.into(),
            pid: 1,
            name: session_id.into(),
            cwd: "/x".into(),
            folder: "x".into(),
            status: AgentStatus::Idle,
            // Set explicitly: an empty kind reaches a capability lookup that
            // denies everything, and this loop is one of the lookups.
            agent_kind: CLAUDE_KIND.into(),
            kind: "interactive".into(),
            started_at: 0,
            ..Agent::default()
        }
    }

    #[derive(Default)]
    struct FakeSource {
        agents: StdMutex<Vec<Agent>>,
        notified: StdMutex<usize>,
    }

    impl FakeSource {
        fn with(list: Vec<Agent>) -> Arc<Self> {
            Arc::new(FakeSource { agents: StdMutex::new(list), notified: StdMutex::new(0) })
        }
        fn find(&self, id: &str) -> Option<Agent> {
            self.agents.lock().unwrap().iter().find(|a| a.session_id == id).cloned()
        }
        fn remove(&self, id: &str) {
            self.agents.lock().unwrap().retain(|a| a.session_id != id);
        }
        fn add(&self, agent: Agent) {
            self.agents.lock().unwrap().push(agent);
        }
        fn notifications(&self) -> usize {
            *self.notified.lock().unwrap()
        }
    }

    #[async_trait]
    impl AgentSource for FakeSource {
        fn list(&self) -> Vec<Agent> {
            self.agents.lock().unwrap().clone()
        }
        fn get(&self, session_id: &str) -> Option<Agent> {
            self.find(session_id)
        }
        fn on_change(&self, _listener: Box<dyn Fn(Vec<Agent>) + Send + Sync>) -> Unsubscribe {
            Box::new(|| {})
        }
        fn enrich(&self, session_id: &str, patch: AgentPatch) {
            let mut list = self.agents.lock().unwrap();
            if let Some(a) = list.iter_mut().find(|a| a.session_id == session_id) {
                patch.apply(a);
            }
        }
        fn notify(&self) {
            *self.notified.lock().unwrap() += 1;
        }
        async fn start(&self) -> anyhow::Result<()> {
            Ok(())
        }
        fn stop(&self) {}
    }

    /// A tail that reports the same patch every read.
    struct FakeTail(AgentPatch);

    #[async_trait]
    impl TailApi for FakeTail {
        async fn read(&mut self) -> anyhow::Result<TailRead> {
            Ok(TailRead { events: Vec::new(), patch: self.0.clone(), first: false, ..Default::default() })
        }
    }

    struct BrokenTail;

    #[async_trait]
    impl TailApi for BrokenTail {
        async fn read(&mut self) -> anyhow::Result<TailRead> {
            anyhow::bail!("unreadable")
        }
    }

    fn activity(text: &str) -> AgentPatch {
        AgentPatch { activity: Some(text.into()), ..AgentPatch::default() }
    }

    fn factory(build: impl Fn(&Agent) -> Option<Box<dyn TailApi>> + Send + Sync + 'static) -> TailFactory {
        Arc::new(build)
    }

    #[tokio::test]
    async fn fills_the_activity_line_for_agents_nobody_has_open() {
        let source = FakeSource::with(vec![agent("a"), agent("b")]);
        let enricher = FleetEnricher::new(
            source.clone(),
            factory(|a| {
                let mut patch = activity(&format!("doing {}", a.session_id));
                patch.tokens = Some(10);
                patch.git_branch = Some("main".into());
                Some(Box::new(FakeTail(patch)))
            }),
        );
        enricher.tick().await;
        assert_eq!(source.find("a").unwrap().activity.as_deref(), Some("doing a"));
        assert_eq!(source.find("b").unwrap().activity.as_deref(), Some("doing b"));
        assert_eq!(source.find("a").unwrap().tokens, Some(10));
        assert_eq!(source.find("a").unwrap().git_branch.as_deref(), Some("main"));
        assert_eq!(source.notifications(), 1);
    }

    /// INV-4: an unchanged fleet must not rebroadcast to every browser tab.
    #[tokio::test]
    async fn inv4_does_not_notify_when_nothing_changed() {
        let mut a = agent("a");
        a.activity = Some("same".into());
        a.tokens = Some(UNCHANGED_TOKENS);
        let source = FakeSource::with(vec![a]);
        let enricher = FleetEnricher::new(
            source.clone(),
            factory(|_| {
                let mut patch = activity("same");
                patch.tokens = Some(UNCHANGED_TOKENS);
                Some(Box::new(FakeTail(patch)))
            }),
        );
        enricher.tick().await;
        assert_eq!(source.notifications(), 0);
    }

    #[tokio::test]
    async fn ignores_a_tail_that_reports_nothing_new() {
        let mut a = agent("a");
        a.activity = Some("kept".into());
        let source = FakeSource::with(vec![a]);
        let enricher = FleetEnricher::new(
            source.clone(),
            factory(|_| Some(Box::new(FakeTail(AgentPatch::default())))),
        );
        enricher.tick().await;
        assert_eq!(source.find("a").unwrap().activity.as_deref(), Some("kept"));
        assert_eq!(source.notifications(), 0);
    }

    /// INV-5: one bad transcript must not stop the others from updating.
    #[tokio::test]
    async fn inv5_keeps_going_when_one_transcript_fails() {
        let source = FakeSource::with(vec![agent("bad"), agent("good")]);
        let enricher = FleetEnricher::new(
            source.clone(),
            factory(|a| {
                Some(if a.session_id == "bad" {
                    Box::new(BrokenTail) as Box<dyn TailApi>
                } else {
                    Box::new(FakeTail(activity("fine")))
                })
            }),
        );
        enricher.tick().await;
        assert_eq!(source.find("good").unwrap().activity.as_deref(), Some("fine"));
    }

    #[tokio::test]
    async fn drops_tails_for_agents_that_have_exited() {
        let source = FakeSource::with(vec![agent("a")]);
        let built = Arc::new(StdMutex::new(0usize));
        let counter = built.clone();
        let enricher = FleetEnricher::new(
            source.clone(),
            factory(move |_| {
                let mut n = counter.lock().unwrap();
                *n += 1;
                Some(Box::new(FakeTail(activity(&format!("v{n}")))))
            }),
        );
        enricher.tick().await;
        assert_eq!(*built.lock().unwrap(), 1);
        source.remove("a");
        enricher.tick().await;
        source.add(agent("a"));
        enricher.tick().await;
        // A fresh tail, because the old one was pruned when the agent vanished:
        // a reused byte offset would point into a different session's file.
        assert_eq!(*built.lock().unwrap(), 2);
    }

    /// A session that has not written a transcript yet is retried, not written
    /// off: caching a "no tail" answer would leave that card blank for the life
    /// of the process.
    #[tokio::test]
    async fn retries_a_session_that_has_no_transcript_yet() {
        let source = FakeSource::with(vec![agent("a")]);
        let ready = Arc::new(StdMutex::new(false));
        let flag = ready.clone();
        let enricher = FleetEnricher::new(
            source.clone(),
            factory(move |_| {
                if !*flag.lock().unwrap() {
                    return None;
                }
                Some(Box::new(FakeTail(activity("now visible"))))
            }),
        );
        enricher.tick().await;
        assert_eq!(source.find("a").unwrap().activity, None);
        *ready.lock().unwrap() = true;
        enricher.tick().await;
        assert_eq!(source.find("a").unwrap().activity.as_deref(), Some("now visible"));
    }

    /// A fresh parse builds a new `GoalState` every tick, so comparing by
    /// identity would rebroadcast the whole fleet once every 5 seconds.
    #[tokio::test]
    async fn compares_the_goal_by_value_not_identity() {
        let goal = || GoalState {
            condition: "ship it".into(),
            met: false,
            at: 1_786_665_600_000,
            reason: None,
            fresh: Some(true),
        };
        let mut a = agent("a");
        a.goal = Some(goal());
        let source = FakeSource::with(vec![a]);
        let enricher = FleetEnricher::new(
            source.clone(),
            factory(move |_| {
                Some(Box::new(FakeTail(AgentPatch {
                    goal: Some(Some(goal())),
                    ..AgentPatch::default()
                })))
            }),
        );
        enricher.tick().await;
        assert_eq!(source.notifications(), 0);

        // A goal that actually moved does get through.
        let moved = FleetEnricher::new(
            source.clone(),
            factory(move |_| {
                let mut g = goal();
                g.met = true;
                g.fresh = None;
                Some(Box::new(FakeTail(AgentPatch {
                    goal: Some(Some(g)),
                    ..AgentPatch::default()
                })))
            }),
        );
        moved.tick().await;
        assert_eq!(source.notifications(), 1);
        assert!(source.find("a").unwrap().goal.unwrap().met);
    }

    /// `status` and `waitingFor` belong to the registry, which watches the pane.
    /// A transcript must not be able to declare an agent idle.
    #[tokio::test]
    async fn a_tail_cannot_set_status_or_waiting_for() {
        let source = FakeSource::with(vec![agent("a")]);
        let enricher = FleetEnricher::new(
            source.clone(),
            factory(|_| {
                Some(Box::new(FakeTail(AgentPatch {
                    status: Some(AgentStatus::Busy),
                    waiting_for: Some(Some("dialog open".into())),
                    // Read from the transcript, but not the card's to move.
                    cwd: Some("/somewhere/else".into()),
                    ..AgentPatch::default()
                })))
            }),
        );
        enricher.tick().await;
        assert_eq!(source.find("a").unwrap().status, AgentStatus::Idle);
        assert_eq!(source.find("a").unwrap().waiting_for, None);
        assert_eq!(source.find("a").unwrap().cwd, "/x");
        assert_eq!(source.notifications(), 0);
    }

    #[tokio::test]
    async fn the_timer_ticks_and_stop_ends_it() {
        let source = FakeSource::with(vec![agent("a")]);
        let enricher = FleetEnricher::with_interval(
            source.clone(),
            factory(|_| Some(Box::new(FakeTail(activity("running"))))),
            BRISK_TICK,
        );
        enricher.start().await;
        tokio::time::sleep(SEVERAL_TICKS).await;
        assert_eq!(source.find("a").unwrap().activity.as_deref(), Some("running"));
        enricher.stop().await;
        let seen = source.notifications();
        tokio::time::sleep(SEVERAL_TICKS).await;
        assert_eq!(source.notifications(), seen, "kept ticking after stop");
    }

    /// A tail that counts how many times it was read, for the cadence tests.
    struct CountingTail {
        reads: Arc<StdMutex<usize>>,
        work: Duration,
    }

    #[async_trait]
    impl TailApi for CountingTail {
        async fn read(&mut self) -> anyhow::Result<TailRead> {
            let n = {
                let mut reads = self.reads.lock().unwrap();
                *reads += 1;
                *reads
            };
            if !self.work.is_zero() {
                tokio::time::sleep(self.work).await;
            }
            Ok(TailRead {
                events: Vec::new(),
                patch: activity(&format!("v{n}")),
                first: false,
                ..Default::default()
            })
        }
    }

    fn counting(reads: &Arc<StdMutex<usize>>, work: Duration) -> TailFactory {
        let reads = reads.clone();
        Arc::new(move |_| {
            Some(Box::new(CountingTail { reads: reads.clone(), work }) as Box<dyn TailApi>)
        })
    }

    /*
     * INV-4 opens with "nothing polls what nobody is watching", and this was the
     * loop that ignored it: with no browser connected at all it still tailed
     * every transcript on the machine every five seconds, to fill in cards
     * nobody was going to look at. The fleet list itself keeps refreshing —
     * that is the Registry's job and it is a directory of small file reads — so
     * what pauses here is only the per-agent transcript read, which is the
     * expensive part.
     */
    #[tokio::test]
    async fn inv4_stops_tailing_while_no_browser_is_connected() {
        let reads = Arc::new(StdMutex::new(0usize));
        let source = FakeSource::with(vec![agent("a")]);
        let enricher = FleetEnricher::with_interval(
            source.clone(),
            counting(&reads, Duration::ZERO),
            Duration::from_millis(10),
        );

        enricher.start().await;
        tokio::time::sleep(LOOP_WARMUP).await;
        assert!(*reads.lock().unwrap() > 2, "the loop never got going");

        enricher.unwatch().await;
        tokio::time::sleep(PAUSE_SETTLES).await;
        let at_pause = *reads.lock().unwrap();
        tokio::time::sleep(WHILE_PAUSED).await;
        assert_eq!(*reads.lock().unwrap(), at_pause, "kept tailing with nobody watching");

        // A tab connecting is about to paint these cards, so it gets a pass now
        // rather than one interval from now.
        enricher.watch().await;
        tokio::time::sleep(RESUME_GRACE).await;
        assert!(*reads.lock().unwrap() > at_pause, "a connecting tab waited for a tick");
        enricher.stop().await;
    }

    /// INV-4: a pass that overruns its interval backs its own cadence off
    /// rather than stacking, so the reads cannot outnumber the passes that fit.
    #[tokio::test]
    async fn inv4_paces_itself_by_the_work_rather_than_by_a_wall_clock() {
        let reads = Arc::new(StdMutex::new(0usize));
        let source = FakeSource::with(vec![agent("a")]);
        let enricher = FleetEnricher::with_interval(
            source.clone(),
            // A fleet large enough that one pass overruns its own interval.
            counting(&reads, OVERRUNNING_PASS),
            Duration::from_millis(10),
        );

        enricher.start().await;
        tokio::time::sleep(PACING_WINDOW).await;
        enricher.stop().await;

        // On a wall clock 160ms at 10ms is 16 passes. Paced by the work it is
        // at most three, and the generous ceiling is what keeps this from
        // failing on a loaded machine rather than on a regression.
        let count = *reads.lock().unwrap();
        assert!(count >= 1, "the loop never ran");
        assert!(
            count <= MOST_PASSES_THAT_FIT,
            "ran {count} passes; a wall clock would have stacked them"
        );
    }

    /// INV-4: no transcript tail for a CLI that keeps no transcripts. Without
    /// this guard, `find_transcript` stats every project directory looking for
    /// a file a Kiro session will never have, every five seconds, forever.
    #[tokio::test]
    async fn inv4_never_opens_a_tail_for_a_cli_with_no_transcripts() {
        let kiro = Agent { agent_kind: "kiro".into(), ..agent("k") };
        let source = FakeSource::with(vec![kiro, agent("c")]);
        let asked = Arc::new(StdMutex::new(Vec::<String>::new()));
        let seen = asked.clone();
        let enricher = FleetEnricher::new(
            source.clone(),
            factory(move |a| {
                seen.lock().unwrap().push(a.session_id.clone());
                Some(Box::new(FakeTail(activity("read"))))
            }),
        );

        enricher.tick().await;

        assert_eq!(*asked.lock().unwrap(), vec!["c"]);
        assert_eq!(source.find("k").unwrap().activity, None);
        assert_eq!(source.find("c").unwrap().activity.as_deref(), Some("read"));
    }
}
