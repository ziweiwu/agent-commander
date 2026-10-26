//! How far each session has been shown in this app, for "new since you last
//! opened it" (F6; INV-11, INV-14).
//!
//! `seen_through[session]` is the agent's own `lastActivityAt` — a time read
//! out of its transcript, never this machine's clock — as it stood the last
//! time a tab that was on screen had that session open. A card whose
//! `lastActivityAt` is past it has done something since it was last shown
//! here. That is all it says: the reader may well have followed it in tmux,
//! so it is "new since opened in this app", never "unread" (INV-11).
//!
//! Kept by the server rather than each browser so the laptop and the phone
//! agree: opening an agent on one clears the mark on the other. In memory
//! only, so a restart forgets it, and the backlog rule INV-14 gives the push
//! tracker applies here too: the first frame that carries a session's
//! transcript time seeds it, and a fresh server shows no marks at all.
//!
//! A hidden tab never advances it, however long the session stays open there:
//! nothing is being shown.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use crate::registry::Listeners;
use crate::sources::Unsubscribe;
use crate::types::Agent;

/// Session id to the transcript time it has been shown through, in ms.
pub type SeenMap = HashMap<String, i64>;

#[derive(Default)]
pub struct SeenThrough {
    through: Mutex<SeenMap>,
    listeners: Listeners<SeenMap>,
}

impl SeenThrough {
    /// Fold one fleet frame into the record, given the sessions a tab has open
    /// on screen, and tell every subscriber if anything moved.
    ///
    /// Only sessions whose CLI keeps a transcript are tracked, and only once a
    /// frame carries their transcript time: before the enricher has read the
    /// tail, `lastActivityAt` is absent, and seeding from nothing would mark
    /// every session the moment its first read lands. A session that leaves
    /// the fleet is forgotten, so one that comes back is backlog again.
    pub fn observe(&self, agents: &[Agent], on_screen: &HashSet<String>) {
        let changed = {
            let mut through = self.through.lock().unwrap();
            let before = through.clone();
            fold(&mut through, agents, on_screen);
            (*through != before).then(|| through.clone())
        };
        if let Some(record) = changed {
            self.listeners.emit(&record);
        }
    }

    /// The record as it stands, for a tab that has just connected.
    pub fn current(&self) -> SeenMap {
        self.through.lock().unwrap().clone()
    }

    /// Run `listener` with the whole record whenever it changes.
    pub fn on_change(&self, listener: Box<dyn Fn(SeenMap) + Send + Sync>) -> Unsubscribe {
        self.listeners.add(listener)
    }
}

/// The session and its transcript time, for an agent that has one.
fn transcript_time(agent: &Agent) -> Option<(&str, i64)> {
    if !crate::agent_kinds::has_transcripts(&agent.agent_kind) {
        return None;
    }
    agent.last_activity_at.map(|at| (agent.session_id.as_str(), at))
}

/// Forget the sessions that left, seed the untracked ones as backlog, and move
/// the ones on screen forward to their own time — never back.
fn fold(through: &mut SeenMap, agents: &[Agent], on_screen: &HashSet<String>) {
    through.retain(|id, _| agents.iter().any(|a| &a.session_id == id));
    for (id, activity) in agents.iter().filter_map(transcript_time) {
        let seen = through.entry(id.to_string()).or_insert(activity);
        if on_screen.contains(id) {
            *seen = (*seen).max(activity);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_kinds::{CLAUDE_KIND, TERMINAL_KIND};
    use crate::types::AgentStatus;
    use std::sync::Arc;

    const T0: i64 = 1_786_600_000_000;
    const LATER: i64 = T0 + 60_000;

    fn agent(id: &str, activity: Option<i64>) -> Agent {
        Agent {
            session_id: id.into(),
            status: AgentStatus::Idle,
            agent_kind: CLAUDE_KIND.into(),
            last_activity_at: activity,
            ..Agent::default()
        }
    }

    fn shown(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    fn is_new(seen: &SeenThrough, agent: &Agent) -> bool {
        let at = agent.last_activity_at.unwrap();
        seen.current().get(&agent.session_id).is_some_and(|through| at > *through)
    }

    #[test]
    fn inv14_the_first_frame_is_backlog_so_a_fresh_server_shows_no_marks() {
        let seen = SeenThrough::default();
        let fleet = [agent("a", Some(T0)), agent("b", Some(LATER))];
        seen.observe(&fleet, &shown(&[]));
        assert!(fleet.iter().all(|a| !is_new(&seen, a)));
        assert_eq!(seen.current().get("b"), Some(&LATER));
    }

    #[test]
    fn inv14_a_session_is_seeded_by_its_first_transcript_time_not_before() {
        let seen = SeenThrough::default();
        seen.observe(&[agent("a", None)], &shown(&[]));
        assert!(seen.current().is_empty(), "nothing read yet is nothing to seed from");
        let read = agent("a", Some(T0));
        seen.observe(std::slice::from_ref(&read), &shown(&[]));
        assert!(!is_new(&seen, &read), "the enricher's first read is backlog, not news");
    }

    #[test]
    fn inv11_a_new_transcript_record_after_a_focus_is_new() {
        let seen = SeenThrough::default();
        seen.observe(&[agent("a", Some(T0))], &shown(&["a"]));
        seen.observe(&[agent("a", Some(T0))], &shown(&[]));
        let moved = agent("a", Some(LATER));
        seen.observe(std::slice::from_ref(&moved), &shown(&[]));
        assert!(is_new(&seen, &moved));
    }

    #[test]
    fn inv11_a_visible_focus_advances_it() {
        let seen = SeenThrough::default();
        seen.observe(&[agent("a", Some(T0))], &shown(&[]));
        let moved = agent("a", Some(LATER));
        seen.observe(std::slice::from_ref(&moved), &shown(&[]));
        assert!(is_new(&seen, &moved));
        seen.observe(std::slice::from_ref(&moved), &shown(&["a"]));
        assert!(!is_new(&seen, &moved), "shown on screen, so nothing is new");
        assert_eq!(seen.current().get("a"), Some(&LATER), "the agent's own time, not a clock");
    }

    #[test]
    fn inv11_a_hidden_focus_does_not_advance_it() {
        let presence = crate::presence::Presence::default();
        let tab = presence.arrive();
        presence.focus(tab, Some("a".into()));
        presence.off_screen(tab);
        let seen = SeenThrough::default();
        seen.observe(&[agent("a", Some(T0))], &presence.on_screen_sessions());
        let moved = agent("a", Some(LATER));
        seen.observe(std::slice::from_ref(&moved), &presence.on_screen_sessions());
        assert!(is_new(&seen, &moved), "open on a hidden tab is shown to nobody");
        presence.on_screen(tab);
        seen.observe(std::slice::from_ref(&moved), &presence.on_screen_sessions());
        assert!(!is_new(&seen, &moved), "the same tab on screen is");
    }

    #[test]
    fn inv11_it_never_moves_back_and_a_session_that_leaves_is_backlog_again() {
        let seen = SeenThrough::default();
        seen.observe(&[agent("a", Some(LATER))], &shown(&[]));
        seen.observe(&[agent("a", Some(T0))], &shown(&["a"]));
        assert_eq!(seen.current().get("a"), Some(&LATER));
        seen.observe(&[], &shown(&[]));
        assert!(seen.current().is_empty());
    }

    #[test]
    fn inv11_a_terminal_is_never_tracked_because_its_time_is_a_pane_clock() {
        let seen = SeenThrough::default();
        let mut shell = agent("t", Some(T0));
        shell.agent_kind = TERMINAL_KIND.into();
        seen.observe(&[shell], &shown(&[]));
        assert!(seen.current().is_empty());
    }

    #[test]
    fn subscribers_hear_a_change_and_nothing_else() {
        let seen = SeenThrough::default();
        let heard = Arc::new(Mutex::new(Vec::new()));
        let log = heard.clone();
        let _off = seen.on_change(Box::new(move |record| log.lock().unwrap().push(record)));
        let fleet = [agent("a", Some(T0))];
        seen.observe(&fleet, &shown(&[]));
        seen.observe(&fleet, &shown(&["a"]));
        assert_eq!(heard.lock().unwrap().len(), 1, "a frame that moved nothing is not news");
    }
}
