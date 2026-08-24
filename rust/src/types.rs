//! Wire types shared by the server and the browser client.
//!
//! This is a byte-for-byte port of `src/shared/types.ts`. The existing React
//! client is the consumer, so field names are camelCase and every optional
//! field must be *omitted* when absent rather than serialised as `null` — a
//! `"waitingFor": null` reads as present-and-empty to the TS client, which
//! checks `!== undefined` in several places.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Busy,
    Idle,
    Waiting,
    Unknown,
}

impl Default for AgentStatus {
    fn default() -> Self {
        AgentStatus::Unknown
    }
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
    /// Why the agent is blocked, e.g. "dialog open". Only when status is waiting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_for: Option<String>,
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
    },
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
