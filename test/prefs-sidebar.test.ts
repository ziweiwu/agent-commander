import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The fleet column's width and state outlive the browser.
 *
 * Collapsing it trades the agents' names for work surface, and expanding it
 * trades back — a deliberate choice either way, which is exactly the kind a
 * reload must not silently undo. The status filter persists for the same
 * reason, and this follows that idiom rather than inventing one.
 *
 * The width is bounded at both ends and clamped on the way *out* of storage as
 * well as in. That is the half worth testing: the bounds can move between
 * releases, so a value an older one wrote must not be honoured past them, and
 * a hand-edited or half-written entry must fall back rather than resolve to
 * zero and leave someone with no column and no obvious way back.
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

describe('sidebar persistence', () => {
  it('starts expanded, because names are why anyone keeps a fleet column', async () => {
    const { loadSidebar } = await import('../src/web/lib/prefs.ts')
    expect(loadSidebar()).toBe('expanded')
  })

  it('round-trips both states through localStorage', async () => {
    const { loadSidebar, saveSidebar } = await import('../src/web/lib/prefs.ts')
    saveSidebar('collapsed')
    expect(loadSidebar()).toBe('collapsed')
    saveSidebar('expanded')
    expect(loadSidebar()).toBe('expanded')
  })

  it('treats anything that is not "collapsed" as expanded', async () => {
    const { loadSidebar } = await import('../src/web/lib/prefs.ts')
    store.set('agent-commander.sidebar', 'rail')
    // An icon rail was built and rejected; a stored value naming it must not
    // resolve to a state this app no longer has.
    expect(loadSidebar()).toBe('expanded')
  })

  it("defaults to Claude Desktop's own 288", async () => {
    const { loadSidebarWidth, SIDEBAR_WIDTH_DEFAULT } = await import('../src/web/lib/prefs.ts')
    expect(SIDEBAR_WIDTH_DEFAULT).toBe(288)
    expect(loadSidebarWidth()).toBe(288)
  })

  it('round-trips a width', async () => {
    const { loadSidebarWidth, saveSidebarWidth } = await import('../src/web/lib/prefs.ts')
    saveSidebarWidth(320)
    expect(loadSidebarWidth()).toBe(320)
  })

  it('clamps a width to the bounds on the way in and on the way out', async () => {
    const { clampSidebarWidth, loadSidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX } =
      await import('../src/web/lib/prefs.ts')
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_WIDTH_MIN)
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_WIDTH_MAX)
    // Written by a release whose bounds were wider: read back inside ours.
    store.set('agent-commander.sidebar-width', '1200')
    expect(loadSidebarWidth()).toBe(SIDEBAR_WIDTH_MAX)
  })

  it('can still reach exactly the width the column used to be', async () => {
    const { SIDEBAR_WIDTH_MAX } = await import('../src/web/lib/prefs.ts')
    // The old track was `minmax(340px, 430px)` less a ~15px scrollbar gutter,
    // so nobody who liked that width loses it by widening back to the maximum.
    expect(SIDEBAR_WIDTH_MAX).toBeGreaterThanOrEqual(415)
  })

  it('falls back to the default for a width that is not a number', async () => {
    const { loadSidebarWidth, SIDEBAR_WIDTH_DEFAULT } = await import('../src/web/lib/prefs.ts')
    for (const junk of ['', 'wide', 'NaN', '-40', '0']) {
      store.set('agent-commander.sidebar-width', junk)
      expect(loadSidebarWidth()).toBe(SIDEBAR_WIDTH_DEFAULT)
    }
  })

  it('rounds a fractional width rather than writing it out', async () => {
    const { loadSidebarWidth, saveSidebarWidth } = await import('../src/web/lib/prefs.ts')
    // A drag reports fractional pixels; a grid track does not need them.
    saveSidebarWidth(300.6)
    expect(loadSidebarWidth()).toBe(301)
  })

  it('survives a localStorage that throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('Safari private mode')
      },
      setItem: () => {
        throw new Error('Safari private mode')
      },
    })
    const { loadSidebar, loadSidebarWidth, saveSidebar, saveSidebarWidth, SIDEBAR_WIDTH_DEFAULT } =
      await import('../src/web/lib/prefs.ts')
    expect(() => saveSidebar('collapsed')).not.toThrow()
    expect(() => saveSidebarWidth(300)).not.toThrow()
    expect(loadSidebar()).toBe('expanded')
    expect(loadSidebarWidth()).toBe(SIDEBAR_WIDTH_DEFAULT)
  })
})
