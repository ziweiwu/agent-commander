/**
 * The trail is two measured lengths or it is nothing.
 *
 * Every case here is one where the honest rendering is a blank, and a blank is
 * the hard thing to keep: a bar that is missing looks like a bug, so the
 * pressure is always to fill it with the nearest available number.
 */
import { describe, expect, it } from 'vitest'
import { trailOf } from '../src/web/lib/trail.ts'

const MINUTE = 60_000
const NOW = 1_700_000_000_000

describe('INV-11 a trail is measured or it is absent', () => {
  it('splits the agent life at the last write', () => {
    const trail = trailOf({ startedAt: NOW - 4 * MINUTE, lastActivityAt: NOW - MINUTE }, NOW)
    expect(trail).toEqual({ worked: 0.75, silent: 0.25 })
  })

  /*
   * No last write means no transcript this app can read, which is the ordinary
   * case for a CLI that writes none. A full-width silence would say "it has
   * produced nothing since it started" about an agent that may be working.
   */
  it('draws nothing for an agent with no readable last write', () => {
    expect(trailOf({ startedAt: NOW - MINUTE }, NOW)).toBeNull()
  })

  it('draws nothing for an agent with no start time', () => {
    expect(trailOf({ startedAt: Number.NaN, lastActivityAt: NOW - MINUTE }, NOW)).toBeNull()
  })

  // A clock that disagrees with the server's is not a reason to draw a
  // negative length, and neither is a session that started this millisecond.
  it('draws nothing when no time has passed', () => {
    expect(trailOf({ startedAt: NOW, lastActivityAt: NOW }, NOW)).toBeNull()
    expect(trailOf({ startedAt: NOW + MINUTE, lastActivityAt: NOW }, NOW)).toBeNull()
  })

  it('clamps a write reported after now rather than overflowing the row', () => {
    const trail = trailOf({ startedAt: NOW - MINUTE, lastActivityAt: NOW + MINUTE }, NOW)
    expect(trail).toEqual({ worked: 1, silent: 0 })
  })

  it('clamps a write reported before the session started', () => {
    const trail = trailOf({ startedAt: NOW - MINUTE, lastActivityAt: NOW - 9 * MINUTE }, NOW)
    expect(trail).toEqual({ worked: 0, silent: 1 })
  })

  it('always fills the row exactly once', () => {
    const trail = trailOf({ startedAt: NOW - 3 * MINUTE, lastActivityAt: NOW - MINUTE }, NOW)
    expect((trail?.worked ?? 0) + (trail?.silent ?? 0)).toBe(1)
  })
})
