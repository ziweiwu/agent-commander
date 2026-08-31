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

use async_trait::async_trait;

use crate::agent_kinds::CLAUDE_KIND;
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

/// Why a pane listing produced nothing.
///
/// **"Could not ask" is not "it is gone", and conflating them is a bug this
/// code has already had.** The listing used to be a bare tmux call that
/// answered `None` on any error, and `None` was read as "the window closed
/// before the agent ever came up" — so the entry was deleted. A
/// `spawn tmux EAGAIN`, which is ordinary on a machine at its process cap, is
/// exactly such an error, and a machine at its process cap is exactly a machine
/// where a new agent takes a while to start. The agent most in need of being
/// visible — one sitting on a trust prompt it cannot get past — vanished from
/// the fleet instead. Only a positive "no such session" drops an entry now;
/// anything else keeps it, and the expiry is what stops it living forever.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListError {
    /// tmux answered, and it does not have that session.
    MissingTarget,
    /// The question was never put, or the answer was not understood.
    Unreachable(String),
}

/// Asks tmux whether a session still has a pane, and which one.
///
/// A trait so the store can be tested without a tmux server: the TypeScript
/// calls into `pane.ts` for the same reason it injects `PendingDeps` — the two
/// answers above have to be driveable apart.
#[async_trait]
pub trait PaneLister: Send + Sync {
    /// Every pane id in the session, in tmux's order.
    async fn list_panes(&self, tmux_session: &str) -> Result<Vec<String>, ListError>;
}

/// The real one, and it goes through `pane.rs` rather than spawning tmux here.
///
/// That routing is the fix, not a tidy-up. `pane.rs` owns the long-lived
/// control client, the EAGAIN retry, and the session-name check that runs
/// before a name reaches argv — and it is `PaneError`'s own `eagain`/`enoent`
/// flags, rather than a guess at the wording of a stderr line, that let
/// [`crate::pane::is_missing_target`] tell "tmux says there is no such session"
/// from "the question was never put". A local `tmux` spawn had neither, so on
/// the machine this matters on — one at its process cap — a refused spawn read
/// as a session that had gone, and the just-started agent vanished.
pub struct TmuxPaneLister;

#[async_trait]
impl PaneLister for TmuxPaneLister {
    async fn list_panes(&self, tmux_session: &str) -> Result<Vec<String>, ListError> {
        crate::pane::list_panes(tmux_session).await.map_err(|err| {
            if crate::pane::is_missing_target(&err) {
                ListError::MissingTarget
            } else {
                ListError::Unreachable(err.message)
            }
        })
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

/// What a spawn knows about the session it has just started.
///
/// One value rather than three arguments side by side, because they are only
/// meaningful together: the name is optional precisely because it falls back
/// first to the cwd's last segment and then to the tmux session.
pub struct SpawnedSession<'a> {
    pub tmux_session: &'a str,
    pub cwd: &'a str,
    pub name: Option<&'a str>,
}

/// What a pane listing settles about a session that has not registered yet.
///
/// Three answers rather than two, because "could not ask" is not "it is gone" —
/// see [`ListError`] for the agent that vanished when they were folded together.
enum PaneAnswer {
    /// tmux named a pane, so the card has something to attach to.
    Attachable(String),
    /// tmux answered, and there is nothing there to show any more.
    Gone,
    /// The question was never put. Evidence of nothing either way.
    Unanswered,
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

    pub fn add(&self, spawned: SpawnedSession<'_>) {
        self.add_at(spawned, now_ms());
    }

    pub fn add_at(&self, spawned: SpawnedSession<'_>, now: i64) {
        let name = spawned
            .name
            .map(str::trim)
            .filter(|given| !given.is_empty())
            .map(str::to_string)
            .or_else(|| basename(spawned.cwd))
            .unwrap_or_else(|| spawned.tmux_session.to_string());
        self.sessions.lock().expect("pending store poisoned").insert(
            spawned.tmux_session.to_string(),
            PendingSession {
                tmux_session: spawned.tmux_session.to_string(),
                cwd: spawned.cwd.to_string(),
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

        let mut out: Vec<Agent> = Vec::new();
        let mut drop_these: Vec<String> = Vec::new();

        // Sequential, one tmux round trip at a time. A concurrent burst is
        // what a machine at its process cap answers with EAGAIN, and this loop
        // runs on every fleet refresh.
        for session in self.snapshot() {
            if claimed.contains(&session.tmux_session)
                || now - session.started_at > EXPIRY_MS
            {
                drop_these.push(session.tmux_session);
                continue;
            }
            match self.first_pane(&session.tmux_session).await {
                PaneAnswer::Attachable(pane) => out.push(starting_up(&session, pane)),
                PaneAnswer::Gone => drop_these.push(session.tmux_session),
                // Keep the entry — it is invisible for this pass rather than
                // deleted — and let the expiry above be what ends it.
                PaneAnswer::Unanswered => continue,
            }
        }

        self.forget(drop_these);
        out.extend(real);
        out
    }

    /// Copy the map out deliberately, so the lock is released before any
    /// `await`: the map is mutated inside the merge loop, and a
    /// `std::sync::Mutex` held across a suspension point is how an async
    /// program deadlocks itself.
    fn snapshot(&self) -> Vec<PendingSession> {
        let sessions = self.sessions.lock().expect("pending store poisoned");
        sessions.values().cloned().collect()
    }

    fn forget(&self, tmux_sessions: Vec<String>) {
        if tmux_sessions.is_empty() {
            return;
        }
        let mut sessions = self.sessions.lock().expect("pending store poisoned");
        for tmux_session in tmux_sessions {
            sessions.remove(&tmux_session);
        }
    }

    /// Ask tmux for something to attach to, and classify what comes back.
    async fn first_pane(&self, tmux_session: &str) -> PaneAnswer {
        match self.lister.list_panes(tmux_session).await {
            // tmux answered, and the session has no panes: the window closed
            // before the agent ever came up.
            Ok(panes) => match panes.into_iter().next() {
                Some(pane) => PaneAnswer::Attachable(pane),
                None => PaneAnswer::Gone,
            },
            // Only a positive "no such session" is evidence of an ending.
            Err(ListError::MissingTarget) => PaneAnswer::Gone,
            Err(ListError::Unreachable(_)) => PaneAnswer::Unanswered,
        }
    }
}

/// The fleet entry a still-unregistered session gets: attachable, and saying
/// plainly that it may be sitting on a trust prompt.
fn starting_up(session: &PendingSession, pane: String) -> Agent {
    Agent {
        session_id: format!("pending:{}", session.tmux_session),
        pid: 0,
        name: session.name.clone(),
        cwd: session.cwd.clone(),
        folder: folder_of(&session.cwd),
        status: AgentStatus::Waiting,
        waiting_for: Some("starting up".into()),
        // This app spawns Claude and nothing else (INV-7), and an empty kind
        // here would deny the very controls the card exists to offer.
        agent_kind: CLAUDE_KIND.into(),
        kind: "interactive".into(),
        started_at: session.started_at,
        pane_id: Some(pane),
        tmux_session: Some(session.tmux_session.clone()),
        activity: Some("Starting — it may be asking whether this folder is trusted.".into()),
        ..Default::default()
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
            agent_kind: CLAUDE_KIND.into(),
            kind: "interactive".into(),
            started_at: 0,
            tmux_session: tmux.map(str::to_string),
            ..Default::default()
        }
    }

    /// A tmux that answers however the test wants, and counts how often it was
    /// asked.
    struct FakeTmux {
        answer: Result<Vec<String>, ListError>,
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl PaneLister for FakeTmux {
        async fn list_panes(&self, _tmux_session: &str) -> Result<Vec<String>, ListError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.answer.clone()
        }
    }

    /// A spawn with no explicit name, which is what most of these tests want.
    fn spawned<'a>(tmux_session: &'a str, cwd: &'a str) -> SpawnedSession<'a> {
        SpawnedSession { tmux_session, cwd, name: None }
    }

    fn answering(
        answer: Result<Vec<String>, ListError>,
    ) -> (PendingStore, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let s = PendingStore::with_lister(Box::new(FakeTmux { answer, calls: calls.clone() }));
        (s, calls)
    }

    /// The ordinary case: tmux answers with a pane, or answers that the session
    /// is not there.
    fn store(pane: Option<&str>) -> (PendingStore, Arc<AtomicUsize>) {
        answering(match pane {
            Some(p) => Ok(vec![p.to_string()]),
            None => Err(ListError::MissingTarget),
        })
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
        s.add_at(spawned("claude-does-not-exist", "/tmp"), 0);
        assert_eq!(s.size(), 1);
        assert!(s.merge_at(vec![], 0).await.is_empty());
        assert_eq!(s.size(), 0);
    }

    #[tokio::test]
    async fn shows_a_session_that_has_not_registered_yet() {
        let (s, _) = store(Some("%77"));
        s.add_at(spawned("claude-123", "/Users/me/Projects/lego-deals"), 1000);
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
        s.add_at(spawned("claude-123", "/tmp"), 0);
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
        let registered = agents.len();
        assert_eq!(s.merge_at(agents.clone(), 0).await.len(), registered);
        // And with something pending, the real ones still all come through.
        s.add_at(spawned("claude-9", "/tmp"), 0);
        let merged = s.merge_at(agents, 0).await;
        assert_eq!(merged.len(), registered + 1);
        assert_eq!(merged[0].session_id, "pending:claude-9", "pending sorts first");
    }

    #[tokio::test]
    async fn gives_up_on_a_session_that_never_registers() {
        let (s, _) = store(Some("%1"));
        s.add_at(spawned("claude-slow", "/tmp"), 0);
        assert_eq!(s.merge_at(vec![], EXPIRY_MS).await.len(), 1, "still inside the window");
        assert_eq!(s.merge_at(vec![], EXPIRY_MS + 1).await.len(), 0);
        assert_eq!(s.size(), 0);
    }

    #[tokio::test]
    async fn an_explicit_name_beats_the_folder() {
        let (s, _) = store(Some("%1"));
        s.add_at(
            SpawnedSession {
                tmux_session: "claude-1",
                cwd: "/Users/me/Projects/app",
                name: Some("nightly build"),
            },
            0,
        );
        assert_eq!(s.merge_at(vec![], 0).await[0].name, "nightly build");
    }

    /// A cwd with no basename to take falls back to the session name rather
    /// than showing a card with no title.
    #[tokio::test]
    async fn a_rootless_cwd_falls_back_to_the_session_name() {
        let (s, _) = store(Some("%1"));
        s.add_at(spawned("claude-1", "/"), 0);
        let merged = s.merge_at(vec![], 0).await;
        assert_eq!(merged[0].name, "claude-1");
    }

    /// Adding the same session twice is an update, not a second card. Spawn
    /// retries and a double-clicked dialog both land here.
    #[tokio::test]
    async fn adding_the_same_session_twice_yields_one_entry() {
        let (s, _) = store(Some("%1"));
        s.add_at(spawned("claude-1", "/tmp/a"), 0);
        s.add_at(spawned("claude-1", "/tmp/a"), 0);
        assert_eq!(s.size(), 1);
        assert_eq!(s.merge_at(vec![], 0).await.len(), 1);
    }

    /// INV-5: a tmux that could not be reached keeps a just-started agent
    /// visible, where only a positive "no such session" removes it.
    ///
    /// This is the failure that mattered. `spawn tmux EAGAIN` is ordinary on a
    /// machine at its process cap, which is exactly the machine where a new
    /// agent takes a while to start — and reading it as "gone" deleted the one
    /// entry that existed so a trust prompt could be answered from the browser.
    #[tokio::test]
    async fn inv5_a_tmux_that_could_not_be_reached_keeps_the_entry() {
        let (s, _) = answering(Err(ListError::Unreachable("spawn tmux EAGAIN".into())));
        s.add_at(spawned("claude-1", "/tmp"), 0);

        // Nothing to show this pass — there is no pane id to attach to — but
        // the entry survives to be asked about again.
        assert!(s.merge_at(vec![], 0).await.is_empty());
        assert_eq!(s.size(), 1, "an unanswerable question deleted a live agent");

        // ...and the expiry, not the error, is what finally ends it.
        assert!(s.merge_at(vec![], EXPIRY_MS + 1).await.is_empty());
        assert_eq!(s.size(), 0);
    }

    /// A session that answers with no panes at all is a window that closed
    /// before the agent came up — evidence of an ending, so it is dropped.
    #[tokio::test]
    async fn drops_a_session_that_answers_with_no_panes() {
        let (s, _) = answering(Ok(vec![]));
        s.add_at(spawned("claude-1", "/tmp"), 0);
        assert!(s.merge_at(vec![], 0).await.is_empty());
        assert_eq!(s.size(), 0);
    }

    /// Which tmux failures are evidence of an ending, and which are not.
    ///
    /// The classification itself lives in `pane.rs`, which is where the
    /// `eagain` and `enoent` flags are set; this pins that the store asks it
    /// rather than reading the prose of a stderr line for itself.
    #[test]
    fn inv5_only_a_positive_answer_counts_as_gone() {
        use crate::pane::{is_missing_target, PaneError};
        for gone in [
            "can't find session: claude-1",
            "cannot find window",
            "no such session: claude-1",
            "session not found",
            "no server running on /tmp/tmux-501/default",
        ] {
            assert!(is_missing_target(&PaneError::msg(gone)), "{gone}");
        }
        // A spawn refused for want of a process slot answered nothing at all,
        // and it is the one that arrives on the machine that most needs the
        // entry kept. It is flagged rather than pattern-matched.
        let refused = PaneError { message: "spawn tmux EAGAIN".into(), eagain: true, enoent: false };
        assert!(!is_missing_target(&refused));
        assert!(!is_missing_target(&PaneError::msg("tmux did not answer in time")));
        assert!(!is_missing_target(&PaneError::msg("")));
    }

    /// A spawned session is Claude and nothing else, and the kind has to say
    /// so: an empty one denies every control the card exists to offer.
    #[tokio::test]
    async fn a_pending_entry_names_its_agent_kind() {
        let (s, _) = store(Some("%1"));
        s.add_at(spawned("claude-1", "/tmp/a"), 0);
        let merged = s.merge_at(vec![], 0).await;
        assert_eq!(merged[0].agent_kind, CLAUDE_KIND);
    }

    /// One tmux round trip per still-pending session per refresh, and none for
    /// the ones already accounted for. A burst is what EAGAIN answers.
    #[tokio::test]
    async fn asks_tmux_once_per_unclaimed_session() {
        let (s, calls) = store(Some("%1"));
        s.add_at(spawned("claude-1", "/tmp/a"), 0);
        s.add_at(spawned("claude-2", "/tmp/b"), 0);
        s.add_at(spawned("claude-3", "/tmp/c"), 0);
        s.merge_at(vec![real("r", Some("claude-2"))], 0).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
