//! Acting on a running agent: closing it, clearing or compacting its context,
//! changing its mode or model, and setting or clearing its goal — plus the
//! three guards that stand in front of anything that can reach a live session.
//!
//! Port of `src/server/control.ts`, plus the `WriteBudget` and destructive-key
//! guard that live in `routes.ts` on the TypeScript side. They are here rather
//! than there because they are boundary rules about reaching a live agent, and
//! this is where the boundary rules live; `routes` calls them.
//!
//! INV-8 guards these, and no longer with one rule for all of them. Closing an
//! agent, clearing or compacting its context and setting its goal are refused
//! while it is busy: each pastes text into the prompt buffer, and text landing
//! mid-tool-call interleaves with work in flight — it arrives in whatever the
//! agent is drawing and submits something nobody wrote.
//!
//! Two exceptions, for different reasons. **Model** types, but through the very
//! same `paste` the message composer uses on working agents by design, so
//! refusing it forbade through one door exactly what the app permits through
//! another; the caller is told the change was `queued` instead. **Mode** is the
//! one action that does not type at all: it sends `BTab`, a control key the CLI
//! handles as a toggle wherever it is.
//!
//! INV-7 is the other half: everything here works by typing Claude Code's own
//! slash commands, which against another CLI is not a feature that degrades —
//! it is this app typing a sentence of its own into somebody's prompt. The
//! browser hides those controls; `assert_slash_commandable` is the boundary
//! that makes it true, because a UI is not one (INV-6).

#![allow(dead_code)]

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;

use crate::agent_kinds::allows_slash_commands;
use crate::options::is_model_alias;
use crate::sources::{PaneApi, Submit};
use crate::types::{is_allowed_key, is_destructive_key, now_ms, Agent, AgentStatus, GoalState};

#[allow(unused_imports)]
pub use crate::options::{is_cyclable_mode, MODE_CYCLE};

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

/* ----------------------------------------------------------------- guards */

/// There is an agent, and there is a pane to reach it through.
///
/// Returns the pane id rather than narrowing a type the way TypeScript's
/// `asserts agent is Controllable` does — Rust has no such assertion, and
/// every caller immediately wants the pane this proves exists.
pub fn assert_attachable(agent: Option<&Agent>) -> Res<&str> {
    let agent = agent.ok_or_else(|| ControlError::new("agent is no longer available"))?;
    agent.pane_id.as_deref().ok_or_else(|| {
        ControlError::new(
            agent
                .attach_blocked_reason
                .clone()
                .unwrap_or_else(|| "agent is not attachable".into()),
        )
    })
}

/// INV-8: the shared guard in front of every action that *types* into the
/// prompt.
///
/// The busy refusal is about text. `/clear`, `/compact`, `/goal` and `/exit`
/// are pasted into the agent's prompt buffer and submitted, and text arriving
/// mid-tool-call interleaves with work in flight. `send_shift_tab` and `set_model`
/// deliberately use [`assert_attachable`] instead; each says why.
pub fn assert_controllable(agent: Option<&Agent>) -> Res<&str> {
    let pane = assert_attachable(agent)?;
    let agent = agent.expect("assert_attachable proved this is Some");
    if agent.status == AgentStatus::Busy {
        return Err(ControlError::new("agent is busy — wait until it is idle before changing it"));
    }
    Ok(pane)
}

/// INV-7's other half: these actions are Claude Code's slash commands.
///
/// Every one of them works by typing `/model`, `/clear`, `/compact`, `/goal`
/// or `/exit` into a live pane. Against another CLI that is not a feature that
/// degrades — it is this app typing a sentence of its own into somebody's
/// prompt and pressing return.
pub fn assert_slash_commandable(agent: &Agent) -> Res<()> {
    if allows_slash_commands(&agent.agent_kind) {
        return Ok(());
    }
    Err(ControlError::new(format!(
        "this action types a Claude Code command into the session, which {} does not understand",
        agent.agent_kind
    )))
}

/// Both guards in the order every typing action wants them, returning the pane.
fn typing_target(agent: Option<&Agent>) -> Res<&str> {
    let pane = assert_controllable(agent)?;
    assert_slash_commandable(agent.expect("assert_controllable proved this is Some"))?;
    Ok(pane)
}

/// The same for the two actions that stay available mid-run.
fn reachable_target(agent: Option<&Agent>) -> Res<&str> {
    let pane = assert_attachable(agent)?;
    assert_slash_commandable(agent.expect("assert_attachable proved this is Some"))?;
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
    async fn paste(
        &self,
        pane_id: &str,
        text: &str,
        submit: Submit,
    ) -> anyhow::Result<()>;
    async fn key(&self, pane_id: &str, key: &SendableKey) -> anyhow::Result<()>;
    /// Reads the goal the session reports now; used to verify one was set.
    async fn read_goal(&self) -> Option<GoalState>;
    /// Reads the session id this process is running *now*.
    ///
    /// `/clear` replaces the session rather than editing it, so this is how
    /// that one is verified — see [`clear_context`].
    async fn read_session_id(&self, pid: i64) -> Option<String>;
    async fn pane_alive(&self, pane_id: &str) -> bool;
    async fn kill_session(&self, tmux_session: &str) -> anyhow::Result<()>;
    async fn wait(&self, millis: u64);
}

type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type GoalReader = Arc<dyn Fn() -> BoxFut<'static, Option<GoalState>> + Send + Sync>;
pub type SessionKiller = Arc<dyn Fn(String) -> BoxFut<'static, anyhow::Result<()>> + Send + Sync>;

/// The production wiring: writes go through the pane API, reads through
/// closures the composition root supplies.
pub struct LiveDeps {
    pub panes: Arc<dyn PaneApi>,
    pub read_goal: GoalReader,
    pub kill: SessionKiller,
}

#[async_trait]
impl ControlDeps for LiveDeps {
    async fn paste(
        &self,
        pane_id: &str,
        text: &str,
        submit: Submit,
    ) -> anyhow::Result<()> {
        self.panes.paste(pane_id, text, submit).await
    }
    async fn key(&self, pane_id: &str, key: &SendableKey) -> anyhow::Result<()> {
        self.panes.key(pane_id, key).await
    }
    async fn read_goal(&self) -> Option<GoalState> {
        (self.read_goal)().await
    }
    /// Straight off disk, not out of anything this app remembers.
    ///
    /// Claude Code writes `~/.claude/sessions/<pid>.json` itself, so the id in
    /// it is evidence rather than inference — which is the whole reason
    /// `/clear` is verified against it (INV-8).
    async fn read_session_id(&self, pid: i64) -> Option<String> {
        crate::registry::read_session_id(pid).await
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
    async fn wait(&self, millis: u64) {
        tokio::time::sleep(std::time::Duration::from_millis(millis)).await;
    }
}

/* ------------------------------------------------------------------ model */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelResult {
    /// The agent was mid-turn, so the CLI reads this when the turn ends.
    pub queued: bool,
}

/// Switch the model with the CLI's own `/model <alias>`.
///
/// The alias is validated against the allow-list first, so nothing free-text
/// is ever typed into a live session.
///
/// Allowed while the agent is working, and the reason is consistency rather
/// than safety: this pastes through the very same primitive the message
/// composer uses, and that path has never had a busy guard at all. Sending
/// "use opus instead" as a chat message to a working agent is a designed
/// feature — it is what the composer's Queue mode *is* — so refusing
/// `/model opus` forbade through one door exactly what the app permits through
/// another, with the same keystrokes reaching the same prompt.
///
/// What that costs is immediacy, not correctness, and the caller is told which
/// of the two happened so the interface can say so instead of claiming a
/// change that has not landed yet (INV-11).
pub async fn set_model(
    agent: Option<&Agent>,
    alias: &str,
    deps: &dyn ControlDeps,
) -> Act<ModelResult> {
    let pane = reachable_target(agent)?;
    if !is_model_alias(alias) {
        return Err(ControlError::new(format!("unknown model: {alias}")).into());
    }
    let queued = agent.expect("guarded above").status == AgentStatus::Busy;
    deps.paste(pane, &format!("/model {alias}"), Submit::Yes).await.map_err(ControlFailure::Failed)?;
    Ok(ModelResult { queued })
}

/* -------------------------------------------------------------- shift+tab */

/// Send one Shift+Tab, exactly as the CLI's own keyboard does.
///
/// **This reports no mode, and that is the fix rather than a shortcoming.**
/// It used to press `BTab` and then poll the transcript for up to 2.5 seconds
/// waiting for the session to report a *different* permission mode. Measured
/// against a live session, that reading is not merely slow — usually it is not
/// there at all. Claude Code writes its `permission-mode` record when a turn
/// ends, so a session sitting at its prompt — precisely the one being switched
/// — writes nothing in response to the press, and a session that has not taken
/// a turn yet has no transcript file to read.
///
/// So every press paid 2.5 seconds with the button dead and then reported
/// `unverified` about a switch that had in fact happened: three presses walk a
/// real session `auto` → `plan` while the app says it cannot tell. A control
/// that works but reports that it did not is indistinguishable from a broken
/// one, and was reported as broken.
///
/// The key is the whole action. `BTab` is a control key Claude Code handles as
/// a toggle wherever it is, so the press either reaches the pane or fails
/// loudly at tmux — there is no third outcome for an observation to find.
/// Claiming nothing beyond "the key was sent" is INV-11 applied to the one
/// control that never had a way to check itself.
///
/// **The one control action allowed while the agent is working**, and the
/// reason is what it sends. Every other action pastes text into the prompt
/// buffer; this sends a control key. Deciding "this next step needs plan mode"
/// happens *while* the agent is running, which is the only time it matters.
pub async fn send_shift_tab(agent: Option<&Agent>, deps: &dyn ControlDeps) -> Act<()> {
    let pane = reachable_target(agent)?;
    // BTab is tmux's name for back-tab, which is what a terminal emits for
    // Shift+Tab.
    deps.key(pane, &SendableKey::server_composed("BTab")).await.map_err(ControlFailure::Failed)?;
    Ok(())
}

/* ------------------------------------------------------------------ clear */

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ClearResult {
    pub ok: bool,
    /// The id the session is running now, when it was observed to change.
    pub session_id: Option<String>,
    /// The paste went out and the session id never changed inside the window.
    ///
    /// Not a failure, for the same reason a bare key press claims nothing: `/clear` is
    /// slower on a large conversation than any window worth blocking on, and a
    /// clear that lands late is indistinguishable from here to one that never
    /// landed at all. Saying it failed asserts something nobody checked
    /// (INV-11).
    pub unobserved: bool,
}

/// How long to watch for the session id to turn over, and how often to look.
const CLEAR_VERIFY_MS: u64 = 6000;
const CLEAR_POLL_MS: u64 = 250;

/// Discard the agent's conversation with Claude Code's own `/clear`.
///
/// Refused while the agent is busy, like everything else that types.
///
/// **Verified by watching the session id turn over, not the transcript.**
/// `/clear` does not edit a conversation, it replaces one: Claude Code opens a
/// fresh transcript under a new session id and rewrites
/// `~/.claude/sessions/<pid>.json` to point at it. So there is nothing to read
/// back in the old file — it simply stops growing, which is also what a
/// `/clear` that never arrived looks like. The id is the only signal that
/// separates them, it costs one small read, and it is written by Claude Code
/// rather than inferred here.
///
/// The caller needs that new id for a second reason: the agent the user was
/// looking at is now addressed differently, and every route, socket focus and
/// URL naming the old id is dead the moment this returns.
pub async fn clear_context(
    agent: Option<&Agent>,
    deps: &dyn ControlDeps,
    verify_ms: u64,
) -> Act<ClearResult> {
    let pane = typing_target(agent)?;
    let pid = agent.expect("guarded above").pid;

    let before = deps.read_session_id(pid).await;
    deps.paste(pane, "/clear", Submit::Yes).await.map_err(ControlFailure::Failed)?;

    let mut waited = 0u64;
    while waited < verify_ms {
        deps.wait(CLEAR_POLL_MS).await;
        let now = deps.read_session_id(pid).await;
        // A record that cannot be read is INV-5's case, not evidence: the
        // clear may well have landed, and nothing here can tell.
        if now.is_some() && now != before {
            return Ok(ClearResult { ok: true, session_id: now, unobserved: false });
        }
        waited += CLEAR_POLL_MS;
    }
    Ok(ClearResult { ok: true, session_id: None, unobserved: true })
}

pub async fn clear_context_default(
    agent: Option<&Agent>,
    deps: &dyn ControlDeps,
) -> Act<ClearResult> {
    clear_context(agent, deps, CLEAR_VERIFY_MS).await
}

/* ---------------------------------------------------------------- compact */

/// Ask the agent to compact its own context with Claude Code's `/compact`.
///
/// Refused while busy for the same reason `/clear` is: it types.
///
/// **Deliberately not verified here, and the number is why.** A compaction
/// writes a `compact_boundary` record when it finishes, and the one real
/// sample on this machine reports `durationMs: 157676` — over two and a half
/// minutes. Holding a request open for that is not a verification strategy, it
/// is a hung button. So this returns as soon as the text is submitted, the
/// interface says the compaction was *asked for* rather than that it happened
/// (INV-11), and the result arrives on its own: the transcript tail turns that
/// boundary record into a timeline event, through the loop that is already
/// reading the file.
pub async fn compact_context(agent: Option<&Agent>, deps: &dyn ControlDeps) -> Act<()> {
    let pane = typing_target(agent)?;
    deps.paste(pane, "/compact", Submit::Yes).await.map_err(ControlFailure::Failed)
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
/// Verified: setting a goal writes a `goal_status` record into the transcript
/// immediately, so a goal that never appears there is one that never landed —
/// the paste went into a dialog, or the session was not at its prompt after
/// all. Reporting that honestly matters more than usual here, because a goal
/// makes the session keep working until an evaluator agrees it is done, and
/// "did that take effect?" is not a question the user can answer by looking at
/// the chat.
pub async fn set_goal(
    agent: Option<&Agent>,
    raw_condition: &str,
    deps: &dyn ControlDeps,
    verify_ms: u64,
) -> Act<GoalResult> {
    let pane = typing_target(agent)?;
    let condition = assert_goal_condition(raw_condition)?;

    let before = deps.read_goal().await;
    deps.paste(pane, &format!("/goal {condition}"), Submit::Yes)
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
    let pane = typing_target(agent)?;
    deps.paste(pane, "/goal clear", Submit::Yes).await.map_err(ControlFailure::Failed)
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
/// An agent that does not speak that command skips straight to closing its
/// tmux session. Typing `/exit` at it would not shut anything down — it would
/// leave a stray line in the prompt of a session the user asked to close, and
/// then force-kill it six seconds later anyway. Closing is the one place INV-7
/// bends, and only because tmux can do it without the agent's cooperation.
///
/// The poll is sequential on purpose and must stay that way. Each
/// `pane_alive` is a tmux round trip, and on a machine at its process cap —
/// which 109 panes and 33 Claude sessions will reach — a burst of tmux clients
/// is answered with `EAGAIN`. One question at a time, spaced by the wait, is
/// what makes this work on the machine that needs it most.
pub async fn close_agent(agent: Option<&Agent>, deps: &dyn ControlDeps) -> Act<CloseResult> {
    let pane = assert_controllable(agent)?;
    let agent = agent.expect("assert_controllable proved this is Some");

    if !allows_slash_commands(&agent.agent_kind) {
        let Some(session) = agent.tmux_session.as_deref() else {
            return Err(ControlError::new(
                "agent has no shutdown command and no tmux session to close",
            )
            .into());
        };
        deps.kill_session(session).await.map_err(ControlFailure::Failed)?;
        return Ok(CloseResult { closed: true, forced: true });
    }

    deps.paste(pane, "/exit", Submit::Yes).await.map_err(ControlFailure::Failed)?;

    let mut waited = 0u64;
    while waited < GRACE_MS {
        deps.wait(POLL_MS).await;
        if !deps.pane_alive(pane).await {
            return Ok(CloseResult { closed: true, forced: false });
        }
        waited += POLL_MS;
    }

    let Some(session) = agent.tmux_session.as_deref() else {
        return Err(
            ControlError::new("agent ignored /exit and has no tmux session to close").into()
        );
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
pub fn check_key(key: &str, confirmed: Option<bool>) -> Result<SendableKey, KeyRefusal> {
    if !is_allowed_key(key) {
        return Err(KeyRefusal::NotAllowed(key.to_string()));
    }
    if is_destructive_key(key) && confirmed != Some(true) {
        return Err(KeyRefusal::NeedsConfirmation(key.to_string()));
    }
    Ok(SendableKey(key.to_string()))
}

/// A key that may reach a live agent.
///
/// This is INV-6 (and INV-2's allow-list) as a type rather than as a check
/// every call site remembers to make. [`PaneApi::key`] takes one, and there
/// are exactly two ways to get one: [`check_key`], which is where a key the
/// *client* named is held to the allow-list and to the confirmation rule; and
/// [`SendableKey::server_composed`], for a key the *server* decided to send —
/// the mode chord, the digit that answers a prompt. The second takes a
/// `&'static str`, which nothing that arrived on the wire can be, so a client's
/// key cannot be smuggled through it. Before this type, `on_key` checked and
/// then passed a bare `&str` on; a second caller that forgot the check would
/// have compiled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendableKey(String);

impl SendableKey {
    /// A key the server chose to send, spelled as a literal in the server.
    ///
    /// Not held to the allow-list: `BTab` is not on it, because a client may
    /// not send it, and this is how the server sends it anyway. It is still
    /// held to INV-6 — the server never composes an interrupt on anyone's
    /// behalf, and a literal that tried to would fail every test that reaches
    /// this line.
    pub(crate) fn server_composed(name: &'static str) -> SendableKey {
        debug_assert!(!is_destructive_key(name), "the server never composes {name}");
        SendableKey(name.to_string())
    }

    /// The tmux key name, for the one place it becomes an argument.
    pub fn as_str(&self) -> &str {
        &self.0
    }
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

/// A clock delta arrives in milliseconds; the refill rate is per second.
const MILLIS_PER_SECOND: f64 = 1000.0;

/// What one message costs. The bucket counts messages rather than bytes:
/// INV-12 is about how many times a live agent is written to, and a `key` and
/// a `paste` reach it exactly once each.
const ONE_MESSAGE: f64 = 1.0;

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
        let elapsed = (now - *last).max(0) as f64 / MILLIS_PER_SECOND;
        *tokens = (*tokens + elapsed * WRITE_PER_SECOND).min(WRITE_BURST);
        *last = now;
        if *tokens < ONE_MESSAGE {
            return false;
        }
        *tokens -= ONE_MESSAGE;
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
    use crate::agent_kinds::CLAUDE_KIND;
    use crate::sources::PaneMeta;
    use std::sync::Mutex as StdMutex;

    /// Verification windows for the fakes. `wait()` is instant in here, so
    /// these are poll counts wearing milliseconds rather than elapsed time.
    ///
    /// The long one gives the fake every chance to answer; the two short ones
    /// run out while it goes on answering the same thing, which is how the
    /// "nothing was observed" paths are reached.
    const VERIFIED_MS: u64 = 5000;
    const CLEAR_TIMES_OUT_MS: u64 = 400;
    const GOAL_TIMES_OUT_MS: u64 = 500;

    /// A window the guard tests never reach: the action is refused before the
    /// verification loop starts, so the value cannot matter.
    const UNREACHED_MS: u64 = 500;

    /// Three moments, ordered. Verification asks "is there a newer record?",
    /// so what matters is only that these are far enough apart to be told
    /// apart.
    const GOAL_SET_EARLIER_AT: i64 = 10;
    const GOAL_SET_AT: i64 = 1000;
    const GOAL_EVALUATED_AT: i64 = 2000;

    fn agent() -> Agent {
        Agent {
            session_id: "a".into(),
            pid: 1,
            name: "agent".into(),
            cwd: "/x".into(),
            folder: "x".into(),
            status: AgentStatus::Idle,
            agent_kind: CLAUDE_KIND.into(),
            kind: "interactive".into(),
            started_at: 0,
            pane_id: Some("%1".into()),
            tmux_session: Some("claude-1".into()),
            ..Default::default()
        }
    }

    /// The one fixture in this file that is not Claude: a CLI that does not
    /// understand a single thing this module types.
    fn kiro() -> Agent {
        Agent {
            session_id: "tmux:kiro-1".into(),
            agent_kind: "kiro".into(),
            tmux_session: Some("kiro-1".into()),
            ..agent()
        }
    }

    /// The record `/goal <condition>` writes. `fresh` is the marker that tells
    /// a set apart from an evaluation, and it is the whole thing `landed` reads.
    fn goal_set(condition: &str, recorded_at: i64) -> GoalState {
        GoalState {
            condition: condition.into(),
            met: false,
            at: recorded_at,
            reason: None,
            fresh: Some(true),
        }
    }

    /// Anything that is not a set: an evaluation of a goal already running, or
    /// a goal read back long after it was set.
    fn goal_evaluated(condition: &str, recorded_at: i64) -> GoalState {
        GoalState { fresh: None, ..goal_set(condition, recorded_at) }
    }

    /// Records everything that would have reached tmux, and answers reads from
    /// whatever the test configured. Nothing here shells out.
    #[derive(Default)]
    struct Fake {
        pastes: StdMutex<Vec<(String, String, Submit)>>,
        keys: StdMutex<Vec<(String, String)>>,
        killed: StdMutex<Vec<String>>,
        /// Goal before anything is typed, and after — the whole question
        /// `set_goal` exists to answer.
        goal_before: StdMutex<Option<GoalState>>,
        goal_after: StdMutex<Option<GoalState>>,
        session_before: StdMutex<Option<String>>,
        session_after: StdMutex<Option<String>>,
        /// Reads of the session id that still answer the old one.
        slow_session_reads: StdMutex<u32>,
        typed: StdMutex<bool>,
        pressed: StdMutex<bool>,
        alive: StdMutex<bool>,
    }

    impl Fake {
        fn new() -> Arc<Self> {
            Arc::new(Fake {
                session_before: StdMutex::new(Some("session-before".into())),
                session_after: StdMutex::new(Some("session-before".into())),
                alive: StdMutex::new(false),
                ..Default::default()
            })
        }
        fn goals(before: Option<GoalState>, after: Option<GoalState>) -> Arc<Self> {
            let f = Fake::new();
            *f.goal_before.lock().unwrap() = before;
            *f.goal_after.lock().unwrap() = after;
            f
        }
        /// A session that rotates its id once `/clear` has been typed.
        fn rotating() -> Arc<Self> {
            let f = Fake::new();
            *f.session_after.lock().unwrap() = Some("session-after".into());
            f
        }
        fn pastes(&self) -> Vec<(String, String, Submit)> {
            self.pastes.lock().unwrap().clone()
        }
        fn presses(&self) -> usize {
            self.keys.lock().unwrap().len()
        }
    }

    #[async_trait]
    impl ControlDeps for Arc<Fake> {
        async fn paste(
            &self,
            pane_id: &str,
            text: &str,
            submit: Submit,
        ) -> anyhow::Result<()> {
            self.pastes.lock().unwrap().push((pane_id.into(), text.into(), submit));
            *self.typed.lock().unwrap() = true;
            Ok(())
        }
        async fn key(&self, pane_id: &str, key: &SendableKey) -> anyhow::Result<()> {
            self.keys.lock().unwrap().push((pane_id.into(), key.as_str().into()));
            *self.pressed.lock().unwrap() = true;
            Ok(())
        }
        async fn read_goal(&self) -> Option<GoalState> {
            if *self.typed.lock().unwrap() {
                self.goal_after.lock().unwrap().clone()
            } else {
                self.goal_before.lock().unwrap().clone()
            }
        }
        async fn read_session_id(&self, _pid: i64) -> Option<String> {
            if !*self.typed.lock().unwrap() {
                return self.session_before.lock().unwrap().clone();
            }
            let mut slow = self.slow_session_reads.lock().unwrap();
            if *slow > 0 {
                *slow -= 1;
                return self.session_before.lock().unwrap().clone();
            }
            self.session_after.lock().unwrap().clone()
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
        async fn wait(&self, _millis: u64) {}
    }

    /* ---- INV-8: the guards ---- */

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
        // ...and the weaker guard, which mode and model use, still lets it by.
        assert!(assert_attachable(Some(&a)).is_ok());
    }

    #[test]
    fn inv8_refuses_an_agent_with_no_pane_and_says_why() {
        let a =
            Agent { pane_id: None, attach_blocked_reason: Some("not in tmux".into()), ..agent() };
        assert!(assert_controllable(Some(&a)).unwrap_err().0.contains("not in tmux"));
        assert!(assert_attachable(Some(&a)).unwrap_err().0.contains("not in tmux"));
    }

    #[test]
    fn inv8_refuses_a_vanished_agent() {
        assert!(assert_controllable(None).unwrap_err().0.contains("no longer available"));
        assert!(assert_attachable(None).is_err());
    }

    /// INV-8's one exception, stated as the property rather than one case:
    /// mode goes through on a busy agent and nothing else does.
    #[tokio::test]
    async fn inv8_mode_is_the_only_action_allowed_while_busy() {
        let busy = Agent { status: AgentStatus::Busy, ..agent() };

        let f = Fake::new();
        send_shift_tab(Some(&busy), &f).await.unwrap();
        assert_eq!(f.presses(), 1);
        // And it still never types: text is what the busy refusal stops.
        assert!(f.pastes().is_empty());

        for refused in [
            clear_context(Some(&busy), &Fake::new(), UNREACHED_MS).await.err(),
            compact_context(Some(&busy), &Fake::new()).await.err(),
            set_goal(Some(&busy), "the tests pass", &Fake::new(), UNREACHED_MS).await.err(),
            clear_goal(Some(&busy), &Fake::new()).await.err(),
            close_agent(Some(&busy), &Fake::new()).await.err(),
        ] {
            let err = refused.expect("a typing action must refuse a busy agent");
            assert!(err.to_string().contains("busy"), "{err}");
            assert!(err.is_client_error());
        }
    }

    /* ---- INV-7: another CLI is not typed at ---- */

    /// A Claude Code slash command is not a feature that degrades on another
    /// CLI. Against Kiro it is this app typing a sentence of its own into
    /// somebody's prompt, so every one of these refuses — and refuses *before*
    /// anything is typed or pressed.
    #[tokio::test]
    async fn inv8_refuses_slash_commands_for_kiro() {
        let k = kiro();

        let f = Fake::new();
        assert!(set_model(Some(&k), "opus", &f).await.unwrap_err().is_client_error());
        assert!(f.pastes().is_empty());

        let f = Fake::new();
        assert!(send_shift_tab(Some(&k), &f).await.is_err());
        assert_eq!(f.presses(), 0, "a BTab reached a CLI that does not cycle modes");

        let f = Fake::rotating();
        assert!(clear_context(Some(&k), &f, UNREACHED_MS).await.is_err());
        assert!(compact_context(Some(&k), &f).await.is_err());
        assert!(set_goal(Some(&k), "the tests pass", &f, UNREACHED_MS).await.is_err());
        assert!(clear_goal(Some(&k), &f).await.is_err());
        assert!(f.pastes().is_empty(), "something was typed at a non-Claude CLI");
    }

    /// An unknown CLI is denied for the same reason, without anyone having to
    /// add it to a list. An empty `agent_kind` — the shape a forgotten field
    /// takes — is one of those.
    #[tokio::test]
    async fn inv7_an_unknown_agent_kind_is_denied_rather_than_assumed() {
        for kind in ["", "gemini", "CLAUDE"] {
            let a = Agent { agent_kind: kind.into(), ..agent() };
            let f = Fake::new();
            assert!(set_model(Some(&a), "opus", &f).await.is_err(), "{kind:?}");
            assert!(f.pastes().is_empty(), "{kind:?}");
        }
    }

    /// Close is the exception, and only because tmux can do it without the
    /// agent's cooperation. Typing `/exit` first would leave a stray line in
    /// the prompt of a session the user asked to close.
    #[tokio::test]
    async fn inv7_closes_kiro_by_killing_its_tmux_session_rather_than_typing() {
        let f = Fake::new();
        let result = close_agent(Some(&kiro()), &f).await.unwrap();
        assert!(f.pastes().is_empty());
        assert_eq!(f.killed.lock().unwrap().as_slice(), ["kiro-1"]);
        assert_eq!(result, CloseResult { closed: true, forced: true });
    }

    #[tokio::test]
    async fn inv7_refuses_to_close_a_foreign_cli_with_no_tmux_session() {
        let f = Fake::new();
        let a = Agent { tmux_session: None, ..kiro() };
        let err = close_agent(Some(&a), &f).await.unwrap_err();
        assert!(err.to_string().contains("no shutdown command"), "{err}");
    }

    /* ---- model ---- */

    #[tokio::test]
    async fn set_model_types_the_clis_own_command() {
        let f = Fake::new();
        let r = set_model(Some(&agent()), "opus", &f).await.unwrap();
        assert_eq!(f.pastes(), vec![("%1".into(), "/model opus".into(), Submit::Yes)]);
        assert!(!r.queued, "an idle agent reads it now");
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

    /// Allowed mid-turn, and reported as queued rather than as done. Refusing
    /// it forbade through one door exactly what the composer permits through
    /// another, with the same keystrokes reaching the same prompt.
    #[tokio::test]
    async fn set_model_switches_a_busy_agent_and_says_the_change_is_queued() {
        let f = Fake::new();
        let a = Agent { status: AgentStatus::Busy, ..agent() };
        let r = set_model(Some(&a), "opus", &f).await.unwrap();
        assert!(r.queued);
        assert_eq!(f.pastes(), vec![("%1".into(), "/model opus".into(), Submit::Yes)]);
    }

    /* ---- shift+tab ---- */

    #[tokio::test]
    async fn shift_tab_presses_back_tab_exactly_once() {
        let f = Fake::new();
        send_shift_tab(Some(&agent()), &f).await.unwrap();
        assert_eq!(f.keys.lock().unwrap().as_slice(), [("%1".to_string(), "BTab".to_string())]);
    }

    /// It types nothing. That is the whole reason this one control stays
    /// available while the agent is working (INV-8).
    #[tokio::test]
    async fn shift_tab_never_types() {
        let f = Fake::new();
        send_shift_tab(Some(&agent()), &f).await.unwrap();
        assert!(f.pastes().is_empty());
    }

    /// Reachable is still required: Shift+Tab skips the busy guard, not the pane.
    #[tokio::test]
    async fn shift_tab_still_refuses_an_agent_it_cannot_reach() {
        let f = Fake::new();
        let a = Agent { status: AgentStatus::Busy, pane_id: None, ..agent() };
        let err = send_shift_tab(Some(&a), &f).await.unwrap_err();
        assert!(err.to_string().contains("attachable"), "{err}");
        assert_eq!(f.presses(), 0);
    }

    /* ---- clear ---- */

    /// `/clear` replaces the session rather than editing it, so the new id is
    /// the answer and not decoration on it.
    #[tokio::test]
    async fn inv8_clear_reports_the_id_the_session_is_running_now() {
        let f = Fake::rotating();
        let r = clear_context(Some(&agent()), &f, VERIFIED_MS).await.unwrap();
        assert_eq!(f.pastes(), vec![("%1".into(), "/clear".into(), Submit::Yes)]);
        assert_eq!(r.session_id.as_deref(), Some("session-after"));
        assert!(!r.unobserved);
    }

    /// The id never turned over inside the window. The paste went out, so this
    /// is not a failure — and a caller that navigated on it would land on an id
    /// that may not exist.
    #[tokio::test]
    async fn inv8_clear_reports_unobserved_rather_than_failure() {
        let f = Fake::new(); // before == after: nothing rotated
        let r = clear_context(Some(&agent()), &f, CLEAR_TIMES_OUT_MS).await.unwrap();
        assert_eq!(f.pastes().len(), 1);
        assert!(r.ok && r.unobserved);
        assert!(r.session_id.is_none());
    }

    /// A session record that cannot be read is INV-5's case, not an error: the
    /// clear may well have landed, and nothing here can tell.
    #[tokio::test]
    async fn inv5_clear_reports_unobserved_when_the_session_record_cannot_be_read() {
        let f = Fake::new();
        *f.session_before.lock().unwrap() = None;
        *f.session_after.lock().unwrap() = None;
        let r = clear_context(Some(&agent()), &f, CLEAR_TIMES_OUT_MS).await.unwrap();
        assert!(r.ok && r.unobserved);
    }

    /// The one that would be a silent disaster: an unreadable record must not
    /// be mistaken for a rotation just because it differs from the old id.
    #[tokio::test]
    async fn inv8_an_unreadable_record_is_never_read_as_a_new_session() {
        let f = Fake::new();
        *f.session_after.lock().unwrap() = None;
        let r = clear_context(Some(&agent()), &f, CLEAR_TIMES_OUT_MS).await.unwrap();
        assert!(r.unobserved);
        assert!(r.session_id.is_none());
    }

    #[tokio::test]
    async fn clear_waits_for_a_record_that_is_rewritten_late() {
        // The old id is answered this many times before the new one appears,
        // which is more polls than a single-shot check would ever make.
        const LATE_REWRITE_POLLS: u32 = 3;

        let f = Fake::rotating();
        *f.slow_session_reads.lock().unwrap() = LATE_REWRITE_POLLS;
        let r = clear_context(Some(&agent()), &f, VERIFIED_MS).await.unwrap();
        assert_eq!(r.session_id.as_deref(), Some("session-after"));
    }

    /* ---- compact ---- */

    /// A real compaction ran for 157 seconds. Anything that verified would
    /// hang; this returns as soon as the text is submitted.
    #[tokio::test]
    async fn inv8_compact_types_and_does_not_wait_for_the_result() {
        let f = Fake::new();
        compact_context(Some(&agent()), &f).await.unwrap();
        assert_eq!(f.pastes(), vec![("%1".into(), "/compact".into(), Submit::Yes)]);
    }

    /* ---- close ---- */

    #[tokio::test]
    async fn close_asks_the_session_to_exit_and_stops_there_when_it_does() {
        let f = Fake::new();
        *f.alive.lock().unwrap() = false;
        let r = close_agent(Some(&agent()), &f).await.unwrap();
        assert_eq!(f.pastes(), vec![("%1".into(), "/exit".into(), Submit::Yes)]);
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

    /* ---- goal ---- */

    #[tokio::test]
    async fn set_goal_types_the_clis_own_goal_command() {
        let f = Fake::goals(None, Some(goal_set("the tests pass", GOAL_SET_AT)));
        set_goal(Some(&agent()), "the tests pass", &f, VERIFIED_MS).await.unwrap();
        assert_eq!(f.pastes(), vec![("%1".into(), "/goal the tests pass".into(), Submit::Yes)]);
    }

    #[tokio::test]
    async fn set_goal_confirms_only_once_the_session_wrote_the_goal_down() {
        let f = Fake::goals(None, Some(goal_set("the tests pass", GOAL_SET_AT)));
        assert!(set_goal(Some(&agent()), "the tests pass", &f, VERIFIED_MS).await.unwrap().ok);
    }

    /// The condition Claude Code stores is canonicalised, so verification asks
    /// "is there a newer record?" rather than "does the text match?".
    #[tokio::test]
    async fn set_goal_accepts_a_record_whose_text_was_rewritten() {
        let f = Fake::goals(
            Some(goal_evaluated("something older", GOAL_SET_EARLIER_AT)),
            Some(goal_set("The tests pass.", GOAL_SET_AT)),
        );
        assert!(set_goal(Some(&agent()), "the tests pass", &f, VERIFIED_MS).await.unwrap().ok);
    }

    #[tokio::test]
    async fn set_goal_reports_failure_when_nothing_is_ever_recorded() {
        let f = Fake::goals(None, None);
        assert!(!set_goal(Some(&agent()), "the tests pass", &f, GOAL_TIMES_OUT_MS).await.unwrap().ok);
    }

    /// The paste went nowhere — into a dialog, or a session that was not at its
    /// prompt — and the goal already on the session is unchanged. Reading it
    /// back must not be mistaken for the new goal landing.
    #[tokio::test]
    async fn set_goal_does_not_mistake_the_previous_goal_for_the_new_one() {
        let stale = goal_evaluated("something older", GOAL_SET_EARLIER_AT);
        let f = Fake::goals(Some(stale.clone()), Some(stale));
        assert!(!set_goal(Some(&agent()), "the tests pass", &f, GOAL_TIMES_OUT_MS).await.unwrap().ok);
    }

    /// A goal already running gets evaluated every time the session would stop.
    /// One of those landing while we waited says nothing about whether the goal
    /// we typed was accepted — only the set-record does.
    #[tokio::test]
    async fn set_goal_does_not_accept_an_evaluation_of_the_old_goal_as_proof() {
        let stale = goal_set("something older", GOAL_SET_EARLIER_AT);
        let mut evaluated = goal_evaluated("something older", GOAL_EVALUATED_AT);
        evaluated.reason = Some("Not yet.".into());
        let f = Fake::goals(Some(stale), Some(evaluated));
        assert!(!set_goal(Some(&agent()), "the tests pass", &f, GOAL_TIMES_OUT_MS).await.unwrap().ok);
    }

    #[tokio::test]
    async fn clear_goal_types_goal_clear() {
        let f = Fake::new();
        clear_goal(Some(&agent()), &f).await.unwrap();
        assert_eq!(f.pastes(), vec![("%1".into(), "/goal clear".into(), Submit::Yes)]);
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
            assert!(set_goal(Some(&agent()), hostile, &f, UNREACHED_MS).await.is_err());
            assert!(f.pastes().is_empty(), "{hostile:?} was typed anyway");
        }
    }

    /* ---- LiveDeps::pane_alive ---- */

    /// A pane, configured with the only two answers this test turns on:
    /// whether tmux replies about it at all, and whether the process behind it
    /// has exited.
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
        async fn capture(&self, _pane_id: &str, _rows: usize) -> anyhow::Result<Vec<String>> {
            Ok(vec![])
        }
        async fn paste(
            &self,
            _pane_id: &str,
            _text: &str,
            _submit: Submit,
        ) -> anyhow::Result<()> {
            Ok(())
        }
        async fn key(&self, _pane_id: &str, _key: &SendableKey) -> anyhow::Result<()> {
            Ok(())
        }
    }

    /// A pane tmux still lists, still answers about, and whose process has
    /// exited. `remain-on-exit` makes this ordinary, and treating it as alive
    /// would send `close_agent` on to kill a tmux session that had already
    /// done what was asked of it.
    #[tokio::test]
    async fn a_dead_but_still_listed_pane_reads_as_not_alive() {
        let live = |dead: bool, answers: bool| LiveDeps {
            panes: Arc::new(Panes { dead, answers }),
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

    /* ---- refusal vs failure ---- */

    /// Deps whose every write to a live pane fails the way a machine at its
    /// process cap fails: tmux itself could not be started.
    struct Broken;

    #[async_trait]
    impl ControlDeps for Broken {
        async fn paste(
            &self,
            _pane_id: &str,
            _text: &str,
            _submit: Submit,
        ) -> anyhow::Result<()> {
            anyhow::bail!("spawn tmux EAGAIN")
        }
        async fn key(&self, _pane_id: &str, _key: &SendableKey) -> anyhow::Result<()> {
            anyhow::bail!("spawn tmux EAGAIN")
        }
        async fn read_goal(&self) -> Option<GoalState> {
            None
        }
        async fn read_session_id(&self, _pid: i64) -> Option<String> {
            None
        }
        async fn pane_alive(&self, _pane_id: &str) -> bool {
            false
        }
        async fn kill_session(&self, _session: &str) -> anyhow::Result<()> {
            Ok(())
        }
        async fn wait(&self, _millis: u64) {}
    }

    /// A tmux round trip that failed is not the user having asked for
    /// something invalid, and must not be reported as if it were.
    #[tokio::test]
    async fn a_failed_write_is_a_server_failure_not_a_refusal() {
        let err = set_model(Some(&agent()), "opus", &Broken).await.unwrap_err();
        assert!(!err.is_client_error(), "{err}");
        assert!(err.to_string().contains("EAGAIN"));

        let err = send_shift_tab(Some(&agent()), &Broken).await.unwrap_err();
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
        let ordinary = crate::types::ALLOWED_KEYS.iter().filter(|k| !is_destructive_key(k)).count();
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
    /// INV-2: a digit is an *absolute* choice, which is the only reason it is
    /// allowed at all. `0` names no option and a two-digit string is not a key.
    #[test]
    fn inv2_allows_single_digits_and_nothing_that_merely_looks_like_one() {
        for key in ["1", "5", "9"] {
            assert!(check_key(key, None).is_ok(), "{key}");
        }
        for hostile in ["0", "10", "1 ", " 1", "1\n", "99", "-1", "1;2"] {
            assert!(
                matches!(check_key(hostile, None), Err(KeyRefusal::NotAllowed(_))),
                "{hostile}"
            );
        }
    }

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
        // The measurement this budget exists because of: 5,000 messages in
        // 1.5s were all accepted, with no error and no backpressure.
        const FLOOD_MESSAGES: usize = 5000;
        const FLOOD_SPAN_MS: f64 = 1500.0;
        // Above this it is not bounded, it is unbounded with extra steps.
        const FLOOD_CEILING: i32 = 500;

        let budget = WriteBudget::new(0);
        let mut allowed = 0;
        for message in 0..FLOOD_MESSAGES {
            let now = (message as f64 * FLOOD_SPAN_MS / FLOOD_MESSAGES as f64) as i64;
            if budget.take_at(now) {
                allowed += 1;
            }
        }
        assert!(allowed < FLOOD_CEILING, "{allowed} got through");
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
        // A brisk sentence typed into the Attach view — faster than most
        // people manage.
        const KEYSTROKE_GAP_MS: i64 = 15;

        let budget = WriteBudget::new(0);
        let sentence = "the quick brown fox jumps over the lazy dog";
        for (i, _) in sentence.chars().enumerate() {
            assert!(budget.take_at(i as i64 * KEYSTROKE_GAP_MS), "refused character {i}");
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
