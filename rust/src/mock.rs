//! Mock provider: fixture agents on a frozen clock.
//!
//! This exists so the UI can be reviewed and signed off without pointing the app
//! at real, working agents — the same reason terminal-system-monitor ships a mock
//! mode. `--mock` never touches tmux or the filesystem: nothing in this module
//! shells out or opens a file.
//!
//! Port of `src/server/mock.ts`. The fixture data is transcribed literally, byte
//! for byte, because the two backends are compared field by field when both are
//! run with `--mock` — any "improvement" here reads as a divergence there.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use async_trait::async_trait;

use crate::agent_kinds::{has_transcripts, CLAUDE_KIND};
use crate::sources::{
    AgentPatch, AgentSource, Deps, LimitsApi, PaneApi, PaneMeta, PaneSample, Submit, TailApi,
    TailRead, Unsubscribe,
};
use crate::types::{
    now_ms, Agent, AgentStatus, AgentTree, GoalState, RateLimits, SubagentNode, SubagentState,
    TimelineEvent, TimelineKind, UsageWindow,
};

/// Frozen clock. Every fixture timestamp is an offset from this, so two runs —
/// and the two backends — produce identical output.
const START: i64 = 1_786_600_000_000;

/// How long a live registry takes to notice a session that has just appeared.
///
/// The real number is one scan interval — seconds. This is far shorter, because
/// the only thing it has to be is *after* the reply that names the new session.
const SCAN_LATENCY_MS: u64 = 50;

/// Real escape byte, so mock frames exercise the same ANSI path as live captures.
const ESC: &str = "\u{001b}[";

/// How often `--mock-transitions` moves the blocked fixture. Slow enough to
/// watch a card change, fast enough that a review does not have to wait for it.
const TRANSITION_PERIOD_MS: u64 = 3000;

/// How often `--mock-transitions` steps the quota meter to its next reading.
/// Offset from the fleet's period so the two are not always seen changing
/// together.
const LIMIT_STEP_PERIOD_MS: u64 = 4000;

/// The fixture pane's geometry. A real agent's pane is wider than 80 columns
/// and shorter than a full screen, and the frame path has to survive both.
const PANE_COLS: usize = 96;
const PANE_ROWS: usize = 24;
/// Where the fixture leaves its cursor: on the prompt line, past the `❯ `.
const CURSOR_COL: usize = 2;
const CURSOR_ROW: usize = 21;

/// Width of the rules the fixture pane draws around its prompt. Narrower than
/// the pane, so the frame has something to align inside rather than fill.
const RULE_WIDTH: usize = 60;

/// The fixture pids, named so the assertions further down say which session
/// each one belongs to. Transcribed from `mock.ts`; the values themselves mean
/// nothing beyond being distinct and plausible.
const WAITING_PID: i64 = 28707;
const BUSY_PID: i64 = 4421;
const DELEGATING_PID: i64 = 47117;
const LONG_NAME_PID: i64 = 18731;
const IDLE_KB_PID: i64 = 34625;
const IDLE_CE_PID: i64 = 50893;
const IDLE_DB_PID: i64 = 53848;
const FRESH_PID: i64 = 2330;
const HEADLESS_PID: i64 = 6556;
const KIRO_PID: i64 = 84638;

/// How many delegates the busy fixture reports. Three, so the count is plural
/// and does not collide with the two the delegating fixture carries.
const BUSY_SUBAGENT_COUNT: i64 = 3;

/// Deliberately modelled on a real, awkward fleet rather than a flattering one:
/// five sessions share the home directory with auto-generated names, one name is
/// far too long for its card, and two have never been prompted so they have no
/// activity at all. If the UI reads well here it reads well anywhere.
///
/// One function per fixture, in the order the fleet is served in: each says what
/// makes its session awkward, which a single 200-line list could not.
fn fixtures() -> Vec<Agent> {
    vec![
        blocked_on_a_dialog(),
        working_towards_a_rejected_goal(),
        parked_on_a_subagent(),
        name_too_long_for_its_card(),
        idle_in_the_home_directory(),
        idle_under_a_title_it_wrote_itself(),
        idle_under_its_last_prompt(),
        never_prompted(),
        headless_outside_tmux(),
        kiro_seen_only_from_tmux(),
    ]
}

/// Waiting on a person: a dialog is open and nothing moves until it is
/// answered. `--mock-transitions` flips this one on a timer.
fn blocked_on_a_dialog() -> Agent {
    Agent {
        session_id: "mock-waiting".into(),
        pid: WAITING_PID,
        name: "ziweiwu-ee".into(),
        // Auto-named in a project directory with no title or prompt: the
        // folder is the last resort in the chain.
        derived_name: Some(true),
        cwd: "/Users/demo/Projects/kb-vault".into(),
        folder: "kb-vault".into(),
        status: AgentStatus::Waiting,
        waiting_for: Some("dialog open".into()),
        kind: "interactive".into(),
        started_at: START - 3_600_000,
        version: Some("2.1.232".into()),
        pane_id: Some("%76".into()),
        tmux_session: Some("claude-mock-a".into()),
        activity: Some("Bash: rm -rf dist && rebuild from scratch".into()),
        last_activity_at: Some(START - 240_000),
        tokens: Some(48_120),
        agent_kind: CLAUDE_KIND.into(),
        ..Default::default()
    }
}

/// The busy fixture: three delegates of its own, and the only goal in the
/// fleet — one that has already been judged once and rejected.
fn working_towards_a_rejected_goal() -> Agent {
    Agent {
        session_id: "mock-busy".into(),
        pid: BUSY_PID,
        name: "terminal-system-monitor-50".into(),
        cwd: "/Users/demo/Projects/terminal-system-monitor".into(),
        folder: "terminal-system-monitor".into(),
        status: AgentStatus::Busy,
        kind: "interactive".into(),
        started_at: START - 7_200_000,
        version: Some("2.1.232".into()),
        git_branch: Some("fix/locale-layout-startup".into()),
        pane_id: Some("%77".into()),
        tmux_session: Some("claude-mock-b".into()),
        activity: Some("Task → Rerun the exhaustive sweep against fixed code".into()),
        last_activity_at: Some(START - 12_000),
        tokens: Some(111_800),
        subagents: Some(BUSY_SUBAGENT_COUNT),
        // Working towards a goal that has already been evaluated once and
        // rejected: the state the goal control has to render well, since it
        // is the one that lasts. A condition long enough to need truncating,
        // because they are.
        goal: Some(GoalState {
            condition:
                "every test passes and the locale sweep reports no layout breakage at 80 columns"
                    .into(),
            met: false,
            at: START - 300_000,
            reason: Some("Two locale snapshots still differ at 80 columns.".into()),
            fresh: None,
        }),
        agent_kind: CLAUDE_KIND.into(),
        ..Default::default()
    }
}

/// Busy, but only its delegate is writing — the case a card reads as dead
/// unless something says the silence is delegation rather than a stall.
fn parked_on_a_subagent() -> Agent {
    Agent {
        session_id: "mock-busy-2".into(),
        pid: DELEGATING_PID,
        name: "markdown-viewer-with-ink".into(),
        cwd: "/Users/demo/Projects/useful-markdown-viewer".into(),
        folder: "useful-markdown-viewer".into(),
        status: AgentStatus::Busy,
        kind: "interactive".into(),
        started_at: START - 5_400_000,
        version: Some("2.1.232".into()),
        git_branch: Some("main".into()),
        pane_id: Some("%75".into()),
        tmux_session: Some("claude-mock-c".into()),
        // Parked on a subagent: the awkward case the fleet card has to
        // survive. Its own transcript has been silent for eleven minutes and
        // only the subagent is writing, so without `delegating` this reads as
        // a dead agent.
        activity: Some("Task → Audit the theme tokens across both themes".into()),
        last_activity_at: Some(START - 12_000),
        delegating: Some(true),
        subagents: Some(2),
        tokens: Some(67_500),
        agent_kind: CLAUDE_KIND.into(),
        ..Default::default()
    }
}

/// The name that does not fit its card, on an agent writing to a path that
/// does not fit either.
fn name_too_long_for_its_card() -> Agent {
    Agent {
        session_id: "mock-long-name".into(),
        pid: LONG_NAME_PID,
        name: "agent-commander-web-dashboard-ux-review-pass".into(),
        cwd: "/Users/demo/Projects/agent-commander".into(),
        folder: "agent-commander".into(),
        status: AgentStatus::Busy,
        kind: "interactive".into(),
        started_at: START - 1_500_000,
        version: Some("2.1.232".into()),
        git_branch: Some("main".into()),
        pane_id: Some("%79".into()),
        tmux_session: Some("claude-mock-d".into()),
        activity: Some(
            "Write: /Users/demo/Projects/agent-commander/src/web/very/deep/path/component.ts"
                .into(),
        ),
        last_activity_at: Some(START - 8_000),
        tokens: Some(23_900),
        subagents: Some(1),
        agent_kind: CLAUDE_KIND.into(),
        ..Default::default()
    }
}

/// Idle in the home directory it shares with three others, so its folder says
/// nothing and the card has to earn its label some other way.
fn idle_in_the_home_directory() -> Agent {
    Agent {
        session_id: "mock-idle-kb".into(),
        pid: IDLE_KB_PID,
        name: "kb-operational-hardening".into(),
        cwd: "/Users/demo".into(),
        folder: "demo".into(),
        status: AgentStatus::Idle,
        kind: "interactive".into(),
        started_at: START - 1_800_000,
        version: Some("2.1.232".into()),
        activity: Some(
            "Repo is back to normal. `main` and `skills-find-suitable` both build.".into(),
        ),
        last_activity_at: Some(START - 960_000),
        tokens: Some(59_800),
        pane_id: Some("%72".into()),
        tmux_session: Some("claude-mock-e".into()),
        agent_kind: CLAUDE_KIND.into(),
        ..Default::default()
    }
}

/// Idle, and the second of the four naming fallbacks: a title the agent wrote
/// for itself, where the folder would have said only "demo".
fn idle_under_a_title_it_wrote_itself() -> Agent {
    Agent {
        session_id: "mock-idle-ce".into(),
        pid: IDLE_CE_PID,
        name: "ziweiwu-ce".into(),
        // Auto-named, but the agent titled its own conversation.
        derived_name: Some(true),
        ai_title: Some("Find an alternative markdown editor to Obsidian".into()),
        cwd: "/Users/demo".into(),
        folder: "demo".into(),
        status: AgentStatus::Idle,
        kind: "interactive".into(),
        started_at: START - 50_400_000,
        version: Some("2.1.232".into()),
        activity: Some("Done — `~/.zshrc` updated (backup at `~/.zshrc.bak.2026`)".into()),
        last_activity_at: Some(START - 50_400_000),
        tokens: Some(31_900),
        pane_id: Some("%73".into()),
        tmux_session: Some("claude-mock-f".into()),
        agent_kind: CLAUDE_KIND.into(),
        ..Default::default()
    }
}

/// Idle, and the third naming fallback: no title yet, so the best label
/// available is the last thing somebody asked it to do.
fn idle_under_its_last_prompt() -> Agent {
    Agent {
        session_id: "mock-idle-db".into(),
        pid: IDLE_DB_PID,
        name: "ziweiwu-db".into(),
        // Auto-named with no title yet, so the last prompt is the best label.
        derived_name: Some(true),
        last_prompt: Some("check the npm download numbers for react-hig-datepicker".into()),
        cwd: "/Users/demo".into(),
        folder: "demo".into(),
        status: AgentStatus::Idle,
        kind: "interactive".into(),
        started_at: START - 3_600_000,
        version: Some("2.1.232".into()),
        activity: Some("**`react-hig-datepicker`, with 6,306 all-time downloads".into()),
        last_activity_at: Some(START - 3_600_000),
        tokens: Some(8_800),
        pane_id: Some("%78".into()),
        tmux_session: Some("claude-mock-g".into()),
        agent_kind: CLAUDE_KIND.into(),
        ..Default::default()
    }
}

/// Never prompted, and the fallback of last resort: the card has a name and
/// nothing else at all — no activity, no tokens, no conversation.
fn never_prompted() -> Agent {
    Agent {
        session_id: "mock-fresh".into(),
        pid: FRESH_PID,
        name: "ziweiwu-35".into(),
        // Auto-named, never prompted, and running in the home directory:
        // there is genuinely nothing better to call it, so it keeps its
        // own name rather than borrowing one from somewhere else.
        derived_name: Some(true),
        cwd: "/Users/demo".into(),
        folder: "demo".into(),
        status: AgentStatus::Idle,
        kind: "interactive".into(),
        started_at: START - 600_000,
        version: Some("2.1.232".into()),
        pane_id: Some("%0".into()),
        tmux_session: Some("claude-mock-h".into()),
        agent_kind: CLAUDE_KIND.into(),
        ..Default::default()
    }
}

/// A background session with no pane at all, so there is nothing to attach to
/// and the card has to say why rather than offer a button that cannot work.
fn headless_outside_tmux() -> Agent {
    Agent {
        session_id: "mock-no-tmux".into(),
        pid: HEADLESS_PID,
        name: "headless-import".into(),
        cwd: "/Users/demo/Projects/lego-deals".into(),
        folder: "lego-deals".into(),
        status: AgentStatus::Idle,
        kind: "background".into(),
        started_at: START - 600_000,
        version: Some("2.1.232".into()),
        attach_blocked_reason: Some("session is not running inside tmux".into()),
        activity: Some("WebFetch: https://example.com/feed.xml".into()),
        last_activity_at: Some(START - 60_000),
        tokens: Some(2_010),
        agent_kind: CLAUDE_KIND.into(),
        ..Default::default()
    }
}

/// A Kiro session, discovered from tmux rather than from a session file it
/// wrote about itself.
///
/// Here so the degraded card is on screen and not only in a test. It has no
/// transcript, so there is no chat to read and no slash command that may be
/// typed at it — and its status is `statusInferred`, because all this app knows
/// is that the pane produced output lately (INV-11). That is a far weaker claim
/// than a Claude session's "waiting, dialog open" wearing the same word.
fn kiro_seen_only_from_tmux() -> Agent {
    Agent {
        session_id: "tmux:kiro-1787832510".into(),
        pid: KIRO_PID,
        name: "folio".into(),
        derived_name: Some(true),
        cwd: "/Users/demo/Projects/folio".into(),
        folder: "folio".into(),
        status: AgentStatus::Busy,
        status_inferred: Some(true),
        agent_kind: "kiro".into(),
        kind: "interactive".into(),
        started_at: START - 900_000,
        git_branch: Some("main".into()),
        pane_id: Some("%302".into()),
        tmux_session: Some("kiro-1787832510".into()),
        last_activity_at: Some(START - 4_000),
        ..Default::default()
    }
}

/// One entry in the fixture transcript, before `MockTail` stamps an id on it.
type TimelineFixture = (i64, TimelineKind, Option<&'static str>, &'static str);

/// The fixture transcript, without ids — `MockTail` stamps those per session.
///
/// Split in two only because it is long: the two halves are one conversation
/// and are always read together, in this order.
fn mock_timeline() -> Vec<TimelineFixture> {
    let mut conversation = getting_oriented();
    conversation.extend(auditing_the_theme());
    conversation
}

/// The opening: a request, an acknowledgement, and the two reads that follow.
fn getting_oriented() -> Vec<TimelineFixture> {
    vec![
        (
            START - 300_000,
            TimelineKind::User,
            None,
            "Add a dark mode toggle to the site header.",
        ),
        (
            START - 295_000,
            TimelineKind::Assistant,
            None,
            "I'll start by getting oriented in the codebase.",
        ),
        (
            START - 290_000,
            TimelineKind::Tool,
            Some("Glob"),
            "src/**/*.astro",
        ),
        (
            START - 280_000,
            TimelineKind::Tool,
            Some("Read"),
            "src/components/Header.astro",
        ),
    ]
}

/// The rest: a delegation, what it found, and the rebuild it led to. The
/// `Subagent` entry is the one the chat renders differently, so it has to be in
/// the fixture rather than only in a test.
fn auditing_the_theme() -> Vec<TimelineFixture> {
    vec![
        (
            START - 260_000,
            TimelineKind::Subagent,
            Some("Task"),
            "Audit existing theme tokens",
        ),
        (
            START - 250_000,
            TimelineKind::Assistant,
            None,
            "The theme tokens already exist but are only defined for light mode.",
        ),
        (
            START - 240_000,
            TimelineKind::Tool,
            Some("Bash"),
            "rm -rf dist && rebuild",
        ),
    ]
}

/// One message the browser sent, echoed back as a transcript event.
#[derive(Debug, Clone)]
struct Echo {
    at: i64,
    text: String,
}

/// Messages sent from the browser, echoed back as transcript events.
///
/// A real agent writes the prompt it was handed into its own transcript, and
/// that echo is what lets the chat drop its local "sending…" copy. The mock's
/// paste was a no-op, so in mock mode every message sent sat pending for ever —
/// which made the send flow the one thing that could not be exercised without
/// pointing at a live agent.
///
/// Append-only, read through a per-reader cursor, because there is never just
/// one reader: the focused viewer polls its own tail every second and the fleet
/// enricher polls a second, independent tail for every agent every five. A queue
/// that each `read()` drained gave the message to whichever polled first — and
/// the enricher discards the events it reads, so when it won, the message was
/// gone for good and the chat marked it "not delivered" although the server had
/// accepted it. This mirrors how `TranscriptTail` already works: each reader
/// holds its own offset into a log nobody consumes.
static ECHOES: LazyLock<Mutex<HashMap<String, Vec<Echo>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Pane id -> session id, so a paste can find the transcript it belongs to.
/// Which fixture session occupies which fake pane.
pub fn session_by_pane(pane_id: &str) -> Option<String> {
    SESSION_BY_PANE.get(pane_id).cloned()
}

static SESSION_BY_PANE: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    fixtures()
        .into_iter()
        .filter_map(|a| a.pane_id.map(|p| (p, a.session_id)))
        .collect()
});

/* ---------------------------------------------------------------- source -- */

/// Shared state, held behind an `Arc` so the transition timer can outlive the
/// `&self` that started it.
#[derive(Default)]
struct SourceInner {
    /// A `Vec`, not a map: `list()` must preserve fixture order the way a JS
    /// `Map` preserves insertion order, and nine agents make lookup free.
    agents: Mutex<Vec<Agent>>,
    listeners: Mutex<Vec<(u64, Arc<dyn Fn(Vec<Agent>) + Send + Sync>)>>,
    next_id: AtomicU64,
}

impl SourceInner {
    fn list(&self) -> Vec<Agent> {
        self.agents.lock().unwrap().clone()
    }

    fn notify(&self) {
        let list = self.list();
        let subs: Vec<_> = self
            .listeners
            .lock()
            .unwrap()
            .iter()
            .map(|(_, listener)| listener.clone())
            .collect();
        for listener in subs {
            listener(list.clone());
        }
    }
}

pub struct MockSource {
    inner: Arc<SourceInner>,
    /// Flips the blocked fixture between waiting and idle on a timer. Static
    /// fixtures cannot show whether the UI keeps up with a status change — for
    /// instance whether the "waiting on you" banner clears once it is answered.
    transitions: bool,
    timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// Move the blocked fixture between waiting and idle until the task is aborted.
///
/// Ends of its own accord if the fixture is ever gone, because there is then
/// nothing left for the timer to say.
async fn flip_the_blocked_fixture_forever(inner: Arc<SourceInner>) {
    // `interval_at` rather than `interval`: tokio's first tick fires
    // immediately, JS's `setInterval` waits out the first period.
    let period = std::time::Duration::from_millis(TRANSITION_PERIOD_MS);
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    loop {
        ticker.tick().await;
        let mut agents = inner.agents.lock().unwrap();
        let Some(agent) = agents.iter_mut().find(|a| a.session_id == "mock-waiting") else {
            return;
        };
        let blocked = agent.status == AgentStatus::Waiting;
        agent.status = if blocked {
            AgentStatus::Idle
        } else {
            AgentStatus::Waiting
        };
        // Cleared when it unblocks, so a stale reason cannot outlive the state
        // it explained.
        agent.waiting_for = if blocked {
            None
        } else {
            Some("dialog open".into())
        };
        drop(agents);
        inner.notify();
    }
}

impl MockSource {
    /// Give one fixture a new session id, as `/clear` really does.
    ///
    /// `/clear` replaces the session rather than editing it: Claude Code opens
    /// a fresh transcript under a new id and rewrites `~/.claude/sessions/`.
    /// Mock mode reproduces that because it is the path with the sharp edge
    /// (INV-8) — the client has to find the agent again under its new id, and a
    /// fixture that kept its id would let a broken client pass.
    ///
    /// The agent moves to the end of the list, because the TS holds its fleet
    /// in a `Map` and rotates with delete-then-set, which is what that does.
    pub fn rotate(&self, old_id: &str, new_id: &str) {
        if !self.reopen_under_a_new_id(old_id, new_id) {
            return;
        }
        /*
         * Broadcast after the caller has been answered, not before.
         *
         * The client learns where the session went from the HTTP reply, and
         * only then stops treating the old id as missing. A fleet frame that
         * removes the old agent *first* arrives while the browser is still on
         * the old URL with nowhere to go, and the route's "the agent ended
         * while it was open" rule bounces it to the fleet.
         *
         * A live server never has that problem, and the reason is worth
         * stating: nothing broadcasts a real `/clear`. The new session appears
         * when the registry next scans `~/.claude/sessions`, seconds later, so
         * the reply always wins by a wide margin. Broadcasting synchronously is
         * the mock being *less* realistic than the thing it stands in for — and
         * the Node mock only gets away with it by winning the race on
         * scheduling, by about 3ms, which is why the e2e test for this is on
         * record as flaky.
         *
         * So the delay is not a workaround for the client; it is the mock
         * finally modelling the latency the live path has always had. Short
         * enough that the view still updates immediately to a human.
         */
        self.notify_once_a_scan_would_have_found_it();
    }

    /// Move the agent to the end of the list under `new_id`, stripped of
    /// everything the old conversation knew. False when there is no such agent.
    fn reopen_under_a_new_id(&self, old_id: &str, new_id: &str) -> bool {
        let mut agents = self.inner.agents.lock().unwrap();
        let Some(at) = agents.iter().position(|a| a.session_id == old_id) else {
            return false;
        };
        let mut agent = agents.remove(at);
        agent.session_id = new_id.to_string();
        // A cleared session has no conversation and nothing to say about one.
        agent.activity = None;
        agent.tokens = None;
        agent.ai_title = None;
        agent.last_prompt = None;
        agent.goal = None;
        agent.subagents = None;
        agent.delegating = Some(false);
        agent.last_activity_at = Some(now_ms());
        agents.push(agent);
        true
    }

    /// Broadcast the new fleet a scan-interval later, for the reason above.
    fn notify_once_a_scan_would_have_found_it(&self) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(SCAN_LATENCY_MS)).await;
            inner.notify();
        });
    }

    pub fn new(transitions: bool) -> Self {
        Self {
            inner: Arc::new(SourceInner {
                agents: Mutex::new(fixtures()),
                ..Default::default()
            }),
            transitions,
            timer: Mutex::new(None),
        }
    }
}

#[async_trait]
impl AgentSource for MockSource {
    fn list(&self) -> Vec<Agent> {
        self.inner.list()
    }

    fn get(&self, session_id: &str) -> Option<Agent> {
        self.inner
            .agents
            .lock()
            .unwrap()
            .iter()
            .find(|a| a.session_id == session_id)
            .cloned()
    }

    fn on_change(&self, listener: Box<dyn Fn(Vec<Agent>) + Send + Sync>) -> Unsubscribe {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        self.inner
            .listeners
            .lock()
            .unwrap()
            .push((id, Arc::from(listener)));
        let inner = self.inner.clone();
        Box::new(move || {
            inner.listeners.lock().unwrap().retain(|(i, _)| *i != id);
        })
    }

    fn enrich(&self, session_id: &str, patch: AgentPatch) {
        let mut agents = self.inner.agents.lock().unwrap();
        if let Some(agent) = agents.iter_mut().find(|a| a.session_id == session_id) {
            patch.apply(agent);
        }
    }

    fn notify(&self) {
        self.inner.notify();
    }

    async fn start(&self) -> anyhow::Result<()> {
        if !self.transitions {
            return Ok(());
        }
        let handle = tokio::spawn(flip_the_blocked_fixture_forever(self.inner.clone()));
        *self.timer.lock().unwrap() = Some(handle);
        Ok(())
    }

    fn stop(&self) {
        if let Some(h) = self.timer.lock().unwrap().take() {
            h.abort();
        }
    }
}

/* ---------------------------------------------------------------- limits -- */

/// The four readings, one per branch the meter has. Deliberately un-round so a
/// hardcoded fallback cannot masquerade as real data.
const OK_FIVE_HOUR_PCT: f64 = 12.4;
const OK_SEVEN_DAY_PCT: f64 = 31.8;
const WARN_FIVE_HOUR_PCT: f64 = 61.4;
const WARN_SEVEN_DAY_PCT: f64 = 47.2;
/// The critical step is also the one with no weekly window at all — a session
/// that has not yet touched the seven-day quota reports exactly that, and a
/// component assuming both windows exist throws on it.
const CRITICAL_FIVE_HOUR_PCT: f64 = 83.6;
const SPENT_FIVE_HOUR_PCT: f64 = 96.1;
const SPENT_SEVEN_DAY_PCT: f64 = 88.3;

/// How far ahead the reset times are stamped, so the countdown has something
/// plausible to run down in both windows.
const FIVE_HOUR_RESETS_IN_MS: i64 = 2 * 3_600_000;
const SEVEN_DAY_RESETS_IN_MS: i64 = 3 * 86_400_000;

/// Quota readings for mock mode.
///
/// The steps are chosen to walk the meter through every branch the UI has —
/// ok, warn, critical — and one reading with `sevenDay` missing, because a
/// session that has not yet touched the weekly window reports exactly that and
/// a component that assumes both windows exist will throw on it. The numbers are
/// deliberately un-round so a hardcoded fallback cannot masquerade as real data.
fn limit_steps() -> Vec<RateLimits> {
    let window = |pct: f64| {
        Some(UsageWindow {
            pct,
            resets_at: None,
        })
    };
    vec![
        RateLimits {
            five_hour: window(OK_FIVE_HOUR_PCT),
            seven_day: window(OK_SEVEN_DAY_PCT),
            at: 0,
        },
        RateLimits {
            five_hour: window(WARN_FIVE_HOUR_PCT),
            seven_day: window(WARN_SEVEN_DAY_PCT),
            at: 0,
        },
        RateLimits {
            five_hour: window(CRITICAL_FIVE_HOUR_PCT),
            seven_day: None,
            at: 0,
        },
        RateLimits {
            five_hour: window(SPENT_FIVE_HOUR_PCT),
            seven_day: window(SPENT_SEVEN_DAY_PCT),
            at: 0,
        },
    ]
}

#[derive(Default)]
struct LimitsInner {
    step: Mutex<usize>,
    limits: Mutex<Option<RateLimits>>,
    listeners: Mutex<Vec<(u64, Arc<dyn Fn(Option<RateLimits>) + Send + Sync>)>>,
    next_id: AtomicU64,
}

impl LimitsInner {
    /// Reset times are stamped relative to now rather than baked into the steps,
    /// so the countdown reads sensibly however long the mock server has been up.
    fn emit(&self) {
        let steps = limit_steps();
        let base = steps[*self.step.lock().unwrap()].clone();
        let now = now_ms();
        let next = RateLimits {
            five_hour: base.five_hour.map(|w| UsageWindow {
                pct: w.pct,
                resets_at: Some(now + FIVE_HOUR_RESETS_IN_MS),
            }),
            seven_day: base.seven_day.map(|w| UsageWindow {
                pct: w.pct,
                resets_at: Some(now + SEVEN_DAY_RESETS_IN_MS),
            }),
            at: now,
        };
        *self.limits.lock().unwrap() = Some(next.clone());
        let subs: Vec<_> = self
            .listeners
            .lock()
            .unwrap()
            .iter()
            .map(|(_, listener)| listener.clone())
            .collect();
        for listener in subs {
            listener(Some(next.clone()));
        }
    }
}

pub struct MockLimits {
    inner: Arc<LimitsInner>,
    transitions: bool,
    timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl MockLimits {
    pub fn new(transitions: bool) -> Self {
        Self {
            inner: Arc::new(LimitsInner::default()),
            transitions,
            timer: Mutex::new(None),
        }
    }
}

impl LimitsApi for MockLimits {
    fn current(&self) -> Option<RateLimits> {
        self.inner.limits.lock().unwrap().clone()
    }

    fn on_change(&self, listener: Box<dyn Fn(Option<RateLimits>) + Send + Sync>) -> Unsubscribe {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        self.inner
            .listeners
            .lock()
            .unwrap()
            .push((id, Arc::from(listener)));
        let inner = self.inner.clone();
        Box::new(move || {
            inner.listeners.lock().unwrap().retain(|(i, _)| *i != id);
        })
    }

    fn start(&self) {
        self.inner.emit();
        if !self.transitions {
            return;
        }
        // The TS timer is `unref`ed so it cannot hold the process open; a tokio
        // task is not a process handle, so nothing corresponds to that here.
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let inner = self.inner.clone();
        let handle = rt.spawn(async move {
            let period = std::time::Duration::from_millis(LIMIT_STEP_PERIOD_MS);
            let mut ticker =
                tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            let len = limit_steps().len();
            loop {
                ticker.tick().await;
                {
                    let mut step = inner.step.lock().unwrap();
                    *step = (*step + 1) % len;
                }
                inner.emit();
            }
        });
        *self.timer.lock().unwrap() = Some(handle);
    }

    fn stop(&self) {
        if let Some(h) = self.timer.lock().unwrap().take() {
            h.abort();
        }
        self.inner.listeners.lock().unwrap().clear();
    }
}

/* ----------------------------------------------------------------- panes -- */

pub struct MockPanes;

#[async_trait]
impl PaneApi for MockPanes {
    async fn meta(&self, _pane_id: &str) -> anyhow::Result<PaneMeta> {
        Ok(PaneMeta {
            cols: PANE_COLS,
            rows: PANE_ROWS,
            cursor_x: CURSOR_COL,
            cursor_y: CURSOR_ROW,
            // A live agent is a full-screen TUI, so the fixture pane reports the
            // alternate screen and a live process — the same combination the
            // frame path sees against a real agent (`mock.ts:360`).
            alternate: true,
            dead: false,
        })
    }

    async fn capture(&self, pane_id: &str, rows: usize) -> anyhow::Result<Vec<String>> {
        let dim = format!("{ESC}38;5;246m");
        let off = format!("{ESC}39m");
        let rule = "─".repeat(RULE_WIDTH);
        let mut lines = vec![
            format!("{dim}╭─ mock pane {pane_id} ───────────────────╮{off}"),
            String::new(),
            format!("{ESC}38;5;44m⏺{off} Reading src/components/Header.astro"),
            format!("  {dim}Read 1 file, ran 2 shell commands{off}"),
            String::new(),
            format!("{ESC}38;5;220m✻{off} Hyperspacing… (2m 14s · {dim}↓ 48.1k tokens{off})"),
            String::new(),
            format!("{dim}{rule}{off}"),
            "❯ ".to_string(),
            format!("{dim}{rule}{off}"),
            format!("  {ESC}38;5;220m⏵⏵ auto mode on{dim} · esc to interrupt{off}"),
        ];
        while lines.len() < rows {
            lines.push(String::new());
        }
        lines.truncate(rows);
        Ok(lines)
    }

    /// The same one-round-trip shape the real adapter has, so the hub is exercised.
    async fn sample(&self, pane_id: &str) -> anyhow::Result<PaneSample> {
        let meta = self.meta(pane_id).await?;
        let lines = self.capture(pane_id, meta.rows).await?;
        Ok(PaneSample { meta, lines })
    }

    async fn paste(&self, pane_id: &str, text: &str, submit: Submit) -> anyhow::Result<()> {
        // Only a submitted message becomes a transcript entry; loose keystrokes
        // sent by the terminal view do not.
        if submit == Submit::No {
            return Ok(());
        }
        let Some(session_id) = SESSION_BY_PANE.get(pane_id) else {
            return Ok(());
        };
        ECHOES
            .lock()
            .unwrap()
            .entry(session_id.clone())
            .or_default()
            .push(Echo {
                at: now_ms(),
                text: text.to_string(),
            });
        Ok(())
    }

    async fn key(&self, _pane_id: &str, _key_name: &str) -> anyhow::Result<()> {
        Ok(())
    }
}

/* ------------------------------------------------------------------ tail -- */

pub struct MockTail {
    session_id: String,
    sent: bool,
    echo_cursor: usize,
}

impl MockTail {
    pub fn new(session_id: String) -> Self {
        Self {
            session_id,
            sent: false,
            echo_cursor: 0,
        }
    }
}

impl MockTail {
    /// Everything sent from the browser since this reader last looked.
    fn echoes_since_last_read(&mut self) -> TailRead {
        let log = ECHOES
            .lock()
            .unwrap()
            .get(&self.session_id)
            .cloned()
            .unwrap_or_default();
        if self.echo_cursor >= log.len() {
            return TailRead::default();
        }
        let events = log[self.echo_cursor..]
            .iter()
            .enumerate()
            .map(|(offset, entry)| TimelineEvent {
                // Stable across readers: the same entry gets the same id
                // whoever reads it, so two tails cannot introduce the same
                // message twice.
                id: format!("{}:echo:{}", self.session_id, self.echo_cursor + offset),
                // Stamped when it was sent, not when it happened to be read —
                // a later reader replaying the log must not restamp the
                // conversation as "now".
                at: entry.at,
                kind: TimelineKind::User,
                text: entry.text.clone(),
                tool: None,
                sidechain: None,
                notice: None,
                tokens_before: None,
                tokens_after: None,
            })
            .collect();
        self.echo_cursor = log.len();
        TailRead {
            events,
            patch: AgentPatch::default(),
            first: false,
        }
    }

    /// The backfill every reader gets once: the fixture conversation, stamped
    /// with this session's ids.
    fn replay_the_fixture_timeline(&self) -> TailRead {
        let events = mock_timeline()
            .into_iter()
            .enumerate()
            .map(|(index, (at, kind, tool, text))| TimelineEvent {
                id: format!("{}:{}", self.session_id, index),
                at,
                kind,
                text: text.to_string(),
                tool: tool.map(str::to_string),
                sidechain: None,
                notice: None,
                tokens_before: None,
                tokens_after: None,
            })
            .collect();
        TailRead {
            events,
            patch: AgentPatch::default(),
            first: true,
        }
    }
}

#[async_trait]
impl TailApi for MockTail {
    async fn read(&mut self) -> anyhow::Result<TailRead> {
        if self.sent {
            return Ok(self.echoes_since_last_read());
        }
        self.sent = true;
        Ok(self.replay_the_fixture_timeline())
    }
}

/* ------------------------------------------------------------------ deps -- */

/// Whether the fixture fleet moves on its own, as `--mock-transitions` asks.
///
/// An alias rather than a two-variant enum because the flag is threaded in from
/// the parsed CLI options, and naming it here is the part that was missing.
pub type Transitions = bool;

/// Everything `routes` needs, in mock form.
pub fn mock_deps(transitions: Transitions) -> (Deps, Arc<MockSource>) {
    let source = Arc::new(MockSource::new(transitions));
    let deps = Deps {
        source: source.clone(),
        panes: Arc::new(MockPanes),
        limits: Arc::new(MockLimits::new(transitions)),
        tail_for: Arc::new(|agent: &Agent| {
            Some(Box::new(MockTail::new(agent.session_id.clone())) as Box<dyn TailApi>)
        }),
    };
    (deps, source)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A name longer than this stops fitting a fleet card, which is the whole
    /// reason the over-long fixture exists.
    const NAME_THAT_OVERFLOWS_A_CARD: usize = 40;

    /// Where the fixture pane puts its prompt line, and how many rows a caller
    /// has to ask for before the capture starts truncating rather than padding.
    const PROMPT_ROW: usize = 8;
    const FEWER_ROWS_THAN_CONTENT: usize = 3;

    /// The `Subagent` entry in the fixture conversation — the one the chat
    /// renders differently from an ordinary tool call.
    const SUBAGENT_EVENT: usize = 4;

    /// Where the never-prompted fixture sits in the fleet, which is what proves
    /// `enrich` patched in place rather than reordering.
    const FRESH_FIXTURE_POSITION: usize = 7;

    /// One reading per branch the meter has: ok, warn, critical, spent.
    const METER_BRANCHES: usize = 4;

    /// The whole fixture set, captured verbatim from `node dist/server/cli.js
    /// --mock --port 4491` hitting `GET /api/agents`, keys sorted.
    ///
    /// This is the differential-testing contract: both backends are run with
    /// `--mock` and their JSON compared field by field, so a fixture that drifts
    /// on either side shows up as a false difference in every later comparison.
    /// Compared as parsed values, not bytes — key order is `types.rs`'s business,
    /// and the TS object literals are in a different order anyway.
    /// Captured from the Node server this port replaces, running `--mock` on
    /// port 4400 at the tip of `main`:
    ///
    /// ```sh
    /// npx tsx src/server/cli.ts --mock --port 4400 &
    /// curl -s http://127.0.0.1:4400/api/agents | python3 -m json.tool --sort-keys
    /// ```
    ///
    /// Kept as a file rather than a literal so it can be regenerated and
    /// diffed. It is the oracle for the whole port: if these bytes differ, the
    /// React client and the Playwright suite are looking at a different server.
    const NODE_MOCK_AGENTS: &str = include_str!("../tests/golden/agents.json");

    /// Captured from the same Node server as the fleet. Node ages are relative
    /// to a live clock, so this compares everything except `lastWriteAt`.
    const NODE_MOCK_TREE: &str = include_str!("../tests/golden/tree.json");

    /// Strip the one field that cannot be stable across two processes.
    fn without_write_times(mut v: serde_json::Value) -> serde_json::Value {
        match &mut v {
            serde_json::Value::Object(map) => {
                map.remove("lastWriteAt");
                for (_, child) in map.iter_mut() {
                    *child = without_write_times(child.take());
                }
            }
            serde_json::Value::Array(items) => {
                for item in items.iter_mut() {
                    *item = without_write_times(item.take());
                }
            }
            _ => {}
        }
        v
    }

    #[test]
    fn inv13_the_fixture_forest_matches_the_node_server() {
        let want = without_write_times(serde_json::from_str(NODE_MOCK_TREE).unwrap());
        let trees: Vec<_> = fixtures().iter().map(|a| mock_tree(a, now_ms())).collect();
        let got = without_write_times(serde_json::json!({ "trees": trees }));
        assert_eq!(got, want);
    }

    #[test]
    fn inv13_a_cli_with_no_transcript_says_unknown_rather_than_none() {
        let kiro = by_id("tmux:kiro-1787832510");
        let tree = mock_tree(&kiro, now_ms());
        // Absence of evidence, not evidence of absence: an empty `children`
        // here must never read as "delegated nothing".
        assert_eq!(tree.unknown, Some(true));
        assert!(tree.children.is_empty());

        // A Claude session that simply never delegated is the other case, and
        // it is a different claim: empty, and *known* to be empty.
        let quiet = by_id("mock-idle-kb");
        let tree = mock_tree(&quiet, now_ms());
        assert_eq!(tree.unknown, None);
        assert!(tree.children.is_empty());
    }

    #[test]
    fn fixtures_serialise_exactly_as_the_node_server_does() {
        // The capture is the whole `/api/agents` body; the fleet is under
        // `agents`, exactly as the route serves it.
        let want: serde_json::Value = serde_json::from_str(NODE_MOCK_AGENTS).unwrap();
        let got = serde_json::json!({ "agents": fixtures(), "mock": true });
        assert_eq!(got, want);
    }

    fn by_id(id: &str) -> Agent {
        fixtures()
            .into_iter()
            .find(|a| a.session_id == id)
            .unwrap_or_else(|| panic!("no fixture {id}"))
    }

    #[test]
    fn fixture_roster_matches_the_ts_source() {
        let ids: Vec<String> = fixtures().into_iter().map(|a| a.session_id).collect();
        assert_eq!(
            ids,
            vec![
                "mock-waiting",
                "mock-busy",
                "mock-busy-2",
                "mock-long-name",
                "mock-idle-kb",
                "mock-idle-ce",
                "mock-idle-db",
                "mock-fresh",
                "mock-no-tmux",
                // Discovered from tmux, not from a session file it wrote.
                "tmux:kiro-1787832510",
            ]
        );
    }

    #[test]
    fn pids_and_panes_match() {
        let fleet = fixtures();
        let got: Vec<(i64, Option<&str>)> = fleet
            .iter()
            .map(|a| (a.pid, a.pane_id.as_deref()))
            .collect();
        assert_eq!(
            got,
            vec![
                (WAITING_PID, Some("%76")),
                (BUSY_PID, Some("%77")),
                (DELEGATING_PID, Some("%75")),
                (LONG_NAME_PID, Some("%79")),
                (IDLE_KB_PID, Some("%72")),
                (IDLE_CE_PID, Some("%73")),
                (IDLE_DB_PID, Some("%78")),
                (FRESH_PID, Some("%0")),
                (HEADLESS_PID, None),
                (KIRO_PID, Some("%302")),
            ]
        );
    }

    /// The awkwardness is the point: if these ever get tidied the fixture stops
    /// being a review surface.
    #[test]
    fn the_over_long_name_is_still_over_long() {
        let a = by_id("mock-long-name");
        assert_eq!(a.name, "agent-commander-web-dashboard-ux-review-pass");
        assert!(
            a.name.len() > NAME_THAT_OVERFLOWS_A_CARD,
            "the long name must not be shortened"
        );
    }

    /// The never-prompted session has no activity line at all and no token
    /// count, so the card has to render from nothing but a name.
    ///
    /// The TS header says "two have never been prompted"; the fixture list it
    /// describes has exactly one such session. The list is the contract the two
    /// backends are diffed against, so the count asserted here follows the data,
    /// not the prose.
    #[test]
    fn one_session_has_never_been_prompted() {
        let never: Vec<String> = fixtures()
            .into_iter()
            .filter(|a| a.activity.is_none())
            .map(|a| a.session_id)
            .collect();
        assert_eq!(never, vec!["mock-fresh", "tmux:kiro-1787832510"]);
        let a = by_id("mock-fresh");
        assert_eq!(a.tokens, None);
        assert_eq!(a.last_activity_at, None);
        assert_eq!(a.last_prompt, None);
        assert_eq!(a.ai_title, None);
    }

    /// Sessions crammed into one directory with auto-generated names: the case
    /// where the folder tells the reader nothing and the card has to.
    ///
    /// Same drift as above — the TS header says five share the home directory,
    /// the fixture list has four. Asserted against the data.
    #[test]
    fn several_sessions_share_the_home_directory() {
        let home: Vec<String> = fixtures()
            .into_iter()
            .filter(|a| a.cwd == "/Users/demo" && a.folder == "demo")
            .map(|a| a.session_id)
            .collect();
        assert_eq!(
            home,
            vec!["mock-idle-kb", "mock-idle-ce", "mock-idle-db", "mock-fresh"]
        );
        let derived: Vec<String> = fixtures()
            .into_iter()
            .filter(|a| a.derived_name == Some(true))
            .map(|a| a.session_id)
            .collect();
        assert_eq!(
            derived,
            vec!["mock-waiting", "mock-idle-ce", "mock-idle-db", "mock-fresh", "tmux:kiro-1787832510"]
        );
        // Each auto-named one falls back differently, which is the point of
        // having four: title, last prompt, folder, and nothing at all.
        assert_eq!(
            by_id("mock-idle-ce").ai_title.as_deref(),
            Some("Find an alternative markdown editor to Obsidian")
        );
        assert_eq!(
            by_id("mock-idle-db").last_prompt.as_deref(),
            Some("check the npm download numbers for react-hig-datepicker")
        );
        assert_eq!(by_id("mock-waiting").folder, "kb-vault");
    }

    #[test]
    fn timestamps_hang_off_the_frozen_clock() {
        assert_eq!(START, 1_786_600_000_000);
        let a = by_id("mock-waiting");
        assert_eq!(a.started_at, START - 3_600_000);
        assert_eq!(a.last_activity_at, Some(START - 240_000));
        assert_eq!(by_id("mock-idle-ce").started_at, START - 50_400_000);
    }

    #[test]
    fn the_busy_fixture_carries_a_rejected_goal() {
        let g = by_id("mock-busy").goal.expect("mock-busy has a goal");
        assert_eq!(
            g.condition,
            "every test passes and the locale sweep reports no layout breakage at 80 columns"
        );
        assert!(!g.met);
        assert_eq!(g.at, START - 300_000);
        assert_eq!(
            g.reason.as_deref(),
            Some("Two locale snapshots still differ at 80 columns.")
        );
        assert_eq!(g.fresh, None);
    }

    #[test]
    fn the_delegating_fixture_is_parked_on_a_subagent() {
        let a = by_id("mock-busy-2");
        assert_eq!(a.delegating, Some(true));
        assert_eq!(a.subagents, Some(2));
    }

    #[test]
    fn the_headless_fixture_cannot_be_attached_to() {
        let a = by_id("mock-no-tmux");
        assert_eq!(a.kind, "background");
        assert_eq!(a.pane_id, None);
        assert_eq!(a.tmux_session, None);
        assert_eq!(
            a.attach_blocked_reason.as_deref(),
            Some("session is not running inside tmux")
        );
    }

    #[test]
    fn tokens_are_exactly_as_written() {
        let got: Vec<Option<i64>> = fixtures().into_iter().map(|a| a.tokens).collect();
        assert_eq!(
            got,
            vec![
                Some(48_120),
                Some(111_800),
                Some(67_500),
                Some(23_900),
                Some(59_800),
                Some(31_900),
                Some(8_800),
                None,
                Some(2_010),
                // A CLI that keeps no transcript has no token count to give,
                // and absent is the honest answer rather than zero (INV-11).
                None,
            ]
        );
    }

    #[tokio::test]
    async fn capture_uses_real_escape_bytes_and_pads_to_rows() {
        let panes = MockPanes;
        let lines = panes.capture("%76", PANE_ROWS).await.unwrap();
        assert_eq!(lines.len(), PANE_ROWS);
        assert!(lines[0].starts_with("\u{001b}[38;5;246m"));
        assert!(lines[0].contains("mock pane %76"));
        assert_eq!(lines[PROMPT_ROW], "❯ ");
        assert!(lines[PANE_ROWS - 1].is_empty());
        // Fewer rows than content truncates rather than overflows.
        let short = panes.capture("%76", FEWER_ROWS_THAN_CONTENT).await.unwrap();
        assert_eq!(short.len(), FEWER_ROWS_THAN_CONTENT);
    }

    #[tokio::test]
    async fn meta_is_the_fixture_geometry() {
        let meta = MockPanes.meta("%76").await.unwrap();
        assert_eq!(meta.cols, PANE_COLS);
        assert_eq!(meta.rows, PANE_ROWS);
        assert_eq!(meta.cursor_x, CURSOR_COL);
        assert_eq!(meta.cursor_y, CURSOR_ROW);
        assert!(meta.alternate, "a live agent draws on the alternate screen");
        assert!(!meta.dead);
    }

    #[tokio::test]
    async fn the_first_tail_read_replays_the_fixture_timeline() {
        let mut tail = MockTail::new("mock-busy".into());
        let first = tail.read().await.unwrap();
        assert!(first.first);
        assert_eq!(first.events.len(), mock_timeline().len());
        assert_eq!(first.events[0].id, "mock-busy:0");
        assert_eq!(first.events[0].at, START - 300_000);
        assert_eq!(first.events[0].kind, TimelineKind::User);
        assert_eq!(first.events[2].tool.as_deref(), Some("Glob"));
        assert_eq!(first.events[SUBAGENT_EVENT].kind, TimelineKind::Subagent);
        let second = tail.read().await.unwrap();
        assert!(!second.first);
        assert!(second.events.is_empty());
    }

    /// Two readers must both see a submitted paste, with the same ids: the bug
    /// this shape fixes was one reader draining the queue out from under the
    /// other.
    #[tokio::test]
    async fn submitted_pastes_echo_to_every_reader() {
        let session = "mock-idle-kb";
        ECHOES.lock().unwrap().remove(session);
        let panes = MockPanes;
        // %72 belongs to mock-idle-kb.
        panes.paste("%72", "not submitted", Submit::No).await.unwrap();
        panes.paste("%72", "hello", Submit::Yes).await.unwrap();

        let mut a = MockTail::new(session.into());
        let mut b = MockTail::new(session.into());
        a.read().await.unwrap();
        b.read().await.unwrap();
        let ra = a.read().await.unwrap();
        let rb = b.read().await.unwrap();
        assert_eq!(ra.events.len(), 1);
        assert_eq!(rb.events.len(), 1);
        assert_eq!(ra.events[0].text, "hello");
        assert_eq!(ra.events[0].id, rb.events[0].id);
        assert_eq!(ra.events[0].id, format!("{session}:echo:0"));
        // Drained once per reader, not once globally.
        assert!(a.read().await.unwrap().events.is_empty());
        ECHOES.lock().unwrap().remove(session);
    }

    #[test]
    fn limit_steps_walk_every_meter_branch() {
        let steps = limit_steps();
        assert_eq!(steps.len(), METER_BRANCHES);
        let pcts: Vec<(f64, Option<f64>)> = steps
            .iter()
            .map(|step| {
                (
                    step.five_hour.as_ref().unwrap().pct,
                    step.seven_day.as_ref().map(|window| window.pct),
                )
            })
            .collect();
        assert_eq!(
            pcts,
            vec![
                (OK_FIVE_HOUR_PCT, Some(OK_SEVEN_DAY_PCT)),
                (WARN_FIVE_HOUR_PCT, Some(WARN_SEVEN_DAY_PCT)),
                (CRITICAL_FIVE_HOUR_PCT, None),
                (SPENT_FIVE_HOUR_PCT, Some(SPENT_SEVEN_DAY_PCT)),
            ]
        );
    }

    #[tokio::test]
    async fn limits_emit_on_start_with_reset_times_relative_to_now() {
        let l = MockLimits::new(false);
        assert!(l.current().is_none());
        l.start();
        let cur = l.current().expect("emitted on start");
        let five = cur.five_hour.expect("five hour window");
        assert_eq!(five.pct, OK_FIVE_HOUR_PCT);
        assert_eq!(five.resets_at, Some(cur.at + FIVE_HOUR_RESETS_IN_MS));
        let seven = cur.seven_day.expect("seven day window");
        assert_eq!(seven.pct, OK_SEVEN_DAY_PCT);
        assert_eq!(seven.resets_at, Some(cur.at + SEVEN_DAY_RESETS_IN_MS));
        l.stop();
    }

    #[tokio::test]
    async fn a_static_source_never_moves() {
        let s = MockSource::new(false);
        s.start().await.unwrap();
        assert_eq!(s.list().len(), 10);
        assert_eq!(s.get("mock-waiting").unwrap().status, AgentStatus::Waiting);
        assert!(s.get("nope").is_none());
        s.stop();
    }

    #[tokio::test(start_paused = true)]
    async fn transitions_flip_the_blocked_fixture_and_clear_its_reason() {
        let s = MockSource::new(true);
        s.start().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(3_100)).await;
        let a = s.get("mock-waiting").unwrap();
        assert_eq!(a.status, AgentStatus::Idle);
        assert_eq!(a.waiting_for, None, "a stale reason must not outlive the state");
        tokio::time::sleep(std::time::Duration::from_millis(3_000)).await;
        let b = s.get("mock-waiting").unwrap();
        assert_eq!(b.status, AgentStatus::Waiting);
        assert_eq!(b.waiting_for.as_deref(), Some("dialog open"));
        s.stop();
    }

    #[test]
    fn enrich_patches_in_place_and_keeps_order() {
        let s = MockSource::new(false);
        s.enrich(
            "mock-fresh",
            AgentPatch {
                activity: Some("Read: notes.md".into()),
                ..Default::default()
            },
        );
        assert_eq!(
            s.get("mock-fresh").unwrap().activity.as_deref(),
            Some("Read: notes.md")
        );
        assert_eq!(s.list()[FRESH_FIXTURE_POSITION].session_id, "mock-fresh");
        // A patch for an unknown session is a no-op, not a new agent.
        s.enrich("ghost", AgentPatch::default());
        assert_eq!(s.list().len(), 10);
    }
}

/* -------------------------------------------------------------------------
 * The fixture fleet's delegation trees (INV-13).
 *
 * Deliberately awkward, for the same reason the fleet itself is: a depth-3
 * chain, a delegate the user stopped, one node in each of the three states, an
 * orphan whose parent is not on disk, a whole family that has gone silent
 * together, an agent that has delegated nothing, and a CLI that cannot say
 * either way. Every one of those is a case the view has to render correctly and
 * none of them is the happy path.
 * ---------------------------------------------------------------------- */

const MINUTE_MS: i64 = 60_000;
const STOPPED_AUDIT_AGE_MS: i64 = 18 * MINUTE_MS;
const UNCLAIMED_TRIAGE_AGE_MS: i64 = 14 * MINUTE_MS;
const FINISHED_RESEARCH_AGE_MS: i64 = 11 * MINUTE_MS;
const FINISHED_CROSS_CHECK_AGE_MS: i64 = 13 * MINUTE_MS;
const ORPHANED_SWEEP_AGE_MS: i64 = 22 * MINUTE_MS;
const SILENT_MIGRATION_AGE_MS: i64 = 16 * MINUTE_MS;
const SILENT_CALLERS_AGE_MS: i64 = 19 * MINUTE_MS;

/// The defaults every fixture node starts from, so each one below states only
/// what makes it interesting — the same shape as `fixtureNodes` in `mock.ts`.
fn node(agent_id: &str, description: &str, wrote_ms_ago: i64, now: i64) -> SubagentNode {
    SubagentNode {
        agent_id: agent_id.into(),
        agent_type: "general-purpose".into(),
        description: description.into(),
        depth: 1,
        parent_agent_id: None,
        last_write_at: now - wrote_ms_ago,
        bytes: 40_000,
        state: SubagentState::Quiet,
        state_inferred: None,
        stopped_by_user: None,
        reparented: None,
        children: Vec::new(),
    }
}

/// One agent's delegates, or the honest absence of an answer.
pub fn mock_tree(agent: &Agent, now: i64) -> AgentTree {
    // A CLI that keeps no transcript cannot be said to have delegated nothing:
    // the evidence lives in files it does not write (INV-13).
    if !has_transcripts(&agent.agent_kind) {
        return AgentTree {
            session_id: agent.session_id.clone(),
            children: Vec::new(),
            unknown: Some(true),
        };
    }
    AgentTree {
        session_id: agent.session_id.clone(),
        children: match agent.session_id.as_str() {
            "mock-busy" => vec![
                stopped_ux_audit(now),
                running_qa_sweep(now),
                wrapping_triage_brief(now),
            ],
            "mock-busy-2" => vec![kissa_listening_list(now), orphaned_vault_sweep(now)],
            "mock-quiet-family" => silent_migration(now),
            "mock-long-name" => vec![review_of_the_diff(now)],
            _ => Vec::new(),
        },
        unknown: None,
    }
}

/// The user stopped it: the one delegate here with evidence of an ending.
fn stopped_ux_audit(now: i64) -> SubagentNode {
    SubagentNode {
        agent_type: "ux-bar-raiser".into(),
        bytes: 412_000,
        state: SubagentState::Done,
        stopped_by_user: Some(true),
        ..node(
            "a58ddcc3c4b6b8989",
            "UX audit of the terminal system monitor",
            STOPPED_AUDIT_AGE_MS,
            now,
        )
    }
}

/// A sweep and the check it handed down, both `active` only by inference.
///
/// Two of them, at two depths, so the dashed edge and the word the view marks a
/// guess with are on screen somewhere other than a root.
fn running_qa_sweep(now: i64) -> SubagentNode {
    let contrast_check = SubagentNode {
        depth: 2,
        parent_agent_id: Some("ac4c01953dfb1440f".into()),
        bytes: 71_000,
        state: SubagentState::Active,
        state_inferred: Some(true),
        ..node(
            "ad49ce3a43efeaa2b",
            "Check contrast at 20 columns in both themes",
            9_000,
            now,
        )
    };
    SubagentNode {
        agent_type: "qa-bar-raiser".into(),
        bytes: 188_000,
        state: SubagentState::Active,
        state_inferred: Some(true),
        children: vec![contrast_check],
        ..node(
            "ac4c01953dfb1440f",
            "Adversarial QA sweep across every terminal size",
            4_000,
            now,
        )
    }
}

/// A brief long enough to need wrapping — the widest thing in this view, and
/// widths break in the awkward case rather than the tidy one.
fn wrapping_triage_brief(now: i64) -> SubagentNode {
    SubagentNode {
        agent_type: "qa-triage".into(),
        bytes: 52_000,
        ..node(
            "a6c07bfd53044168f",
            "Independent second pass over the QA report, verifying every \
             claimed finding against the source before it is believed",
            UNCLAIMED_TRIAGE_AGE_MS,
            now,
        )
    }
}

/// A depth-3 chain: a delegate whose delegate delegated again.
fn kissa_listening_list(now: i64) -> SubagentNode {
    let opening_hours = SubagentNode {
        depth: 3,
        parent_agent_id: Some("a69275682c401ef83".into()),
        bytes: 96_000,
        state: SubagentState::Done,
        ..node(
            "ab481603df0bb2d1d",
            "Cross-check opening hours against the venues",
            FINISHED_CROSS_CHECK_AGE_MS,
            now,
        )
    };
    let regional_research = SubagentNode {
        depth: 2,
        parent_agent_id: Some("a9b1181eab51efaf0".into()),
        bytes: 244_000,
        state: SubagentState::Done,
        children: vec![opening_hours],
        ..node(
            "a69275682c401ef83",
            "Research Benelux, Italy and Spain bars",
            FINISHED_RESEARCH_AGE_MS,
            now,
        )
    };
    SubagentNode {
        agent_type: "find-music".into(),
        bytes: 301_000,
        state: SubagentState::Active,
        state_inferred: Some(true),
        children: vec![regional_research],
        ..node(
            "a9b1181eab51efaf0",
            "Kissa listening list for Tokyo and Yokohama",
            2_000,
            now,
        )
    }
}

/// Its parent is not on disk. Raised to the top and marked, rather than dropped
/// along with anything below it — see `assemble` in `subagents.rs` and INV-13.
fn orphaned_vault_sweep(now: i64) -> SubagentNode {
    SubagentNode {
        agent_type: "Explore".into(),
        depth: 2,
        parent_agent_id: Some("a-parent-that-is-gone".into()),
        bytes: 31_000,
        reparented: Some(true),
        ..node(
            "ab21ff3003f5f193c",
            "Sweep the vault for existing kissa notes",
            ORPHANED_SWEEP_AGE_MS,
            now,
        )
    }
}

/// Two delegates that have both stopped writing, under a parent that has too.
///
/// Neither is `done` — nothing recorded an ending for either — so the honest
/// reading of the whole family is that nobody has checked on it, which is the
/// question INV-15 puts on the card.
fn silent_migration(now: i64) -> Vec<SubagentNode> {
    vec![
        SubagentNode {
            bytes: 87_000,
            ..node(
                "a3f81c0b7d2e45a19",
                "Rewrite migration 0042 against the new schema",
                SILENT_MIGRATION_AGE_MS,
                now,
            )
        },
        SubagentNode {
            agent_type: "Explore".into(),
            bytes: 24_000,
            ..node(
                "a7d20e91fc8b3a604",
                "Find every caller of the old billing columns",
                SILENT_CALLERS_AGE_MS,
                now,
            )
        },
    ]
}

/// The sole delegate of the agent whose name is too long for its card.
fn review_of_the_diff(now: i64) -> SubagentNode {
    SubagentNode {
        agent_type: "code-reviewer".into(),
        bytes: 118_000,
        ..node(
            "af0e1cdf1ec262236",
            "Review the diff for correctness",
            8_000,
            now,
        )
    }
}
