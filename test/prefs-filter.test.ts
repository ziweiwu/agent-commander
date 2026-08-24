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

/**
 * Sort key and direction share the filter's scope, and for the same reason.
 *
 * They are restored *together* with the filter: "least tokens first, idle only"
 * is one thought. Restoring the filter while resetting the sort left the user
 * in an arrangement they never chose, and the half that survived made the half
 * that did not look deliberate.
 */
describe('sort persistence', () => {
  it('round-trips the sort key through sessionStorage', async () => {
    const { loadSort, saveSort } = await import('../src/web/lib/prefs.ts')
    expect(loadSort()).toBe('recent')
    saveSort('tokens')
    expect(loadSort()).toBe('tokens')
  })

  it('round-trips the direction through sessionStorage', async () => {
    const { loadDir, saveDir } = await import('../src/web/lib/prefs.ts')
    expect(loadDir()).toBe('desc')
    saveDir('asc')
    expect(loadDir()).toBe('asc')
  })

  it('accepts every sort key the UI can actually set', async () => {
    const { loadSort, saveSort } = await import('../src/web/lib/prefs.ts')
    for (const key of ['recent', 'tokens', 'duration', 'name'] as const) {
      saveSort(key)
      expect(loadSort()).toBe(key)
    }
  })

  it('falls back to the defaults for values that are not a sort or a direction', async () => {
    const { loadSort, loadDir } = await import('../src/web/lib/prefs.ts')
    store.set('agent-commander.sort', 'cromulence')
    store.set('agent-commander.dir', 'sideways')
    expect(loadSort()).toBe('recent')
    expect(loadDir()).toBe('desc')
  })

  /* Safari private mode and some embedded webviews throw on access. */
  it('degrades to the defaults when storage is unavailable', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    const { loadSort, saveSort, loadDir, saveDir } = await import('../src/web/lib/prefs.ts')
    expect(() => saveSort('name')).not.toThrow()
    expect(() => saveDir('asc')).not.toThrow()
    expect(loadSort()).toBe('recent')
    expect(loadDir()).toBe('desc')
  })

  it('is what the store initialises from, and what the setters write back', async () => {
    store.set('agent-commander.sort', 'duration')
    store.set('agent-commander.dir', 'asc')
    const { useStore } = await import('../src/web/store/store.ts')
    expect(useStore.getState().fleet.sort).toBe('duration')
    expect(useStore.getState().fleet.dir).toBe('asc')

    useStore.getState().setSort('name')
    useStore.getState().setDir('desc')
    expect(store.get('agent-commander.sort')).toBe('name')
    expect(store.get('agent-commander.dir')).toBe('desc')
  })

  it('restores the whole arrangement, not half of it', async () => {
    store.set('agent-commander.filter', 'idle')
    store.set('agent-commander.sort', 'tokens')
    store.set('agent-commander.dir', 'asc')
    const { useStore } = await import('../src/web/store/store.ts')
    const { filter, sort, dir, query } = useStore.getState().fleet
    expect({ filter, sort, dir }).toEqual({ filter: 'idle', sort: 'tokens', dir: 'asc' })
    // The one thing that must NOT come back: a search term has no visible
    // cause on a fresh load, so it reads as the app hiding agents at random.
    expect(query).toBe('')
  })
})
