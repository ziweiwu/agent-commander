//! Agents that have been started but have not registered themselves yet.
//!
//! Port of `src/server/pending.ts`.
//!
//! A freshly spawned `claude` does not write its session file until it has
//! finished starting up — and in a directory it has not seen before, it stops
//! on a workspace-trust prompt first. Without this, such an agent is invisible
//! in the fleet, and the prompt blocking it can only be answered from the
//! terminal the user opened this app to avoid. So a spawned session is shown
//! immediately, attachable, until the real record replaces it.
//!
//! **Why this is not the same mechanism as the chat's optimistic echo, even
//! though both suppress a duplicate.** That one is about INV-2's "exactly
//! once": a message the user typed is drawn locally and removed when the
//! transcript confirms *that copy*, and it is never re-sent. This one is about
//! a record that does not exist yet: nothing is being sent, and the entry
//! disappears when a real agent claims the same tmux session. Folding them
//! together would mean a fleet entry could be "retried", which is precisely
//! what INV-2 forbids. Two mechanisms, because they are answering two
//! different questions.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;

use crate::types::{now_ms, Agent, AgentStatus};

/// How long to keep showing a session that never registered before giving up.
const EXPIRY_MS: i64 = 5 * 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingSession {
    pub tmux_session: String,
    pub cwd: String,
    pub name: String,
    pub started_at: i64,
}

/// Asks tmux whether a session still has a pane, and which one.
///
/// A trait so the store can be tested without a tmux server: the TypeScript
/// calls `execFile` inline, which is why its own tests can only assert the
/// *pruning* half of this behaviour.
#[async_trait]
pub trait PaneLister: Send + Sync {
    /// The first pane id in the session, or `None` when the session is gone.
    async fn first_pane(&self, tmux_session: &str) -> Option<String>;
}

/// The real one: `tmux list-panes -t <session> -F '#{pane_id}'`.
pub struct TmuxPaneLister;

#[async_trait]
impl PaneLister for TmuxPaneLister {
    async fn first_pane(&self, tmux_session: &str) -> Option<String> {
        let run = tokio::process::Command::new("tmux")
            .args(["list-panes", "-t", tmux_session, "-F", "#{pane_id}"])
            .kill_on_drop(true)
            .output();
        let out = tokio::time::timeout(Duration::from_secs(5), run).await.ok()?.ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .lines()
            .next()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }
}

/// The last segment of a path, when it has one. `/` has none, which is why
/// this returns an `Option` rather than folding the two fallbacks together —
/// the name falls back to the tmux session, the folder falls back to the whole
/// path, and they are not the same answer.
fn basename(cwd: &str) -> Option<String> {
    Path::new(cwd)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
}

/// What the card header shows: the last path segment, or the path itself.
fn folder_of(cwd: &str) -> String {
    basename(cwd).unwrap_or_else(|| cwd.to_string())
}

pub struct PendingStore {
    sessions: Mutex<HashMap<String, PendingSession>>,
    lister: Box<dyn PaneLister>,
}

impl Default for PendingStore {
    fn default() -> Self {
        Self::new()
    }
}

impl PendingStore {
    pub fn new() -> Self {
        Self::with_lister(Box::new(TmuxPaneLister))
    }

    pub fn with_lister(lister: Box<dyn PaneLister>) -> Self {
        Self { sessions: Mutex::new(HashMap::new()), lister }
    }

    pub fn add(&self, tmux_session: &str, cwd: &str, name: Option<&str>) {
        self.add_at(tmux_session, cwd, name, now_ms());
    }

    pub fn add_at(&self, tmux_session: &str, cwd: &str, name: Option<&str>, now: i64) {
        let name = name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| basename(cwd))
            .unwrap_or_else(|| tmux_session.to_string());
        self.sessions.lock().expect("pending store poisoned").insert(
            tmux_session.to_string(),
            PendingSession {
                tmux_session: tmux_session.to_string(),
                cwd: cwd.to_string(),
                name,
                started_at: now,
            },
        );
    }

    pub fn size(&self) -> usize {
        self.sessions.lock().expect("pending store poisoned").len()
    }

    pub async fn merge(&self, real: Vec<Agent>) -> Vec<Agent> {
        self.merge_at(real, now_ms()).await
    }

    /// Turn still-unregistered sessions into fleet entries.
    ///
    /// A pending session is dropped as soon as a real agent reports the same
    /// tmux session, when its tmux session is gone, or when it has waited too
    /// long to plausibly still be starting.
    pub async fn merge_at(&self, real: Vec<Agent>, now: i64) -> Vec<Agent> {
        if self.size() == 0 {
            return real;
        }

        let claimed: Vec<String> =
            real.iter().filter_map(|a| a.tmux_session.clone()).collect();

        // Snapshot deliberately, and release the lock before any `await`: the
        // map is mutated inside this loop, and a `std::sync::Mutex` held across
        // a suspension point is how an async program deadlocks itself.
        let snapshot: Vec<PendingSession> = {
            let sessions = self.sessions.lock().expect("pending store poisoned");
            sessions.values().cloned().collect()
        };

        let mut out: Vec<Agent> = Vec::new();
        let mut drop_these: Vec<String> = Vec::new();

        // Sequential, one tmux round trip at a time. A concurrent burst is
        // what a machine at its process cap answers with EAGAIN, and this loop
        // runs on every fleet refresh.
        for session in snapshot {
            if claimed.contains(&session.tmux_session)
                || now - session.started_at > EXPIRY_MS
            {
                drop_these.push(session.tmux_session);
                continue;
            }

            let Some(pane) = self.lister.first_pane(&session.tmux_session).await else {
                // The window closed before the agent ever came up.
                drop_these.push(session.tmux_session);
                continue;
            };

            out.push(Agent {
                session_id: format!("pending:{}", session.tmux_session),
                pid: 0,
                name: session.name.clone(),
                cwd: session.cwd.clone(),
                folder: folder_of(&session.cwd),
                status: AgentStatus::Waiting,
                waiting_for: Some("starting up".into()),
                kind: "interactive".into(),
                started_at: session.started_at,
                pane_id: Some(pane),
                tmux_session: Some(session.tmux_session.clone()),
                activity: Some(
                    "Starting — it may be asking whether this folder is trusted.".into(),
                ),
                ..Default::default()
            });
        }

        if !drop_these.is_empty() {
            let mut sessions = self.sessions.lock().expect("pending store poisoned");
            for id in drop_these {
                sessions.remove(&id);
            }
        }

        out.extend(real);
        out
    }
}

/* ------------------------------------------------------------------ tests */

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn real(session_id: &str, tmux: Option<&str>) -> Agent {
        Agent {
            session_id: session_id.into(),
            pid: 1,
            name: "real".into(),
            cwd: "/x".into(),
            folder: "x".into(),
            status: AgentStatus::Idle,
            kind: "interactive".into(),
            started_at: 0,
            tmux_session: tmux.map(str::to_string),
            ..Default::default()
        }
    }

    /// A tmux that answers however the test wants, and counts how often it was
    /// asked.
    struct FakeTmux {
        pane: Option<String>,
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl PaneLister for FakeTmux {
        async fn first_pane(&self, _tmux_session: &str) -> Option<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.pane.clone()
        }
    }

    fn store(pane: Option<&str>) -> (PendingStore, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let s = PendingStore::with_lister(Box::new(FakeTmux {
            pane: pane.map(str::to_string),
            calls: calls.clone(),
        }));
        (s, calls)
    }

    #[tokio::test]
    async fn is_empty_until_something_is_spawned() {
        let (s, calls) = store(Some("%1"));
        assert!(s.merge_at(vec![], 0).await.is_empty());
        assert_eq!(s.size(), 0);
        assert_eq!(calls.load(Ordering::SeqCst), 0, "an empty store must not ask tmux anything");
    }

    /// The behaviour for a window that closed before startup finished.
    #[tokio::test]
    async fn drops_a_session_whose_tmux_window_is_gone() {
        let (s, _) = store(None);
        s.add_at("claude-does-not-exist", "/tmp", None, 0);
        assert_eq!(s.size(), 1);
        assert!(s.merge_at(vec![], 0).await.is_empty());
        assert_eq!(s.size(), 0);
    }

    #[tokio::test]
    async fn shows_a_session_that_has_not_registered_yet() {
        let (s, _) = store(Some("%77"));
        s.add_at("claude-123", "/Users/me/Projects/lego-deals", None, 1000);
        let merged = s.merge_at(vec![], 1000).await;
        assert_eq!(merged.len(), 1);
        let a = &merged[0];
        assert_eq!(a.session_id, "pending:claude-123");
        assert_eq!(a.pane_id.as_deref(), Some("%77"), "it has to be attachable to be any use");
        assert_eq!(a.status, AgentStatus::Waiting);
        assert_eq!(a.waiting_for.as_deref(), Some("starting up"));
        assert_eq!(a.name, "lego-deals");
        assert_eq!(a.folder, "lego-deals");
        assert_eq!(a.pid, 0);
        assert_eq!(a.started_at, 1000);
        assert!(a.activity.as_deref().unwrap().contains("trusted"));
        // Still pending: nothing has claimed it.
        assert_eq!(s.size(), 1);
    }

    #[tokio::test]
    async fn drops_a_session_once_the_real_agent_reports_the_same_tmux_session() {
        let (s, calls) = store(Some("%1"));
        s.add_at("claude-123", "/tmp", None, 0);
        let merged = s.merge_at(vec![real("real-1", Some("claude-123"))], 0).await;
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].session_id, "real-1");
        assert_eq!(s.size(), 0);
        // A claimed session is dropped without a tmux round trip.
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn leaves_unrelated_agents_untouched() {
        let (s, _) = store(Some("%1"));
        let agents = vec![real("real-1", None), real("real-2", None)];
        assert_eq!(s.merge_at(agents.clone(), 0).await.len(), 2);
        // And with something pending, the real ones still all come through.
        s.add_at("claude-9", "/tmp", None, 0);
        let merged = s.merge_at(agents, 0).await;
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].session_id, "pending:claude-9", "pending sorts first");
    }

    #[tokio::test]
    async fn gives_up_on_a_session_that_never_registers() {
        let (s, _) = store(Some("%1"));
        s.add_at("claude-slow", "/tmp", None, 0);
        assert_eq!(s.merge_at(vec![], EXPIRY_MS).await.len(), 1, "still inside the window");
        assert_eq!(s.merge_at(vec![], EXPIRY_MS + 1).await.len(), 0);
        assert_eq!(s.size(), 0);
    }

    #[tokio::test]
    async fn an_explicit_name_beats_the_folder() {
        let (s, _) = store(Some("%1"));
        s.add_at("claude-1", "/Users/me/Projects/app", Some("nightly build"), 0);
        assert_eq!(s.merge_at(vec![], 0).await[0].name, "nightly build");
    }

    /// A cwd with no basename to take falls back to the session name rather
    /// than showing a card with no title.
    #[tokio::test]
    async fn a_rootless_cwd_falls_back_to_the_session_name() {
        let (s, _) = store(Some("%1"));
        s.add_at("claude-1", "/", None, 0);
        let merged = s.merge_at(vec![], 0).await;
        assert_eq!(merged[0].name, "claude-1");
    }

    /// Adding the same session twice is an update, not a second card. Spawn
    /// retries and a double-clicked dialog both land here.
    #[tokio::test]
    async fn adding_the_same_session_twice_yields_one_entry() {
        let (s, _) = store(Some("%1"));
        s.add_at("claude-1", "/tmp/a", None, 0);
        s.add_at("claude-1", "/tmp/a", None, 0);
        assert_eq!(s.size(), 1);
        assert_eq!(s.merge_at(vec![], 0).await.len(), 1);
    }

    /// One tmux round trip per still-pending session per refresh, and none for
    /// the ones already accounted for. A burst is what EAGAIN answers.
    #[tokio::test]
    async fn asks_tmux_once_per_unclaimed_session() {
        let (s, calls) = store(Some("%1"));
        s.add_at("claude-1", "/tmp/a", None, 0);
        s.add_at("claude-2", "/tmp/b", None, 0);
        s.add_at("claude-3", "/tmp/c", None, 0);
        s.merge_at(vec![real("r", Some("claude-2"))], 0).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
