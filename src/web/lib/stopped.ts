/** Pure rules for the "stopped by an API error" marker and its fleet strip. */
import type { Agent, StopCause, StoppedBy } from '../../shared/types.ts'
import type { Key } from './i18n.ts'

/** A strip for one card would say what that card already says. */
const STRIP_MIN_CARDS = 2

/** Each cause in words. The two with no phrase of their own read as a plain API error. */
export const STOP_CAUSE_KEY: Record<StopCause, Key> = {
  authentication_failed: 'stoppedCauseSignIn',
  rate_limit: 'stoppedCauseLimit',
  server_error: 'stoppedCauseServer',
  billing_error: 'stoppedCauseOther',
  invalid_request: 'stoppedCauseOther',
  other: 'stoppedCauseOther',
}

/**
 * What a card may say about the stop.
 *
 * Idle only: a busy or waiting status is newer news about the agent than the
 * record, and the stop clears with the next record the server reads anyway.
 */
export function stopOf(agent: Agent): StoppedBy | null {
  return agent.status === 'idle' ? (agent.stoppedBy ?? null) : null
}

export interface StoppedGroup {
  cause: StopCause
  count: number
  /** The earliest of the stops, which is when this began. */
  since: number
}

/**
 * The fleet's one shared stop, or null.
 *
 * Every stopped card has to agree. A fleet stopped for two different reasons
 * has no one sentence, and picking the larger group would tell the owner to
 * sign in about agents that hit a limit, so mixed causes are left to the cards.
 */
export function stoppedGroup(agents: Agent[]): StoppedGroup | null {
  const stops = agents.flatMap((agent) => stopOf(agent) ?? [])
  const first = stops[0]
  if (!first || stops.length < STRIP_MIN_CARDS) return null
  if (stops.some((stop) => stop.cause !== first.cause)) return null
  return { cause: first.cause, count: stops.length, since: Math.min(...stops.map((stop) => stop.at)) }
}
