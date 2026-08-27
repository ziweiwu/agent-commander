import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The status filter outlives the browser, not just the tab.
 *
 * localStorage rather than sessionStorage is the whole point: a view chosen
 * once should not have to be chosen again tomorrow morning. It was the other
 * way round, guarding against a tab opened next week silently showing only
 * "needs you" — but the active chip carries a glyph as well as a fill, so an
 * already-filtered dashboard reads as filtered rather than as an empty fleet.
 */
const store = new Map<string, string>()

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

describe('filter persistence', () => {
  it('round-trips through localStorage', async () => {
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
    vi.stubGlobal('localStorage', {
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

  /*
   * The distinguishing test, and the reason this file changed: sessionStorage
   * dies with the browsing session, so a filter kept there is gone the next
   * time the browser is opened. Asserting the value lands in localStorage *and
   * not* in sessionStorage is what stops a future refactor quietly restoring
   * the old scope while every round-trip test above still passes.
   */
  it('writes where quitting the browser cannot reach, not to the session', async () => {
    const session = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
    })
    const { saveFilter, saveSort, saveDir } = await import('../src/web/lib/prefs.ts')

    saveFilter('waiting')
    saveSort('tokens')
    saveDir('asc')

    expect(store.get('agent-commander.filter')).toBe('waiting')
    expect(store.get('agent-commander.sort')).toBe('tokens')
    expect(store.get('agent-commander.dir')).toBe('asc')
    expect(session.size).toBe(0)
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
 * Sort key and direction share the filter's storage, and for the same reason.
 *
 * They are restored *together* with the filter: "least tokens first, idle only"
 * is one thought. Restoring the filter while resetting the sort left the user
 * in an arrangement they never chose, and the half that survived made the half
 * that did not look deliberate.
 */
describe('sort persistence', () => {
  it('round-trips the sort key through localStorage', async () => {
    const { loadSort, saveSort } = await import('../src/web/lib/prefs.ts')
    expect(loadSort()).toBe('recent')
    saveSort('tokens')
    expect(loadSort()).toBe('tokens')
  })

  it('round-trips the direction through localStorage', async () => {
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
    vi.stubGlobal('localStorage', {
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

/**
 * Searching for what is written on the card.
 *
 * The card wears a `Kiro` badge, and typing `kiro` returned "Nothing matches
 * that filter". A search that cannot find a word the user is looking straight
 * at is the plainest kind of broken, whatever the field list says.
 */
describe('free-text search covers the agent kind', () => {
  const kiro = {
    sessionId: 'tmux:kiro-1',
    pid: 1,
    name: 'folio',
    cwd: '/x/folio',
    folder: 'folio',
    status: 'idle' as const,
    agentKind: 'kiro',
    kind: 'interactive',
    startedAt: 0,
  }

  it('matches the kind id and its label, either case', async () => {
    const { matches } = await import('../src/web/lib/format.ts')
    for (const query of ['kiro', 'Kiro', 'KIRO']) {
      expect(matches(kiro, query)).toBe(true)
    }
  })

  it('does not sweep in every other agent', async () => {
    const { matches } = await import('../src/web/lib/format.ts')
    expect(matches({ ...kiro, agentKind: 'claude', folder: 'other' }, 'kiro')).toBe(false)
  })

  it('still finds a Claude agent by its kind', async () => {
    const { matches } = await import('../src/web/lib/format.ts')
    expect(matches({ ...kiro, agentKind: 'claude' }, 'claude')).toBe(true)
  })
})
