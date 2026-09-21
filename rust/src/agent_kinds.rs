//! Which kind of session this is, and what this app may do to it.
//!
//! Mirrored by `src/shared/agent-kinds.ts`. Two kinds: Claude Code, found
//! from the session files it writes about itself, and the plain terminals
//! this app opens, known only by the marker it puts on them. `slash_commands`
//! is the load-bearing capability: everything in `control.rs` works by typing
//! Claude Code's own slash commands into a live pane, so offering it to a
//! shell does not degrade — it types `/model opus` into somebody's prompt.
//!
//! There was a third row here, Kiro CLI, discovered from tmux by its session
//! name or process name and carried as a degraded card. It was removed to keep
//! the app to the one CLI it can read: a kind whose every flag is a claim about
//! another program's interface, checked against no version, went stale for a
//! whole major version before anybody looked.

#[derive(Debug, Clone, Copy)]
pub struct AgentKindSpec {
    pub id: &'static str,
    /// Shown on the card when this is not the default kind.
    pub label: &'static str,
    /// Whether this app can read a conversation for it — gates the Chat tab
    /// and, under INV-4, whether a transcript tail is ever opened.
    pub transcripts: bool,
    /// Whether Claude Code's slash commands may be typed into its pane.
    pub slash_commands: bool,
}

pub const CLAUDE_KIND: &str = "claude";

/// A plain tmux session this app opened, with no agent in it.
///
/// It is a kind so that every capability gate already written applies to it
/// unchanged: no transcript to read, and no slash command to type at a shell
/// that would only receive the words. It is *not* tmux-discoverable — nothing
/// about a shell's name or process says who made it, which is the whole reason
/// husks are excluded — so it is recognised by the marker this app writes on
/// the session instead (`pane::MARKER_OPTION`).
pub const TERMINAL_KIND: &str = "terminal";

pub const AGENT_KINDS: &[AgentKindSpec] = &[
    AgentKindSpec { id: CLAUDE_KIND, label: "Claude Code", transcripts: true, slash_commands: true },
    // A plain shell is indistinguishable from every other plain shell, which
    // is exactly what `tmux_agents` refuses to guess at: the marker this app
    // writes on the session is what identifies one of these.
    AgentKindSpec { id: TERMINAL_KIND, label: "Terminal", transcripts: false, slash_commands: false },
];

/// A pane sitting at a shell prompt is an agent that has exited, not an agent.
///
/// tmux-resurrect restores sessions by name long after the process inside them
/// died, so a machine accumulates `gemini-1780008794` sessions that are nothing
/// but an idle `zsh`. Listing those would be worse than listing nothing: they
/// look exactly like live agents that have gone quiet.
pub const SHELL_COMMANDS: &[&str] = &[
    "zsh", "-zsh", "bash", "-bash", "sh", "-sh", "fish", "-fish", "nu", "elvish", "xonsh",
    "login", "tmux",
];

pub fn spec_of(kind: &str) -> Option<&'static AgentKindSpec> {
    AGENT_KINDS.iter().find(|k| k.id == kind)
}

/// True when the app may type Claude Code's slash commands into this agent.
pub fn allows_slash_commands(kind: &str) -> bool {
    spec_of(kind).is_some_and(|s| s.slash_commands)
}

/// True when a conversation can be read for this agent (INV-4: else no tail).
pub fn has_transcripts(kind: &str) -> bool {
    spec_of(kind).is_some_and(|s| s.transcripts)
}

/// True when this pane is a shell rather than an agent.
pub fn is_shell_command(command: &str) -> bool {
    SHELL_COMMANDS.contains(&command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_deny_by_default_for_unknown_kinds() {
        for unknown in ["gemini", "kiro", "", "CLAUDE"] {
            assert!(!allows_slash_commands(unknown), "{unknown:?}");
            assert!(!has_transcripts(unknown), "{unknown:?}");
        }
        assert!(allows_slash_commands(CLAUDE_KIND));
        assert!(has_transcripts(CLAUDE_KIND));
    }

    /// A terminal is a session this app opened and may close, and nothing
    /// else: no conversation to read, and nothing Claude Code's commands could
    /// be typed at.
    #[test]
    fn a_terminal_can_be_attached_to_and_closed_and_nothing_more() {
        assert!(!allows_slash_commands(TERMINAL_KIND));
        assert!(!has_transcripts(TERMINAL_KIND));
        assert_eq!(spec_of(TERMINAL_KIND).map(|k| k.label), Some("Terminal"));
    }
}
