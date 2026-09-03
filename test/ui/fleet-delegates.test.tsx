/**
 * Delegates on the fleet card.
 *
 * The forest used to be the only place a delegation tree was drawn, and it was
 * a place you had to go. These are the clauses that have to survive the move
 * onto the card everybody already reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import type { AgentTree, SubagentNode } from '../../src/shared/types.ts'
import { AgentCard } from '../../src/web/components/AgentCard.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(),
  sendKey: vi.fn(),
  sendText: vi.fn(),
  loadEnv: vi.fn(),
  startAgent: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
}))

const node = (over: Partial<SubagentNode> & { agentId: string }): SubagentNode => ({
  agentType: 'general-purpose',
  description: 'sweep the invariants',
  depth: 1,
  lastWriteAt: Date.now() - 60_000,
  bytes: 2048,
  state: 'quiet',
  children: [],
  ...over,
})

const card = (
  over: Parameters<typeof agent>[0],
  tree?: AgentTree,
): ReturnType<typeof renderApp> =>
  renderApp(
    <AgentCard agent={agent(over)} tree={tree} selected={false} onSelect={() => {}} />,
  )

const tree = (children: SubagentNode[], over: Partial<AgentTree> = {}): AgentTree => ({
  sessionId: 'a',
  children,
  ...over,
})

const delegates = (): string => screen.getByTestId('agent-delegates').textContent ?? ''

beforeEach(() => {
  resetStore()
})

describe('INV-13 the card says only what the sidecars support', () => {
  it('claims nothing while the graph has not arrived', () => {
    card({ sessionId: 'a' })
    expect(screen.queryByTestId('agent-delegates')).toBeNull()
  })

  it('says "delegated nothing" and "cannot tell" as different sentences', () => {
    const { unmount } = card({ sessionId: 'a' }, tree([]))
    // On an idle card "delegated nothing" lives in the fold — it is the one
    // claim not worth a glance forty times a day — but it is still a sentence.
    fireEvent.click(screen.getByTestId('details-toggle'))
    const none = delegates()
    unmount()

    card({ sessionId: 'a' }, tree([], { unknown: true }))
    expect(delegates()).not.toBe(none)
    expect(delegates()).toMatch(/cannot tell/i)
  })

  it('rolls the states up without turning quiet into done', () => {
    card(
      { sessionId: 'a' },
      tree([node({ agentId: 'x' }), node({ agentId: 'y', state: 'done' })]),
    )
    expect(delegates()).toContain('1 quiet')
    expect(delegates()).toContain('1 done')
  })

  it('marks an inferred active count as a guess, in words', () => {
    card(
      { sessionId: 'a' },
      tree([node({ agentId: 'x', state: 'active', stateInferred: true })]),
    )
    const active = screen.getByTestId('delegates-active')
    expect(active.textContent).toContain('inferred')
    expect(active.getAttribute('data-inferred')).toBe('true')
  })
})

describe('INV-13 the expanded tree', () => {
  const open = (children: SubagentNode[]): void => {
    card({ sessionId: 'a' }, tree(children))
    fireEvent.click(screen.getByTestId('details-toggle'))
  }

  it('names a quiet delegate quiet rather than done', () => {
    open([node({ agentId: 'x', state: 'quiet' })])
    const state = screen.getByTestId('delegate-state')
    expect(state.textContent).toBe('quiet')
    expect(state.getAttribute('data-inferred')).toBe('false')
    // The attribute the stylesheet colours from, and what an e2e spec reads:
    // it lived on the wrapper for a while, where both silently missed it.
    expect(state.getAttribute('data-state')).toBe('quiet')
  })

  it('says an active delegate is inferred rather than reported', () => {
    open([node({ agentId: 'x', state: 'active', stateInferred: true })])
    expect(screen.getByTestId('delegate-state').textContent).toContain('inferred')
  })

  it('names a stopped delegate rather than calling it finished', () => {
    open([node({ agentId: 'x', state: 'done', stoppedByUser: true })])
    expect(screen.getByTestId('delegate').textContent).toContain('you stopped it')
  })

  it('shows a raised orphan as raised', () => {
    open([node({ agentId: 'x', reparented: true })])
    expect(screen.getByTestId('delegate-orphan').textContent).toMatch(/parent not found/i)
  })

  it('draws a grandchild, not just the top row', () => {
    open([node({ agentId: 'x', children: [node({ agentId: 'y', depth: 2 })] })])
    expect(screen.getAllByTestId('delegate')).toHaveLength(2)
  })

  /*
   * The answer to "quiet, but what did it actually do?". Seven delegates all
   * reading `quiet` say nothing on their own; this is the part that separates
   * thirteen minutes of work from a delegate that died on its first call.
   */
  it('says what the delegate did, beside what became of it', () => {
    open([node({ agentId: 'x', calls: 29, workedMs: 13 * 60_000 })])
    expect(screen.getByTestId('delegate-effort').textContent).toBe('29 calls over 13m')
    // Beside, not instead of: the state is still the state.
    expect(screen.getByTestId('delegate-state').textContent).toBe('quiet')
  })

  it('drops the span when it is too short to name rather than saying 0m', () => {
    open([node({ agentId: 'x', calls: 4, workedMs: 900 })])
    expect(screen.getByTestId('delegate-effort').textContent).toBe('4 calls')
  })

  /*
   * INV-11 at the last inch. The server withholds the numbers when it could not
   * read a transcript, and the row has to withhold them too — a rendered "0
   * calls" would be a confident claim about a delegate that may have done a
   * great deal.
   */
  it('says nothing at all when the transcript could not be read', () => {
    open([node({ agentId: 'x' })])
    expect(screen.queryByTestId('delegate-effort')).toBeNull()
  })

  it('still says zero when zero is what was read', () => {
    open([node({ agentId: 'x', calls: 0, workedMs: 0 })])
    expect(screen.getByTestId('delegate-effort').textContent).toBe('0 calls')
  })

  // There is no total for a transcript size to be a fraction of, so the moment
  // it is drawn somebody has invented one.
  it('draws no transcript size at all', () => {
    open([node({ agentId: 'x', bytes: 999_999 })])
    expect(screen.getByTestId('delegation-tree').textContent).not.toMatch(/\d+\s*(B|KB|MB)/i)
  })

  /*
   * The card is itself a button. A disclosure inside one is not a button — the
   * markup is invalid and a keyboard lands on whichever the browser honours.
   */
  it('keeps the toggle outside the card button', () => {
    card({ sessionId: 'a' }, tree([node({ agentId: 'x' })]))
    expect(screen.getByTestId('agent-card').querySelector('button')).toBeNull()
  })
})

/*
 * A long session's tree is mostly history. While anything is moving, only
 * the moving subtrees are drawn and the rest wait behind a count; while
 * nothing is moving the whole tree is shown, since there is no "current" to
 * prefer and an empty tree standing in for a full one would be a lie.
 */
describe('INV-13 the tree leads with what is moving', () => {
  const open = (children: SubagentNode[]): void => {
    card({ sessionId: 'a', status: 'busy', delegating: true }, tree(children))
    fireEvent.click(screen.getByTestId('details-toggle'))
  }

  it('folds the delegates that are not moving behind a count', () => {
    open([
      node({ agentId: 'x', state: 'active', stateInferred: true }),
      node({ agentId: 'y', state: 'quiet' }),
      node({ agentId: 'z', state: 'done' }),
    ])
    expect(screen.getAllByTestId('delegate')).toHaveLength(1)
    const fold = screen.getByTestId('delegates-show-rest')
    expect(fold.textContent).toMatch(/2 more/)
    fireEvent.click(fold)
    expect(screen.getAllByTestId('delegate')).toHaveLength(3)
    expect(fold.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps a quiet parent whose child is still moving', () => {
    open([
      node({ agentId: 'p', state: 'quiet', children: [node({ agentId: 'c', state: 'active', depth: 2 })] }),
      node({ agentId: 'q', state: 'quiet' }),
    ])
    const shown = screen.getAllByTestId('delegate').map((el) => el.getAttribute('data-state'))
    expect(shown).toEqual(['quiet', 'active'])
    expect(screen.getByTestId('delegates-show-rest').textContent).toMatch(/1 more/)
  })

  it('shows everything when nothing is moving, with no fold to open', () => {
    open([node({ agentId: 'x', state: 'quiet' }), node({ agentId: 'y', state: 'done' })])
    expect(screen.getAllByTestId('delegate')).toHaveLength(2)
    expect(screen.queryByTestId('delegates-show-rest')).toBeNull()
  })
})

describe('INV-15 a silent family is asked about, not pronounced on', () => {
  const quietFamily = tree([node({ agentId: 'x' }), node({ agentId: 'y' })])

  it('asks when the agent and every delegate have gone quiet', () => {
    card(
      { sessionId: 'a', status: 'busy', delegating: true, lastActivityAt: Date.now() - 600_000 },
      quietFamily,
    )
    expect(screen.getByTestId('stall-candidate').textContent).toMatch(/still working\?/)
  })

  it('says the opposite, in the same place, while a delegate is moving', () => {
    card(
      { sessionId: 'a', status: 'busy', delegating: true, lastActivityAt: Date.now() - 600_000 },
      tree([node({ agentId: 'x' }), node({ agentId: 'y', state: 'active', stateInferred: true })]),
    )
    expect(screen.queryByTestId('stall-candidate')).toBeNull()
    expect(screen.getByTestId('delegates-moving').textContent).toMatch(/not a stall/i)
  })

  it('never asks about an agent that is working itself', () => {
    card({ sessionId: 'a', status: 'busy', lastActivityAt: Date.now() - 600_000 }, quietFamily)
    expect(screen.queryByTestId('stall-candidate')).toBeNull()
  })

  // Without a duration there is no question, only an insinuation.
  it('stays silent when it cannot say how long the silence has been', () => {
    card({ sessionId: 'a', status: 'busy', delegating: true }, quietFamily)
    expect(screen.queryByTestId('stall-candidate')).toBeNull()
  })
})

describe('INV-11 the trail is drawn only where it was measured', () => {
  it('draws the split, and names both lengths in words', () => {
    card({ sessionId: 'a', status: 'busy', lastActivityAt: Date.now() - 60_000 })
    expect(screen.getByTestId('agent-trail').getAttribute('aria-label')).toMatch(/silent/i)
  })

  it('draws nothing for an agent with no last write to measure from', () => {
    card({ sessionId: 'a', status: 'busy' })
    expect(screen.queryByTestId('agent-trail')).toBeNull()
  })

  // On an idle card the trail says nothing the timestamp does not, and a
  // shape carrying no new information is noise on the card everybody reads.
  it('draws nothing on a card that is not working', () => {
    card({ sessionId: 'a', status: 'idle', lastActivityAt: Date.now() - 60_000 })
    expect(screen.queryByTestId('agent-trail')).toBeNull()
  })

  /*
   * A pane goes quiet when a TUI stops repainting, not only when the agent
   * stops, so the same field means a weaker thing here — and the trail has no
   * way to draw a weaker claim, only the same shape.
   */
  it('draws nothing for an agent whose CLI writes no transcript', () => {
    card({ sessionId: 'a', agentKind: 'kiro', lastActivityAt: Date.now() - 60_000 })
    expect(screen.queryByTestId('agent-trail')).toBeNull()
  })
})
