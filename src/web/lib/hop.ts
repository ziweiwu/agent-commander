/**
 * Where to go next: the pure half of moving between agents without the list.
 *
 * The list is the one place this app says which agents need you, and two
 * shapes take it off the screen while an agent is open — the phone's sheet and
 * a collapsed column — as does full screen at any width. These functions answer
 * "which one next" from the fleet itself, so the chip, the post-answer hand-off
 * and the keyboard chords agree with each other and with the list.
 *
 * **Over the whole fleet, not the filtered view, for the waiting ones.** A
 * search term or a status filter is about what the list shows; it is not a
 * decision that an agent blocked on you has stopped mattering, and a chip that
 * said "nothing needs you" because a filter hid the one that did would be the
 * over-claim INV-11 exists to prevent. `listNeighbour` is the exception, and on
 * purpose: ⌥J/⌥K walk the list, so they walk the list as it is filtered.
 */
import type { Agent } from '../../shared/types.ts'
import { grouped, sortAgents, type FleetState, type SortDir, type SortKey } from './filter.ts'
import { railOf } from './status.ts'
import { PENDING_PREFIX } from './succession.ts'

/** The tab an agent opens on: the conversation, or its terminal. */
export type AgentTab = 'chat' | 'attach'

/** The route for one agent, on the tab named. */
export function agentPath(sessionId: string, tab: AgentTab): string {
  const base = `/agent/${encodeURIComponent(sessionId)}`
  return tab === 'attach' ? `${base}/term` : base
}

/**
 * Whether this agent is blocked on you in a way you could answer from here.
 *
 * Through `railOf`, which already refuses the hand to an inferred status and to
 * a pane that has gone or exited: the same mark the card draws is the one that
 * counts here, so the chip cannot send you somewhere the card would not. A
 * `starting up` placeholder is a block this app minted while a CLI boots
 * (`pending.rs`), not a question, so it is no reason to go and look.
 */
export function needsYou(agent: Agent, exited: readonly string[] = []): boolean {
  return (
    railOf(agent, exited).state === 'waiting' &&
    agent.waitingFor !== 'starting up' &&
    !agent.sessionId.startsWith(PENDING_PREFIX)
  )
}

/** Every agent other than the open one that needs you, in fleet order. */
export function othersWaiting(
  agents: readonly Agent[],
  openId: string | null,
  exited: readonly string[] = [],
): Agent[] {
  return agents.filter((a) => a.sessionId !== openId && needsYou(a, exited))
}

/** The order the list is sorted in, which "next" follows. */
export interface Order {
  sort: SortKey
  dir: SortDir
}

/**
 * The next agent that needs you after the open one, in the list's own order,
 * wrapping round; null when no other agent does.
 *
 * The list draws its waiting group first and sorts inside it, so from an agent
 * that is not itself waiting, "next" wrapping round is the top of that group.
 * From a waiting one it is the one drawn below it — or the top again, once it
 * is the last.
 */
export function nextWaiting(
  agents: readonly Agent[],
  openId: string | null,
  order: Order,
  exited: readonly string[] = [],
): Agent | null {
  const others = othersWaiting(agents, openId, exited)
  if (others.length === 0) return null
  const open = agents.find((a) => a.sessionId === openId && a.status === 'waiting')
  const ring = sortAgents(open ? [...others, open] : others, order.sort, order.dir)
  if (!open) return ring[0] ?? null
  return ring[(ring.indexOf(open) + 1) % ring.length] ?? null
}

/**
 * The agent that has needed you longest, other than the open one; null when no
 * other agent needs you.
 *
 * Longest is the oldest `lastActivityAt`, which for a waiting agent is the
 * moment it stopped and asked (`ageFrom`). One with no recorded activity goes
 * last: how long it has been blocked is not something this app knows, and
 * treating that as "forever" would put a guess at the front of the queue.
 */
export function longestWaiting(
  agents: readonly Agent[],
  openId: string | null,
  exited: readonly string[] = [],
): Agent | null {
  const since = (blocked: Agent): number => blocked.lastActivityAt ?? Number.POSITIVE_INFINITY
  const queue = [...othersWaiting(agents, openId, exited)].sort(
    (first, second) => since(first) - since(second),
  )
  return queue[0] ?? null
}

/**
 * The agent `step` places along the list as it is drawn, wrapping round; null
 * when the list holds nothing else to go to.
 *
 * Computed from `grouped`, the function the list renders from, rather than
 * from the cards in the DOM: the list is not mounted while a sheet or a
 * collapsed column covers it, which is exactly when these keys are wanted.
 * From no agent, or one the list does not show, the first step forward is the
 * top of the list and the first step back is its foot.
 */
export function listNeighbour(
  agents: readonly Agent[],
  fleet: FleetState,
  openId: string | null,
  step: 1 | -1,
): Agent | null {
  const list = grouped([...agents], fleet).flatMap((group) => group.agents)
  if (list.length === 0) return null
  const at = list.findIndex((a) => a.sessionId === openId)
  const index = at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length
  const target = list[index]
  return target && target.sessionId !== openId ? target : null
}
