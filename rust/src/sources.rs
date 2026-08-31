//! The capability interfaces the server talks to, so mock mode can stand in.
//!
//! Port of `src/server/sources.ts`. These are the seams every other module is
//! written against: `routes` never touches tmux or the filesystem directly, it
//! goes through these, which is what lets `--mock` be a real substitution
//! rather than a pile of conditionals.

use crate::types::{Agent, RateLimits, TimelineEvent};
use async_trait::async_trait;
use std::sync::Arc;

/// Metadata for one tmux pane. Port of `PaneMeta` in `pane.ts`.
///
/// All six fields come back from a single `display-message` format string
/// (`pane.ts:106`), so carrying `alternate` and `dead` costs nothing extra —
/// they are already in the one round trip the geometry needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneMeta {
    pub cols: usize,
    pub rows: usize,
    pub cursor_x: usize,
    pub cursor_y: usize,
    /// tmux `alternate_on`: the pane is in the alternate screen, i.e. a
    /// full-screen TUI is drawing into it rather than a scrolling shell.
    pub alternate: bool,
    /// tmux `pane_dead`: the process behind the pane has exited. Load-bearing —
    /// `control.ts` refuses to act on a dead pane and `routes.ts` stops serving
    /// frames for one, because a dead pane's last capture is a memory, not a
    /// reading (INV-11).
    pub dead: bool,
}

/// One capture: geometry plus content, from a single round trip where possible.
#[derive(Debug, Clone)]
pub struct PaneSample {
    pub meta: PaneMeta,
    pub lines: Vec<String>,
}

/// A partial `Agent`, applied over an existing one by `enrich`.
///
/// The TS side uses `Partial<Agent>`; Rust has no structural partials, so this
/// carries only the fields enrichment actually sets. Anything `None` is left
/// alone rather than cleared — the same semantics as spreading a partial.
#[derive(Debug, Clone, Default)]
pub struct AgentPatch {
    pub activity: Option<String>,
    pub last_activity_at: Option<i64>,
    pub tokens: Option<i64>,
    pub subagents: Option<i64>,
    pub delegating: Option<bool>,
    pub ai_title: Option<String>,
    pub last_prompt: Option<String>,
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    pub goal: Option<Option<crate::types::GoalState>>,
    pub status: Option<crate::types::AgentStatus>,
    pub waiting_for: Option<Option<String>>,
    /// `transcript.ts:240` — set only when tmux reported a real branch, never
    /// the literal "HEAD" of a detached checkout.
    pub git_branch: Option<String>,
    /// `transcript.ts:241`. Setting this also re-derives `folder`, since the
    /// card header renders the basename and the two must never disagree.
    pub cwd: Option<String>,
}

impl AgentPatch {
    /// True when nothing would change, so a broadcast can be skipped.
    pub fn is_empty(&self) -> bool {
        self.activity.is_none()
            && self.last_activity_at.is_none()
            && self.tokens.is_none()
            && self.subagents.is_none()
            && self.delegating.is_none()
            && self.ai_title.is_none()
            && self.last_prompt.is_none()
            && self.permission_mode.is_none()
            && self.model.is_none()
            && self.goal.is_none()
            && self.status.is_none()
            && self.waiting_for.is_none()
            && self.git_branch.is_none()
            && self.cwd.is_none()
    }

    /// Apply this patch onto an agent in place.
    pub fn apply(&self, agent: &mut Agent) {
        if let Some(v) = &self.activity { agent.activity = Some(v.clone()) }
        if let Some(v) = self.last_activity_at { agent.last_activity_at = Some(v) }
        if let Some(v) = self.tokens { agent.tokens = Some(v) }
        if let Some(v) = self.subagents { agent.subagents = Some(v) }
        if let Some(v) = self.delegating { agent.delegating = Some(v) }
        if let Some(v) = &self.ai_title { agent.ai_title = Some(v.clone()) }
        if let Some(v) = &self.last_prompt { agent.last_prompt = Some(v.clone()) }
        if let Some(v) = &self.permission_mode { agent.permission_mode = Some(v.clone()) }
        if let Some(v) = &self.model { agent.model = Some(v.clone()) }
        if let Some(v) = &self.goal { agent.goal = v.clone() }
        if let Some(v) = self.status { agent.status = v }
        if let Some(v) = &self.waiting_for { agent.waiting_for = v.clone() }
        if let Some(v) = &self.git_branch { agent.git_branch = Some(v.clone()) }
        if let Some(v) = &self.cwd {
            agent.cwd = v.clone();
            // Keep the precomputed basename in step with the path it describes.
            agent.folder = std::path::Path::new(v)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| v.clone());
        }
    }
}

/// Whether the text a paste writes is followed by Enter.
///
/// Named, because the two cases are not variations of one action: without it
/// the text sits in the agent's prompt buffer where a person can still read and
/// delete it, and with it the text is *handed to a running agent*, which is the
/// only thing INV-2 allows to happen and only from an explicit user action.
/// Every call site has to be readable as one or the other at a glance.
///
/// The two are different acts at the far end, not two settings of one act: one
/// leaves text in a composer for the user to read back, the other commits it to
/// a live agent. A bare `true` at a call site says which line of code was
/// written; this says which of the two things is about to happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Submit {
    /// Press Enter in the same tmux command sequence as the paste, so nothing
    /// can come between the text and its submission.
    Yes,
    /// Leave the text sitting in the agent's composer, unsent.
    No,
}

/// Unsubscribe handle. Dropping it is *not* enough — call it.
pub type Unsubscribe = Box<dyn FnOnce() + Send + Sync>;

#[async_trait]
pub trait AgentSource: Send + Sync + 'static {
    fn list(&self) -> Vec<Agent>;
    fn get(&self, session_id: &str) -> Option<Agent>;
    fn on_change(&self, listener: Box<dyn Fn(Vec<Agent>) + Send + Sync>) -> Unsubscribe;
    fn enrich(&self, session_id: &str, patch: AgentPatch);
    /// Broadcast the current list after out-of-band enrichment.
    fn notify(&self) {}
    async fn start(&self) -> anyhow::Result<()>;
    fn stop(&self);
}

#[async_trait]
pub trait PaneApi: Send + Sync + 'static {
    async fn meta(&self, pane_id: &str) -> anyhow::Result<PaneMeta>;
    async fn capture(&self, pane_id: &str, rows: usize) -> anyhow::Result<Vec<String>>;
    /// Geometry and content in one round trip, for adapters that can do it.
    ///
    /// Default falls back to `meta` then `capture`, so an adapter that cannot
    /// combine them changes nothing but the number of round trips.
    async fn sample(&self, pane_id: &str) -> anyhow::Result<PaneSample> {
        let meta = self.meta(pane_id).await?;
        let lines = self.capture(pane_id, meta.rows).await?;
        Ok(PaneSample { meta, lines })
    }
    async fn paste(&self, pane_id: &str, text: &str, submit: Submit) -> anyhow::Result<()>;
    async fn key(&self, pane_id: &str, key_name: &str) -> anyhow::Result<()>;
}

#[derive(Debug, Clone, Default)]
pub struct TailRead {
    pub events: Vec<TimelineEvent>,
    pub patch: AgentPatch,
    pub first: bool,
}

#[async_trait]
pub trait TailApi: Send + Sync + 'static {
    async fn read(&mut self) -> anyhow::Result<TailRead>;
}

/// Account-level quota, watched from the file the statusLine bridge writes.
pub trait LimitsApi: Send + Sync + 'static {
    /// Last good reading, or None when nothing has been written yet.
    fn current(&self) -> Option<RateLimits>;
    fn on_change(&self, listener: Box<dyn Fn(Option<RateLimits>) + Send + Sync>) -> Unsubscribe;
    fn start(&self);
    fn stop(&self);
}

/// Everything `routes` needs, assembled once by `main`.
pub struct Deps {
    pub source: Arc<dyn AgentSource>,
    pub panes: Arc<dyn PaneApi>,
    pub limits: Arc<dyn LimitsApi>,
    /// Builds a tail reader for one session's transcript.
    pub tail_for: Arc<dyn Fn(&Agent) -> Option<Box<dyn TailApi>> + Send + Sync>,
}
