/**
 * The status rail's two channels, and the claims each one refuses to make.
 *
 * The rail replaced a coloured word in the card's corner, which means a shape
 * now carries what a sentence used to. A shape is read faster and argued with
 * less, so what it may assert is the thing worth pinning down.
 */
import { describe, expect, it } from 'vitest'
import { ageFrom, ageIsTimeInState, railOf, reachOf } from '../src/web/lib/status.ts'
import type { Agent } from '../src/shared/types.ts'

const base: Agent = {
  sessionId: 'a',
  pid: 1,
  name: 'a',
  cwd: '/x',
  folder: 'x',
  status: 'idle',
  agentKind: 'claude',
  kind: 'interactive',
  startedAt: 1_000,
  paneId: '%1',
}

const agent = (over: Partial<Agent>): Agent => ({ ...base, ...over })

describe('the rail says what the session is doing', () => {
  it('draws the hand only for a status the agent reported itself', () => {
    expect(railOf(agent({ status: 'waiting' })).state).toBe('waiting')
  })

  /*
   * INV-11's sharpest edge. An agent blocked on a permission prompt and one
   * that has finished both sit there emitting nothing, and no timestamp
   * separates them — so a guess wearing the hand would put a fabricated "needs
   * you" beside the real ones, and the whole product rests on that mark being
   * worth walking across the room for. The server has no branch that returns
   * an inferred `waiting`; this is the second lock on the same door.
   */
  it('never draws the hand for a status this app worked out', () => {
    const rail = railOf(agent({ status: 'waiting', statusInferred: true }))
    expect(rail.state).not.toBe('waiting')
    expect(rail.inferred).toBe(true)
  })

  it('marks an inferred working or idle state without hiding it', () => {
    expect(railOf(agent({ status: 'busy', statusInferred: true }))).toMatchObject({
      state: 'working',
      inferred: true,
    })
    expect(railOf(agent({ status: 'idle', statusInferred: true }))).toMatchObject({
      state: 'idle',
      inferred: true,
    })
  })

  /*
   * `delegating` is a field the registry keeps deliberately separate from
   * `status`, and the rail keeps that separation: a modifier on working, never
   * a fifth shape. Both answers mean "nothing for you to do yet".
   */
  it('carries delegation as a modifier on working, not a state', () => {
    expect(railOf(agent({ status: 'busy', delegating: true }))).toMatchObject({
      state: 'working',
      delegated: true,
    })
    expect(railOf(agent({ status: 'idle', delegating: true })).delegated).toBe(false)
  })

  /*
   * A question that cannot be answered from anywhere must not wear the mark
   * that means "you can answer this". The hand is an invitation; with no pane
   * there is no surface to invite anyone to.
   */
  it('lets an unreachable session outrank even a waiting one', () => {
    expect(railOf(agent({ status: 'waiting', paneId: undefined })).state).toBe('gone')
    expect(
      railOf(agent({ status: 'waiting', attachBlockedReason: 'pane exited' })).state,
    ).toBe('gone')
  })
})

describe('reachability is its own channel', () => {
  it('is reachable when there is a pane and nothing blocking it', () => {
    expect(reachOf(agent({}))).toEqual({ reach: 'reachable' })
  })

  it('reports the server’s own reason when it has one', () => {
    expect(reachOf(agent({ attachBlockedReason: 'pane exited' }))).toEqual({
      reach: 'gone',
      reason: 'pane exited',
    })
  })

  it('is gone without a reason when there was never a pane', () => {
    expect(reachOf(agent({ paneId: undefined }))).toEqual({ reach: 'gone' })
  })

  /*
   * The two channels are independent, and this is the case that proves it: a
   * Kiro session is perfectly reachable and its state is still unknowable.
   * Collapsing them would have to call this one or the other.
   */
  it('is independent of what the session is doing', () => {
    const kiro = agent({ status: 'idle', statusInferred: true })
    expect(reachOf(kiro).reach).toBe('reachable')
    expect(railOf(kiro).inferred).toBe(true)
  })
})

describe('the age says how long, and of what', () => {
  it('reads as time-in-state for an agent that reported it is waiting', () => {
    expect(ageIsTimeInState(agent({ status: 'waiting' }))).toBe(true)
  })

  it('does not for a busy agent, where it is just the last thing seen', () => {
    expect(ageIsTimeInState(agent({ status: 'busy' }))).toBe(false)
  })

  /*
   * An inferred status is a claim about a pane going quiet, not about the
   * agent stopping to ask — so "blocked for 14m" is not a sentence this app
   * may write about it.
   */
  it('does not for a status this app worked out', () => {
    expect(ageIsTimeInState(agent({ status: 'waiting', statusInferred: true }))).toBe(false)
  })

  it('has nothing to count from when nothing has been recorded', () => {
    expect(ageFrom(agent({ status: 'waiting' }))).toBeNull()
    expect(ageFrom(agent({ status: 'waiting', lastActivityAt: 5_000 }))).toBe(5_000)
  })
})
