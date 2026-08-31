/**
 * The shape of one agent's life, as two lengths: how long it was writing, and
 * how long it has been silent since.
 *
 * This exists because "is anything here still moving" is a shape rather than a
 * number. A card already prints "9s" or "41m", and reading six of those and
 * comparing them is work the eye should not have to do while scanning.
 *
 * It is deliberately **self-relative** — each trail is a fraction of that
 * agent's own life, not a position on a fleet-wide axis. A shared axis has to
 * hold a session ninety seconds old and one running four hours in the same
 * scale, and the young one collapses to nothing at the right-hand edge.
 */

/** Two fractions of one row, summing to 1. */
export interface Trail {
  /** Start until the last write this app has seen. */
  worked: number
  /** That write until now. */
  silent: number
}

/**
 * Everything a trail needs, which is the point of the type.
 *
 * A `SubagentNode` carries `lastWriteAt` but **no start time** — Claude Code's
 * sidecars do not record when a delegate began. So a delegate cannot be passed
 * here at all, and the tree draws a mark with nothing before it. That blank is
 * the honest rendering and not an unfinished one: the alternative is to begin
 * its bar at the parent's start, or at the previous sibling's, both of which
 * are inventions that would look exactly like measurements.
 */
export interface Lived {
  startedAt: number
  lastActivityAt?: number
}

/**
 * `null` whenever a trail would have to be guessed at.
 *
 * No last-activity time means no transcript this app can read, which is the
 * ordinary case for a CLI that writes none. Drawing that as a full-width
 * silence would say "it has produced nothing since it started" about an agent
 * that may well be working — absence of evidence again (INV-11).
 */
export function trailOf(lived: Lived, now = Date.now()): Trail | null {
  const { startedAt, lastActivityAt } = lived
  if (!Number.isFinite(startedAt) || lastActivityAt === undefined) return null

  const span = now - startedAt
  if (span <= 0) return null

  const lastWrite = Math.min(Math.max(lastActivityAt, startedAt), now)
  const worked = (lastWrite - startedAt) / span
  return { worked, silent: 1 - worked }
}
