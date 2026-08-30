/**
 * The delegation tree, and what each row is allowed to say.
 *
 * INV-13 is enforced on the server; this is the other half of it — a state the
 * reader can act on wrongly is one that was drawn wrongly, and the two failures
 * that matter here are a `quiet` node reading as finished and an inferred
 * `active` reading as a report.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { TreeRoot } from '../../src/web/components/TreeView.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'
import type { AgentTree, SubagentNode } from '../../src/shared/types.ts'

vi.mock('../../src/web/store/transport.ts', () => ({ fetchTree: vi.fn() }))

const node = (over: Partial<SubagentNode> & Pick<SubagentNode, 'agentId'>): SubagentNode => ({
  agentType: 'general-purpose',
  description: 'do the thing',
  depth: 1,
  lastWriteAt: Date.now() - 5_000,
  bytes: 40_000,
  state: 'quiet',
  children: [],
  ...over,
})

const tree = (children: SubagentNode[], over: Partial<AgentTree> = {}): AgentTree => ({
  sessionId: 'a',
  children,
  ...over,
})

const render = (children: SubagentNode[], over: Partial<AgentTree> = {}) => {
  resetStore()
  return renderApp(
    <TreeRoot agent={agent({ sessionId: 'a', status: 'busy' })} tree={tree(children, over)} />,
  )
}

describe('what a node claims', () => {
  /*
   * The failure this exists to stop. An agent that finished and one that died
   * both stop writing, so a quiet node drawn as done would tell someone their
   * work completed when nothing checked.
   */
  it('does not render a quiet delegate as done', () => {
    render([node({ agentId: 'a1', state: 'quiet' })])

    const chip = screen.getByTestId('tree-state')
    expect(chip.getAttribute('data-state')).toBe('quiet')
    expect(chip.textContent).not.toMatch(/done/i)
  })

  // A guess and a report must not read as equals — the same rule, and the same
  // dashed-edge device, the fleet card uses for an inferred status.
  it('says so in words when an active state was inferred', () => {
    render([node({ agentId: 'a1', state: 'active', stateInferred: true })])

    const chip = screen.getByTestId('tree-state')
    expect(chip.getAttribute('data-inferred')).toBe('true')
    expect(chip.textContent).toMatch(/inferred/i)
  })

  it('does not mark an evidenced done as inferred', () => {
    render([node({ agentId: 'a1', state: 'done' })])

    const chip = screen.getByTestId('tree-state')
    expect(chip.getAttribute('data-inferred')).toBe('false')
    expect(chip.textContent).not.toMatch(/inferred/i)
  })

  it('names a delegate the user stopped rather than calling it finished', () => {
    render([node({ agentId: 'a1', state: 'done', stoppedByUser: true })])

    expect(screen.getByTestId('tree-state').textContent).toMatch(/stopped by you/i)
  })

  /*
   * Captioned as a size and never as a percentage: nothing here knows what
   * "all of it" would be. INV-11 caught the same mistake with `tokens`, which
   * was shown as spend and sorted as "most spent".
   */
  it('labels transcript size as a size', () => {
    render([node({ agentId: 'a1', bytes: 188_000 })])

    expect(screen.getByTestId('tree-node').textContent).toMatch(/188 KB/)
    expect(screen.getByTestId('tree-node').textContent).not.toMatch(/%/)
  })

  it('says when a delegate was raised out of a missing parent', () => {
    render([node({ agentId: 'a1', reparented: true, parentAgentId: 'gone' })])

    expect(screen.getByTestId('tree-reparented')).toBeTruthy()
  })

  it('nests a delegate of a delegate', () => {
    render([
      node({
        agentId: 'a1',
        children: [node({ agentId: 'a2', depth: 2, parentAgentId: 'a1' })],
      }),
    ])

    expect(screen.getAllByTestId('tree-node')).toHaveLength(2)
  })
})

describe('an agent with nothing under it', () => {
  it('says it has delegated nothing', () => {
    render([])
    expect(screen.getByTestId('tree-empty').textContent).toMatch(/has not delegated/i)
  })

  /*
   * Absence of evidence, and it must not read as evidence of absence. The
   * sidecars are written by Claude Code, so for another CLI there is nothing to
   * read and "delegated nothing" is a claim nobody could make (INV-11).
   */
  it('says it cannot tell, for a CLI that keeps no transcript', () => {
    resetStore()
    renderApp(
      <TreeRoot
        agent={agent({ sessionId: 'a', agentKind: 'kiro' })}
        tree={tree([], { unknown: true })}
      />,
    )

    expect(screen.getByTestId('tree-empty').textContent).toMatch(/cannot tell/i)
  })
})
