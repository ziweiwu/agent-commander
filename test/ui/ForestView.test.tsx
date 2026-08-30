/**
 * The forest's lanes, and what each mark is allowed to say.
 *
 * INV-13 is enforced on the server; this is the other half of it — a state the
 * reader can act on wrongly is one that was drawn wrongly, and the two failures
 * that matter here are a `quiet` mark reading as finished and an inferred
 * `writing` reading as a report. The mark itself is a dot, so everything it
 * claims is carried by `data-state`/`data-inferred` (what the CSS draws) and by
 * `aria-label` (what a screen reader speaks) — both are asserted, because
 * either channel alone can lie while the other tells the truth.
 *
 * One clause of the tree view's version of these tests is deliberately not
 * ported: "labels transcript size as a size". The forest draws no size at all —
 * `Lane` carries no bytes — so there is nothing to caption. The rule survives
 * at the server (`test/subagents.test.ts` pins `bytes` as bytes), and any
 * surface that ever draws it again inherits the clause.
 */
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { ForestView } from '../../src/web/components/ForestView.tsx'
import { buildForest } from '../../src/web/lib/forest.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'
import type { AgentTree, SubagentNode } from '../../src/shared/types.ts'

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

const noop = () => {}

const render = (children: SubagentNode[], over: Partial<AgentTree> = {}) => {
  resetStore()
  const one = agent({ sessionId: 'a', status: 'busy' })
  const tree: AgentTree = { sessionId: 'a', children, ...over }
  return renderApp(
    <ForestView
      families={buildForest([one], [tree])}
      stale={false}
      staleSince={null}
      selected={null}
      onOpen={noop}
    />,
  )
}

/** The delegates' marks only — the session's own mark sits on the depth-0 lane. */
const delegateMarks = () =>
  [...document.querySelectorAll('[data-testid="forest-lane"]')]
    .filter((lane) => lane.getAttribute('data-depth') !== '0')
    .map((lane) => lane.querySelector('[data-testid="forest-mark"]'))

describe("INV-13 what a lane's mark claims", () => {
  /*
   * The failure this exists to stop. An agent that finished and one that died
   * both stop writing, so a quiet mark drawn as done would tell someone their
   * work completed when nothing checked.
   */
  it('never draws a quiet delegate as done', () => {
    render([node({ agentId: 'a1', state: 'quiet' })])

    const mark = delegateMarks()[0]
    expect(mark?.getAttribute('data-state')).toBe('quiet')
    expect(mark?.getAttribute('aria-label')).toMatch(/quiet/)
    expect(mark?.getAttribute('aria-label')).not.toMatch(/done/)
  })

  // A guess and a report must not read as equals — the same rule the fleet
  // card's dashed border enforces for an inferred status.
  it('says in words when an active state was inferred', () => {
    render([node({ agentId: 'a1', state: 'active', stateInferred: true })])

    const mark = delegateMarks()[0]
    expect(mark?.getAttribute('data-inferred')).toBe('true')
    expect(mark?.getAttribute('aria-label')).toMatch(/worked out, not reported/)
  })

  it('does not mark an evidenced done as a guess', () => {
    render([node({ agentId: 'a1', state: 'done' })])

    const mark = delegateMarks()[0]
    expect(mark?.getAttribute('data-inferred')).toBe('false')
    expect(mark?.getAttribute('aria-label')).not.toMatch(/worked out/)
  })

  it('names a stopped delegate rather than calling it finished', () => {
    render([node({ agentId: 'a1', state: 'done', stoppedByUser: true })])

    const mark = delegateMarks()[0]
    expect(mark?.getAttribute('data-state')).toBe('stopped')
    expect(mark?.getAttribute('aria-label')).toMatch(/stopped by the user/)
  })

  it('says when a delegate was raised out of a missing parent', () => {
    render([node({ agentId: 'a1', reparented: true, parentAgentId: 'gone' })])

    expect(screen.getByTestId('forest-orphan').textContent).toMatch(/not on disk/)
  })

  it('keeps a delegate of a delegate under its parent', () => {
    render([
      node({
        agentId: 'a1',
        children: [node({ agentId: 'a2', depth: 2, parentAgentId: 'a1' })],
      }),
    ])

    const depths = [...document.querySelectorAll('[data-testid="forest-lane"]')].map((lane) =>
      lane.getAttribute('data-depth'),
    )
    expect(depths).toEqual(['0', '1', '2'])
  })

  /*
   * Absence of evidence must not read as evidence of absence. "Delegated
   * nothing" is stated by drawing nothing; "cannot tell" is a sentence — the
   * two claims must not collapse into the same empty family (INV-11).
   */
  it("distinguishes 'delegated nothing' from 'cannot tell'", () => {
    const first = render([], { unknown: true })
    expect(screen.getByTestId('forest-unknown').textContent).toMatch(/cannot tell/i)
    first.unmount()

    render([])
    expect(screen.queryByTestId('forest-unknown')).toBeNull()
    // Only the session's own lane: an empty family, not an annotated one.
    expect(screen.getAllByTestId('forest-lane')).toHaveLength(1)
  })
})
