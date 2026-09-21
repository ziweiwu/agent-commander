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
      railOf(agent({ status: 'waiting', paneId: undefined, attachBlockedReason: 'pane exited' }))
        .state,
    ).toBe('gone')
  })
})

describe('reachability is its own channel', () => {
  it('is reachable when there is a pane and nothing blocking it', () => {
    expect(reachOf(agent({}))).toEqual({ reach: 'reachable' })
  })

  it('reports the server’s own reason when it has one', () => {
    expect(reachOf(agent({ paneId: undefined, attachBlockedReason: 'pane exited' }))).toEqual({
      reach: 'gone',
      reason: 'pane exited',
    })
  })

  /*
   * The pair is mutually exclusive on the wire and `overlay` keeps it that way
   * — but it did not always, and an agent first seen before its pane existed
   * used to carry both for ever. The pane id is the concrete fact and the
   * reason only explains its absence, so the pane wins: a rail reading
   * "unreachable" beside a live Answer button is worse than either alone.
   */
  it('lets a pane win over a stale reason there was none', () => {
    const both = agent({ paneId: '%1', attachBlockedReason: 'session is not running inside tmux' })
    expect(reachOf(both)).toEqual({ reach: 'reachable' })
    expect(railOf({ ...both, status: 'waiting' }).state).toBe('waiting')
  })

  it('is gone without a reason when there was never a pane', () => {
    expect(reachOf(agent({ paneId: undefined }))).toEqual({ reach: 'gone' })
  })

  /*
   * The two channels are independent, and this is the case that proves it: a
   * terminal is perfectly reachable and its state is still unknowable.
   * Collapsing them would have to call this one or the other.
   */
  it('is independent of what the session is doing', () => {
    const shell = agent({ status: 'idle', statusInferred: true })
    expect(reachOf(shell).reach).toBe('reachable')
    expect(railOf(shell).inferred).toBe(true)
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

/*
 * A pane id says a *reference* exists, not that anything is behind it.
 *
 * The registry sets that field from whether the session file's tmux reference
 * parses and never revisits it, so an agent whose pane has since exited keeps
 * it. Only the Attach tab consulted the server's `pane-exited` report, so the
 * card went on showing "terminal reachable" beside its own line reading
 * `idle · exited` — INV-11 defines reachability as whether this app can still
 * send anything there, and for a dead pane that is false.
 */
describe('a pane that has exited is not reachable', () => {
  const gone = agent({ sessionId: 'dead', status: 'idle', paneId: '%9' })

  it('is reachable while nothing has said otherwise', () => {
    expect(reachOf(gone, []).reach).toBe('reachable')
  })

  it('is gone once the server has reported the exit', () => {
    expect(reachOf(gone, ['dead']).reach).toBe('gone')
    expect(railOf(gone, ['dead']).state).toBe('gone')
  })

  it('does not confuse it with another session that exited', () => {
    expect(reachOf(gone, ['someone-else']).reach).toBe('reachable')
  })

  /*
   * And it outranks even a question: a dialog on a pane that has gone cannot
   * be answered from here or from the terminal, so the hand — the one mark
   * worth crossing the room for — must not be drawn over it.
   */
  it('outranks a waiting status, as an unreachable session always does', () => {
    const waiting = agent({ sessionId: 'dead', status: 'waiting', paneId: '%9' })
    expect(railOf(waiting, ['dead']).state).toBe('gone')
  })
})
