/**
 * What a fleet card is allowed to say about an agent's delegates.
 *
 * The server already reads the tree honestly (`test/subagents.test.ts`); this
 * is the second half, where the tree is compressed to one line and the
 * distinctions have every opportunity to be lost.
 */
import { describe, expect, it } from 'vitest'
import type { Agent, AgentTree, SubagentNode } from '../src/shared/types.ts'
import { claimOf, flatten, isGuess, isStallCandidate } from '../src/web/lib/delegation.ts'
import { agent as makeAgent } from './helpers/agent.ts'

const node = (over: Partial<SubagentNode> & { agentId: string }): SubagentNode => ({
  agentType: 'general-purpose',
  description: 'do the thing',
  depth: 1,
  lastWriteAt: Date.now(),
  bytes: 1024,
  state: 'quiet',
  children: [],
  ...over,
})

const tree = (children: SubagentNode[], over: Partial<AgentTree> = {}): AgentTree => ({
  sessionId: 's1',
  children,
  ...over,
})

const delegating = (over: Partial<Agent> = {}): Agent =>
  makeAgent({ sessionId: 's1', status: 'busy', delegating: true, ...over })

describe('INV-13 the four claims a card can make about delegates', () => {
  it('says nothing at all before the graph has arrived', () => {
    expect(claimOf(undefined)).toEqual({ kind: 'unread' })
  })

  // The whole point. An empty tree from a CLI that writes no sidecars is not
  // the same answer as an empty tree from one that does.
  it('separates "delegated nothing" from "cannot tell"', () => {
    expect(claimOf(tree([])).kind).toBe('none')
    expect(claimOf(tree([], { unknown: true })).kind).toBe('unknown')
  })

  it('counts every depth, not just the top row', () => {
    const claim = claimOf(
      tree([
        node({
          agentId: 'a',
          state: 'active',
          stateInferred: true,
          children: [node({ agentId: 'b', depth: 2, state: 'quiet' })],
        }),
      ]),
    )
    expect(claim).toMatchObject({ kind: 'some', total: 2, active: 1, quiet: 1, deepest: 2 })
  })

  it('never rolls a quiet delegate up as done', () => {
    const claim = claimOf(tree([node({ agentId: 'a', state: 'quiet' })]))
    expect(claim).toMatchObject({ kind: 'some', quiet: 1, done: 0 })
  })

  it('counts a raised orphan rather than dropping it and its subtree', () => {
    const claim = claimOf(
      tree([
        node({
          agentId: 'a',
          reparented: true,
          children: [node({ agentId: 'b', depth: 3 })],
        }),
      ]),
    )
    expect(claim).toMatchObject({ kind: 'some', total: 2, orphans: 1 })
  })

  it('visits parents before children when flattening', () => {
    const nodes = flatten([node({ agentId: 'a', children: [node({ agentId: 'b' })] })])
    expect(nodes.map((each) => each.agentId)).toEqual(['a', 'b'])
  })
})

describe('INV-13 a guess is marked, and done is never one', () => {
  it('marks an inferred active delegate', () => {
    expect(isGuess(node({ agentId: 'a', state: 'active', stateInferred: true }))).toBe(true)
  })

  /*
   * `done` is the state a reader acts on — it is what makes them stop checking
   * — so it must not be reachable from an inference however the field arrives.
   * This is the rule, not a description of today's server.
   */
  it('refuses to call a done delegate a guess even when the flag says so', () => {
    expect(isGuess(node({ agentId: 'a', state: 'done', stateInferred: true }))).toBe(false)
  })

  // Quiet is the honest answer, not a weaker one. Marking it as inferred would
  // imply a better reading exists.
  it('does not mark quiet as a guess', () => {
    expect(isGuess(node({ agentId: 'a', state: 'quiet', stateInferred: true }))).toBe(false)
  })

  it('counts the guesses separately from the actives', () => {
    const claim = claimOf(
      tree([
        node({ agentId: 'a', state: 'active', stateInferred: true }),
        node({ agentId: 'b', state: 'active' }),
      ]),
    )
    expect(claim).toMatchObject({ kind: 'some', active: 2, guesses: 1 })
  })
})

describe('INV-15 a silent family is a question, never a verdict', () => {
  it('asks about a delegating agent whose delegates have all gone quiet', () => {
    const claim = claimOf(tree([node({ agentId: 'a' }), node({ agentId: 'b' })]))
    expect(isStallCandidate(delegating(), claim)).toBe(true)
  })

  // One delegate still moving is enough. It is only ever a guess that it is
  // moving, but a guess that work continues is the safe direction to err in:
  // the cost is a question nobody was asked, not a stall nobody noticed.
  it('stays silent while any delegate is called active', () => {
    const claim = claimOf(
      tree([
        node({ agentId: 'a' }),
        node({ agentId: 'b', state: 'active', stateInferred: true }),
      ]),
    )
    expect(isStallCandidate(delegating(), claim)).toBe(false)
  })

  it('never asks about an agent that is working itself', () => {
    const claim = claimOf(tree([node({ agentId: 'a' })]))
    expect(isStallCandidate(makeAgent({ sessionId: 's1', status: 'busy' }), claim)).toBe(false)
  })

  // Absence of a tree is not evidence of a silent one, and neither is a CLI
  // that keeps no sidecars. Both would be a question asked on nothing.
  it('never asks on an unread or unknown tree', () => {
    expect(isStallCandidate(delegating(), { kind: 'unread' })).toBe(false)
    expect(isStallCandidate(delegating(), { kind: 'unknown' })).toBe(false)
    expect(isStallCandidate(delegating(), { kind: 'none' })).toBe(false)
  })
})
