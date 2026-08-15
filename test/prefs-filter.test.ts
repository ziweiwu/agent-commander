import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The status filter survives a reload but not a new tab.
 *
 * sessionStorage rather than localStorage is the whole point: a filter is a
 * statement about the task in front of you, not about you. Persisting it
 * forever would mean a tab opened next week to check the whole fleet silently
 * shows only "needs you", with the reason days in the past.
 */
const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('filter persistence', () => {
  it('round-trips through sessionStorage', async () => {
    const { loadFilter, saveFilter } = await import('../src/web/lib/prefs.ts')
    expect(loadFilter()).toBe('all')
    saveFilter('waiting')
    expect(loadFilter()).toBe('waiting')
  })

  it('falls back to "all" for a value that is not a filter', async () => {
    const { loadFilter } = await import('../src/web/lib/prefs.ts')
    store.set('agent-commander.filter', 'everything')
    expect(loadFilter()).toBe('all')
  })

  it('accepts every filter the UI can actually set', async () => {
    const { loadFilter, saveFilter } = await import('../src/web/lib/prefs.ts')
    for (const key of ['all', 'waiting', 'busy', 'idle'] as const) {
      saveFilter(key)
      expect(loadFilter()).toBe(key)
    }
  })

  /* Safari private mode and some embedded webviews throw on access. */
  it('degrades to "all" when storage is unavailable', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    const { loadFilter, saveFilter } = await import('../src/web/lib/prefs.ts')
    expect(() => saveFilter('busy')).not.toThrow()
    expect(loadFilter()).toBe('all')
  })

  it('is what the store initialises from, and what setFilter writes back', async () => {
    store.set('agent-commander.filter', 'busy')
    const { useStore } = await import('../src/web/store/store.ts')
    expect(useStore.getState().fleet.filter).toBe('busy')

    useStore.getState().setFilter('idle')
    expect(store.get('agent-commander.filter')).toBe('idle')
  })
})
