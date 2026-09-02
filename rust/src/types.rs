//! Wire types shared by the server and the browser client.
//!
//! This is a byte-for-byte port of `src/shared/types.ts`. The existing React
//! client is the consumer, so field names are camelCase and every optional
//! field must be *omitted* when absent rather than serialised as `null` — a
//! `"waitingFor": null` reads as present-and-empty to the TS client, which
//! checks `!== undefined` in several places.

use serde::{Deserialize, Serialize};

#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts"))]
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
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts", optional_fields))]
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
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts", optional_fields))]
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
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts", optional_fields))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// 0-100.
    pub pct: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
}

/// Account-level subscription usage, bridged out of Claude Code's statusLine.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts", optional_fields))]
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

#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts"))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleEnv {
    pub cli_path: String,
    pub dns_name: String,
    pub ip: String,
    pub running: bool,
}

/// Facts about the host machine, used by the help page.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts"))]
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

#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts", optional_fields))]
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

#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts"))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    pub name: String,
    pub path: String,
    pub hidden: bool,
}

#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts"))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub root: String,
    pub entries: Vec<DirEntryDto>,
}

/// `{ ok: true, detail? } | { ok: false, error }`
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts"))]
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ControlResponse {
    Ok {
        #[cfg_attr(test, ts(type = "true"))]
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        detail: Option<String>,
    },
    Err {
        #[cfg_attr(test, ts(type = "false"))]
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
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts"))]
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum NewAgentResponse {
    Ok {
        #[cfg_attr(test, ts(type = "true"))]
        ok: bool,
        #[serde(rename = "tmuxSession")]
        tmux_session: String,
        cwd: String,
    },
    Err {
        #[cfg_attr(test, ts(type = "false"))]
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

#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimelineKind {
    User,
    Assistant,
    Tool,
    Subagent,
    Notice,
}

#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts", optional_fields))]
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

/// One choice in a prompt the agent is blocked on.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts", optional_fields))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A question the agent is waiting on, read out of its own transcript.
///
/// Claude Code flushes a tool call before the dialog it raises is answered, so
/// an `AskUserQuestion` still waiting for a reply is on disk in full — question,
/// options, and whether it takes more than one. That is the only reason this
/// app may name an option at all: it is *read*, never inferred from the screen
/// (INV-16).
///
/// The other two blocked shapes are deliberately thinner. `ExitPlanMode` writes
/// its plan but not the three approval choices, which the CLI composes; a tool
/// permission request writes the tool and its input but not the numbered list.
/// For those `options` stays empty and the interface offers keys rather than
/// labels it would have had to invent.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts", optional_fields))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPrompt {
    /// The tool that raised it — `AskUserQuestion`, `ExitPlanMode`, or another.
    pub tool: String,
    /// The question, where the transcript states one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    /// Only ever what the transcript named. Absent means "not knowable here".
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    #[cfg_attr(test, ts(as = "Option<Vec<PromptOption>>", optional))]
    pub options: Vec<PromptOption>,
    /// True when the picker takes several answers, so one digit cannot finish it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multi_select: Option<bool>,
    /// How many questions this one call asks, when it asks more than one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub more_questions: Option<usize>,
    /// Reference text: the plan under review, or the command being asked about.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Identity of *this* question, for binding an answer to it (INV-2).
    ///
    /// Derived from the content rather than stored anywhere: the transcript
    /// issues no id, and a counter would not survive the server restarting
    /// under a browser that stayed open. Filled by `with_id` on the way out;
    /// empty on a prompt that has not been sent.
    #[serde(skip_serializing_if = "String::is_empty", default)]
    #[cfg_attr(test, ts(as = "Option<String>", optional))]
    pub id: String,
}

impl PendingPrompt {
    /// A short, stable name for the exact question on screen.
    ///
    /// Every field a user reads before deciding goes in, so an answer is bound
    /// to the question it was given for. `more_questions` is included because
    /// question two of an `AskUserQuestion` set is a *different* question from
    /// question one even when both read identically, and answering the wrong
    /// one is the failure this exists to stop. The session id is in it so a
    /// prompt cannot be answered on the wrong agent.
    pub fn fingerprint(&self, session_id: &str) -> String {
        use sha1::Digest;
        let mut hasher = sha1::Sha1::new();
        for part in [
            session_id,
            &self.tool,
            self.question.as_deref().unwrap_or(""),
            self.detail.as_deref().unwrap_or(""),
            &self.more_questions.map(|n| n.to_string()).unwrap_or_default(),
        ] {
            // Length-prefixed, so ("ab", "c") and ("a", "bc") differ.
            hasher.update((part.len() as u64).to_le_bytes());
            hasher.update(part.as_bytes());
        }
        for option in &self.options {
            hasher.update((option.label.len() as u64).to_le_bytes());
            hasher.update(option.label.as_bytes());
        }
        let digest = hasher.finalize();
        base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, digest)
    }

    /// The same prompt, carrying the id the client must echo back.
    pub fn with_id(mut self, session_id: &str) -> Self {
        self.id = self.fingerprint(session_id);
        self
    }
}

/// Which compaction notice a `Notice` event is reporting.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeKind {
    Compacted,
    CompactedAuto,
}

#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts"))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedRow {
    pub row: usize,
    pub text: String,
}

/// A rendered snapshot of a tmux pane.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts", optional_fields))]
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

#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts"))]
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
        #[cfg_attr(test, ts(optional))]
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
        #[cfg_attr(test, ts(optional))]
        confirmed: Option<bool>,
    },
    /// Answer the prompt an agent is blocked on, named by its id.
    ///
    /// Separate from `Key` because answering is not typing. A bare digit is
    /// whatever the pane happens to be showing when tmux receives it: a stale
    /// tab, a duplicated frame, or a second question in the same
    /// `AskUserQuestion` set all turn "yes, edit that file" into an answer to
    /// something else. `prompt_id` is `PendingPrompt::fingerprint` echoed back,
    /// and the server refuses the answer if the question has moved on.
    ///
    /// `choice` is an index into the options the transcript named, so the
    /// keystroke is composed here rather than sent by the browser (INV-2: the
    /// client's view of the keyboard is a convenience, not the boundary).
    #[serde(rename = "answer")]
    Answer {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "promptId")]
        prompt_id: String,
        choice: usize,
    },
}

/* ---- server -> client ---- */

#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts"))]
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
        /// What this agent is blocked on, when its transcript says.
        ///
        /// Sent with the conversation rather than on the fleet frame: the fleet
        /// goes out for every agent many times a minute, and this is only ever
        /// wanted for the one being read.
        #[serde(rename = "prompt", skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        prompt: Option<PendingPrompt>,
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
        #[cfg_attr(test, ts(optional))]
        session_id: Option<String>,
        message: String,
        /// `kind` names the condition; `message` is only how to say it. The
        /// pane-exit case is the one state a viewer must react to
        /// structurally, because INV-1 means there is no pty to report it.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        kind: Option<ErrorKind>,
    },
}

/// Structured error conditions a client may branch on.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts"))]
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
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubagentState {
    Active,
    Quiet,
    Done,
}

/// One delegate in an agent's tree, and everything below it.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts", optional_fields))]
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
    /// needed because `state` is almost always `quiet` — the honest answer, and
    /// an uninformative one on its own (INV-13). Absent when the transcript
    /// could not be read or is too large to keep re-reading; a node then
    /// renders without them rather than with a zero, which would claim it did
    /// nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calls: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worked_ms: Option<i64>,
    pub state: SubagentState,
    /// The state was worked out here rather than reported (INV-11). Set on
    /// `active`, which is a guess from a recent write and a busy parent, and
    /// never on `done`, which is only ever claimed on evidence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_inferred: Option<bool>,
    /// The user stopped it. Evidence of an ending, so the state is `done`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_by_user: Option<bool>,
    /// Its parent id named a delegate that is not on disk, so it was raised to
    /// the top of the tree rather than dropped with everything under it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reparented: Option<bool>,
    pub children: Vec<SubagentNode>,
}

/// One agent's delegates. `children` is empty for an agent that never delegated.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts", optional_fields))]
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
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "wire.ts"))]
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
///
/// The digits are how a numbered choice is answered. Claude Code's pickers are
/// numbered, and a digit selects the option it labels wherever the cursor
/// happens to be sitting — which is the whole reason they are here rather than
/// arrow keys: a relative move has to assume where the highlight started, and
/// being wrong about that answers a different question than the one the user
/// read. `1`–`9` only; there is no tenth option and `0` selects nothing.
pub const ALLOWED_KEYS: &[&str] = &[
    "Enter", "Escape", "Tab", "BSpace", "Space", "Up", "Down", "Left", "Right", "Home", "End",
    "PageUp", "PageDown", "C-c", "C-d", "C-o", "C-r", "C-u", "1", "2", "3", "4", "5", "6", "7",
    "8", "9",
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

/// The TypeScript side of this file, generated from it.
///
/// `src/shared/wire.ts` used to be written by hand as a mirror of these types,
/// and `AGENTS.md` said the two were "edited together or not at all, because
/// nothing checks that they still agree". Now something does: the file is
/// rendered from the Rust by `npm run gen:types`, and
/// `the_checked_in_wire_contract_is_current` fails `npm test` when a checkout
/// carries a stale one. The value lists travel too — they are what makes "the
/// server validates against them and the browser offers exactly them" true, so
/// a type-only export would have left that half to drift.
///
/// Test-only: `ts_rs` is a dev-dependency and every derive above is behind
/// `cfg_attr(test)`, so the release binary carries none of it.
#[cfg(test)]
pub mod wire {
    use super::*;
    use std::sync::OnceLock;

    /// Where the browser reads the contract from, relative to the crate root.
    pub const TS_PATH: &str = "../src/shared/wire.ts";

    const HEADER: &str = "\
/*
 * Wire types shared by the server and the browser client.
 *
 * GENERATED from rust/src/types.rs by `npm run gen:types` — do not edit.
 * `types::tests::the_checked_in_wire_contract_is_current` fails when this
 * file and the Rust disagree. The doc comments are the Rust doc comments;
 * change them there.
 */
";

    /// The whole file, rendered once per process.
    ///
    /// Once, because ts-rs keeps a process-wide record of what it has already
    /// written to each path and a second export to the same file would come
    /// back partial.
    pub fn render() -> &'static str {
        static RENDERED: OnceLock<String> = OnceLock::new();
        RENDERED.get_or_init(|| render_once().expect("the wire contract renders"))
    }

    fn render_once() -> Result<String, Box<dyn std::error::Error>> {
        use ts_rs::TS;
        let dir = tempfile::tempdir()?;
        let cfg = ts_rs::Config::new().with_out_dir(dir.path()).with_large_int("number");
        // Every root type; each brings in what it references.
        ServerMessage::export_all(&cfg)?;
        ClientMessage::export_all(&cfg)?;
        ServerEnv::export_all(&cfg)?;
        NewAgentRequest::export_all(&cfg)?;
        DirListing::export_all(&cfg)?;
        ControlResponse::export_all(&cfg)?;
        NewAgentResponse::export_all(&cfg)?;
        FleetTree::export_all(&cfg)?;
        let types = std::fs::read_to_string(dir.path().join("wire.ts"))?;
        Ok(format!("{HEADER}\n{}\n\n{}", types.trim_end(), values()))
    }

    /// The option lists, as `as const` arrays so the browser can derive union
    /// types from them (`ModelAlias`, `PermissionMode`).
    fn values() -> String {
        format!(
            "/**
 * Control keys the server will forward. Anything else is rejected (INV-2).
 * The digits are how a numbered choice is answered.
 */
export const ALLOWED_KEYS = {} as const

/** Keys that can destroy work, so the UI must confirm before sending (INV-6). */
export const DESTRUCTIVE_KEYS = new Set({})

/** Model aliases the CLI accepts, and the only ones this app will pass on. */
export const MODEL_ALIASES = {} as const

/** Permission modes in the order Shift+Tab cycles them. */
export const MODE_CYCLE = {} as const

/** Modes settable at spawn time. `dontAsk` is reachable by flag but never cycles. */
export const SPAWN_MODES = {} as const
",
            ts_list(ALLOWED_KEYS),
            ts_list(DESTRUCTIVE_KEYS),
            ts_list(MODEL_ALIASES),
            ts_list(MODE_CYCLE),
            ts_list(SPAWN_MODES),
        )
    }

    fn ts_list(items: &[&str]) -> String {
        let quoted: Vec<String> = items.iter().map(|item| format!("{item:?}")).collect();
        format!("[{}]", quoted.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `src/shared/wire.ts` is what the browser compiles against, and it is
    /// generated from this file. A checkout where the two disagree fails here
    /// rather than in a browser; `npm run gen:types` (this test with
    /// `WIRE_WRITE=1`) rewrites it.
    #[test]
    fn the_checked_in_wire_contract_is_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(wire::TS_PATH);
        let rendered = wire::render();
        if std::env::var_os("WIRE_WRITE").is_some() {
            std::fs::write(&path, rendered).expect("write the wire contract");
            return;
        }
        let on_disk = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            on_disk == rendered,
            "src/shared/wire.ts does not match rust/src/types.rs — run `npm run gen:types`"
        );
    }

    fn question(text: &str) -> PendingPrompt {
        PendingPrompt {
            tool: "AskUserQuestion".into(),
            question: Some(text.into()),
            options: vec![
                PromptOption { label: "Yes".into(), description: None },
                PromptOption { label: "No".into(), description: None },
            ],
            multi_select: None,
            more_questions: None,
            detail: None,
            id: String::new(),
        }
    }

    #[test]
    fn inv2_a_prompt_id_changes_with_every_field_a_reader_reads() {
        let base = question("Delete the table?");
        let id = base.fingerprint("s1");

        // The question itself.
        assert_ne!(question("Edit one file?").fingerprint("s1"), id);
        // The agent it belongs to: an answer must not cross sessions.
        assert_ne!(base.fingerprint("s2"), id);

        let mut other_tool = base.clone();
        other_tool.tool = "ExitPlanMode".into();
        assert_ne!(other_tool.fingerprint("s1"), id);

        let mut other_detail = base.clone();
        other_detail.detail = Some("rm -rf /".into());
        assert_ne!(other_detail.fingerprint("s1"), id);

        let mut other_options = base.clone();
        other_options.options[1].label = "Never".into();
        assert_ne!(other_options.fingerprint("s1"), id);

        // The sharp one: question two of a set reads identically to question
        // one often enough, and answering the wrong one is the whole hazard.
        let mut later = base.clone();
        later.more_questions = Some(1);
        assert_ne!(later.fingerprint("s1"), id);

        // Stable across calls, or the client could never echo it back.
        assert_eq!(base.fingerprint("s1"), id);
    }

    #[test]
    fn inv2_field_boundaries_cannot_be_shifted_to_forge_a_match() {
        // Without length prefixes, ("ab", "") and ("a", "b") hash the same, so
        // a question could be made to match a different one by moving a
        // character across a field boundary.
        let mut split = question("ab");
        split.detail = None;
        let mut shifted = question("a");
        shifted.detail = Some("b".into());
        assert_ne!(split.fingerprint("s1"), shifted.fingerprint("s1"));
    }

    #[test]
    fn with_id_fills_the_field_the_client_echoes_back() {
        let sent = question("Proceed?").with_id("s1");
        assert!(!sent.id.is_empty());
        assert_eq!(sent.id, question("Proceed?").fingerprint("s1"));
    }
}
