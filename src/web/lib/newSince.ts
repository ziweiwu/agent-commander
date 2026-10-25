/**
 * "New since you last opened it in this app" (F6), without a DOM.
 *
 * The server keeps `seenThrough[session]`: the agent's own `lastActivityAt`
 * as it stood the last time a tab on screen had it open (`seen.rs`). This
 * module decides what the card and the conversation may say about it, and
 * the wording is the claim: new since it was opened *here*. The reader may
 * have followed it in tmux, so it is never "unread", "done" or "ready"
 * (INV-11, INV-13).
 */
import type { Agent } from '../../shared/types.ts'
import { CLAUDE_KIND } from '../../shared/agent-kinds.ts'
import type { ChatMessage } from './chat.ts'

/** Session id to the transcript time it has been shown through, in ms. */
export type SeenThrough = Record<string, number>

/**
 * Whether an agent's card may carry the "new" mark.
 *
 * Only an idle Claude agent that reported its own status: a busy card is
 * still moving, so "new" is a given there and says nothing; a waiting card
 * already has the hand; an inferred status, and a terminal's pane clock, are
 * not transcript times (INV-11). A session the server has not recorded yet
 * is backlog, never new.
 */
export function isNewSinceOpened(agent: Agent, seen: SeenThrough | null): boolean {
  if (agent.status !== 'idle' || agent.statusInferred || agent.agentKind !== CLAUDE_KIND) return false
  const through = seen?.[agent.sessionId]
  return through !== undefined && agent.lastActivityAt !== undefined && agent.lastActivityAt > through
}

/**
 * Where the conversation stood when this visit to it began: how far it had
 * been shown, and how far the agent had got.
 *
 * Held for the whole visit. Opening the session moves the server's record to
 * now within a round trip, so the divider has to be placed from what was true
 * a moment before, and kept there while the reader works down to it.
 *
 * Except `activityAt` while the fleet may still be frozen: with no tab
 * connected the server idles the enricher and keeps its last values, so a
 * cold open can begin on an agent whose news has not been read yet. A visit
 * begun before the server said the fleet was caught up follows the agent's
 * activity until the frame that says so, and holds from then on. A visit
 * begun on a caught-up fleet never follows: what arrives while the reader is
 * here is not news (INV-11).
 */
export interface Visit {
  sessionId: string
  seenThrough: number
  activityAt: number
  following: boolean
}

/** The fleet as the last frame left it, and whether that frame was caught up. */
export interface FleetFrame {
  agents: Agent[]
  caughtUp: boolean
}

/** The visit beginning now, or null while the server has not said how far it was shown. */
export function visitOf(sessionId: string | null, fleet: FleetFrame, seen: SeenThrough | null): Visit | null {
  if (sessionId === null) return null
  const seenThrough = seen?.[sessionId]
  const activityAt = fleet.agents.find((a) => a.sessionId === sessionId)?.lastActivityAt
  if (seenThrough === undefined || activityAt === undefined) return null
  return { sessionId, seenThrough, activityAt, following: !fleet.caughtUp }
}

/** The visit after a fleet frame: still following it until the frame that is caught up. */
export function followVisit(visit: Visit | null, fleet: FleetFrame): Visit | null {
  if (visit === null || !visit.following) return visit
  const latest = fleet.agents.find((a) => a.sessionId === visit.sessionId)?.lastActivityAt
  const activityAt = latest !== undefined && latest > visit.activityAt ? latest : visit.activityAt
  return { ...visit, activityAt, following: !fleet.caughtUp }
}

/** Where the divider goes in the conversation, and what it counts. */
export interface Divider {
  /** The first message after it. */
  before: string
  replies: number
  tools: number
  /** The read did not reach back to `seenThrough`, so the counts are a floor. */
  atLeast: boolean
}

/**
 * The divider for this visit, or null when nothing was newer when it began.
 *
 * It sits before the first message past `seenThrough` and counts the messages
 * up to where the agent had got when the visit began — what arrives while the
 * reader is here is not news to them. When nothing loaded is at or before
 * `seenThrough`, the transcript tail did not reach back that far: the divider
 * goes at the top and its counts say "at least" (INV-11).
 */
export function dividerFor(messages: ChatMessage[], visit: Visit | null): Divider | null {
  if (visit === null || visit.activityAt <= visit.seenThrough) return null
  const confirmed = messages.filter((m) => !m.pending && !m.failed)
  const firstNew = confirmed.findIndex((m) => m.at > visit.seenThrough)
  const first = confirmed[firstNew]
  if (first === undefined) return null
  const fresh = confirmed.slice(firstNew).filter((m) => m.at <= visit.activityAt)
  const agentSaid = fresh.filter((m) => m.role === 'agent')
  return {
    before: first.id,
    replies: agentSaid.filter((m) => m.text.trim() !== '').length,
    tools: agentSaid.reduce((sum, m) => sum + m.tools.length, 0),
    atLeast: firstNew === 0,
  }
}
