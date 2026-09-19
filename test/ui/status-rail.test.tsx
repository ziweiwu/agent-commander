/**
 * The status rail: which agents need the reader, said in one column of shapes.
 *
 * The card used to answer this with a coloured word in its top-right corner —
 * eight cards, eight reads, at eight different x positions, with hue doing the
 * work a shape should. The rail is a fixed gutter down the fleet, so the
 * question is answered by position before it is answered by reading.
 *
 * `test/status.test.ts` holds what the rail may *claim*, without a DOM. This
 * holds that the card draws it, and — the part that matters — that the words
 * are still there underneath for anyone the shapes do not reach.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { AgentCard } from '../../src/web/components/AgentCard.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'

const card = (over: Parameters<typeof agent>[0]) =>
  renderApp(<AgentCard agent={agent(over)} selected={false} onSelect={() => {}} />)

const rail = () => screen.getByTestId('agent-rail')

beforeEach(resetStore)

describe('the rail draws one shape per state', () => {
  it('raises a hand for an agent that reported itself waiting', () => {
    card({ sessionId: 'a', status: 'waiting', waitingFor: 'dialog open', paneId: '%1' })
    expect(rail().dataset.state).toBe('waiting')
  })

  it('sweeps an arc for a working agent', () => {
    card({ sessionId: 'a', status: 'busy', paneId: '%1' })
    expect(rail().dataset.state).toBe('working')
  })

  it('draws a plain ring for an idle one', () => {
    card({ sessionId: 'b', status: 'idle', paneId: '%1' })
    expect(rail().dataset.state).toBe('idle')
  })

  /*
   * INV-11's sharpest edge, drawn. An agent blocked on a permission prompt and
   * one that has finished both sit there emitting nothing, and no timestamp
   * separates them — so a hand over a guess would put a fabricated "needs you"
   * beside the real ones, and the whole product rests on that mark being worth
   * crossing the room for.
   */
  it('never raises a hand for a status this app worked out', () => {
    card({ sessionId: 'a', status: 'waiting', statusInferred: true, paneId: '%1' })
    expect(rail().dataset.state).not.toBe('waiting')
    expect(rail().dataset.inferred).toBe('true')
  })

  it('marks an inferred state rather than hiding or promoting it', () => {
    card({ sessionId: 'a', status: 'busy', statusInferred: true, paneId: '%1' })
    expect(rail().dataset.state).toBe('working')
    expect(rail().dataset.inferred).toBe('true')
  })

  /*
   * A question that can be answered from nowhere must not wear the mark that
   * means "you can answer this". The hand is an invitation; with no pane there
   * is no surface to invite anyone to — which is also why the card withholds
   * its verb in the same case.
   */
  it('strikes the ring for a session whose pane is gone, even a waiting one', () => {
    card({ sessionId: 'a', status: 'waiting', waitingFor: 'dialog open', paneId: undefined })
    expect(rail().dataset.state).toBe('gone')
    expect(screen.queryByTestId('agent-answer-cta')).toBeNull()
  })
})

describe('the rail is a second channel, never the only one', () => {
  /*
   * The icon set's contract: `Icon` is always `aria-hidden`, so a shape can
   * never be the accessible name. Everything the rail says, the status text
   * beside it says in words — which is what a screen reader, and anyone who
   * has not learned five shapes, actually reads.
   */
  it('says nothing a screen reader cannot get from the words beside it', () => {
    card({ sessionId: 'a', status: 'waiting', waitingFor: 'dialog open', paneId: '%1' })
    expect(rail().getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByTestId('agent-status').textContent).toMatch(/waiting/)
  })
})

describe('reachability is its own channel', () => {
  it('marks a session whose pane this app can drive', () => {
    card({ sessionId: 'a', status: 'idle', paneId: '%1' })
    expect(screen.getByTestId('agent-reach').dataset.reach).toBe('reachable')
  })

  it('strikes the mark for one it cannot', () => {
    card({ sessionId: 'b', status: 'idle', paneId: undefined })
    expect(screen.getByTestId('agent-reach').dataset.reach).toBe('gone')
  })

  /*
   * `attachBlockedReason` is the server's own words for why it cannot drive
   * that pane, and it has never had anywhere to live: it is not a status, and
   * squeezing it into one was what conflated "what is it doing" with "can I
   * reach it". The reach mark is where it goes.
   */
  it('carries the server’s reason rather than inventing one', () => {
    card({ sessionId: 'a', status: 'idle', paneId: '%1', attachBlockedReason: 'pane exited' })
    const mark = screen.getByTestId('agent-reach')
    expect(mark.dataset.reach).toBe('gone')
    expect(mark.getAttribute('title')).toBe('pane exited')
    expect(mark.textContent).toContain('pane exited')
  })

  /*
   * The two channels are independent, and a Kiro session proves it: perfectly
   * reachable, and its state still unknowable. A single scale would have to
   * call this one or the other.
   */
  it('stays independent of the state beside it', () => {
    card({ sessionId: 'a', status: 'idle', statusInferred: true, paneId: '%1' })
    expect(screen.getByTestId('agent-reach').dataset.reach).toBe('reachable')
    expect(rail().dataset.inferred).toBe('true')
  })
})

describe('the age says how long, and of what', () => {
  it('reads as time blocked for an agent waiting on the reader', () => {
    card({
      sessionId: 'a',
      status: 'waiting',
      waitingFor: 'dialog open',
      paneId: '%1',
      lastActivityAt: Date.now() - 60_000,
    })
    expect(screen.getByTestId('agent-age').dataset.since).toBe('state')
  })

  it('reads as time since for anything else', () => {
    card({ sessionId: 'a', status: 'busy', paneId: '%1', lastActivityAt: Date.now() - 60_000 })
    expect(screen.getByTestId('agent-age').dataset.since).toBe('activity')
  })
})
