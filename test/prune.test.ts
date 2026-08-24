/**
 * Which sessions count as unused.
 *
 * The predicate decides what a button offers to close, so its job is to be
 * *narrow*: every case below that returns false is a session someone might
 * still want, and being wrong about one of those destroys work. Being wrong the
 * other way only means an empty shell stays in the list.
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '../src/shared/types.ts'
import { isUnused, unusedAgents } from '../src/web/lib/filter.ts'

const agent = (over: Partial<Agent> & { sessionId: string }): Agent => ({
  pid: 100,
  name: over.sessionId,
  cwd: '/Users/me/Projects/thing',
  folder: 'thing',
  status: 'idle',
  kind: 'interactive',
  startedAt: 1_700_000_000_000,
  paneId: '%77',
  ...over,
})

describe('isUnused', () => {
  it('accepts an idle session that was never prompted', () => {
    expect(isUnused(agent({ sessionId: 'fresh' }))).toBe(true)
  })

  // Each of these is the single piece of evidence that it was used at all.
  it.each([
    ['an activity line', { activity: 'Edit: src/app.ts' }],
    ['a last-activity clock', { lastActivityAt: 1_700_000_000_000 }],
    ['token spend', { tokens: 12 }],
    ['a title it generated', { aiTitle: 'Fix the parser' }],
    ['a prompt it was given', { lastPrompt: 'run the tests' }],
  ])('refuses a session with %s', (_label, over) => {
    expect(isUnused(agent({ sessionId: 'used', ...over }))).toBe(false)
  })

  it('refuses a busy session, however empty it looks', () => {
    expect(isUnused(agent({ sessionId: 'working', status: 'busy' }))).toBe(false)
  })

  // A waiting agent is asking a question, which is the opposite of unused.
  it('refuses a waiting session', () => {
    expect(isUnused(agent({ sessionId: 'blocked', status: 'waiting' }))).toBe(false)
  })

  /*
   * `unknown` means the status field was missing or unrecognised. That is an
   * absence of evidence, not evidence of idleness, and it must not be read as
   * permission to close the session.
   */
  it('refuses a session whose status is unknown', () => {
    expect(isUnused(agent({ sessionId: 'mystery', status: 'unknown' }))).toBe(false)
  })

  // Delegated work leaves the parent's own transcript silent — the exact shape
  // an unused session has, which is why it is checked separately.
  it('refuses a session that has handed work to a subagent', () => {
    expect(isUnused(agent({ sessionId: 'parent', delegating: true }))).toBe(false)
  })

  /*
   * Closing is `/exit` typed into a pane. Without one there is nothing to type
   * into, so offering to prune it would promise something that cannot happen.
   */
  it('refuses a session with no pane, which it could not close anyway', () => {
    expect(isUnused(agent({ sessionId: 'detached', paneId: undefined }))).toBe(false)
  })
})

describe('unusedAgents', () => {
  it('selects only the unused ones and keeps the given order', () => {
    const fleet = [
      agent({ sessionId: 'a' }),
      agent({ sessionId: 'b', tokens: 900 }),
      agent({ sessionId: 'c' }),
      agent({ sessionId: 'd', status: 'busy' }),
    ]
    expect(unusedAgents(fleet).map((a) => a.sessionId)).toEqual(['a', 'c'])
  })

  it('finds nothing in a fleet that is all working', () => {
    expect(unusedAgents([agent({ sessionId: 'a', status: 'busy', tokens: 5 })])).toEqual([])
  })
})
