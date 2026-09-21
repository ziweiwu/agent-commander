/**
 * INV-11: the one figure on a card with a real denominator.
 *
 * `tokens` is output only, from a capped tail, and was once shown as spend.
 * Context-window usage is Claude Code's own reading over its own
 * `context_window_size`, and cost is the CLI's own estimate — so both may be
 * shown as what they are, captioned with when they were read, and the
 * percentage may even reach the face, but only where it says something a
 * glance wants: that the session is about to compact.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { AgentCard } from '../../src/web/components/AgentCard.tsx'
import { CONTEXT_WARN_PCT } from '../../src/web/lib/format.ts'
import type { Agent } from '../../src/shared/types.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

const card = (over: Partial<Agent> & { sessionId: string }) =>
  renderApp(<AgentCard agent={agent(over)} selected={false} onSelect={() => {}} />)

const face = (): HTMLElement => screen.getByTestId('agent-card')

beforeEach(resetStore)

describe('INV-11 context and cost are shown as what they are', () => {
  it('folds the percentage with its denominator and when it was read', () => {
    card({
      sessionId: 'a',
      status: 'busy',
      usage: { contextPct: 42.4, contextSize: 200_000, costUsd: 1.234, at: Date.now() - 120_000 },
    })
    expect(screen.queryByTestId('agent-context')).toBeNull()
    expect(face().textContent).not.toContain('42')
    fireEvent.click(screen.getByTestId('details-toggle'))
    const context = screen.getByTestId('agent-context-fact')
    expect(context.textContent).toContain('42%')
    expect(context.textContent).toContain('200.0k')
    expect(context.textContent).toMatch(/as Claude Code reported it/)
    const cost = screen.getByTestId('agent-cost')
    expect(cost.textContent).toContain('$1.23')
    expect(cost.textContent).toMatch(/estimate at list price/)
  })

  it('reaches the face only once the window is close to compacting', () => {
    card({
      sessionId: 'a',
      status: 'busy',
      usage: { contextPct: CONTEXT_WARN_PCT + 11, at: Date.now() },
    })
    const mark = screen.getByTestId('agent-context')
    expect(mark.textContent).toContain('91%')
    // Words, not a colour: the mark is text on the line (INV-13).
    expect(mark.textContent).toMatch(/context/i)
  })

  it('says nothing where the bridge has written nothing', () => {
    card({ sessionId: 'a', status: 'busy', tokens: 12_400 })
    expect(screen.queryByTestId('agent-context')).toBeNull()
    fireEvent.click(screen.getByTestId('details-toggle'))
    expect(screen.queryByTestId('agent-context-fact')).toBeNull()
    expect(screen.queryByTestId('agent-cost')).toBeNull()
  })

  it('shows a cost under a cent as under a cent rather than as zero', () => {
    card({ sessionId: 'a', status: 'idle', usage: { costUsd: 0.004, at: Date.now() } })
    fireEvent.click(screen.getByTestId('details-toggle'))
    expect(screen.getByTestId('agent-cost').textContent).toContain('<$0.01')
  })
})
