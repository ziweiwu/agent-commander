//! Agents discovered from tmux alone, for CLIs that report nothing about
//! themselves.
//!
//! Port of `src/server/tmux-agents.ts`.
//!
//! Claude Code writes a session file saying what it is, where it is, and
//! whether it is blocked; `registry` reads it and this app never has to guess.
//! Kiro writes `~/.kiro/sessions/cli/<uuid>.json`, but that file carries no
//! tmux reference and no status — so it can neither be attached to nor sorted
//! from. tmux is the only place that has both, and it costs one query for the
//! machine.
//!
//! Everything here is a pure function of a [`PaneFacts`] snapshot, so the rules
//! can be tested without a tmux server.

use crate::agent_kinds::{is_shell_command, tmux_discoverable, AgentKindSpec};
use crate::pane::PaneFacts;
use crate::types::{Agent, AgentStatus};

/// How long after its last output an agent is still considered working.
///
/// A TUI agent that is thinking animates something — a spinner, an elapsed
/// counter — so it emits a frame roughly once a second. Eight seconds is wide
/// enough to ride out a slow tool call without flickering, and short enough
/// that a finished agent settles within one poll.
pub const BUSY_MS: i64 = 8_000;

/// Nine digits is the shortest a plausible epoch-seconds stamp can be, and it
/// is what keeps a session someone named `agent-42` by hand from being read as
/// one.
const EPOCH_DIGITS: usize = 9;

/// `kiro-1787832510` -> 1787832510000. The launcher's convention, not a
/// contract.
///
/// The TS side spells this as `/-(\d{9,})$/`. Taking everything after the last
/// `-` is the same match: the pattern is anchored at the end, and a run of
/// digits reaching the end of the string that is preceded by a `-` is exactly
/// the suffix after the final `-`.
pub fn started_at_of(session: &str) -> i64 {
    let Some((_, digits)) = session.rsplit_once('-') else {
        return 0;
    };
    if digits.len() < EPOCH_DIGITS || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return 0;
    }
    // A stamp too large to be a time is not a time. Node would carry it as a
    // float and hand the UI a nonsense date; refusing it is the honest answer.
    digits
        .parse::<i64>()
        .ok()
        .and_then(|s| s.checked_mul(1_000))
        .unwrap_or(0)
}

/// Which CLI, if any, this pane is running.
///
/// Either test alone is too narrow. The session prefix is the user's own
/// launcher convention and misses an agent started by hand; the process name
/// misses one launched through a wrapper, and is not a contract either — Claude
/// Code rewrites its process title to its version number, so a name allow-list
/// would not even recognise the CLI this app was built for. Matching on either,
/// then rejecting shells, keeps both doors open without letting a plain
/// terminal through.
pub fn kind_of(row: &PaneFacts) -> Option<&'static AgentKindSpec> {
    tmux_discoverable().find(|k| {
        k.process_names.contains(&row.command.as_str())
            || k.session_prefix.is_some_and(|p| p.matches(&row.session))
    })
}

/// True when this pane holds a live agent rather than what one left behind.
///
/// tmux-resurrect restores sessions by name long after the process inside them
/// exited, so a machine accumulates `gemini-1780008794` sessions containing
/// nothing but an idle `zsh`. On this laptop every gemini and opencode session
/// is one of those. They are indistinguishable from a live agent by name alone,
/// and listing them would be worse than listing nothing.
pub fn is_live_agent(row: &PaneFacts) -> bool {
    !row.dead && !is_shell_command(&row.command)
}

/// Working or not, judged only by whether the pane has produced output lately.
///
/// This is a genuinely weaker claim than the one a Claude card makes, and it is
/// marked as such all the way to the pill (INV-11). In particular it can never
/// be `waiting`: an agent blocked on a permission dialog and an agent that has
/// finished both sit there emitting nothing, and no amount of squinting at a
/// timestamp separates them. Saying `idle` for both is the honest reading;
/// inventing a `waiting` would spend the credibility of the one alert this
/// dashboard exists to raise.
///
/// A window with more than one pane gets `unknown`, because tmux tracks
/// activity per window and there is no way to tell which pane produced it.
pub fn infer_status(row: &PaneFacts, now: i64) -> AgentStatus {
    if row.window_panes > 1 {
        return AgentStatus::Unknown;
    }
    if row.activity_at <= 0 {
        return AgentStatus::Unknown;
    }
    if now - row.activity_at * 1_000 <= BUSY_MS {
        AgentStatus::Busy
    } else {
        AgentStatus::Idle
    }
}

/// `basename`, with Node's answer for the cases that differ.
///
/// `path::basename('/')` is `''` and `basename('/a/b/')` is `'b'`; Rust's
/// `file_name` returns `None` for the first and `Some("b")` for the second, so
/// only the empty case needs saying.
fn basename(path: &str) -> &str {
    std::path::Path::new(path).file_name().and_then(|s| s.to_str()).unwrap_or("")
}

pub fn to_tmux_agent(row: &PaneFacts, spec: &AgentKindSpec, now: i64) -> Agent {
    let cwd = if row.cwd.is_empty() { "~" } else { row.cwd.as_str() };
    let status = infer_status(row, now);
    let folder = basename(cwd);
    Agent {
        // Namespaced so it can never collide with a Claude UUID or a `pending:`
        // id, and keyed on the session name rather than the pane id because
        // tmux reuses `%N` after a pane closes.
        session_id: format!("tmux:{}", row.session),
        pid: row.pid,
        name: if folder.is_empty() { row.session.clone() } else { folder.to_string() },
        derived_name: Some(true),
        cwd: cwd.to_string(),
        folder: if folder.is_empty() { cwd.to_string() } else { folder.to_string() },
        status,
        // INV-11: this status was worked out here, not reported. `unknown` is
        // not an inference, so it carries no flag.
        status_inferred: (status != AgentStatus::Unknown).then_some(true),
        // Set explicitly: an empty `agent_kind` reaches a capability lookup and
        // silently denies everything.
        agent_kind: spec.id.to_string(),
        kind: "interactive".to_string(),
        started_at: started_at_of(&row.session),
        pane_id: Some(row.pane_id.clone()),
        tmux_session: Some(row.session.clone()),
        last_activity_at: (row.activity_at > 0).then(|| row.activity_at * 1_000),
        ..Default::default()
    }
}

/// Every live non-Claude agent in a snapshot.
pub fn agents_from_panes(rows: &[PaneFacts], now: i64) -> Vec<Agent> {
    let mut agents = Vec::new();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for row in rows {
        if !is_live_agent(row) {
            continue;
        }
        let Some(spec) = kind_of(row) else { continue };
        // One agent per tmux session: a split window is still one CLI.
        if !seen.insert(&row.session) {
            continue;
        }
        agents.push(to_tmux_agent(row, spec, now));
    }
    agents
}

#[cfg(test)]
mod tests {
    //! The rule that matters most here is the one that keeps husks out.
    //! tmux-resurrect restores sessions by name long after the process inside
    //! them exited, so this machine carries `gemini-1780008794` sessions
    //! containing nothing but an idle `zsh`. They are indistinguishable from a
    //! live agent by name, and listing them would be worse than listing
    //! nothing: a fleet of five dead agents that look merely quiet is exactly
    //! the confusion this dashboard exists to remove.

    use super::*;

    const NOW: i64 = 1_787_832_700_000;

    fn pane() -> PaneFacts {
        PaneFacts {
            pane_id: "%302".into(),
            session: "kiro-1787832510".into(),
            pid: 84_638,
            command: "kiro-cli".into(),
            activity_at: NOW / 1_000,
            window_panes: 1,
            dead: false,
            cwd: "/Users/ziweiwu/Projects/folio".into(),
        }
    }

    /* ------------------------------------------- recognising an agent */

    #[test]
    fn matches_the_real_kiro_session_on_this_machine() {
        assert_eq!(kind_of(&pane()).map(|k| k.id), Some("kiro"));
    }

    /// The process name is not a contract: Claude Code rewrites its own process
    /// title to its version number, so a name allow-list alone would not even
    /// recognise the CLI this app was built for.
    #[test]
    fn matches_on_the_session_name_when_the_command_is_unrecognised() {
        let row = PaneFacts { command: "node".into(), ..pane() };
        assert_eq!(kind_of(&row).map(|k| k.id), Some("kiro"));
    }

    #[test]
    fn matches_on_the_command_when_the_session_was_named_by_hand() {
        let row = PaneFacts { session: "work".into(), ..pane() };
        assert_eq!(kind_of(&row).map(|k| k.id), Some("kiro"));
    }

    #[test]
    fn ignores_a_session_merely_named_like_one() {
        let row = PaneFacts { session: "kiro-notes".into(), command: "vim".into(), ..pane() };
        assert!(kind_of(&row).is_none());
    }

    #[test]
    fn reads_the_launcher_epoch_out_of_the_session_name() {
        assert_eq!(started_at_of("kiro-1787832510"), 1_787_832_510_000);
        assert_eq!(started_at_of("work"), 0);
        // Too few digits to be an epoch — someone's own name for a session.
        assert_eq!(started_at_of("agent-42"), 0);
        // The stamp has to end the name.
        assert_eq!(started_at_of("kiro-1787832510-old"), 0);
    }

    /* ---------------------------------------------- husks are not agents */

    #[test]
    fn drops_a_session_whose_agent_exited_leaving_a_shell() {
        for command in ["zsh", "-zsh", "bash", "fish", "sh"] {
            let row = PaneFacts { command: command.into(), ..pane() };
            assert!(!is_live_agent(&row), "{command} should not count as an agent");
        }
    }

    #[test]
    fn drops_a_dead_pane() {
        assert!(!is_live_agent(&PaneFacts { dead: true, ..pane() }));
    }

    #[test]
    fn keeps_a_live_one() {
        assert!(is_live_agent(&pane()));
    }

    /// The exact shape of the five stale sessions on this machine.
    #[test]
    fn excludes_resurrected_gemini_and_opencode_husks_from_the_fleet() {
        let rows = vec![
            PaneFacts {
                session: "gemini-1780008794".into(),
                pane_id: "%66".into(),
                command: "zsh".into(),
                ..pane()
            },
            PaneFacts {
                session: "opencode-1785617312".into(),
                pane_id: "%70".into(),
                command: "zsh".into(),
                ..pane()
            },
            pane(),
        ];
        let ids: Vec<_> =
            agents_from_panes(&rows, NOW).into_iter().map(|a| a.session_id).collect();
        assert_eq!(ids, vec!["tmux:kiro-1787832510"]);
    }

    /* ------------------------------ status, inferred and labelled as such */

    #[test]
    fn is_busy_while_the_pane_is_still_producing_output() {
        assert_eq!(infer_status(&pane(), NOW), AgentStatus::Busy);
    }

    #[test]
    fn goes_idle_once_it_has_been_quiet() {
        let quiet = PaneFacts { activity_at: (NOW - BUSY_MS - 1_000) / 1_000, ..pane() };
        assert_eq!(infer_status(&quiet, NOW), AgentStatus::Idle);
    }

    /// tmux tracks activity per window, so with a split there is no way to say
    /// which pane produced it. Refusing to guess beats guessing.
    #[test]
    fn is_unknown_when_the_window_holds_more_than_one_pane() {
        let split = PaneFacts { window_panes: 2, ..pane() };
        assert_eq!(infer_status(&split, NOW), AgentStatus::Unknown);
    }

    /// How long a pane has been quiet, from "this instant" out to a full day.
    /// The span matters because every one of these is a plausible age for a
    /// real pane, and not one of them is evidence that anybody was *asked*
    /// anything — which is what INV-11 turns on.
    const SILENCE_AGES_SECONDS: [i64; 5] = [0, 1, 60, 3_600, 86_400];

    #[test]
    fn inv11_an_inferred_status_is_never_waiting() {
        for age in SILENCE_AGES_SECONDS {
            let row = PaneFacts { activity_at: NOW / 1_000 - age, ..pane() };
            assert_ne!(infer_status(&row, NOW), AgentStatus::Waiting, "age {age}s");
        }
        // And neither of the two cases that short-circuit to unknown.
        assert_ne!(
            infer_status(&PaneFacts { activity_at: 0, ..pane() }, NOW),
            AgentStatus::Waiting
        );
    }

    #[test]
    fn inv11_marks_the_status_as_inferred_so_the_card_can_say_so() {
        let agents = agents_from_panes(&[pane()], NOW);
        assert_eq!(agents[0].status_inferred, Some(true));
    }

    #[test]
    fn inv11_claims_nothing_when_the_status_could_not_be_worked_out() {
        let agents = agents_from_panes(&[PaneFacts { window_panes: 3, ..pane() }], NOW);
        assert_eq!(agents[0].status, AgentStatus::Unknown);
        assert_eq!(agents[0].status_inferred, None);
    }

    /* ----------------------------------------------------- the agent record */

    #[test]
    fn carries_what_the_fleet_card_and_the_attach_tab_need() {
        let agents = agents_from_panes(&[pane()], NOW);
        let a = &agents[0];
        // Namespaced: tmux reuses `%N`, and a bare uuid could collide with
        // Claude.
        assert_eq!(a.session_id, "tmux:kiro-1787832510");
        assert_eq!(a.agent_kind, "kiro");
        assert_eq!(a.pid, 84_638);
        assert_eq!(a.pane_id.as_deref(), Some("%302"));
        assert_eq!(a.tmux_session.as_deref(), Some("kiro-1787832510"));
        assert_eq!(a.cwd, "/Users/ziweiwu/Projects/folio");
        assert_eq!(a.folder, "folio");
        assert_eq!(a.name, "folio");
        assert_eq!(a.started_at, 1_787_832_510_000);
        assert_eq!(a.kind, "interactive");
        assert_eq!(a.derived_name, Some(true));
        assert_eq!(a.last_activity_at, Some(NOW / 1_000 * 1_000));
    }

    /// An empty `agent_kind` reaches a capability lookup that denies chat,
    /// slash commands and everything else, with no error anywhere.
    #[test]
    fn every_discovered_agent_names_its_kind() {
        let rows = vec![pane(), PaneFacts { session: "work".into(), ..pane() }];
        for a in agents_from_panes(&rows, NOW) {
            assert!(!a.agent_kind.is_empty(), "{} has no agentKind", a.session_id);
        }
    }

    #[test]
    fn gives_one_agent_per_session_not_one_per_pane() {
        let rows = vec![pane(), PaneFacts { pane_id: "%303".into(), ..pane() }];
        assert_eq!(agents_from_panes(&rows, NOW).len(), 1);
    }

    /// tmux reports no path for a pane whose process is gone from under it.
    #[test]
    fn falls_back_to_a_readable_name_when_tmux_reports_no_path() {
        let rows = vec![PaneFacts { cwd: String::new(), ..pane() }];
        let a = &agents_from_panes(&rows, NOW)[0];
        assert_eq!(a.cwd, "~");
        assert_eq!(a.folder, "~");
        assert_eq!(a.name, "~");
    }

    #[test]
    fn a_pane_at_the_filesystem_root_is_named_from_its_session() {
        let rows = vec![PaneFacts { cwd: "/".into(), ..pane() }];
        let a = &agents_from_panes(&rows, NOW)[0];
        assert_eq!(a.name, "kiro-1787832510");
        assert_eq!(a.folder, "/");
    }

    #[test]
    fn a_pane_that_never_produced_output_reports_no_last_activity() {
        let rows = vec![PaneFacts { activity_at: 0, ..pane() }];
        let a = &agents_from_panes(&rows, NOW)[0];
        assert_eq!(a.last_activity_at, None);
        assert_eq!(a.status, AgentStatus::Unknown);
    }
}
