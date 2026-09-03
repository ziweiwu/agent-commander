/**
 * The fleet card's three tiers (FR-CARD-1).
 *
 * The face of a card carries what its group's question needs and nothing
 * else. A card could show nine facts at three type sizes, and on the screen
 * whose whole job is "which agent needs me" every one of them competed with
 * the answer. What a reader asks for but does not scan for — the token count
 * and its caveat, the original session name, the full path, the delegation
 * tree — sits in a fold below the card.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { AgentCard } from '../../src/web/components/AgentCard.tsx'
import type { Agent, AgentTree } from '../../src/shared/types.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

/** Rows on the face of the card: the top line, the activity, the meta line… */
const MAX_FACE_ROWS_AT_REST = 4

const card = (over: Parameters<typeof agent>[0], tree?: AgentTree) =>
  renderApp(
    <AgentCard agent={agent(over)} tree={tree} selected={false} onSelect={() => {}} />,
  )

const face = (): HTMLElement => screen.getByTestId('agent-card')
const rows = (): number => face().children.length

const busyFacts: Partial<Agent> = {
  status: 'busy',
  gitBranch: 'main',
  tokens: 12_400,
  lastActivityAt: Date.now() - 60_000,
  activity: 'Write: src/web/components/AgentCard.tsx',
  name: 'agent-commander-da',
  derivedName: true,
  aiTitle: 'Put the card on a diet',
}

beforeEach(resetStore)

describe('FR-CARD-1 the face of the card is the group’s question', () => {
  it('keeps an idle card to identity, activity and place', () => {
    card({ sessionId: 'a', ...busyFacts, status: 'idle' }, { sessionId: 'a', children: [] })
    expect(rows()).toBeLessThanOrEqual(MAX_FACE_ROWS_AT_REST)
    expect(screen.queryByTestId('agent-tokens')).toBeNull()
    expect(screen.queryByTestId('agent-trail')).toBeNull()
    expect(screen.queryByTestId('agent-delegates')).toBeNull()
    expect(face().textContent).not.toContain('12.4k')
  })

  it('gives a waiting card its verb, and nothing to read past on the way to it', () => {
    card({ sessionId: 'a', ...busyFacts, status: 'waiting', waitingFor: 'dialog open' })
    expect(screen.getByTestId('agent-answer-cta')).toBeTruthy()
    expect(rows()).toBeLessThanOrEqual(MAX_FACE_ROWS_AT_REST)
    expect(screen.queryByTestId('agent-trail')).toBeNull()
  })

  it('withholds the verb from a waiting card that cannot be reached', () => {
    card({ sessionId: 'a', status: 'waiting', waitingFor: 'dialog open', paneId: undefined })
    expect(screen.queryByTestId('agent-answer-cta')).toBeNull()
  })

  it('lets a working card say whether it is still moving', () => {
    card({ sessionId: 'a', ...busyFacts }, { sessionId: 'a', children: [] })
    expect(screen.getByTestId('agent-trail')).toBeTruthy()
    // "delegated nothing" is on the face of a working card: the question
    // there is whether anything under it moves, and "nothing" answers it.
    expect(screen.getByTestId('agent-delegates').dataset.claim).toBe('none')
  })
})

describe('FR-CARD-3 the fold says what a figure is, in words', () => {
  it('folds the token count with its caveat as visible text', () => {
    card({ sessionId: 'a', ...busyFacts })
    fireEvent.click(screen.getByTestId('details-toggle'))
    const tokens = screen.getByTestId('agent-tokens')
    expect(tokens.textContent).toContain('12.4k')
    expect(tokens.textContent).toMatch(/not the session total/i)
  })

  it('folds the original session name behind the title it wrote itself', () => {
    card({ sessionId: 'a', ...busyFacts })
    expect(screen.getByTestId('agent-name').textContent).toBe('Put the card on a diet')
    expect(face().textContent).not.toContain('agent-commander-da')
    fireEvent.click(screen.getByTestId('details-toggle'))
    expect(screen.getByTestId('agent-details').textContent).toContain('agent-commander-da')
  })

  it('keeps the fold outside the card button', () => {
    card({ sessionId: 'a', ...busyFacts })
    expect(face().querySelector('button')).toBeNull()
    expect(screen.getByTestId('details-toggle').getAttribute('aria-expanded')).toBe('false')
  })
})
