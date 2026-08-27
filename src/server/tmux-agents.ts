/**
 * Agents discovered from tmux alone, for CLIs that report nothing about
 * themselves.
 *
 * Claude Code writes a session file saying what it is, where it is, and whether
 * it is blocked; `registry.ts` reads it and this app never has to guess. Kiro
 * writes `~/.kiro/sessions/cli/<uuid>.json`, but that file carries no tmux
 * reference and no status — so it can neither be attached to nor sorted from.
 * tmux is the only place that has both, and it costs one query for the machine.
 *
 * Everything here is a pure function of a `PaneFacts` snapshot, so the rules can
 * be tested without a tmux server.
 */
import { basename } from 'node:path'
import {
  SHELL_COMMANDS,
  tmuxDiscoverable,
  type AgentKindSpec,
} from '../shared/agent-kinds.ts'
import type { Agent } from '../shared/types.ts'
import type { PaneFacts } from './pane.ts'

/**
 * How long after its last output an agent is still considered working.
 *
 * A TUI agent that is thinking animates something — a spinner, an elapsed
 * counter — so it emits a frame roughly once a second. Eight seconds is wide
 * enough to ride out a slow tool call without flickering, and short enough that
 * a finished agent settles within one poll.
 */
export const BUSY_MS = 8_000

/**
 * `kiro-1787832510` -> 1787832510000. The launcher's convention, not a contract.
 *
 * Nine digits is the shortest a plausible epoch-seconds stamp can be, and it is
 * what keeps a session someone named `agent-42` by hand from being read as one.
 */
const EPOCH_DIGITS = 9

export function startedAtOf(session: string): number {
  const epoch = new RegExp(`-(\\d{${EPOCH_DIGITS},})$`).exec(session)
  if (!epoch) return 0
  return Number.parseInt(epoch[1] as string, 10) * 1000
}

function isShell(command: string): boolean {
  return SHELL_COMMANDS.includes(command)
}

/**
 * Which CLI, if any, this pane is running.
 *
 * Either test alone is too narrow. The session prefix is the user's own
 * launcher convention and misses an agent started by hand; the process name
 * misses one launched through a wrapper, and is not a contract either — Claude
 * Code rewrites its process title to its version number, so a name allow-list
 * would not even recognise the CLI this app was built for. Matching on either,
 * then rejecting shells, keeps both doors open without letting a plain terminal
 * through.
 */
export function kindOf(row: PaneFacts, kinds = tmuxDiscoverable()): AgentKindSpec | undefined {
  return kinds.find(
    (k) =>
      k.processNames?.includes(row.command) === true || k.sessionPrefix?.test(row.session) === true,
  )
}

/**
 * True when this pane holds a live agent rather than what one left behind.
 *
 * tmux-resurrect restores sessions by name long after the process inside them
 * exited, so a machine accumulates `gemini-1780008794` sessions containing
 * nothing but an idle `zsh`. On this laptop every gemini and opencode session
 * is one of those. They are indistinguishable from a live agent by name alone,
 * and listing them would be worse than listing nothing.
 */
export function isLiveAgent(row: PaneFacts): boolean {
  return !row.dead && !isShell(row.command)
}

/**
 * Working or not, judged only by whether the pane has produced output lately.
 *
 * This is a genuinely weaker claim than the one a Claude card makes, and it is
 * marked as such all the way to the pill (INV-11). In particular it can never
 * be `waiting`: an agent blocked on a permission dialog and an agent that has
 * finished both sit there emitting nothing, and no amount of squinting at a
 * timestamp separates them. Saying `idle` for both is the honest reading;
 * inventing a `waiting` would spend the credibility of the one alert this
 * dashboard exists to raise.
 *
 * A window with more than one pane gets `unknown`, because tmux tracks activity
 * per window and there is no way to tell which pane produced it.
 */
export function inferStatus(row: PaneFacts, now: number): Agent['status'] {
  if (row.windowPanes > 1) return 'unknown'
  if (row.activityAt <= 0) return 'unknown'
  return now - row.activityAt * 1000 <= BUSY_MS ? 'busy' : 'idle'
}

export function toTmuxAgent(row: PaneFacts, spec: AgentKindSpec, now: number): Agent {
  const cwd = row.cwd || '~'
  const status = inferStatus(row, now)
  const agent: Agent = {
    // Namespaced so it can never collide with a Claude UUID or a `pending:` id,
    // and keyed on the session name rather than the pane id because tmux reuses
    // `%N` after a pane closes.
    sessionId: `tmux:${row.session}`,
    pid: row.pid,
    name: basename(cwd) || row.session,
    derivedName: true,
    cwd,
    folder: basename(cwd) || cwd,
    status,
    agentKind: spec.id,
    kind: 'interactive',
    startedAt: startedAtOf(row.session),
    paneId: row.paneId,
    tmuxSession: row.session,
  }
  if (status !== 'unknown') agent.statusInferred = true
  if (row.activityAt > 0) agent.lastActivityAt = row.activityAt * 1000
  return agent
}

/** Every live non-Claude agent in a snapshot, newest-looking first. */
export function agentsFromPanes(
  rows: PaneFacts[],
  now: number,
  kinds = tmuxDiscoverable(),
): Agent[] {
  const agents: Agent[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!isLiveAgent(row)) continue
    const spec = kindOf(row, kinds)
    if (!spec) continue
    // One agent per tmux session: a split window is still one CLI.
    if (seen.has(row.session)) continue
    seen.add(row.session)
    agents.push(toTmuxAgent(row, spec, now))
  }
  return agents
}
