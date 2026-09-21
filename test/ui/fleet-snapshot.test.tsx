/**
 * INV-11 and INV-3, at the moment a phone opens the app cold.
 *
 * A page iOS evicted repaints from a spinner while the tunnel re-forms, and the
 * last thing it knew is the most useful thing it could show — captioned as a
 * memory, exactly as the stale-fleet rule already does for a frame the page
 * watched go stale. What may be remembered is the fleet's shape: which
 * sessions, what state, where. Nothing an agent said. The token moved out of
 * browser storage for the same reason (INV-3), and a conversation is the thing
 * the token protects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../src/shared/types.ts'
import { loadFleetSnapshot, saveFleetSnapshot } from '../../src/web/lib/prefs.ts'

/** A localStorage the test can read back, in place of jsdom's absent one. */
function stubStorage(): Map<string, string> {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  })
  return store
}

const agent = (over: Partial<Agent> & { sessionId: string }): Agent => ({
  pid: 100,
  name: over.sessionId,
  cwd: '/Users/me/Projects/thing',
  folder: 'thing',
  status: 'busy',
  agentKind: 'claude',
  kind: 'interactive',
  startedAt: 1_700_000_000_000,
  ...over,
})

beforeEach(stubStorage)
afterEach(() => vi.unstubAllGlobals())

describe('the fleet snapshot', () => {
  it('remembers the shape of the fleet and when it was true', () => {
    saveFleetSnapshot(
      [agent({ sessionId: 'a', status: 'waiting', waitingFor: 'dialog open', lastActivityAt: 5 })],
      1234,
    )
    const snap = loadFleetSnapshot()
    expect(snap?.at).toBe(1234)
    expect(snap?.agents[0]).toMatchObject({
      sessionId: 'a',
      status: 'waiting',
      waitingFor: 'dialog open',
      folder: 'thing',
      lastActivityAt: 5,
    })
  })

  it('keeps nothing an agent said (INV-3)', () => {
    saveFleetSnapshot(
      [
        agent({
          sessionId: 'a',
          activity: 'Bash: curl -H "Authorization: Bearer sk-…" https://x.test',
          lastPrompt: 'the user’s own words',
          aiTitle: 'A title made from the conversation',
          goal: { condition: 'secret plan', met: false, at: 1 },
        }),
      ],
      1,
    )
    const raw = localStorage.getItem('agent-commander.fleet') ?? ''
    expect(raw).not.toContain('Bearer')
    expect(raw).not.toContain('own words')
    expect(raw).not.toContain('A title')
    expect(raw).not.toContain('secret plan')
    const [kept] = loadFleetSnapshot()?.agents ?? []
    expect(kept?.activity).toBeUndefined()
    expect(kept?.lastPrompt).toBeUndefined()
  })

  it('forgets an empty fleet rather than painting "no sessions" from memory (INV-11)', () => {
    saveFleetSnapshot([agent({ sessionId: 'a' })], 1)
    saveFleetSnapshot([], 2)
    expect(loadFleetSnapshot()).toBeNull()
  })

  it('reads junk as nothing', () => {
    localStorage.setItem('agent-commander.fleet', '{"agents": "no"}')
    expect(loadFleetSnapshot()).toBeNull()
    localStorage.setItem('agent-commander.fleet', 'not json')
    expect(loadFleetSnapshot()).toBeNull()
  })
})
