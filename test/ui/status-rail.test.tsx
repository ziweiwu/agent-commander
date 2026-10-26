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
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { AgentCard } from '../../src/web/components/AgentCard.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

const card = (over: Parameters<typeof agent>[0]) =>
  renderApp(<AgentCard agent={agent(over)} selected={false} onSelect={() => {}} />)

const rail = () => screen.getByTestId('agent-rail')
const entry = () => screen.getByTestId('agent-entry')

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

  /**
   * The same, for a pane id that is still on the wire after the server said
   * the pane had exited. The verb used to check only for an id, so "Answer →"
   * was drawn beside the struck ring of a terminal that is not there.
   */
  it('offers no Answer verb for a waiting agent whose pane has exited', () => {
    useStore.setState({ exited: ['a'] })
    card({ sessionId: 'a', status: 'waiting', waitingFor: 'dialog open', paneId: '%1' })
    expect(rail().dataset.state).toBe('gone')
    expect(screen.queryByTestId('agent-answer-cta')).toBeNull()
  })

  it('offers it beside the hand of a waiting agent it can reach', () => {
    card({ sessionId: 'a', status: 'waiting', waitingFor: 'dialog open', paneId: '%1' })
    expect(rail().dataset.state).toBe('waiting')
    expect(screen.getByTestId('agent-answer-cta')).toBeTruthy()
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
    card({ sessionId: 'a', status: 'idle', paneId: undefined, attachBlockedReason: 'pane exited' })
    const mark = screen.getByTestId('agent-reach')
    expect(mark.dataset.reach).toBe('gone')
    expect(mark.getAttribute('title')).toBe('pane exited')
    expect(mark.textContent).toContain('pane exited')
  })

  /*
   * The two channels are independent, and a terminal proves it: perfectly
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

/*
 * The card is a button, and its name is what a screen reader hears before
 * anything else on the row.
 *
 * It used to be whatever its text concatenated to. The context line separates
 * its parts with a `::after` middot and generated content is in the
 * accessibility tree, so the name arrived as "waiting · dialog open· Bash: rm
 * -rf dist· ~/Projects/lego-deals· terminal reachable" — every fact worth
 * having, in an order nobody would choose, with the separators read out.
 */
describe('what the card calls itself', () => {
  it('names itself by agent, state and place, and not by its own punctuation', () => {
    card({
      sessionId: 'a',
      name: 'rebuild-dist',
      status: 'waiting',
      waitingFor: 'dialog open',
      cwd: '/Users/demo/Projects/lego-deals',
      paneId: '%1',
    })
    const label = screen.getByTestId('agent-card').getAttribute('aria-label') ?? ''
    expect(label).toContain('rebuild-dist')
    expect(label).toContain('~/Projects/lego-deals')
    expect(label).toMatch(/waiting/)
    // The reach mark's own words belong to the mark, not to the card's name.
    expect(label).not.toMatch(/terminal reachable/)
  })
})

/**
 * A waiting card is the one tinted surface on the fleet, and every waiting mark
 * on it follows the rail rather than `data-status`.
 *
 * The status says what the agent reported; the rail says what the reader can
 * do about it, and a pane that has exited outranks the question (INV-11). The
 * stripe was keyed on `data-status`, so a waiting agent whose pane had gone
 * kept an amber edge and amber words beside a struck red ring.
 */
describe('INV-11 the waiting surface is keyed on the rail', () => {
  /** A CSS comment, written as a string so no scanner reads its opening as one. */
  const CSS_COMMENT = new RegExp('/\\*[\\s\\S]*?\\*/', 'g')
  const sheet = readFileSync('src/web/components/AgentCard.module.css', 'utf8').replace(CSS_COMMENT, '')
  const rules = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector = '', body = '']) => ({
    selectors: selector.split(/,(?![^(]*\))/).map((part) => part.trim()),
    body,
  }))
  const PAINTS_WAITING = /var\(--(?:waiting|wash-waiting|edge-waiting|tint-waiting)\)/

  /** What may paint in the waiting colours without the rail's say-so, and why. */
  const OFF_THE_RAIL: Record<string, string> = {
    ".rail[data-state='waiting']": 'the rail glyph, keyed on the rail’s own state',
    '.stall': 'INV-15’s question, in the fold of a working card; never on a waiting face',
    '.cta': 'drawn only when the rail is waiting; the DOM tests above hold that',
  }

  it('marks the entry with its rail state', () => {
    card({ sessionId: 'a', status: 'waiting', waitingFor: 'dialog open', paneId: '%1' })
    expect(entry().dataset.rail).toBe('waiting')
  })

  it('gives a waiting agent whose pane has exited no wash, no amber and no verb', () => {
    useStore.setState({ exited: ['a'] })
    card({ sessionId: 'a', status: 'waiting', waitingFor: 'dialog open', paneId: '%1' })
    expect(entry().dataset.rail).toBe('gone')
    expect(screen.getByTestId('agent-card').dataset.status).toBe('waiting')
    expect(screen.queryByTestId('agent-answer-cta')).toBeNull()
    expect(screen.getByTestId('agent-status').textContent).toMatch(/waiting/)
  })

  it('draws the wash only on a waiting rail, on the card and its toggle', () => {
    const washed = rules.filter((rule) => rule.body.includes('var(--wash-waiting)'))
    expect(washed.map((rule) => rule.selectors)).toEqual([
      [".wrap[data-rail='waiting'] > :is(.card, .disclosure)"],
    ])
  })

  it('paints nothing amber from data-status, only from the rail', () => {
    const offRail = rules
      .filter((rule) => PAINTS_WAITING.test(rule.body))
      .flatMap((rule) => rule.selectors)
      .filter((selector) => !selector.includes("[data-rail='waiting']"))
      .filter((selector) => OFF_THE_RAIL[selector] === undefined)
    expect(offRail, 'key a waiting mark on .wrap[data-rail], or say here why it may not be').toEqual(
      [],
    )
  })
})
