//! The fleet, from more than one place.
//!
//! Port of `src/server/tmux-source.ts`.
//!
//! `registry` finds Claude sessions by reading the files Claude Code writes
//! about itself. [`TmuxProvider`] finds everything else by asking tmux what is
//! running. [`CompositeSource`] puts the two behind the one
//! [`AgentSource`](crate::sources::AgentSource) the rest of the server already
//! talks to, so nothing downstream learns that agents now come from two places.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;

use crate::pane::{fleet_facts, PaneFacts};
use crate::poll::{FirstPass, Poller};
use crate::registry::{sort_agents, Listeners};
use crate::sources::{AgentPatch, AgentSource, Unsubscribe};
use crate::tmux_agents::agents_from_panes;
use crate::types::Agent;

const TICK: Duration = Duration::from_secs(3);

/// One read of every pane on the machine.
///
/// Injected rather than called directly, so the discovery loop — the guard, the
/// change detection, the INV-5 behaviour on a failed read — can be driven from
/// a fixture without a tmux server. [`TmuxProvider::live`] supplies the real
/// one.
pub type FactsReader = Arc<
    dyn Fn() -> Pin<Box<dyn Future<Output = anyhow::Result<Vec<PaneFacts>>> + Send>>
        + Send
        + Sync,
>;

/// Fields worth a broadcast, mirroring `Registry::changed`.
fn changed(before: &Agent, after: &Agent) -> bool {
    before.status != after.status
        || before.name != after.name
        || before.cwd != after.cwd
        || before.pane_id != after.pane_id
        || before.last_activity_at != after.last_activity_at
}

fn differs(prev: &[Agent], next: &[Agent]) -> bool {
    if prev.len() != next.len() {
        return true;
    }
    let by_id: HashMap<&str, &Agent> = prev.iter().map(|a| (a.session_id.as_str(), a)).collect();
    next.iter()
        .any(|a| by_id.get(a.session_id.as_str()).is_none_or(|before| changed(before, a)))
}

/// What [`CompositeSource`] needs from anything that produces agents.
///
/// The TS `onChange` hands the listener nothing — the composite re-reads every
/// provider and publishes the merged list — so this carries no payload either.
#[async_trait]
pub trait AgentProvider: Send + Sync + 'static {
    fn list(&self) -> Vec<Agent>;
    fn on_change(&self, listener: Box<dyn Fn(()) + Send + Sync>) -> Unsubscribe;
    async fn start(&self) -> anyhow::Result<()>;
    fn stop(&self);
}

/// An [`AgentSource`] seen as a provider, so `registry`'s Claude source can sit
/// in a [`CompositeSource`] beside the tmux one.
///
/// The TS needs no such thing: `Registry` satisfies `AgentProvider`
/// structurally, because both interfaces happen to spell
/// `list`/`onChange`/`start`/`stop`. The two Rust traits differ in what
/// `on_change` hands its listener — a source publishes the fleet, a provider
/// only says "something moved" — so the bridge is written out. It must come
/// **first** in the provider list: the claim rule below is "an earlier provider
/// wins", and Claude knowing its own status is always better evidence than a
/// pane's output age.
pub struct SourceAsProvider(pub Arc<dyn AgentSource>);

#[async_trait]
impl AgentProvider for SourceAsProvider {
    fn list(&self) -> Vec<Agent> {
        self.0.list()
    }

    fn on_change(&self, listener: Box<dyn Fn(()) + Send + Sync>) -> Unsubscribe {
        // The fleet it publishes is dropped rather than forwarded: the
        // composite has to re-read *every* provider to answer, so a list from
        // one of them is not the answer to the question being asked.
        self.0.on_change(Box::new(move |_| listener(())))
    }

    async fn start(&self) -> anyhow::Result<()> {
        self.0.start().await
    }

    fn stop(&self) {
        self.0.stop();
    }
}

struct ProviderInner {
    read: FactsReader,
    agents: Mutex<Vec<Agent>>,
    listeners: Listeners<()>,
    refreshing: AtomicBool,
}

impl ProviderInner {
    async fn refresh(&self) {
        // A pass already in flight owns this one's work. `Poller` re-arms only
        // after its pass returns, so what this guards is a manual `refresh()`
        // racing the tick, not the tick racing itself.
        if self.refreshing.swap(true, Ordering::SeqCst) {
            return;
        }
        // A question that could not be put is not an answer (INV-5). Emptying
        // the fleet because one tmux call failed would blink every agent off
        // the dashboard and, worse, make it look like they had exited.
        if let Ok(rows) = (self.read)().await {
            let next = agents_from_panes(&rows, now_ms());
            let moved = {
                let mut agents = self.agents.lock().unwrap();
                let moved = differs(&agents, &next);
                *agents = next;
                moved
            };
            if moved {
                self.listeners.emit(&());
            }
        }
        self.refreshing.store(false, Ordering::SeqCst);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Agents discovered by asking tmux, polled.
pub struct TmuxProvider {
    inner: Arc<ProviderInner>,
    tick: Poller,
}

impl TmuxProvider {
    /// The real thing: one `list-panes -a` sweep of the machine per tick.
    pub fn live() -> Self {
        Self::new(Arc::new(|| Box::pin(async { Ok(fleet_facts().await?) })))
    }

    pub fn new(read: FactsReader) -> Self {
        Self::with_tick(read, TICK)
    }

    pub fn with_tick(read: FactsReader, tick: Duration) -> Self {
        let inner = Arc::new(ProviderInner {
            read,
            agents: Mutex::new(Vec::new()),
            listeners: Listeners::new(),
            refreshing: AtomicBool::new(false),
        });
        // INV-4, and it is `Poller` rather than a loop of this module's own
        // because the rule — re-arm after the pass, never sooner than the pass
        // itself took — is one rule the whole server holds to, and a second
        // copy of it is a second thing to get wrong.
        let polled = Arc::clone(&inner);
        TmuxProvider {
            tick: Poller::new(tick, move || {
                let inner = Arc::clone(&polled);
                async move { inner.refresh().await }
            }),
            inner,
        }
    }

    /// One pass, awaited. Public so a caller can force a read after acting.
    pub async fn refresh(&self) {
        self.inner.refresh().await;
    }
}

#[async_trait]
impl AgentProvider for TmuxProvider {
    fn list(&self) -> Vec<Agent> {
        self.inner.agents.lock().unwrap().clone()
    }

    fn on_change(&self, listener: Box<dyn Fn(()) + Send + Sync>) -> Unsubscribe {
        self.inner.listeners.add(listener)
    }

    async fn start(&self) -> anyhow::Result<()> {
        // Awaited, so the first HTTP response already has a fleet rather than
        // an empty list that fills in a moment later. The chain therefore
        // starts one interval out rather than immediately.
        self.inner.refresh().await;
        self.tick.start(FirstPass::AfterAnInterval);
        Ok(())
    }

    fn stop(&self) {
        self.tick.stop();
        self.inner.listeners.clear();
    }
}

/* -------------------------------------------------------------------------- */
/*  CompositeSource                                                           */
/* -------------------------------------------------------------------------- */

/// Fold `src` over `dst`, the way `{ ...prev, ...patch }` does: a field the new
/// patch does not mention keeps the value the old one gave it.
macro_rules! overwrite_named_fields {
    ($dst:expr, $src:expr, $($field:ident),+ $(,)?) => {
        $(if $src.$field.is_some() { $dst.$field = $src.$field; })+
    };
}

fn merge_patch(dst: &mut AgentPatch, src: AgentPatch) {
    overwrite_named_fields!(
        dst,
        src,
        activity,
        last_activity_at,
        tokens,
        subagents,
        delegating,
        ai_title,
        last_prompt,
        permission_mode,
        model,
        goal,
        status,
        waiting_for,
        git_branch,
        cwd,
        running,
    );
}

struct CompositeInner {
    providers: Vec<Arc<dyn AgentProvider>>,
    listeners: Listeners<Vec<Agent>>,
    patches: Mutex<HashMap<String, AgentPatch>>,
    unsubscribes: Mutex<Vec<Unsubscribe>>,
}

/// Whether this agent gets to keep the tmux session it is sitting in.
///
/// An earlier provider wins a tmux session outright. Claude is first, and what
/// it says about itself — a real status, a reason for waiting — is always
/// better evidence than what this app can infer from a pane. An agent in no
/// tmux session at all has nothing to lose and always wins.
fn claims_its_tmux_session(claimed: &mut HashSet<String>, agent: &Agent) -> bool {
    match &agent.tmux_session {
        Some(session) => claimed.insert(session.clone()),
        None => true,
    }
}

impl CompositeInner {
    fn list(&self) -> Vec<Agent> {
        let patches = self.patches.lock().unwrap();
        let mut out: Vec<Agent> = Vec::new();
        let mut claimed: HashSet<String> = HashSet::new();
        for provider in &self.providers {
            for mut agent in provider.list() {
                if !claims_its_tmux_session(&mut claimed, &agent) {
                    continue;
                }
                if let Some(patch) = patches.get(&agent.session_id) {
                    patch.apply(&mut agent);
                }
                out.push(agent);
            }
        }
        sort_agents(&out)
    }
}

/// Every provider behind one `AgentSource`, Claude winning any tmux session
/// both claim.
pub struct CompositeSource {
    inner: Arc<CompositeInner>,
}

impl CompositeSource {
    pub fn new(providers: Vec<Arc<dyn AgentProvider>>) -> Self {
        CompositeSource {
            inner: Arc::new(CompositeInner {
                providers,
                listeners: Listeners::new(),
                patches: Mutex::new(HashMap::new()),
                unsubscribes: Mutex::new(Vec::new()),
            }),
        }
    }
}

#[async_trait]
impl AgentSource for CompositeSource {
    fn list(&self) -> Vec<Agent> {
        self.inner.list()
    }

    fn get(&self, session_id: &str) -> Option<Agent> {
        self.inner.list().into_iter().find(|a| a.session_id == session_id)
    }

    fn on_change(&self, listener: Box<dyn Fn(Vec<Agent>) + Send + Sync>) -> Unsubscribe {
        self.inner.listeners.add(listener)
    }

    fn enrich(&self, session_id: &str, patch: AgentPatch) {
        let mut patches = self.inner.patches.lock().unwrap();
        merge_patch(patches.entry(session_id.to_string()).or_default(), patch);
    }

    fn notify(&self) {
        let agents = self.inner.list();
        self.inner.listeners.emit(&agents);
    }

    async fn start(&self) -> anyhow::Result<()> {
        for provider in &self.inner.providers {
            // Weak, so the subscription a provider holds cannot keep this
            // source alive: the provider outlives nothing here, but the cycle
            // would otherwise only be broken by `stop()` being called.
            let weak = Arc::downgrade(&self.inner);
            let off = provider.on_change(Box::new(move |()| {
                if let Some(inner) = weak.upgrade() {
                    let agents = inner.list();
                    inner.listeners.emit(&agents);
                }
            }));
            self.inner.unsubscribes.lock().unwrap().push(off);
        }
        // One provider failing to start must not stop the others (INV-5), and
        // they start together: each costs a round trip nobody else is waiting
        // on, and the TS `Promise.allSettled` pays for one of them, not the sum.
        let starting = self.inner.providers.iter().map(|p| p.start());
        for outcome in futures_util::future::join_all(starting).await {
            if let Err(e) = outcome {
                eprintln!("agent-commander: a fleet source failed to start: {e:#}");
            }
        }
        Ok(())
    }

    fn stop(&self) {
        for off in self.inner.unsubscribes.lock().unwrap().drain(..) {
            off();
        }
        for provider in &self.inner.providers {
            provider.stop();
        }
        self.inner.listeners.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AgentStatus;
    use std::sync::atomic::AtomicUsize;

    /// A poll far brisker than production's, so a cadence test finishes in
    /// milliseconds rather than seconds.
    const BRISK_POLL: Duration = Duration::from_millis(5);
    /// Long enough for several of those polls to have happened — and, after
    /// `stop()`, long enough that one still running would have been caught.
    const SEVERAL_POLLS: Duration = Duration::from_millis(40);

    fn claude(session_id: &str, tmux_session: Option<&str>) -> Agent {
        Agent {
            session_id: session_id.into(),
            name: session_id.into(),
            agent_kind: crate::agent_kinds::CLAUDE_KIND.into(),
            kind: "interactive".into(),
            status: AgentStatus::Busy,
            tmux_session: tmux_session.map(str::to_string),
            ..Default::default()
        }
    }

    fn kiro_pane(session: &str) -> PaneFacts {
        PaneFacts {
            pane_id: "%302".into(),
            session: session.into(),
            pid: 84_638,
            command: "kiro-cli".into(),
            activity_at: now_ms() / 1_000,
            window_panes: 1,
            dead: false,
            cwd: "/Users/ziweiwu/Projects/folio".into(),
        }
    }

    /// A reader that answers from a script, counting how often it was asked.
    #[derive(Clone)]
    struct FakeFacts {
        rows: Arc<Mutex<anyhow::Result<Vec<PaneFacts>, String>>>,
        calls: Arc<AtomicUsize>,
    }

    impl FakeFacts {
        fn new(rows: Vec<PaneFacts>) -> Self {
            FakeFacts {
                rows: Arc::new(Mutex::new(Ok(rows))),
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn set(&self, rows: Vec<PaneFacts>) {
            *self.rows.lock().unwrap() = Ok(rows);
        }

        fn fail(&self) {
            *self.rows.lock().unwrap() = Err("tmux is not running".into());
        }

        fn reader(&self) -> FactsReader {
            let me = self.clone();
            Arc::new(move || {
                let me = me.clone();
                Box::pin(async move {
                    me.calls.fetch_add(1, Ordering::SeqCst);
                    match &*me.rows.lock().unwrap() {
                        Ok(rows) => Ok(rows.clone()),
                        Err(msg) => Err(anyhow::anyhow!(msg.clone())),
                    }
                })
            })
        }
    }

    /// A provider that lists exactly what it was handed.
    struct StaticProvider(Mutex<Vec<Agent>>, Listeners<()>);

    impl StaticProvider {
        fn new(agents: Vec<Agent>) -> Arc<Self> {
            Arc::new(StaticProvider(Mutex::new(agents), Listeners::new()))
        }
    }

    #[async_trait]
    impl AgentProvider for StaticProvider {
        fn list(&self) -> Vec<Agent> {
            self.0.lock().unwrap().clone()
        }
        fn on_change(&self, listener: Box<dyn Fn(()) + Send + Sync>) -> Unsubscribe {
            self.1.add(listener)
        }
        async fn start(&self) -> anyhow::Result<()> {
            Ok(())
        }
        fn stop(&self) {}
    }

    struct FailingProvider;

    #[async_trait]
    impl AgentProvider for FailingProvider {
        fn list(&self) -> Vec<Agent> {
            Vec::new()
        }
        fn on_change(&self, _listener: Box<dyn Fn(()) + Send + Sync>) -> Unsubscribe {
            Box::new(|| {})
        }
        async fn start(&self) -> anyhow::Result<()> {
            Err(anyhow::anyhow!("no tmux server"))
        }
        fn stop(&self) {}
    }

    /* ------------------------------------------------------ the provider */

    #[tokio::test]
    async fn lists_the_agents_the_first_read_found() {
        let facts = FakeFacts::new(vec![kiro_pane("kiro-1787832510")]);
        let provider = TmuxProvider::new(facts.reader());
        provider.start().await.unwrap();
        let ids: Vec<_> = provider.list().into_iter().map(|a| a.session_id).collect();
        assert_eq!(ids, vec!["tmux:kiro-1787832510"]);
        provider.stop();
    }

    #[tokio::test]
    async fn broadcasts_only_when_the_fleet_actually_moved() {
        let facts = FakeFacts::new(vec![kiro_pane("kiro-1787832510")]);
        let provider = TmuxProvider::new(facts.reader());
        provider.start().await.unwrap();

        let hits = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&hits);
        let _off = provider.on_change(Box::new(move |()| {
            seen.fetch_add(1, Ordering::SeqCst);
        }));

        // The same panes again: nothing the fleet view draws has changed.
        provider.refresh().await;
        assert_eq!(hits.load(Ordering::SeqCst), 0);

        facts.set(vec![kiro_pane("kiro-1787832510"), kiro_pane("kiro-1787900000")]);
        provider.refresh().await;
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        provider.stop();
    }

    /// INV-5. A failed tmux call is not evidence that the agents are gone, and
    /// blanking the fleet would read on screen exactly like them all exiting.
    #[tokio::test]
    async fn inv5_a_failed_read_keeps_the_last_known_fleet() {
        let facts = FakeFacts::new(vec![kiro_pane("kiro-1787832510")]);
        let provider = TmuxProvider::new(facts.reader());
        provider.start().await.unwrap();
        assert_eq!(provider.list().len(), 1);

        let hits = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&hits);
        let _off = provider.on_change(Box::new(move |()| {
            seen.fetch_add(1, Ordering::SeqCst);
        }));

        facts.fail();
        provider.refresh().await;
        assert_eq!(provider.list().len(), 1, "the fleet was emptied by a failed read");
        assert_eq!(hits.load(Ordering::SeqCst), 0, "a failure was broadcast as a change");
        provider.stop();
    }

    /// INV-4. The loop re-arms after the pass returns, so a stopped provider
    /// stops reading rather than leaving a timer running against nothing.
    #[tokio::test]
    async fn inv4_stopping_the_provider_stops_the_polling() {
        let facts = FakeFacts::new(vec![kiro_pane("kiro-1787832510")]);
        let provider = TmuxProvider::with_tick(facts.reader(), BRISK_POLL);
        provider.start().await.unwrap();
        tokio::time::sleep(SEVERAL_POLLS).await;
        provider.stop();
        let after_stop = facts.calls.load(Ordering::SeqCst);
        assert!(after_stop > 1, "the poll never ran: {after_stop} reads");
        tokio::time::sleep(SEVERAL_POLLS).await;
        assert_eq!(
            facts.calls.load(Ordering::SeqCst),
            after_stop,
            "the poll outlived stop()"
        );
    }

    #[tokio::test]
    async fn every_agent_it_publishes_names_its_kind() {
        let facts = FakeFacts::new(vec![kiro_pane("kiro-1787832510")]);
        let provider = TmuxProvider::new(facts.reader());
        provider.start().await.unwrap();
        for a in provider.list() {
            assert!(!a.agent_kind.is_empty(), "{} has no agentKind", a.session_id);
        }
        provider.stop();
    }

    /* ----------------------------------------------------- the composite */

    #[tokio::test]
    async fn claude_wins_a_tmux_session_both_providers_claim() {
        let first = StaticProvider::new(vec![claude("uuid-1", Some("kiro-1787832510"))]);
        let facts = FakeFacts::new(vec![kiro_pane("kiro-1787832510")]);
        let second: Arc<dyn AgentProvider> = Arc::new(TmuxProvider::new(facts.reader()));
        second.start().await.unwrap();

        let source = CompositeSource::new(vec![first, second]);
        let ids: Vec<_> = source.list().into_iter().map(|a| a.session_id).collect();
        assert_eq!(ids, vec!["uuid-1"]);
    }

    #[tokio::test]
    async fn keeps_a_tmux_agent_no_claude_session_claims() {
        let first = StaticProvider::new(vec![claude("uuid-1", Some("claude-42"))]);
        let facts = FakeFacts::new(vec![kiro_pane("kiro-1787832510")]);
        let second: Arc<dyn AgentProvider> = Arc::new(TmuxProvider::new(facts.reader()));
        second.start().await.unwrap();

        let source = CompositeSource::new(vec![first, second]);
        let mut ids: Vec<_> = source.list().into_iter().map(|a| a.session_id).collect();
        ids.sort();
        assert_eq!(ids, vec!["tmux:kiro-1787832510", "uuid-1"]);
    }

    /// An agent with no tmux session can never be shadowed by one, however
    /// many of them there are.
    #[test]
    fn an_agent_without_a_tmux_session_is_never_claimed_away() {
        let first = StaticProvider::new(vec![claude("uuid-1", None)]);
        let second = StaticProvider::new(vec![claude("uuid-2", None)]);
        let source = CompositeSource::new(vec![first, second]);
        assert_eq!(source.list().len(), 2);
    }

    #[test]
    fn enrich_accumulates_rather_than_replacing() {
        let provider = StaticProvider::new(vec![claude("uuid-1", None)]);
        let source = CompositeSource::new(vec![provider]);
        source.enrich("uuid-1", AgentPatch { model: Some("opus".into()), ..Default::default() });
        source.enrich(
            "uuid-1",
            AgentPatch { activity: Some("editing".into()), ..Default::default() },
        );
        let a = source.get("uuid-1").unwrap();
        // The second patch said nothing about the model, so it kept the first's.
        assert_eq!(a.model.as_deref(), Some("opus"));
        assert_eq!(a.activity.as_deref(), Some("editing"));
    }

    #[test]
    fn a_patch_survives_the_provider_re_listing_the_agent() {
        let provider = StaticProvider::new(vec![claude("uuid-1", None)]);
        let source = CompositeSource::new(vec![provider]);
        source.enrich("uuid-1", AgentPatch { tokens: Some(4_096), ..Default::default() });
        assert_eq!(source.list()[0].tokens, Some(4_096));
        assert_eq!(source.list()[0].tokens, Some(4_096));
    }

    /// INV-5. `Promise.allSettled` in the TS: a tmux-less machine must still
    /// get its Claude sessions.
    #[tokio::test]
    async fn inv5_one_provider_failing_to_start_does_not_stop_the_others() {
        let working = StaticProvider::new(vec![claude("uuid-1", None)]);
        let broken: Arc<dyn AgentProvider> = Arc::new(FailingProvider);
        let source = CompositeSource::new(vec![broken, working]);
        source.start().await.unwrap();
        assert_eq!(source.list().len(), 1);
        source.stop();
    }

    #[tokio::test]
    async fn a_provider_change_republishes_the_merged_fleet() {
        let provider = StaticProvider::new(vec![claude("uuid-1", None)]);
        let source = CompositeSource::new(vec![provider.clone()]);
        source.start().await.unwrap();

        let seen: Arc<Mutex<Vec<usize>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let _off = source.on_change(Box::new(move |agents: Vec<Agent>| {
            sink.lock().unwrap().push(agents.len());
        }));

        provider.0.lock().unwrap().push(claude("uuid-2", None));
        provider.1.emit(&());
        assert_eq!(*seen.lock().unwrap(), vec![2]);
        source.stop();
    }

    #[tokio::test]
    async fn stop_unsubscribes_so_a_later_provider_change_is_silent() {
        let provider = StaticProvider::new(vec![claude("uuid-1", None)]);
        let source = CompositeSource::new(vec![provider.clone()]);
        source.start().await.unwrap();

        let hits = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&hits);
        let _off = source.on_change(Box::new(move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
        }));
        source.stop();
        provider.1.emit(&());
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    /// A plain `AgentSource` holding one Claude session, for the bridge test.
    struct OneAgent(Listeners<Vec<Agent>>);

    #[async_trait]
    impl AgentSource for OneAgent {
        fn list(&self) -> Vec<Agent> {
            vec![claude("uuid-1", Some("kiro-1787832510"))]
        }
        fn get(&self, session_id: &str) -> Option<Agent> {
            self.list().into_iter().find(|a| a.session_id == session_id)
        }
        fn on_change(&self, listener: Box<dyn Fn(Vec<Agent>) + Send + Sync>) -> Unsubscribe {
            self.0.add(listener)
        }
        fn enrich(&self, _session_id: &str, _patch: AgentPatch) {}
        async fn start(&self) -> anyhow::Result<()> {
            Ok(())
        }
        fn stop(&self) {}
    }

    /// The wiring `main`/`routes` will use: `registry`'s Claude source first,
    /// tmux second. Written as a test because the bridge is the one place the
    /// TS gets structural typing for free and Rust does not.
    #[tokio::test]
    async fn a_plain_agent_source_can_stand_in_as_a_provider() {
        let claude_source = Arc::new(OneAgent(Listeners::new()));
        let bridged: Arc<dyn AgentProvider> =
            Arc::new(SourceAsProvider(claude_source.clone() as Arc<dyn AgentSource>));
        let facts = FakeFacts::new(vec![kiro_pane("kiro-1787832510")]);
        let tmux: Arc<dyn AgentProvider> = Arc::new(TmuxProvider::new(facts.reader()));

        let source = CompositeSource::new(vec![bridged, tmux]);
        source.start().await.unwrap();

        // Claude was first, so it keeps the session the tmux sweep also saw.
        let ids: Vec<_> = source.list().into_iter().map(|a| a.session_id).collect();
        assert_eq!(ids, vec!["uuid-1"]);

        // And a change it announces still reaches the composite's listeners.
        let hits = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&hits);
        let _off = source.on_change(Box::new(move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
        }));
        claude_source.0.emit(&claude_source.list());
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        source.stop();
    }

    #[test]
    fn the_merged_list_is_sorted_the_way_the_fleet_view_expects() {
        let waiting = Agent { status: AgentStatus::Waiting, ..claude("uuid-w", None) };
        let idle = Agent { status: AgentStatus::Idle, ..claude("uuid-i", None) };
        let busy = claude("uuid-b", None);
        let source = CompositeSource::new(vec![StaticProvider::new(vec![idle, busy, waiting])]);
        let ids: Vec<_> = source.list().into_iter().map(|a| a.session_id).collect();
        assert_eq!(ids, vec!["uuid-w", "uuid-b", "uuid-i"]);
    }
}
