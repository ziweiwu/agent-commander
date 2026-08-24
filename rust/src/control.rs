//! Acting on a running agent: closing it, changing its mode or model, setting
//! or clearing its goal — and the two guards that stand in front of anything
//! else that can reach a live session.
//!
//! Port of `src/server/control.ts`, plus the `WriteBudget` and destructive-key
//! guard that live in `routes.ts` on the TypeScript side. They are here rather
//! than there because they are boundary rules about reaching a live agent, and
//! this is where the boundary rules live; `routes` calls them.
//!
//! INV-8: every action here refuses an agent that is busy. These work by
//! typing into the agent's own prompt, and a keystroke that lands in the
//! middle of a tool call would be interleaved with work in flight. Idle and
//! waiting are fine — a waiting agent is precisely the one you may want to
//! redirect.

#![allow(dead_code)]

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;

use crate::options::{is_cyclable_mode, is_model_alias};
use crate::sources::PaneApi;
use crate::types::{is_allowed_key, is_destructive_key, now_ms, Agent, AgentStatus, GoalState};

#[allow(unused_imports)]
pub use crate::options::{is_cyclable_mode as mode_is_cyclable, MODE_CYCLE};

/// A refusal the caller is expected to render to the user as a 400.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct ControlError(pub String);

impl ControlError {
    fn new(msg: impl Into<String>) -> Self {
        ControlError(msg.into())
    }
}

/// What an action can fail with.
///
/// Kept as two cases because the caller renders them differently, and the
/// TypeScript's `err instanceof ControlError` test is the same distinction: a
/// refusal is the caller's mistake and gets a 400 with the reason next to the
/// control that caused it, while a tmux round trip that failed is the
/// server's problem and gets a 500. Collapsing them would tell a user that
/// their perfectly good request was invalid.
#[derive(Debug, thiserror::Error)]
pub enum ControlFailure {
    #[error("{0}")]
    Refused(#[from] ControlError),
    #[error("{0}")]
    Failed(#[source] anyhow::Error),
}

impl ControlFailure {
    /// True when this is worth a 400 rather than a 500.
    pub fn is_client_error(&self) -> bool {
        matches!(self, ControlFailure::Refused(_))
    }
}

type Res<T> = Result<T, ControlError>;
type Act<T> = Result<T, ControlFailure>;

/// INV-8: the shared guard in front of every action.
///
/// Returns the agent rather than asserting on it, because Rust has no
/// assertion that narrows a type the way TypeScript's `asserts` does — and
/// because every caller immediately wants the pane id this proves exists.
pub fn assert_controllable(agent: Option<&Agent>) -> Res<&str> {
    let agent = agent.ok_or_else(|| ControlError::new("agent is no longer available"))?;
    let pane = agent.pane_id.as_deref().ok_or_else(|| {
        ControlError::new(
            agent.attach_blocked_reason.clone().unwrap_or_else(|| "agent is not attachable".into()),
        )
    })?;
    if agent.status == AgentStatus::Busy {
        return Err(ControlError::new("agent is busy — wait until it is idle before changing it"));
    }
    Ok(pane)
}

/* -------------------------------------------------------------- the seam */

/// What an action needs from the outside world.
///
/// The TypeScript passes a record of closures; here it is a trait so a test
/// can hand in a recorder and production can hand in [`LiveDeps`]. Everything
/// is `&self` so one set of deps can be shared behind an `Arc`.
#[async_trait]
pub trait ControlDeps: Send + Sync {
    async fn paste(&self, pane_id: &str, text: &str, submit: bool) -> anyhow::Result<()>;
    async fn key(&self, pane_id: &str, key: &str) -> anyhow::Result<()>;
    /// Reads the mode the session reports now; used to verify a switch landed.
    async fn read_mode(&self) -> Option<String>;
    /// Reads the goal the session reports now; used to verify one was set.
    async fn read_goal(&self) -> Option<GoalState>;
    async fn pane_alive(&self, pane_id: &str) -> bool;
    async fn kill_session(&self, tmux_session: &str) -> anyhow::Result<()>;
    async fn wait(&self, ms: u64);
}

type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
/// Reads the session's current permission mode. Supplied by the caller because
/// it comes from the transcript, which this module deliberately knows nothing
/// about.
pub type ModeReader = Arc<dyn Fn() -> BoxFut<'static, Option<String>> + Send + Sync>;
pub type GoalReader = Arc<dyn Fn() -> BoxFut<'static, Option<GoalState>> + Send + Sync>;
pub type SessionKiller =
    Arc<dyn Fn(String) -> BoxFut<'static, anyhow::Result<()>> + Send + Sync>;

/// The production wiring: writes go through the pane API, reads through
/// closures the composition root supplies.
pub struct LiveDeps {
    pub panes: Arc<dyn PaneApi>,
    pub read_mode: ModeReader,
    pub read_goal: GoalReader,
    pub kill: SessionKiller,
}

#[async_trait]
impl ControlDeps for LiveDeps {
    async fn paste(&self, pane_id: &str, text: &str, submit: bool) -> anyhow::Result<()> {
        self.panes.paste(pane_id, text, submit).await
    }
    async fn key(&self, pane_id: &str, key: &str) -> anyhow::Result<()> {
        self.panes.key(pane_id, key).await
    }
    async fn read_mode(&self) -> Option<String> {
        (self.read_mode)().await
    }
    async fn read_goal(&self) -> Option<GoalState> {
        (self.read_goal)().await
    }
    /// Two separate ways for a pane to be gone, and both count.
    ///
    /// tmux does not forget a pane the moment its process exits: under
    /// `remain-on-exit` the pane stays listed and `display-message` keeps
    /// answering questions about it, with `pane_dead` set. So "tmux replied"
    /// is not the same question as "the agent is still there", and `/exit`
    /// leaving a dead pane behind is exactly the case `close_agent` polls for.
    /// Reading the flag is what lets it report `forced: false` — the session
    /// shut itself down — instead of going on to kill a tmux session that had
    /// already finished with it.
    async fn pane_alive(&self, pane_id: &str) -> bool {
        match self.panes.meta(pane_id).await {
            Ok(meta) => !meta.dead,
            // No answer at all: the pane is gone outright.
            Err(_) => false,
        }
    }
    async fn kill_session(&self, tmux_session: &str) -> anyhow::Result<()> {
        (self.kill)(tmux_session.to_string()).await
    }
    async fn wait(&self, ms: u64) {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }
}

/* ------------------------------------------------------------------ model */

/// Switch the model by typing the CLI's own `/model` command.
///
/// The alias is validated against the allow-list first, so nothing free-text
/// is ever typed into a live session.
pub async fn set_model(agent: Option<&Agent>, alias: &str, deps: &dyn ControlDeps) -> Act<()> {
    let pane = assert_controllable(agent)?;
    if !is_model_alias(alias) {
        return Err(ControlError::new(format!("unknown model: {alias}")).into());
    }
    deps.paste(pane, &format!("/model {alias}"), true).await.map_err(ControlFailure::Failed)
}

/* ------------------------------------------------------------------- mode */

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeResult {
    pub ok: bool,
    pub mode: Option<String>,
    pub steps: u32,
}

/// How many Shift+Tab presses before giving up; the cycle is at most five long.
const MAX_STEPS: u32 = 6;

/// Switch permission mode by cycling Shift+Tab until the session reports the
/// target.
///
/// Verified rather than counted: the cycle silently omits `bypassPermissions`
/// and `auto` when they are unavailable, so a fixed number of presses would
/// land somewhere else entirely. Gives up after a bounded number of steps and
/// reports where it actually ended up.
pub async fn set_mode(
    agent: Option<&Agent>,
    target: &str,
    deps: &dyn ControlDeps,
    max_steps: u32,
) -> Act<ModeResult> {
    let pane = assert_controllable(agent)?;
    if !is_cyclable_mode(target) {
        return Err(ControlError::new(format!("unknown permission mode: {target}")).into());
    }

    let mut mode = deps.read_mode().await;
    if mode.as_deref() == Some(target) {
        return Ok(ModeResult { ok: true, mode, steps: 0 });
    }

    for steps in 1..=max_steps {
        // BTab is tmux's name for back-tab, which is what a terminal emits for
        // Shift+Tab.
        deps.key(pane, "BTab").await.map_err(ControlFailure::Failed)?;
        deps.wait(250).await;
        mode = deps.read_mode().await;
        if mode.as_deref() == Some(target) {
            return Ok(ModeResult { ok: true, mode, steps });
        }
    }
    Ok(ModeResult { ok: false, mode, steps: max_steps })
}

/// The default step budget, for callers with no reason to pick another.
pub async fn set_mode_default(
    agent: Option<&Agent>,
    target: &str,
    deps: &dyn ControlDeps,
) -> Act<ModeResult> {
    set_mode(agent, target, deps, MAX_STEPS).await
}

/* ------------------------------------------------------------------- goal */

/// The longest goal condition that will be typed into a live prompt.
///
/// Claude Code has its own cap and refuses anything longer, so this is not the
/// boundary that matters for correctness — it is the boundary that keeps a
/// paste that is going to be rejected anyway from being typed into a session
/// at all.
pub const GOAL_MAX_CHARS: usize = 400;

/// Check a goal condition before it becomes a line typed into a live agent.
///
/// A newline is the dangerous character here, not a shell metacharacter: this
/// text is pasted into Claude Code's prompt and submitted, so an embedded
/// newline would submit early and send the remainder as a second, unreviewed
/// instruction. A leading `/` is refused for the same reason — the user asked
/// to set a goal, not to run some other slash command.
pub fn assert_goal_condition(raw: &str) -> Res<String> {
    let condition = raw.trim();
    if condition.is_empty() {
        return Err(ControlError::new("a goal needs a condition"));
    }
    // Counted in `char`s, not bytes: the TypeScript counts UTF-16 code units,
    // and for a cap whose only job is "smaller than the one Claude Code
    // enforces" a code point is the closer of the two available meanings.
    if condition.chars().count() > GOAL_MAX_CHARS {
        return Err(ControlError::new(format!(
            "a goal condition must be {GOAL_MAX_CHARS} characters or fewer"
        )));
    }
    for ch in condition.chars() {
        let code = ch as u32;
        if code < 0x20 || code == 0x7f {
            return Err(ControlError::new("a goal condition must be a single line of text"));
        }
    }
    if condition.starts_with('/') {
        return Err(ControlError::new(
            "a goal condition cannot start with / — that would run a command",
        ));
    }
    Ok(condition.to_string())
}

#[derive(Debug, Clone)]
pub struct GoalResult {
    pub ok: bool,
    pub goal: Option<GoalState>,
}

/// How long to wait for the session to write the goal down before giving up.
const GOAL_VERIFY_MS: u64 = 5000;
const GOAL_POLL_MS: u64 = 250;

/// Set a session goal by typing Claude Code's own `/goal <condition>`.
///
/// Verified, like the mode switch: setting a goal writes a `goal_status`
/// record into the transcript immediately, so a goal that never appears there
/// is one that never landed — the paste went into a dialog, or the session was
/// not at its prompt after all. Reporting that honestly matters more than
/// usual here, because a goal makes the session keep working until an
/// evaluator agrees it is done, and "did that take effect?" is not a question
/// the user can answer by looking at the chat.
pub async fn set_goal(
    agent: Option<&Agent>,
    raw_condition: &str,
    deps: &dyn ControlDeps,
    verify_ms: u64,
) -> Act<GoalResult> {
    let pane = assert_controllable(agent)?;
    let condition = assert_goal_condition(raw_condition)?;

    let before = deps.read_goal().await;
    deps.paste(pane, &format!("/goal {condition}"), true)
        .await
        .map_err(ControlFailure::Failed)?;

    let mut waited = 0u64;
    while waited < verify_ms {
        deps.wait(GOAL_POLL_MS).await;
        let goal = deps.read_goal().await;
        if landed(before.as_ref(), goal.as_ref()) {
            return Ok(GoalResult { ok: true, goal });
        }
        waited += GOAL_POLL_MS;
    }
    Ok(GoalResult { ok: false, goal: before })
}

pub async fn set_goal_default(
    agent: Option<&Agent>,
    raw_condition: &str,
    deps: &dyn ControlDeps,
) -> Act<GoalResult> {
    set_goal(agent, raw_condition, deps, GOAL_VERIFY_MS).await
}

/// Is this record evidence that the goal we just typed was accepted?
///
/// Two things are checked and neither is the condition text. Claude Code
/// canonicalises what it stores, so comparing text would report a perfectly
/// good goal as failed.
///
///   - It must be the *set* record. Every `/goal <condition>` writes one, and
///     only setting one does; an evaluation landing while we waited says the
///     session is working on the goal it already had.
///   - It must be newer than whatever was there before we typed, so a session
///     that ignored the paste keeps reading as unchanged.
///
/// Erring towards "not set" is deliberate. A goal wrongly reported as failed
/// is visible — the meter appears anyway on the next enrichment tick and the
/// toast looks wrong. A goal wrongly reported as set is invisible, and the
/// user walks away believing the session will keep working when it will stop
/// at the next prompt.
fn landed(before: Option<&GoalState>, goal: Option<&GoalState>) -> bool {
    let Some(goal) = goal else { return false };
    if goal.fresh != Some(true) {
        return false;
    }
    let Some(before) = before else { return true };
    goal.at > before.at || goal.condition != before.condition
}

/// Clear the goal with `/goal clear`.
///
/// Nothing is written to the transcript when a goal is cleared, so unlike
/// every other action here this one cannot be verified by reading the session
/// back. The caller drops its own copy instead; if the clear did not land, the
/// next evaluation writes a fresh record and the goal reappears on its own,
/// which is the right way round for a claim this app cannot check.
pub async fn clear_goal(agent: Option<&Agent>, deps: &dyn ControlDeps) -> Act<()> {
    let pane = assert_controllable(agent)?;
    deps.paste(pane, "/goal clear", true).await.map_err(ControlFailure::Failed)
}

/* ------------------------------------------------------------------ close */

/// Milliseconds to let `/exit` shut the session down before forcing it.
const GRACE_MS: u64 = 6000;
const POLL_MS: u64 = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseResult {
    pub closed: bool,
    pub forced: bool,
}

/// Close a session.
///
/// `/exit` is Claude Code's own shutdown path, so it gets the chance to finish
/// writing its transcript. Only a session that ignores it is killed outright.
///
/// The poll is sequential on purpose and must stay that way. Each
/// `pane_alive` is a tmux round trip, and on a machine at its process cap —
/// which 109 panes and 33 Claude sessions will reach — a burst of tmux clients
/// is answered with `EAGAIN`. One question at a time, spaced by the wait, is
/// what makes this work on the machine that needs it most.
pub async fn close_agent(agent: Option<&Agent>, deps: &dyn ControlDeps) -> Act<CloseResult> {
    let pane = assert_controllable(agent)?;
    let agent = agent.expect("assert_controllable proved this is Some");

    deps.paste(pane, "/exit", true).await.map_err(ControlFailure::Failed)?;

    let mut waited = 0u64;
    while waited < GRACE_MS {
        deps.wait(POLL_MS).await;
        if !deps.pane_alive(pane).await {
            return Ok(CloseResult { closed: true, forced: false });
        }
        waited += POLL_MS;
    }

    let Some(session) = agent.tmux_session.as_deref() else {
        return Err(ControlError::new("agent ignored /exit and has no tmux session to close").into());
    };
    deps.kill_session(session).await.map_err(ControlFailure::Failed)?;
    Ok(CloseResult { closed: true, forced: true })
}

/* --------------------------------------------- INV-6: destructive keys */

/// Why a key was refused. `routes` renders these straight onto the wire.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeyRefusal {
    #[error("key not allowed: {0}")]
    NotAllowed(String),
    #[error("{0} discards work in progress and needs confirmation")]
    NeedsConfirmation(String),
}

/// The gate every `key` message passes through before it reaches a live agent.
///
/// INV-2 first: only keys on the allow-list ever reach a live agent, because
/// the key name becomes an argv entry to `send-keys`.
///
/// Then INV-6, and this is the part that used to be missing. `C-c`, `C-d` and
/// `Escape` are on the allow-list because they are keys a user legitimately
/// sends — interrupting a stuck agent is half the point of the Attach view.
/// What made them different was a confirmation dialog in `Terminal.tsx`, and
/// nothing else: the server forwarded them to a live agent for anyone who
/// could open a WebSocket, discarding whatever that agent had in flight. That
/// is the exact inversion of INV-2's posture, which says the client's
/// allow-list is a convenience and not the boundary.
///
/// `confirmed` is not proof that a human answered — nothing on this wire can
/// be. What it buys is that sending one is deliberate rather than incidental,
/// and that the rule lives where every other rule about reaching a live agent
/// lives. Note the type: only a JSON `true` gets through. A client that omits
/// the flag, sends `false`, or sends some other truthy value gets the same
/// refusal, because `Option<bool>` cannot be coerced the way a JavaScript
/// truthiness test could.
pub fn check_key(key: &str, confirmed: Option<bool>) -> Result<(), KeyRefusal> {
    if !is_allowed_key(key) {
        return Err(KeyRefusal::NotAllowed(key.to_string()));
    }
    if is_destructive_key(key) && confirmed != Some(true) {
        return Err(KeyRefusal::NeedsConfirmation(key.to_string()));
    }
    Ok(())
}

/* ------------------------------------------------ INV-12: input budget */

/// The most text a single `paste` may carry.
pub const MAX_PASTE: usize = 100_000;

/// The most a single WebSocket frame may be.
///
/// `MAX_PASTE` already refuses oversized text, but it refuses it *after* the
/// frame has been buffered and the whole string built: a 5MB paste was
/// accepted, parsed, and only then rejected. Bounding the frame means the
/// memory is never committed. Sized well above `MAX_PASTE` so the two limits
/// cannot disagree about the same paste — this one is about memory, that one
/// is about intent.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// How much a single tab may ask of a live agent, and how fast.
///
/// INV-12. INV-2 governs whether input is intentional; nothing governed how
/// *much* of it there could be. Measured before this existed: 5,000 `key`
/// messages sent in 1.5s were all accepted, with no error and no backpressure,
/// and in a live fleet each one is a `send-keys` queued behind the last on that
/// pane's write queue. A key-repeat storm, a loop in a client, or anything that
/// got past the origin gate could bury a working agent in keystrokes.
///
/// The bucket is sized for a person and not for a program. Sustained 30/s is
/// far above human typing — the Attach view coalesces to roughly one write per
/// burst — and the 120 burst absorbs a held-down arrow key without complaint.
pub const WRITE_BURST: f64 = 120.0;
pub const WRITE_PER_SECOND: f64 = 30.0;

/// A token bucket, refilled continuously rather than on a timer.
///
/// Interior mutability, because `routes` holds one per connection behind a
/// shared reference and there is nothing here worth an `&mut` for.
#[derive(Debug)]
pub struct WriteBudget {
    state: Mutex<(f64, i64)>,
    /// Whether the client has already been told; telling it per message
    /// amplifies a flood into a flood in both directions.
    warned: AtomicBool,
}

impl Default for WriteBudget {
    fn default() -> Self {
        Self::new(now_ms())
    }
}

impl WriteBudget {
    pub fn new(now: i64) -> Self {
        Self { state: Mutex::new((WRITE_BURST, now)), warned: AtomicBool::new(false) }
    }

    /// True when this message may proceed.
    pub fn take_at(&self, now: i64) -> bool {
        let mut state = self.state.lock().expect("write budget poisoned");
        let (ref mut tokens, ref mut last) = *state;
        let elapsed = (now - *last).max(0) as f64 / 1000.0;
        *tokens = (*tokens + elapsed * WRITE_PER_SECOND).min(WRITE_BURST);
        *last = now;
        if *tokens < 1.0 {
            return false;
        }
        *tokens -= 1.0;
        self.warned.store(false, Ordering::Relaxed);
        true
    }

    pub fn take(&self) -> bool {
        self.take_at(now_ms())
    }

    /// True the first time a refusal should be reported, false while it
    /// persists. Answering a flood with a flood is not an improvement.
    pub fn should_warn(&self) -> bool {
        !self.warned.swap(true, Ordering::Relaxed)
    }
}

/// The message a refused burst is reported with.
pub const TOO_MUCH_INPUT: &str = "too much input at once — slowing down";

/* ------------------------------------------------------------------ tests */

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn agent() -> Agent {
        Agent {
            session_id: "a".into(),
            pid: 1,
            name: "agent".into(),
            cwd: "/x".into(),
            folder: "x".into(),
            status: AgentStatus::Idle,
            kind: "interactive".into(),
            started_at: 0,
            pane_id: Some("%1".into()),
            tmux_session: Some("claude-1".into()),
            ..Default::default()
        }
    }

    fn goal(condition: &str, at: i64, fresh: bool) -> GoalState {
        GoalState {
            condition: condition.into(),
            met: false,
            at,
            reason: None,
            fresh: if fresh { Some(true) } else { None },
        }
    }

    /// Records everything that would have reached tmux, and answers reads from
    /// whatever the test configured. Nothing here shells out.
    #[derive(Default)]
    struct Fake {
        pastes: StdMutex<Vec<(String, String, bool)>>,
        keys: StdMutex<Vec<(String, String)>>,
        killed: StdMutex<Vec<String>>,
        /// Cycle of modes a Shift+Tab walks through, and where it is now.
        cycle: StdMutex<(Vec<String>, usize)>,
        mode: StdMutex<Option<String>>,
        /// Goal before anything is typed, and after — the whole question
        /// `set_goal` exists to answer.
        goal_before: StdMutex<Option<GoalState>>,
        goal_after: StdMutex<Option<GoalState>>,
        typed: StdMutex<bool>,
        alive: StdMutex<bool>,
    }

    impl Fake {
        fn new() -> Arc<Self> {
            Arc::new(Fake {
                mode: StdMutex::new(Some("default".into())),
                alive: StdMutex::new(false),
                ..Default::default()
            })
        }
        fn cycling(cycle: &[&str]) -> Arc<Self> {
            let f = Fake::new();
            *f.cycle.lock().unwrap() =
                (cycle.iter().map(|s| (*s).to_string()).collect(), 0);
            *f.mode.lock().unwrap() = Some(cycle[0].to_string());
            f
        }
        fn goals(before: Option<GoalState>, after: Option<GoalState>) -> Arc<Self> {
            let f = Fake::new();
            *f.goal_before.lock().unwrap() = before;
            *f.goal_after.lock().unwrap() = after;
            f
        }
        fn pastes(&self) -> Vec<(String, String, bool)> {
            self.pastes.lock().unwrap().clone()
        }
        fn at(&self) -> Option<String> {
            self.mode.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl ControlDeps for Arc<Fake> {
        async fn paste(&self, pane_id: &str, text: &str, submit: bool) -> anyhow::Result<()> {
            self.pastes.lock().unwrap().push((pane_id.into(), text.into(), submit));
            *self.typed.lock().unwrap() = true;
            Ok(())
        }
        async fn key(&self, pane_id: &str, key: &str) -> anyhow::Result<()> {
            self.keys.lock().unwrap().push((pane_id.into(), key.into()));
            let mut c = self.cycle.lock().unwrap();
            if !c.0.is_empty() {
                c.1 = (c.1 + 1) % c.0.len();
                *self.mode.lock().unwrap() = Some(c.0[c.1].clone());
            }
            Ok(())
        }
        async fn read_mode(&self) -> Option<String> {
            self.mode.lock().unwrap().clone()
        }
        async fn read_goal(&self) -> Option<GoalState> {
            if *self.typed.lock().unwrap() {
                self.goal_after.lock().unwrap().clone()
            } else {
                self.goal_before.lock().unwrap().clone()
            }
        }
        async fn pane_alive(&self, _pane_id: &str) -> bool {
            *self.alive.lock().unwrap()
        }
        async fn kill_session(&self, session: &str) -> anyhow::Result<()> {
            self.killed.lock().unwrap().push(session.into());
            Ok(())
        }
        /// Instant, so the tests do not spend six real seconds proving a grace
        /// period exists.
        async fn wait(&self, _ms: u64) {}
    }

    /* ---- INV-8: the guard ---- */

    #[test]
    fn inv8_accepts_an_idle_agent() {
        assert_eq!(assert_controllable(Some(&agent())).unwrap(), "%1");
    }

    /// A waiting agent is precisely the one you may want to redirect.
    #[test]
    fn inv8_accepts_a_waiting_agent() {
        let a = Agent { status: AgentStatus::Waiting, ..agent() };
        assert!(assert_controllable(Some(&a)).is_ok());
    }

    #[test]
    fn inv8_refuses_a_busy_agent_whose_prompt_is_mid_turn() {
        let a = Agent { status: AgentStatus::Busy, ..agent() };
        assert!(assert_controllable(Some(&a)).unwrap_err().0.contains("busy"));
    }

    #[test]
    fn inv8_refuses_an_agent_with_no_pane_and_says_why() {
        let a = Agent {
            pane_id: None,
            attach_blocked_reason: Some("not in tmux".into()),
            ..agent()
        };
        assert!(assert_controllable(Some(&a)).unwrap_err().0.contains("not in tmux"));
    }

    #[test]
    fn inv8_refuses_a_vanished_agent() {
        assert!(assert_controllable(None).unwrap_err().0.contains("no longer available"));
    }

    /* ---- model ---- */

    #[tokio::test]
    async fn set_model_types_the_clis_own_command() {
        let f = Fake::new();
        set_model(Some(&agent()), "opus", &f).await.unwrap();
        assert_eq!(f.pastes(), vec![("%1".into(), "/model opus".into(), true)]);
    }

    #[tokio::test]
    async fn set_model_refuses_an_alias_off_the_allow_list_before_typing() {
        for hostile in ["gpt-9", "--dangerously-skip-permissions", "opus; rm -rf /", ""] {
            let f = Fake::new();
            let err = set_model(Some(&agent()), hostile, &f).await.unwrap_err();
            assert!(err.to_string().contains("unknown model"), "{hostile}: {err}");
            assert!(f.pastes().is_empty(), "{hostile} reached a live pane");
        }
    }

    #[tokio::test]
    async fn set_model_refuses_a_busy_agent_before_typing_anything() {
        let f = Fake::new();
        let a = Agent { status: AgentStatus::Busy, ..agent() };
        assert!(set_model(Some(&a), "opus", &f).await.unwrap_err().to_string().contains("busy"));
        assert!(f.pastes().is_empty());
    }

    /* ---- mode ---- */

    #[tokio::test]
    async fn set_mode_does_nothing_when_already_in_the_target_mode() {
        let f = Fake::new();
        *f.mode.lock().unwrap() = Some("plan".into());
        let r = set_mode(Some(&agent()), "plan", &f, 6).await.unwrap();
        assert!(r.ok);
        assert_eq!(r.steps, 0);
        assert!(f.keys.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn set_mode_cycles_until_the_session_reports_the_target() {
        let f = Fake::cycling(&["default", "acceptEdits", "plan", "bypassPermissions", "auto"]);
        let r = set_mode(Some(&agent()), "plan", &f, 6).await.unwrap();
        assert!(r.ok);
        assert_eq!(r.steps, 2);
        assert_eq!(f.at().as_deref(), Some("plan"));
    }

    /// The cycle omits `bypassPermissions` and `auto` when unavailable, which
    /// is why this is verified rather than counted.
    #[tokio::test]
    async fn set_mode_lands_correctly_on_a_session_with_a_shortened_cycle() {
        let f = Fake::cycling(&["default", "acceptEdits", "plan"]);
        let r = set_mode(Some(&agent()), "plan", &f, 6).await.unwrap();
        assert!(r.ok);
        assert_eq!(f.at().as_deref(), Some("plan"));
    }

    #[tokio::test]
    async fn set_mode_gives_up_and_reports_where_it_ended_rather_than_cycling_forever() {
        let f = Fake::cycling(&["default", "acceptEdits", "plan"]);
        let r = set_mode(Some(&agent()), "bypassPermissions", &f, 4).await.unwrap();
        assert!(!r.ok);
        assert_eq!(r.steps, 4);
        assert!(r.mode.is_some());
        assert_eq!(f.keys.lock().unwrap().len(), 4, "the step budget is a real bound");
    }

    #[tokio::test]
    async fn set_mode_refuses_a_mode_that_is_not_in_the_cycle() {
        // `dontAsk` is the interesting one: spawnable by flag, never cycled to.
        for bad in ["turbo", "dontAsk", "--dangerously-skip-permissions", ""] {
            let f = Fake::new();
            let err = set_mode(Some(&agent()), bad, &f, 6).await.unwrap_err();
            assert!(err.to_string().contains("unknown permission mode"), "{bad}: {err}");
            assert!(f.keys.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn set_mode_refuses_a_busy_agent() {
        let f = Fake::new();
        let a = Agent { status: AgentStatus::Busy, ..agent() };
        assert!(set_mode(Some(&a), "plan", &f, 6).await.unwrap_err().to_string().contains("busy"));
    }

    /* ---- close ---- */

    #[tokio::test]
    async fn close_asks_the_session_to_exit_and_stops_there_when_it_does() {
        let f = Fake::new();
        *f.alive.lock().unwrap() = false;
        let r = close_agent(Some(&agent()), &f).await.unwrap();
        assert_eq!(f.pastes(), vec![("%1".into(), "/exit".into(), true)]);
        assert_eq!(r, CloseResult { closed: true, forced: false });
        assert!(f.killed.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn close_forces_a_session_that_ignores_exit() {
        let f = Fake::new();
        *f.alive.lock().unwrap() = true;
        let r = close_agent(Some(&agent()), &f).await.unwrap();
        assert_eq!(r, CloseResult { closed: true, forced: true });
        assert_eq!(f.killed.lock().unwrap().as_slice(), ["claude-1"]);
    }

    #[tokio::test]
    async fn close_reports_rather_than_hanging_when_there_is_nothing_left_to_kill() {
        let f = Fake::new();
        *f.alive.lock().unwrap() = true;
        let a = Agent { tmux_session: None, ..agent() };
        assert!(close_agent(Some(&a), &f).await.unwrap_err().to_string().contains("ignored /exit"));
    }

    #[tokio::test]
    async fn close_refuses_a_busy_agent() {
        let f = Fake::new();
        let a = Agent { status: AgentStatus::Busy, ..agent() };
        assert!(close_agent(Some(&a), &f).await.unwrap_err().to_string().contains("busy"));
        assert!(f.pastes().is_empty());
    }

    /* ---- goal ---- */

    #[tokio::test]
    async fn set_goal_types_the_clis_own_goal_command() {
        let f = Fake::goals(None, Some(goal("the tests pass", 1000, true)));
        set_goal(Some(&agent()), "the tests pass", &f, 5000).await.unwrap();
        assert_eq!(f.pastes(), vec![("%1".into(), "/goal the tests pass".into(), true)]);
    }

    #[tokio::test]
    async fn set_goal_refuses_a_busy_agent() {
        let f = Fake::new();
        let a = Agent { status: AgentStatus::Busy, ..agent() };
        assert!(set_goal(Some(&a), "x", &f, 500).await.unwrap_err().to_string().contains("busy"));
    }

    #[tokio::test]
    async fn set_goal_confirms_only_once_the_session_wrote_the_goal_down() {
        let f = Fake::goals(None, Some(goal("the tests pass", 1000, true)));
        assert!(set_goal(Some(&agent()), "the tests pass", &f, 5000).await.unwrap().ok);
    }

    /// The condition Claude Code stores is canonicalised, so verification asks
    /// "is there a newer record?" rather than "does the text match?".
    #[tokio::test]
    async fn set_goal_accepts_a_record_whose_text_was_rewritten() {
        let f = Fake::goals(
            Some(goal("something older", 10, false)),
            Some(goal("The tests pass.", 1000, true)),
        );
        assert!(set_goal(Some(&agent()), "the tests pass", &f, 5000).await.unwrap().ok);
    }

    #[tokio::test]
    async fn set_goal_reports_failure_when_nothing_is_ever_recorded() {
        let f = Fake::goals(None, None);
        assert!(!set_goal(Some(&agent()), "the tests pass", &f, 500).await.unwrap().ok);
    }

    /// The paste went nowhere — into a dialog, or a session that was not at its
    /// prompt — and the goal already on the session is unchanged. Reading it
    /// back must not be mistaken for the new goal landing.
    #[tokio::test]
    async fn set_goal_does_not_mistake_the_previous_goal_for_the_new_one() {
        let stale = goal("something older", 10, false);
        let f = Fake::goals(Some(stale.clone()), Some(stale));
        assert!(!set_goal(Some(&agent()), "the tests pass", &f, 500).await.unwrap().ok);
    }

    /// A goal already running gets evaluated every time the session would stop.
    /// One of those landing while we waited says nothing about whether the goal
    /// we typed was accepted — only the set-record does.
    #[tokio::test]
    async fn set_goal_does_not_accept_an_evaluation_of_the_old_goal_as_proof() {
        let stale = goal("something older", 10, true);
        let mut evaluated = goal("something older", 2000, false);
        evaluated.reason = Some("Not yet.".into());
        let f = Fake::goals(Some(stale), Some(evaluated));
        assert!(!set_goal(Some(&agent()), "the tests pass", &f, 500).await.unwrap().ok);
    }

    #[tokio::test]
    async fn clear_goal_types_goal_clear() {
        let f = Fake::new();
        clear_goal(Some(&agent()), &f).await.unwrap();
        assert_eq!(f.pastes(), vec![("%1".into(), "/goal clear".into(), true)]);
    }

    #[tokio::test]
    async fn clear_goal_refuses_a_busy_agent() {
        let f = Fake::new();
        let a = Agent { status: AgentStatus::Busy, ..agent() };
        assert!(clear_goal(Some(&a), &f).await.is_err());
        assert!(f.pastes().is_empty());
    }

    /* ---- goal sanitisation ---- */

    #[test]
    fn goal_condition_is_trimmed_and_returned() {
        assert_eq!(assert_goal_condition("  ship it  ").unwrap(), "ship it");
    }

    #[test]
    fn goal_condition_refuses_an_empty_condition() {
        for empty in ["", "   ", "\t\n "] {
            assert!(assert_goal_condition(empty).is_err(), "{empty:?}");
        }
    }

    /// The one that matters: this text is pasted into a prompt and submitted,
    /// so an embedded newline would submit early and send the rest as a second,
    /// unreviewed instruction to a live agent.
    #[test]
    fn goal_condition_refuses_an_embedded_newline() {
        for hostile in [
            "tests pass\nrm -rf /",
            "tests pass\r\n/exit",
            "tests pass\rrm -rf /",
            "a\u{2028}b\nc",
        ] {
            let err = assert_goal_condition(hostile).unwrap_err();
            assert!(err.0.contains("single line"), "{hostile:?}: {err}");
        }
    }

    #[test]
    fn goal_condition_refuses_other_control_characters() {
        for hostile in ["tests\u{7}pass", "tests\u{1b}[2Jpass", "tests\u{0}pass", "a\u{7f}b"] {
            assert!(assert_goal_condition(hostile).unwrap_err().0.contains("single line"));
        }
    }

    #[test]
    fn goal_condition_refuses_a_condition_that_is_itself_a_command() {
        for hostile in ["/exit", "/model opus", "  /clear  "] {
            assert!(
                assert_goal_condition(hostile).unwrap_err().0.contains("cannot start with"),
                "{hostile}"
            );
        }
    }

    #[test]
    fn goal_condition_refuses_a_condition_longer_than_the_cap() {
        let long = "x".repeat(GOAL_MAX_CHARS + 1);
        assert!(assert_goal_condition(&long).unwrap_err().0.contains("characters or fewer"));
        assert!(assert_goal_condition(&"x".repeat(GOAL_MAX_CHARS)).is_ok());
        // Trimming happens first, so padding does not push a legal goal over.
        let padded = format!("   {}   ", "x".repeat(GOAL_MAX_CHARS));
        assert!(assert_goal_condition(&padded).is_ok());
    }

    #[tokio::test]
    async fn an_oversized_or_multiline_goal_never_reaches_a_live_pane() {
        for hostile in ["/exit", &"x".repeat(GOAL_MAX_CHARS + 1), "a\nb", "   "] {
            let f = Fake::new();
            assert!(set_goal(Some(&agent()), hostile, &f, 500).await.is_err());
            assert!(f.pastes().is_empty(), "{hostile:?} was typed anyway");
        }
    }

    /* ---- LiveDeps::pane_alive ---- */

    /// A pane tmux still lists, still answers about, and whose process has
    /// exited. `remain-on-exit` makes this ordinary, and treating it as alive
    /// would send `close_agent` on to kill a tmux session that had already
    /// done what was asked of it.
    #[tokio::test]
    async fn a_dead_but_still_listed_pane_reads_as_not_alive() {
        use crate::sources::{PaneApi, PaneMeta};

        struct Panes {
            dead: bool,
            answers: bool,
        }
        #[async_trait]
        impl PaneApi for Panes {
            async fn meta(&self, _pane_id: &str) -> anyhow::Result<PaneMeta> {
                if !self.answers {
                    anyhow::bail!("can't find pane");
                }
                Ok(PaneMeta {
                    cols: 80,
                    rows: 24,
                    cursor_x: 0,
                    cursor_y: 0,
                    alternate: false,
                    dead: self.dead,
                })
            }
            async fn capture(&self, _p: &str, _rows: usize) -> anyhow::Result<Vec<String>> {
                Ok(vec![])
            }
            async fn paste(&self, _p: &str, _t: &str, _s: bool) -> anyhow::Result<()> {
                Ok(())
            }
            async fn key(&self, _p: &str, _k: &str) -> anyhow::Result<()> {
                Ok(())
            }
        }

        let live = |dead: bool, answers: bool| LiveDeps {
            panes: Arc::new(Panes { dead, answers }),
            read_mode: Arc::new(|| Box::pin(async { None })),
            read_goal: Arc::new(|| Box::pin(async { None })),
            kill: Arc::new(|_| Box::pin(async { Ok(()) })),
        };

        // Alive: tmux answers and the process is still running.
        assert!(live(false, true).pane_alive("%1").await);
        // Dead: tmux answers, but `pane_dead` is set.
        assert!(!live(true, true).pane_alive("%1").await);
        // Gone: tmux does not answer at all.
        assert!(!live(false, false).pane_alive("%1").await);
    }

    /// End to end: a session that answers `/exit` by leaving a dead pane is
    /// reported as having exited, and its tmux session is never killed.
    #[tokio::test]
    async fn close_does_not_force_a_session_that_exited_into_a_dead_pane() {
        let f = Fake::new();
        // `Fake::pane_alive` is the same predicate `LiveDeps` computes from
        // `!meta.dead`; false is what a dead pane produces.
        *f.alive.lock().unwrap() = false;
        let r = close_agent(Some(&agent()), &f).await.unwrap();
        assert_eq!(r, CloseResult { closed: true, forced: false });
        assert!(f.killed.lock().unwrap().is_empty(), "a finished session must not be killed");
    }

    /* ---- refusal vs failure ---- */

    /// A tmux round trip that failed is not the user having asked for
    /// something invalid, and must not be reported as if it were.
    #[tokio::test]
    async fn a_failed_write_is_a_server_failure_not_a_refusal() {
        struct Broken;
        #[async_trait]
        impl ControlDeps for Broken {
            async fn paste(&self, _p: &str, _t: &str, _s: bool) -> anyhow::Result<()> {
                anyhow::bail!("spawn tmux EAGAIN")
            }
            async fn key(&self, _p: &str, _k: &str) -> anyhow::Result<()> {
                anyhow::bail!("spawn tmux EAGAIN")
            }
            async fn read_mode(&self) -> Option<String> {
                Some("default".into())
            }
            async fn read_goal(&self) -> Option<GoalState> {
                None
            }
            async fn pane_alive(&self, _p: &str) -> bool {
                false
            }
            async fn kill_session(&self, _s: &str) -> anyhow::Result<()> {
                Ok(())
            }
            async fn wait(&self, _ms: u64) {}
        }

        let err = set_model(Some(&agent()), "opus", &Broken).await.unwrap_err();
        assert!(!err.is_client_error(), "{err}");
        assert!(err.to_string().contains("EAGAIN"));

        let err = set_mode(Some(&agent()), "plan", &Broken, 6).await.unwrap_err();
        assert!(!err.is_client_error());

        // And a refusal still reads as one.
        let refused = set_model(Some(&agent()), "gpt-9", &Broken).await.unwrap_err();
        assert!(refused.is_client_error(), "{refused}");
    }

    /* ---- INV-6 ---- */

    #[test]
    fn inv6_every_destructive_key_needs_confirmation() {
        for key in crate::types::DESTRUCTIVE_KEYS {
            assert_eq!(
                check_key(key, None),
                Err(KeyRefusal::NeedsConfirmation((*key).to_string())),
                "{key}"
            );
            assert!(check_key(key, Some(true)).is_ok(), "{key} must be sendable once confirmed");
        }
    }

    /// The point of moving this server-side: a client that simply omits the
    /// flag — a script, an old tab, a page on another origin that got past the
    /// gate — gets the same answer as the one that asks properly. `false` and
    /// `None` are the two spellings a Rust deserialiser can produce; a JSON
    /// `"yes"` or `1` fails to deserialise into `Option<bool>` at all, which is
    /// a refusal one layer earlier still.
    #[test]
    fn inv6_refuses_it_however_the_client_is_written() {
        for confirmed in [None, Some(false)] {
            assert!(check_key("C-c", confirmed).is_err(), "{confirmed:?}");
        }
    }

    #[test]
    fn inv6_every_other_allowed_key_still_needs_no_confirmation() {
        let ordinary =
            crate::types::ALLOWED_KEYS.iter().filter(|k| !is_destructive_key(k)).count();
        assert!(ordinary > 0);
        for key in crate::types::ALLOWED_KEYS {
            if is_destructive_key(key) {
                continue;
            }
            assert!(check_key(key, None).is_ok(), "{key}");
        }
    }

    /// INV-2: the key name becomes an argv entry, so anything off the list is
    /// refused before tmux is reached — and confirmation does not buy a way in.
    #[test]
    fn inv2_refuses_a_key_that_is_not_on_the_allow_list() {
        for hostile in ["C-z", "; rm -rf /", "Enter Enter", "", "escape", "C-C"] {
            assert!(matches!(check_key(hostile, None), Err(KeyRefusal::NotAllowed(_))), "{hostile}");
            assert!(check_key(hostile, Some(true)).is_err(), "{hostile} confirmed its way in");
        }
    }

    #[test]
    fn inv6_every_destructive_key_is_itself_an_allowed_key() {
        for key in crate::types::DESTRUCTIVE_KEYS {
            assert!(crate::types::ALLOWED_KEYS.contains(key), "{key}");
        }
    }

    /* ---- INV-12 ---- */

    #[test]
    fn inv12_a_flood_does_not_all_reach_the_agent() {
        // 5,000 messages in the 1.5s the measurement used. Before the budget
        // this was 5,000 writes.
        let budget = WriteBudget::new(0);
        let mut allowed = 0;
        for i in 0..5000 {
            let now = (i as f64 * 1.5 * 1000.0 / 5000.0) as i64;
            if budget.take_at(now) {
                allowed += 1;
            }
        }
        assert!(allowed < 500, "{allowed} got through");
        assert!(allowed > 0, "the bucket must not be shut, only bounded");
    }

    #[test]
    fn inv12_says_so_once_rather_than_once_per_refused_message() {
        let budget = WriteBudget::new(0);
        let mut warnings = 0;
        for _ in 0..3000 {
            if !budget.take_at(0) && budget.should_warn() {
                warnings += 1;
            }
        }
        // An error per refusal would answer a flood with a flood.
        assert_eq!(warnings, 1);
    }

    #[test]
    fn inv12_ordinary_use_is_never_refused() {
        // A brisk sentence typed into the Attach view, one write every 15ms —
        // faster than most people manage.
        let budget = WriteBudget::new(0);
        let sentence = "the quick brown fox jumps over the lazy dog";
        for (i, _) in sentence.chars().enumerate() {
            assert!(budget.take_at(i as i64 * 15), "refused character {i}");
        }
    }

    #[test]
    fn inv12_recovers_after_a_burst_rather_than_staying_shut() {
        let budget = WriteBudget::new(0);
        while budget.take_at(0) {}
        assert!(!budget.take_at(0));
        // The bucket refills; a user who let go of the key can type again.
        assert!(budget.take_at(1000));
    }

    /// A refusal re-arms the warning only once a message actually gets through,
    /// so a burst that never lets up is still reported once.
    #[test]
    fn inv12_warns_again_after_the_flood_has_passed() {
        let budget = WriteBudget::new(0);
        while budget.take_at(0) {}
        assert!(budget.should_warn());
        assert!(!budget.should_warn());
        assert!(budget.take_at(10_000));
        while budget.take_at(10_000) {}
        assert!(budget.should_warn(), "a second, separate burst deserves its own warning");
    }

    /// Time going backwards — an NTP step, a suspended laptop — must not mint
    /// tokens or panic on a negative duration.
    #[test]
    fn inv12_a_clock_that_jumps_backwards_does_not_refill_the_bucket() {
        let budget = WriteBudget::new(10_000);
        while budget.take_at(10_000) {}
        assert!(!budget.take_at(0), "a backwards clock bought free tokens");
    }

    #[test]
    fn inv12_the_two_size_limits_cannot_disagree_about_the_same_paste() {
        assert!(MAX_FRAME_BYTES > MAX_PASTE, "the frame cap must sit well above the paste cap");
    }
}
