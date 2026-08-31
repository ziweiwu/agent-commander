//! Wire types shared by the server and the browser client.
//!
//! This is a byte-for-byte port of `src/shared/types.ts`. The existing React
//! client is the consumer, so field names are camelCase and every optional
//! field must be *omitted* when absent rather than serialised as `null` — a
//! `"waitingFor": null` reads as present-and-empty to the TS client, which
//! checks `!== undefined` in several places.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Busy,
    Idle,
    Waiting,
    /// The default, deliberately: an unset status must never read as a claim.
    #[default]
    Unknown,
}

/// One Claude Code session, as presented to the UI.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub session_id: String,
    pub pid: i64,
    pub name: String,
    pub cwd: String,
    /// Basename of cwd, precomputed for the card header.
    pub folder: String,
    pub status: AgentStatus,
    /// The status above was derived by this app rather than reported by the agent.
    ///
    /// INV-11: the dashboard never asserts more than it knows. A Claude session
    /// says "waiting, dialog open" about itself; a tmux-discovered agent only
    /// ever shows whether its pane has produced output lately, which is a far
    /// weaker claim wearing the same word.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_inferred: Option<bool>,
    /// Why the agent is blocked, e.g. "dialog open". Only when status is waiting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_for: Option<String>,
    /// Which agent CLI this is — see `agent_kinds.rs`.
    ///
    /// Not optional, so every construction site has to say: a silent default
    /// here reaches a capability lookup and quietly denies everything. Distinct
    /// from `kind` below, which is Claude Code's own word for the sort of
    /// session it is and means nothing elsewhere.
    pub agent_kind: String,
    pub kind: String,
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    /// tmux pane id (e.g. "%77"). Absent means the agent cannot be attached to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    /// tmux session name, display only — never attached to (INV-1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmux_session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attach_blocked_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagents: Option<i64>,
    /// Handed work to a subagent and doing nothing itself until it returns.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delegating: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derived_name: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<GoalState>,
}

/// A Claude Code session goal, as recorded by `/goal` in the transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalState {
    pub condition: String,
    /// True once the evaluator confirmed it. A met goal is finished, not running.
    pub met: bool,
    pub at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// True when this is the set-record, so nothing has evaluated it yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fresh: Option<bool>,
}

/// One quota window, as a percentage used and when it refills.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// 0-100.
    pub pct: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
}

/// Account-level subscription usage, bridged out of Claude Code's statusLine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<UsageWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seven_day: Option<UsageWindow>,
    /// Epoch ms the bridge last wrote. The UI dims the meters once this is old.
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleEnv {
    pub cli_path: String,
    pub dns_name: String,
    pub ip: String,
    pub running: bool,
}

/// Facts about the host machine, used by the help page.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEnv {
    pub tailscale: Option<TailscaleEnv>,
    /// False when no tmux server is reachable, which disables attach and spawning.
    pub tmux: bool,
    pub port: u16,
    pub platform: String,
    /// The version of the code that is answering, not of anything asking.
    ///
    /// Compiled in from `CARGO_PKG_VERSION`, so it cannot drift from the binary
    /// the way a string read off disk could — and `the_two_manifests_agree`
    /// keeps that in step with the npm package the binary ships inside.
    pub version: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAgentRequest {
    pub cwd: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    pub name: String,
    pub path: String,
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub root: String,
    pub entries: Vec<DirEntryDto>,
}

/// `{ ok: true, detail? } | { ok: false, error }`
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ControlResponse {
    Ok {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    Err {
        ok: bool,
        error: String,
    },
}

impl ControlResponse {
    pub fn ok(detail: Option<String>) -> Self {
        ControlResponse::Ok { ok: true, detail }
    }
    pub fn err(error: impl Into<String>) -> Self {
        ControlResponse::Err { ok: false, error: error.into() }
    }
}

/// `{ ok: true, tmuxSession, cwd } | { ok: false, error }`
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum NewAgentResponse {
    Ok {
        ok: bool,
        #[serde(rename = "tmuxSession")]
        tmux_session: String,
        cwd: String,
    },
    Err {
        ok: bool,
        error: String,
    },
}

impl NewAgentResponse {
    pub fn ok(tmux_session: String, cwd: String) -> Self {
        NewAgentResponse::Ok { ok: true, tmux_session, cwd }
    }
    pub fn err(error: impl Into<String>) -> Self {
        NewAgentResponse::Err { ok: false, error: error.into() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimelineKind {
    User,
    Assistant,
    Tool,
    Subagent,
    Notice,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEvent {
    pub id: String,
    pub at: i64,
    pub kind: TimelineKind,
    /// Primary line of text.
    pub text: String,
    /// Tool name, for kind == Tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// True when this event came from a subagent sidechain.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidechain: Option<bool>,
    /// For `kind == Notice`: which notice this is, so the client names it in
    /// the reader's language rather than showing a sentence the server wrote.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<NoticeKind>,
    /// Context tokens either side of a compaction, for the notice above.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_before: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_after: Option<i64>,
}

/// Which compaction notice a `Notice` event is reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeKind {
    Compacted,
    CompactedAuto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedRow {
    pub row: usize,
    pub text: String,
}

/// A rendered snapshot of a tmux pane.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub session_id: String,
    pub cols: usize,
    pub rows: usize,
    pub cursor_x: usize,
    pub cursor_y: usize,
    /// Full frame: every line, padded to `rows`. Sent on first paint and resync.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<String>>,
    /// Sparse update: only the rows that changed since the last frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed: Option<Vec<ChangedRow>>,
}

/// Pane geometry, the non-content half of a capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Geom {
    pub cols: usize,
    pub rows: usize,
    pub cursor_x: usize,
    pub cursor_y: usize,
}

/* ---- client -> server ---- */

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    #[serde(rename = "focus")]
    Focus {
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
    },
    #[serde(rename = "attach")]
    Attach {
        #[serde(rename = "sessionId")]
        session_id: String,
        on: bool,
    },
    /// `seq` is echoed back as a `paste-ack` so the client keeps exactly one
    /// paste in flight.
    #[serde(rename = "paste")]
    Paste {
        #[serde(rename = "sessionId")]
        session_id: String,
        text: String,
        submit: bool,
        #[serde(default)]
        seq: Option<i64>,
    },
    /// `confirmed` is set only when the user answered a confirmation dialog for
    /// a key on `DESTRUCTIVE_KEYS`. The server refuses those keys without it —
    /// the guard is a boundary, not a UI convention (INV-6).
    #[serde(rename = "key")]
    Key {
        #[serde(rename = "sessionId")]
        session_id: String,
        key: String,
        #[serde(default)]
        confirmed: Option<bool>,
    },
}

/* ---- server -> client ---- */

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    #[serde(rename = "fleet")]
    Fleet { agents: Vec<Agent>, mock: bool },
    #[serde(rename = "limits")]
    Limits { limits: Option<RateLimits> },
    #[serde(rename = "timeline")]
    Timeline {
        #[serde(rename = "sessionId")]
        session_id: String,
        events: Vec<TimelineEvent>,
        reset: bool,
    },
    #[serde(rename = "frame")]
    Frame { frame: Frame },
    /// A paste has finished being written to tmux. Flow control only: it never
    /// causes anything to be sent again (INV-2).
    #[serde(rename = "paste-ack")]
    PasteAck {
        #[serde(rename = "sessionId")]
        session_id: String,
        seq: i64,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        message: String,
        /// `kind` names the condition; `message` is only how to say it. The
        /// pane-exit case is the one state a viewer must react to
        /// structurally, because INV-1 means there is no pty to report it.
        #[serde(skip_serializing_if = "Option::is_none")]
        kind: Option<ErrorKind>,
    },
}

/// Structured error conditions a client may branch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    PaneExited,
}

/*
 * The delegation graph (INV-13).
 *
 * Ported from `src/shared/types.ts`. Three states rather than two, and the
 * third is the point: an agent that finished and an agent that died both stop
 * writing, so nothing on disk separates them. `Quiet` is its own answer and is
 * never drawn as `Done` — the same absence-of-evidence rule INV-11 applies to
 * an inferred status on a fleet card.
 */

/// What a delegate is doing, and how much of that this app actually knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubagentState {
    Active,
    Quiet,
    Done,
}

/// One delegate in an agent's tree, and everything below it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentNode {
    /// Claude Code's own id for the delegate; the transcript is named after it.
    pub agent_id: String,
    /// The subagent type, e.g. `general-purpose`, or a forked skill's name.
    pub agent_type: String,
    /// The one-line brief the parent gave it.
    pub description: String,
    /// 1 for a delegate of the session itself, 2 for a delegate of a delegate.
    pub depth: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_agent_id: Option<String>,
    /// When its transcript was last written to.
    pub last_write_at: i64,
    /// Transcript size. A coarse "how much work", never a percentage.
    pub bytes: u64,
    /// Tool calls recorded in its transcript, and the span it worked over.
    ///
    /// What it *did*, as against `state`, which is what became of it. Both are
    /// needed because `state` is almost always `Quiet` — the honest answer, and
    /// an uninformative one on its own (INV-13). `None` when the transcript
    /// could not be read or is too large to keep re-reading; a node then
    /// renders without them rather than with a zero, which would claim it did
    /// nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calls: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worked_ms: Option<i64>,
    pub state: SubagentState,
    /// The state was worked out here rather than reported (INV-11). Set on
    /// `Active`, which is a guess from a recent write and a busy parent, and
    /// never on `Done`, which is only ever claimed on evidence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_inferred: Option<bool>,
    /// The user stopped it. Evidence of an ending, so the state is `Done`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_by_user: Option<bool>,
    /// Its parent id named a delegate that is not on disk, so it was raised to
    /// the top of the tree rather than dropped with everything under it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reparented: Option<bool>,
    pub children: Vec<SubagentNode>,
}

/// One agent's delegates. `children` is empty for an agent that never delegated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTree {
    pub session_id: String,
    pub children: Vec<SubagentNode>,
    /// This app cannot tell whether this agent has delegated at all.
    ///
    /// True for a CLI that keeps no transcript: the evidence lives in files it
    /// does not write, so an empty tree here is absence of evidence rather than
    /// evidence of absence, and must not read as "delegated nothing".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unknown: Option<bool>,
}

/// The whole fleet's delegation graph, as served by `GET /api/tree`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FleetTree {
    pub trees: Vec<AgentTree>,
}

/*
 * The option lists, in the one module both sides import.
 *
 * These lived in three places each, and drift between the copies is asymmetric
 * and bad in both directions — a model the server accepts but no UI offers is
 * invisible, and one the UI offers but the server rejects is a click that turns
 * into a toast. Only the values live here; labelling stays in the web layer.
 */

/// Model aliases the CLI accepts, and the only ones this app will pass on.
pub const MODEL_ALIASES: &[&str] =
    &["default", "opus", "sonnet", "haiku", "fable", "opusplan"];

/// Permission modes in the order Shift+Tab cycles them, per the CLI's own
/// documentation. The last two appear only when available in that session.
pub const MODE_CYCLE: &[&str] =
    &["default", "acceptEdits", "plan", "bypassPermissions", "auto"];

/// Modes settable at spawn time. `dontAsk` is reachable by flag but never cycles.
pub const SPAWN_MODES: &[&str] = &[
    "default", "acceptEdits", "plan", "bypassPermissions", "auto", "dontAsk",
];

pub fn is_model_alias(value: &str) -> bool {
    MODEL_ALIASES.contains(&value)
}

pub fn is_cyclable_mode(value: &str) -> bool {
    MODE_CYCLE.contains(&value)
}

pub fn is_spawn_mode(value: &str) -> bool {
    SPAWN_MODES.contains(&value)
}

/// Control keys the server will forward. Anything else is rejected (INV-2).
pub const ALLOWED_KEYS: &[&str] = &[
    "Enter", "Escape", "Tab", "BSpace", "Space", "Up", "Down", "Left", "Right", "Home", "End",
    "PageUp", "PageDown", "C-c", "C-d", "C-o", "C-r", "C-u",
];

/// Keys that can destroy work, so the UI must confirm before sending (INV-6).
pub const DESTRUCTIVE_KEYS: &[&str] = &["C-c", "C-d", "Escape"];

pub fn is_allowed_key(key: &str) -> bool {
    ALLOWED_KEYS.contains(&key)
}

pub fn is_destructive_key(key: &str) -> bool {
    DESTRUCTIVE_KEYS.contains(&key)
}

/// Epoch milliseconds, the unit every timestamp on the wire uses.
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
