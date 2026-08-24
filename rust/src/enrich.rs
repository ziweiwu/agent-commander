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
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::task::JoinHandle;

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
        })
    }

    /// Tick now, then on the interval, until [`stop`](Self::stop).
    pub async fn start(self: &Arc<Self>) {
        let me = Arc::clone(self);
        let handle = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(me.interval);
            loop {
                ticker.tick().await;
                me.tick().await;
            }
        });
        *self.task.lock().await = Some(handle);
    }

    pub async fn stop(&self) {
        if let Some(handle) = self.task.lock().await.take() {
            handle.abort();
        }
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
    use crate::sources::{TailRead, Unsubscribe};
    use crate::types::{AgentStatus, GoalState};
    use async_trait::async_trait;
    use std::sync::Mutex as StdMutex;

    fn agent(session_id: &str) -> Agent {
        Agent {
            session_id: session_id.into(),
            pid: 1,
            name: session_id.into(),
            cwd: "/x".into(),
            folder: "x".into(),
            status: AgentStatus::Idle,
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
        fn add(&self, a: Agent) {
            self.agents.lock().unwrap().push(a);
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
        fn on_change(&self, _f: Box<dyn Fn(Vec<Agent>) + Send + Sync>) -> Unsubscribe {
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
            Ok(TailRead { events: Vec::new(), patch: self.0.clone(), first: false })
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

    fn factory(f: impl Fn(&Agent) -> Option<Box<dyn TailApi>> + Send + Sync + 'static) -> TailFactory {
        Arc::new(f)
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
        a.tokens = Some(5);
        let source = FakeSource::with(vec![a]);
        let enricher = FleetEnricher::new(
            source.clone(),
            factory(|_| {
                let mut patch = activity("same");
                patch.tokens = Some(5);
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
            Duration::from_millis(5),
        );
        enricher.start().await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(source.find("a").unwrap().activity.as_deref(), Some("running"));
        enricher.stop().await;
        let seen = source.notifications();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(source.notifications(), seen, "kept ticking after stop");
    }
}
