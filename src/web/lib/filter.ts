/** Pure filtering and grouping for the agent list. */
import { hasTranscripts } from '../../shared/agent-kinds.ts'
import type { Agent, AgentStatus } from '../../shared/types.ts'
import { GROUPS, type GroupKey, matches } from './format.ts'

export type StatusFilter = 'all' | GroupKey

export const SORTS = ['recent', 'tokens', 'duration', 'name'] as const
export type SortKey = (typeof SORTS)[number]

export type SortDir = 'desc' | 'asc'

export interface FleetState {
  query: string
  filter: StatusFilter
  sort: SortKey
  dir: SortDir
}

/**
 * What each key means in each direction, as translation keys — the toggle is
 * labelled with the answer rather than with "asc"/"desc", because nobody thinks
 * "ascending tokens", they think "least spent first".
 */
export const SORT_SENSE: Record<SortKey, { desc: SenseKey; asc: SenseKey }> = {
  recent: { desc: 'senseNewest', asc: 'senseOldest' },
  tokens: { desc: 'senseMost', asc: 'senseLeast' },
  duration: { desc: 'senseLongest', asc: 'senseShortest' },
  name: { desc: 'senseZA', asc: 'senseAZ' },
}

type SenseKey =
  | 'senseNewest'
  | 'senseOldest'
  | 'senseMost'
  | 'senseLeast'
  | 'senseLongest'
  | 'senseShortest'
  | 'senseZA'
  | 'senseAZ'

export const IN_GROUP: Record<GroupKey, ReadonlySet<AgentStatus>> = {
  waiting: new Set<AgentStatus>(['waiting']),
  busy: new Set<AgentStatus>(['busy']),
  idle: new Set<AgentStatus>(['idle', 'unknown']),
}

/**
 * A session that was opened and never used.
 *
 * The evidence is the same the card already draws "No prompts yet" from: no
 * activity line, no token spend, no last-activity clock, and nothing the agent
 * named for itself. A session that has been prompted has at least one of those,
 * even after it goes quiet — so this cannot select work in progress, only
 * shells that were started and forgotten.
 *
 * `idle` is required rather than merely "not busy": `unknown` means the status
 * field was missing or unrecognised, which is not evidence of anything, and
 * `waiting` is an agent asking a question. Neither may be pruned on a guess.
 *
 * A pane is required too, because closing is `/exit` typed into that pane. An
 * agent this app cannot close is one it must not offer to prune — the button
 * would promise something it has no way to do.
 *
 * And every one of those signals is read out of a transcript, so for an agent
 * whose CLI writes none they are all absent by construction. That is absence of
 * evidence, not evidence of disuse: without this clause a Kiro session working
 * away in its pane matches every test above and gets offered to a button that
 * types `/exit` into it.
 */
export function isUnused(agent: Agent): boolean {
  return (
    hasTranscripts(agent.agentKind) &&
    agent.status === 'idle' &&
    agent.paneId !== undefined &&
    !agent.delegating &&
    !agent.activity &&
    !agent.lastActivityAt &&
    !agent.tokens &&
    !agent.aiTitle &&
    !agent.lastPrompt
  )
}

/** Every session that qualifies, in the order the list already shows them. */
export function unusedAgents(agents: Agent[]): Agent[] {
  return agents.filter(isUnused)
}

export function countByGroup(agents: Agent[]): Record<GroupKey, number> {
  return {
    waiting: agents.filter((a) => IN_GROUP.waiting.has(a.status)).length,
    busy: agents.filter((a) => IN_GROUP.busy.has(a.status)).length,
    idle: agents.filter((a) => IN_GROUP.idle.has(a.status)).length,
  }
}

/** Apply the status filter and the free-text query. */
export function visibleAgents(agents: Agent[], state: FleetState): Agent[] {
  return agents.filter(
    (a) =>
      (state.filter === 'all' || IN_GROUP[state.filter].has(a.status)) && matches(a, state.query),
  )
}

/**
 * Order agents by the chosen key.
 *
 * Agents missing the value always sort last, whichever direction the key runs.
 * A session that has never been prompted has no token spend and no last
 * activity; treating that as zero would rank it as genuinely cheapest or
 * stalest, which is a different claim from "unknown".
 */
export function sortAgents(agents: Agent[], sort: SortKey, dir: SortDir = 'desc'): Agent[] {
  /**
   * Compare two optional numbers.
   *
   * `undefined` always sorts last, in *both* directions — the direction applies
   * to the values, not to the placement of the ones that have none. Flipping the
   * whole comparison would send an agent that has never been prompted to the top
   * of "least spent", which claims it is the cheapest rather than unknown.
   */
  const compare = (a: number | undefined, b: number | undefined): number => {
    if (a === undefined && b === undefined) return 0
    if (a === undefined) return 1
    if (b === undefined) return -1
    return dir === 'asc' ? a - b : b - a
  }

  // The name tiebreak stays ascending in both directions so the order never
  // jitters between renders for equal values.
  const byName = (a: Agent, b: Agent): number => a.name.localeCompare(b.name)
  const byNameDirected = (a: Agent, b: Agent): number =>
    dir === 'asc' ? byName(b, a) : byName(a, b)

  return [...agents].sort((a, b) => {
    switch (sort) {
      case 'tokens':
        return compare(a.tokens, b.tokens) || byName(a, b)
      case 'duration':
        // Longest-running first by default: the oldest start is the largest age.
        return compare(durationOf(a), durationOf(b)) || byName(a, b)
      case 'name':
        return byNameDirected(a, b)
      case 'recent':
      default:
        return compare(a.lastActivityAt, b.lastActivityAt) || byName(a, b)
    }
  })
}

/** Age of a session, or undefined when it never reported a start time. */
function durationOf(agent: Agent, now = Date.now()): number | undefined {
  return agent.startedAt ? now - agent.startedAt : undefined
}

/**
 * Split the visible agents into the display groups, dropping empty ones.
 *
 * Sorting happens inside each group, never across them: surfacing blocked
 * agents is this app's whole job, so no sort key may bury one below the fold.
 */
export function grouped(
  agents: Agent[],
  state: FleetState,
): Array<{ key: GroupKey; agents: Agent[] }> {
  const shown = visibleAgents(agents, state)
  return GROUPS.map((g) => ({
    key: g.key,
    agents: sortAgents(
      shown.filter((a) => IN_GROUP[g.key].has(a.status)),
      state.sort,
      state.dir,
    ),
  })).filter((g) => g.agents.length > 0)
}
