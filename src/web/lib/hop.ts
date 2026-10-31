/**
 * Where to go next: the pure half of moving between agents without the list.
 *
 * The list is the one place this app says which agents need you, and two
 * shapes take it off the screen while an agent is open — the phone's sheet and
 * a collapsed column — as does full screen at any width. These functions answer
 * "which one next" from the fleet itself: the chip, the post-answer hand-off and
 * ⌥H all name one agent (`nextUp`), and ⌥J/⌥K walk the list (`listNeighbour`).
 *
 * **Over the whole fleet, not the filtered view, for the waiting ones.** A
 * search term or a status filter is about what the list shows; it is not a
 * decision that an agent blocked on you has stopped mattering, and a chip that
 * said "nothing needs you" because a filter hid the one that did would be the
 * over-claim INV-11 exists to prevent. `listNeighbour` is the exception, and on
 * purpose: ⌥J/⌥K walk the list, so they walk the list as it is filtered.
 */
import type { Agent } from '../../shared/types.ts'
import { grouped, type FleetState } from './filter.ts'
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

/**
 * The order "next" walks the agents that need you in: the one blocked longest
 * first, which is the oldest `lastActivityAt` — for a waiting agent, the moment
 * it stopped and asked (`ageFrom`). A blocked agent costs more the longer it
 * waits, and the list's own waiting group is where recency is shown.
 *
 * One with no recorded activity goes last: how long it has been blocked is not
 * something this app knows, and treating that as "forever" would put a guess at
 * the front of the queue. A tie is broken by session id, so the ring is the same
 * on every render and on every device.
 *
 * This comparator is the whole of the choice. "Next" in the list's sort instead
 * would replace it with `sortAgents` over the fleet's `{ sort, dir }`.
 */
function blockedLongestFirst(first: Agent, second: Agent): number {
  const since = (blocked: Agent): number => blocked.lastActivityAt ?? Number.POSITIVE_INFINITY
  const byAge = since(first) - since(second)
  if (byAge) return byAge
  if (first.sessionId === second.sessionId) return 0
  return first.sessionId < second.sessionId ? -1 : 1
}

/**
 * The agent the chip, the Next button under a spent answer and ⌥H all open;
 * null when nothing else needs you.
 *
 * The queue is every agent that needs you, the open one included when it is
 * itself waiting, in `blockedLongestFirst` order. From an agent in it, next is
 * the one after it, wrapping round — so following it again and again visits
 * every agent rather than bouncing between the two oldest. From one that is not
 * waiting, which is where an answered agent is once it turns busy, next is the
 * one that has waited longest.
 */
export function nextUp(
  agents: readonly Agent[],
  openId: string | null,
  exited: readonly string[] = [],
): Agent | null {
  const queue = agents.filter((a) => needsYou(a, exited)).sort(blockedLongestFirst)
  const at = queue.findIndex((a) => a.sessionId === openId)
  if (at < 0) return queue[0] ?? null
  const after = queue[(at + 1) % queue.length]
  return after && after.sessionId !== openId ? after : null
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
