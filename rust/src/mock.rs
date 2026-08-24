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

use crate::sources::{
    AgentPatch, AgentSource, Deps, LimitsApi, PaneApi, PaneMeta, PaneSample, TailApi, TailRead,
    Unsubscribe,
};
use crate::types::{
    now_ms, Agent, AgentStatus, GoalState, RateLimits, TimelineEvent, TimelineKind, UsageWindow,
};

/// Frozen clock. Every fixture timestamp is an offset from this, so two runs —
/// and the two backends — produce identical output.
const START: i64 = 1_786_600_000_000;

/// Real escape byte, so mock frames exercise the same ANSI path as live captures.
const ESC: &str = "\u{001b}[";

/// Deliberately modelled on a real, awkward fleet rather than a flattering one:
/// five sessions share the home directory with auto-generated names, one name is
/// far too long for its card, and two have never been prompted so they have no
/// activity at all. If the UI reads well here it reads well anywhere.
fn fixtures() -> Vec<Agent> {
    vec![
        Agent {
            session_id: "mock-waiting".into(),
            pid: 28707,
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
            ..Default::default()
        },
        Agent {
            session_id: "mock-busy".into(),
            pid: 4421,
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
            subagents: Some(3),
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
            ..Default::default()
        },
        Agent {
            session_id: "mock-busy-2".into(),
            pid: 47117,
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
            ..Default::default()
        },
        Agent {
            session_id: "mock-long-name".into(),
            pid: 18731,
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
            ..Default::default()
        },
        Agent {
            session_id: "mock-idle-kb".into(),
            pid: 34625,
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
            ..Default::default()
        },
        Agent {
            session_id: "mock-idle-ce".into(),
            pid: 50893,
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
            ..Default::default()
        },
        Agent {
            session_id: "mock-idle-db".into(),
            pid: 53848,
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
            ..Default::default()
        },
        Agent {
            session_id: "mock-fresh".into(),
            pid: 2330,
            name: "ziweiwu-35".into(),
            // Auto-named, never prompted, and running in the home directory:
            // there is genuinely nothing better to call it, so it keeps its own
            // name.
            derived_name: Some(true),
            cwd: "/Users/demo".into(),
            folder: "demo".into(),
            status: AgentStatus::Idle,
            kind: "interactive".into(),
            started_at: START - 600_000,
            version: Some("2.1.232".into()),
            pane_id: Some("%0".into()),
            tmux_session: Some("claude-mock-h".into()),
            ..Default::default()
        },
        Agent {
            session_id: "mock-no-tmux".into(),
            pid: 6556,
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
            ..Default::default()
        },
    ]
}

/// The fixture transcript, without ids — `MockTail` stamps those per session.
fn mock_timeline() -> Vec<(i64, TimelineKind, Option<&'static str>, &'static str)> {
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
            .map(|(_, f)| f.clone())
            .collect();
        for f in subs {
            f(list.clone());
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

impl MockSource {
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

    fn on_change(&self, f: Box<dyn Fn(Vec<Agent>) + Send + Sync>) -> Unsubscribe {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        self.inner.listeners.lock().unwrap().push((id, Arc::from(f)));
        let inner = self.inner.clone();
        Box::new(move || {
            inner.listeners.lock().unwrap().retain(|(i, _)| *i != id);
        })
    }

    fn enrich(&self, session_id: &str, patch: AgentPatch) {
        let mut agents = self.inner.agents.lock().unwrap();
        if let Some(a) = agents.iter_mut().find(|a| a.session_id == session_id) {
            patch.apply(a);
        }
    }

    fn notify(&self) {
        self.inner.notify();
    }

    async fn start(&self) -> anyhow::Result<()> {
        if !self.transitions {
            return Ok(());
        }
        let inner = self.inner.clone();
        let handle = tokio::spawn(async move {
            // `interval_at` rather than `interval`: tokio's first tick fires
            // immediately, JS's `setInterval` waits out the first period.
            let period = std::time::Duration::from_millis(3000);
            let mut ticker =
                tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            loop {
                ticker.tick().await;
                {
                    let mut agents = inner.agents.lock().unwrap();
                    let Some(agent) = agents.iter_mut().find(|a| a.session_id == "mock-waiting")
                    else {
                        return;
                    };
                    let blocked = agent.status == AgentStatus::Waiting;
                    agent.status = if blocked {
                        AgentStatus::Idle
                    } else {
                        AgentStatus::Waiting
                    };
                    // Cleared when it unblocks, so a stale reason cannot outlive
                    // the state it explained.
                    agent.waiting_for = if blocked {
                        None
                    } else {
                        Some("dialog open".into())
                    };
                }
                inner.notify();
            }
        });
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

/// Quota readings for mock mode.
///
/// The steps are chosen to walk the meter through every branch the UI has —
/// ok, warn, critical — and one reading with `sevenDay` missing, because a
/// session that has not yet touched the weekly window reports exactly that and
/// a component that assumes both windows exist will throw on it. The numbers are
/// deliberately un-round so a hardcoded fallback cannot masquerade as real data.
fn limit_steps() -> Vec<RateLimits> {
    let w = |pct: f64| {
        Some(UsageWindow {
            pct,
            resets_at: None,
        })
    };
    vec![
        RateLimits {
            five_hour: w(12.4),
            seven_day: w(31.8),
            at: 0,
        },
        RateLimits {
            five_hour: w(61.4),
            seven_day: w(47.2),
            at: 0,
        },
        RateLimits {
            five_hour: w(83.6),
            seven_day: None,
            at: 0,
        },
        RateLimits {
            five_hour: w(96.1),
            seven_day: w(88.3),
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
                resets_at: Some(now + 2 * 3_600_000),
            }),
            seven_day: base.seven_day.map(|w| UsageWindow {
                pct: w.pct,
                resets_at: Some(now + 3 * 86_400_000),
            }),
            at: now,
        };
        *self.limits.lock().unwrap() = Some(next.clone());
        let subs: Vec<_> = self
            .listeners
            .lock()
            .unwrap()
            .iter()
            .map(|(_, f)| f.clone())
            .collect();
        for f in subs {
            f(Some(next.clone()));
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

    fn on_change(&self, f: Box<dyn Fn(Option<RateLimits>) + Send + Sync>) -> Unsubscribe {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        self.inner.listeners.lock().unwrap().push((id, Arc::from(f)));
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
            let period = std::time::Duration::from_millis(4000);
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
            cols: 96,
            rows: 24,
            cursor_x: 2,
            cursor_y: 21,
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
        let rule = "─".repeat(60);
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

    async fn paste(&self, pane_id: &str, text: &str, submit: bool) -> anyhow::Result<()> {
        // Only a submitted message becomes a transcript entry; loose keystrokes
        // sent by the terminal view do not.
        if !submit {
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

#[async_trait]
impl TailApi for MockTail {
    async fn read(&mut self) -> anyhow::Result<TailRead> {
        if self.sent {
            let log = ECHOES
                .lock()
                .unwrap()
                .get(&self.session_id)
                .cloned()
                .unwrap_or_default();
            if self.echo_cursor >= log.len() {
                return Ok(TailRead::default());
            }
            let events = log[self.echo_cursor..]
                .iter()
                .enumerate()
                .map(|(i, entry)| TimelineEvent {
                    // Stable across readers: the same entry gets the same id
                    // whoever reads it, so two tails cannot introduce the same
                    // message twice.
                    id: format!("{}:echo:{}", self.session_id, self.echo_cursor + i),
                    // Stamped when it was sent, not when it happened to be read —
                    // a later reader replaying the log must not restamp the
                    // conversation as "now".
                    at: entry.at,
                    kind: TimelineKind::User,
                    text: entry.text.clone(),
                    tool: None,
                    sidechain: None,
                })
                .collect();
            self.echo_cursor = log.len();
            return Ok(TailRead {
                events,
                patch: AgentPatch::default(),
                first: false,
            });
        }
        self.sent = true;
        let events = mock_timeline()
            .into_iter()
            .enumerate()
            .map(|(i, (at, kind, tool, text))| TimelineEvent {
                id: format!("{}:{}", self.session_id, i),
                at,
                kind,
                text: text.to_string(),
                tool: tool.map(str::to_string),
                sidechain: None,
            })
            .collect();
        Ok(TailRead {
            events,
            patch: AgentPatch::default(),
            first: true,
        })
    }
}

/* ------------------------------------------------------------------ deps -- */

/// Everything `routes` needs, in mock form. `transitions` comes from
/// `--mock-transitions`.
pub fn mock_deps(transitions: bool) -> Deps {
    Deps {
        source: Arc::new(MockSource::new(transitions)),
        panes: Arc::new(MockPanes),
        limits: Arc::new(MockLimits::new(transitions)),
        tail_for: Arc::new(|agent: &Agent| {
            Some(Box::new(MockTail::new(agent.session_id.clone())) as Box<dyn TailApi>)
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole fixture set, captured verbatim from `node dist/server/cli.js
    /// --mock --port 4491` hitting `GET /api/agents`, keys sorted.
    ///
    /// This is the differential-testing contract: both backends are run with
    /// `--mock` and their JSON compared field by field, so a fixture that drifts
    /// on either side shows up as a false difference in every later comparison.
    /// Compared as parsed values, not bytes — key order is `types.rs`'s business,
    /// and the TS object literals are in a different order anyway.
    const NODE_MOCK_AGENTS: &str = r#"
    [
      {
        "activity": "Bash: rm -rf dist && rebuild from scratch",
        "cwd": "/Users/demo/Projects/kb-vault",
        "derivedName": true,
        "folder": "kb-vault",
        "kind": "interactive",
        "lastActivityAt": 1786599760000,
        "name": "ziweiwu-ee",
        "paneId": "%76",
        "pid": 28707,
        "sessionId": "mock-waiting",
        "startedAt": 1786596400000,
        "status": "waiting",
        "tmuxSession": "claude-mock-a",
        "tokens": 48120,
        "version": "2.1.232",
        "waitingFor": "dialog open"
      },
      {
        "activity": "Task → Rerun the exhaustive sweep against fixed code",
        "cwd": "/Users/demo/Projects/terminal-system-monitor",
        "folder": "terminal-system-monitor",
        "gitBranch": "fix/locale-layout-startup",
        "goal": {
          "at": 1786599700000,
          "condition": "every test passes and the locale sweep reports no layout breakage at 80 columns",
          "met": false,
          "reason": "Two locale snapshots still differ at 80 columns."
        },
        "kind": "interactive",
        "lastActivityAt": 1786599988000,
        "name": "terminal-system-monitor-50",
        "paneId": "%77",
        "pid": 4421,
        "sessionId": "mock-busy",
        "startedAt": 1786592800000,
        "status": "busy",
        "subagents": 3,
        "tmuxSession": "claude-mock-b",
        "tokens": 111800,
        "version": "2.1.232"
      },
      {
        "activity": "Task → Audit the theme tokens across both themes",
        "cwd": "/Users/demo/Projects/useful-markdown-viewer",
        "delegating": true,
        "folder": "useful-markdown-viewer",
        "gitBranch": "main",
        "kind": "interactive",
        "lastActivityAt": 1786599988000,
        "name": "markdown-viewer-with-ink",
        "paneId": "%75",
        "pid": 47117,
        "sessionId": "mock-busy-2",
        "startedAt": 1786594600000,
        "status": "busy",
        "subagents": 2,
        "tmuxSession": "claude-mock-c",
        "tokens": 67500,
        "version": "2.1.232"
      },
      {
        "activity": "Write: /Users/demo/Projects/agent-commander/src/web/very/deep/path/component.ts",
        "cwd": "/Users/demo/Projects/agent-commander",
        "folder": "agent-commander",
        "gitBranch": "main",
        "kind": "interactive",
        "lastActivityAt": 1786599992000,
        "name": "agent-commander-web-dashboard-ux-review-pass",
        "paneId": "%79",
        "pid": 18731,
        "sessionId": "mock-long-name",
        "startedAt": 1786598500000,
        "status": "busy",
        "subagents": 1,
        "tmuxSession": "claude-mock-d",
        "tokens": 23900,
        "version": "2.1.232"
      },
      {
        "activity": "Repo is back to normal. `main` and `skills-find-suitable` both build.",
        "cwd": "/Users/demo",
        "folder": "demo",
        "kind": "interactive",
        "lastActivityAt": 1786599040000,
        "name": "kb-operational-hardening",
        "paneId": "%72",
        "pid": 34625,
        "sessionId": "mock-idle-kb",
        "startedAt": 1786598200000,
        "status": "idle",
        "tmuxSession": "claude-mock-e",
        "tokens": 59800,
        "version": "2.1.232"
      },
      {
        "activity": "Done — `~/.zshrc` updated (backup at `~/.zshrc.bak.2026`)",
        "aiTitle": "Find an alternative markdown editor to Obsidian",
        "cwd": "/Users/demo",
        "derivedName": true,
        "folder": "demo",
        "kind": "interactive",
        "lastActivityAt": 1786549600000,
        "name": "ziweiwu-ce",
        "paneId": "%73",
        "pid": 50893,
        "sessionId": "mock-idle-ce",
        "startedAt": 1786549600000,
        "status": "idle",
        "tmuxSession": "claude-mock-f",
        "tokens": 31900,
        "version": "2.1.232"
      },
      {
        "activity": "**`react-hig-datepicker`, with 6,306 all-time downloads",
        "cwd": "/Users/demo",
        "derivedName": true,
        "folder": "demo",
        "kind": "interactive",
        "lastActivityAt": 1786596400000,
        "lastPrompt": "check the npm download numbers for react-hig-datepicker",
        "name": "ziweiwu-db",
        "paneId": "%78",
        "pid": 53848,
        "sessionId": "mock-idle-db",
        "startedAt": 1786596400000,
        "status": "idle",
        "tmuxSession": "claude-mock-g",
        "tokens": 8800,
        "version": "2.1.232"
      },
      {
        "cwd": "/Users/demo",
        "derivedName": true,
        "folder": "demo",
        "kind": "interactive",
        "name": "ziweiwu-35",
        "paneId": "%0",
        "pid": 2330,
        "sessionId": "mock-fresh",
        "startedAt": 1786599400000,
        "status": "idle",
        "tmuxSession": "claude-mock-h",
        "version": "2.1.232"
      },
      {
        "activity": "WebFetch: https://example.com/feed.xml",
        "attachBlockedReason": "session is not running inside tmux",
        "cwd": "/Users/demo/Projects/lego-deals",
        "folder": "lego-deals",
        "kind": "background",
        "lastActivityAt": 1786599940000,
        "name": "headless-import",
        "pid": 6556,
        "sessionId": "mock-no-tmux",
        "startedAt": 1786599400000,
        "status": "idle",
        "tokens": 2010,
        "version": "2.1.232"
      }
    ]
    "#;

    #[test]
    fn fixtures_serialise_exactly_as_the_node_server_does() {
        let want: serde_json::Value = serde_json::from_str(NODE_MOCK_AGENTS).unwrap();
        let got = serde_json::to_value(fixtures()).unwrap();
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
            ]
        );
    }

    #[test]
    fn pids_and_panes_match() {
        let got: Vec<(i64, Option<String>)> = fixtures()
            .into_iter()
            .map(|a| (a.pid, a.pane_id))
            .collect();
        assert_eq!(
            got,
            vec![
                (28707, Some("%76".to_string())),
                (4421, Some("%77".to_string())),
                (47117, Some("%75".to_string())),
                (18731, Some("%79".to_string())),
                (34625, Some("%72".to_string())),
                (50893, Some("%73".to_string())),
                (53848, Some("%78".to_string())),
                (2330, Some("%0".to_string())),
                (6556, None),
            ]
        );
    }

    /// The awkwardness is the point: if these ever get tidied the fixture stops
    /// being a review surface.
    #[test]
    fn the_over_long_name_is_still_over_long() {
        let a = by_id("mock-long-name");
        assert_eq!(a.name, "agent-commander-web-dashboard-ux-review-pass");
        assert!(a.name.len() > 40, "the long name must not be shortened");
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
        assert_eq!(never, vec!["mock-fresh"]);
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
            vec!["mock-waiting", "mock-idle-ce", "mock-idle-db", "mock-fresh"]
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
            ]
        );
    }

    #[tokio::test]
    async fn capture_uses_real_escape_bytes_and_pads_to_rows() {
        let panes = MockPanes;
        let lines = panes.capture("%76", 24).await.unwrap();
        assert_eq!(lines.len(), 24);
        assert!(lines[0].starts_with("\u{001b}[38;5;246m"));
        assert!(lines[0].contains("mock pane %76"));
        assert_eq!(lines[8], "❯ ");
        assert!(lines[23].is_empty());
        // Fewer rows than content truncates rather than overflows.
        assert_eq!(panes.capture("%76", 3).await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn meta_is_the_fixture_geometry() {
        let m = MockPanes.meta("%76").await.unwrap();
        assert_eq!(m.cols, 96);
        assert_eq!(m.rows, 24);
        assert_eq!(m.cursor_x, 2);
        assert_eq!(m.cursor_y, 21);
        assert!(m.alternate, "a live agent draws on the alternate screen");
        assert!(!m.dead);
    }

    #[tokio::test]
    async fn the_first_tail_read_replays_the_fixture_timeline() {
        let mut tail = MockTail::new("mock-busy".into());
        let first = tail.read().await.unwrap();
        assert!(first.first);
        assert_eq!(first.events.len(), 7);
        assert_eq!(first.events[0].id, "mock-busy:0");
        assert_eq!(first.events[0].at, START - 300_000);
        assert_eq!(first.events[0].kind, TimelineKind::User);
        assert_eq!(first.events[2].tool.as_deref(), Some("Glob"));
        assert_eq!(first.events[4].kind, TimelineKind::Subagent);
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
        panes.paste("%72", "not submitted", false).await.unwrap();
        panes.paste("%72", "hello", true).await.unwrap();

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
        assert_eq!(steps.len(), 4);
        let pcts: Vec<(f64, Option<f64>)> = steps
            .iter()
            .map(|s| (s.five_hour.as_ref().unwrap().pct, s.seven_day.as_ref().map(|w| w.pct)))
            .collect();
        assert_eq!(
            pcts,
            vec![
                (12.4, Some(31.8)),
                (61.4, Some(47.2)),
                (83.6, None),
                (96.1, Some(88.3)),
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
        assert_eq!(five.pct, 12.4);
        assert_eq!(five.resets_at, Some(cur.at + 2 * 3_600_000));
        let seven = cur.seven_day.expect("seven day window");
        assert_eq!(seven.pct, 31.8);
        assert_eq!(seven.resets_at, Some(cur.at + 3 * 86_400_000));
        l.stop();
    }

    #[tokio::test]
    async fn a_static_source_never_moves() {
        let s = MockSource::new(false);
        s.start().await.unwrap();
        assert_eq!(s.list().len(), 9);
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
        assert_eq!(s.list()[7].session_id, "mock-fresh");
        // A patch for an unknown session is a no-op, not a new agent.
        s.enrich("ghost", AgentPatch::default());
        assert_eq!(s.list().len(), 9);
    }
}
