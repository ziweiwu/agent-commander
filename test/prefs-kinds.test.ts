import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The fleet's kind scope was once an on/off terminals toggle under the same
 * key; a saved choice must survive the upgrade to the three-way scope.
 */
const store = new Map<string, string>()
const KEY = 'agent-commander.terminals'

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('kind scope persistence', () => {
  it.each([
    ['on', 'all'],
    ['off', 'claude'],
    ['garbage', 'claude'],
    ['terminals', 'terminals'],
  ])('reads a stored %s as %s', async (stored, expected) => {
    const { loadKinds } = await import('../src/web/lib/prefs.ts')
    store.set(KEY, stored)
    expect(loadKinds()).toBe(expected)
  })

  it('round-trips every scope', async () => {
    const { loadKinds, saveKinds } = await import('../src/web/lib/prefs.ts')
    const { KIND_SCOPES } = await import('../src/web/lib/filter.ts')
    for (const scope of KIND_SCOPES) {
      saveKinds(scope)
      expect(loadKinds()).toBe(scope)
    }
  })
})
