//! Which agent CLI a session belongs to, and what this app may do to it.
//!
//! Port of `src/shared/agent-kinds.ts`. Every capability here is a statement
//! about a *foreign program's* interface. `slash_commands` is the load-bearing
//! one: everything in `control.rs` works by typing Claude Code's own slash
//! commands into a live pane, so offering it for another CLI does not degrade
//! — it types `/model opus` into somebody's prompt.

/// A session-name matcher, kept as its own type so the anchored digit rule is
/// stated once. A regex crate would be a dependency for two patterns.
#[derive(Debug, Clone, Copy)]
pub struct SessionPrefix {
    /// The literal lead, e.g. `"kiro-"`.
    pub prefix: &'static str,
}

impl SessionPrefix {
    /// Matches `<prefix><digits>` and nothing else.
    ///
    /// Digits are required so a session someone named `kiro-notes` by hand is
    /// not mistaken for an agent, and the match is anchored at both ends.
    pub fn matches(&self, session: &str) -> bool {
        let Some(rest) = session.strip_prefix(self.prefix) else {
            return false;
        };
        !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct AgentKindSpec {
    pub id: &'static str,
    /// Shown on the card when this is not the default kind.
    pub label: &'static str,
    /// Anchored match for the tmux session name, where a CLI is launched by a
    /// wrapper that names sessions `<id>-<epoch>`.
    pub session_prefix: Option<SessionPrefix>,
    /// What tmux reports as the pane's foreground command. tmux resolves this
    /// through child processes, so it is the running agent rather than the
    /// shell or wrapper that started it.
    pub process_names: &'static [&'static str],
    /// Whether this app can read a conversation for it — gates the Chat tab.
    pub transcripts: bool,
    /// Whether Claude Code's slash commands may be typed into its pane.
    pub slash_commands: bool,
}

pub const CLAUDE_KIND: &str = "claude";

/// Claude is discovered from the session files it writes about itself, never
/// from tmux, so it carries no matchers here — only its capabilities.
pub const AGENT_KINDS: &[AgentKindSpec] = &[
    AgentKindSpec {
        id: CLAUDE_KIND,
        label: "Claude Code",
        session_prefix: None,
        process_names: &[],
        transcripts: true,
        slash_commands: true,
    },
    AgentKindSpec {
        id: "kiro",
        label: "Kiro",
        session_prefix: Some(SessionPrefix { prefix: "kiro-" }),
        process_names: &["kiro-cli", "kiro-cli-chat"],
        transcripts: false,
        slash_commands: false,
    },
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

/// Kinds this app finds by looking at tmux — everything except Claude.
pub fn tmux_discoverable() -> impl Iterator<Item = &'static AgentKindSpec> {
    AGENT_KINDS
        .iter()
        .filter(|k| k.session_prefix.is_some() || !k.process_names.is_empty())
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
    fn inv13_session_prefix_requires_digits() {
        let kiro = spec_of("kiro").unwrap().session_prefix.unwrap();
        assert!(kiro.matches("kiro-1780008794"));
        assert!(kiro.matches("kiro-1"));
        // Named by hand, not by the wrapper — not an agent.
        assert!(!kiro.matches("kiro-notes"));
        assert!(!kiro.matches("kiro-"));
        assert!(!kiro.matches("kiro-12a"));
        // Anchored at the front.
        assert!(!kiro.matches("my-kiro-12"));
    }

    #[test]
    fn capabilities_deny_by_default_for_unknown_kinds() {
        assert!(!allows_slash_commands("gemini"));
        assert!(!has_transcripts("gemini"));
        assert!(allows_slash_commands(CLAUDE_KIND));
        assert!(has_transcripts(CLAUDE_KIND));
        // Kiro is discoverable but must never be typed at.
        assert!(!allows_slash_commands("kiro"));
        assert!(!has_transcripts("kiro"));
    }

    #[test]
    fn claude_is_not_tmux_discoverable() {
        let ids: Vec<_> = tmux_discoverable().map(|k| k.id).collect();
        assert_eq!(ids, vec!["kiro"]);
    }
}
