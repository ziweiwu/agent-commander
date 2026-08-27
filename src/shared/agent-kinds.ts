/**
 * Which agent CLI a session belongs to, and what this app may do to it.
 *
 * Shared rather than server-only for the same reason `MODEL_ALIASES` is: the
 * browser decides which controls to offer and the server decides which to
 * honour, and a second copy of the table is how those two stop agreeing.
 *
 * Every capability here is a statement about a *foreign program's* interface.
 * `slashCommands` is the load-bearing one: everything in `control.ts` works by
 * typing Claude Code's own slash commands into a live pane, so offering it for
 * another CLI does not degrade — it types `/model opus` into somebody's prompt.
 */

export interface AgentKindSpec {
  id: string
  /** Shown on the card when this is not the default kind. */
  label: string
  /**
   * Anchored match for the tmux session name, where a CLI is launched by a
   * wrapper that names sessions `<id>-<epoch>`. Digits required, so a session
   * someone named `kiro-notes` by hand is not mistaken for an agent.
   */
  sessionPrefix?: RegExp
  /**
   * What tmux reports as the pane's foreground command. tmux resolves this
   * through child processes, so it is the running agent rather than the shell
   * or wrapper that started it.
   */
  processNames?: readonly string[]
  /** Whether this app can read a conversation for it — gates the Chat tab. */
  transcripts: boolean
  /** Whether Claude Code's slash commands may be typed into its pane. */
  slashCommands: boolean
}

export const CLAUDE_KIND = 'claude'

/**
 * Claude is discovered from the session files it writes about itself, never
 * from tmux, so it carries no matchers here — only its capabilities.
 */
export const AGENT_KINDS: readonly AgentKindSpec[] = [
  { id: CLAUDE_KIND, label: 'Claude Code', transcripts: true, slashCommands: true },
  {
    id: 'kiro',
    label: 'Kiro',
    sessionPrefix: /^kiro-\d+$/,
    processNames: ['kiro-cli', 'kiro-cli-chat'],
    transcripts: false,
    slashCommands: false,
  },
]

/**
 * A pane sitting at a shell prompt is an agent that has exited, not an agent.
 *
 * tmux-resurrect restores sessions by name long after the process inside them
 * died, so a machine accumulates `gemini-1780008794` sessions that are nothing
 * but an idle `zsh`. Listing those would be worse than listing nothing: they
 * look exactly like live agents that have gone quiet.
 */
export const SHELL_COMMANDS: readonly string[] = [
  'zsh',
  '-zsh',
  'bash',
  '-bash',
  'sh',
  '-sh',
  'fish',
  '-fish',
  'nu',
  'elvish',
  'xonsh',
  'login',
  'tmux',
]

export function specOf(kind: string): AgentKindSpec | undefined {
  return AGENT_KINDS.find((k) => k.id === kind)
}

/** Kinds this app finds by looking at tmux — everything except Claude. */
export function tmuxDiscoverable(): AgentKindSpec[] {
  return AGENT_KINDS.filter((k) => k.sessionPrefix || k.processNames)
}

/** True when the app may type Claude Code's slash commands into this agent. */
export function allowsSlashCommands(kind: string): boolean {
  return specOf(kind)?.slashCommands ?? false
}

/** True when a conversation can be read for this agent (INV-4: else no tail). */
export function hasTranscripts(kind: string): boolean {
  return specOf(kind)?.transcripts ?? false
}
