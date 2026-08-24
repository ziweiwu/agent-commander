/**
 * One poll per pane, whatever the cadence and however many tabs.
 *
 * Three properties, each of which was a real cost before:
 *   - two tabs on one agent asked tmux for the same pane twice as often
 *   - a fixed `setInterval` shorter than the work never kept its own schedule
 *   - one failed read stopped the terminal for good
 */
import { describe, expect, it, vi } from 'vitest'
import { PaneHub, BASE_MS, MAX_MS, type HubEvent, type Sample } from '../src/server/pane-hub.ts'
import type { PaneApi } from '../src/server/sources.ts'
import type { PaneMeta } from '../src/server/pane.ts'

const META: PaneMeta = { cols: 80, rows: 3, cursorX: 0, cursorY: 0, alternate: false, dead: false }

/** A pane API whose reads are scripted and counted. */
function fakePanes(script: {
  read?: (n: number) => Sample | Error
  delayMs?: number
}): PaneApi & { reads: number } {
  const api = {
    reads: 0,
    async sample(_paneId: string): Promise<Sample> {
      const n = api.reads
      api.reads += 1
      if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs))
      const out = script.read?.(n) ?? { meta: META, lines: ['a', 'b', 'c'] }
      if (out instanceof Error) throw out
      return out
    },
    async meta(): Promise<PaneMeta> {
      return META
    },
    async capture(): Promise<string[]> {
      return ['a', 'b', 'c']
    },
    async paste(): Promise<void> {},
    async key(): Promise<void> {},
  }
  return api
}

const lines = (text: string): Sample => ({ meta: META, lines: [text, 'b', 'c'] })

/** Wait for real timers to advance past `ms`. */
const tick = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

describe('sharing one read between tabs', () => {
  it('delivers every read to every subscriber', async () => {
    const panes = fakePanes({})
    const hub = new PaneHub(panes)
    const seen: number[] = [0, 0, 0]
    const offs = [0, 1, 2].map((i) =>
      hub.subscribe('%1', (e: HubEvent) => {
        if (e.sample) seen[i] = (seen[i] as number) + 1
      }),
    )

    await tick(BASE_MS * 2.5)
    for (const off of offs) off()

    expect(hub.size).toBe(0)
    expect(panes.reads).toBeGreaterThanOrEqual(2)
    expect(seen[0]).toBe(seen[1])
    expect(seen[1]).toBe(seen[2])
    expect(seen[0]).toBeGreaterThanOrEqual(panes.reads - 1)
  })

  /*
   * The property the whole class exists for, asserted as a *comparison*.
   *
   * An earlier version of this test only checked that all three subscribers
   * saw the same events and that some reads happened — both of which stayed
   * true while the pane was being read three times as often. Subscribing
   * during an in-flight read started a second tick chain, each chain armed its
   * own timer, and nothing cancelled the others, so three viewers cost three
   * times the tmux traffic behind a `size` of 1. Only measuring one count
   * against the other catches that.
   */
  it('costs the same tmux traffic however many subscribers it has', async () => {
    const readsFor = async (subscribers: number): Promise<number> => {
      const panes = fakePanes({ delayMs: 20 })
      const hub = new PaneHub(panes)
      const offs = Array.from({ length: subscribers }, () => hub.subscribe('%1', () => {}))
      await tick(600)
      for (const off of offs) off()
      return panes.reads
    }

    const one = await readsFor(1)
    const three = await readsFor(3)
    expect(one).toBeGreaterThan(1)
    // Allowance for the extra first read each subscriber legitimately triggers
    // by waking the loop as it attaches -- but nothing like a third each.
    expect(three).toBeLessThanOrEqual(one + 2)
  })

  it('gives a tab that joins late the last read at once', async () => {
    // Reads are slow here on purpose: it is the only way to show the first
    // frame came from the cache rather than from a read that happened to be
    // quick. A tab attaching to a pane someone else is already watching must
    // paint from what is already known, not wait out a round trip.
    const panes = fakePanes({ delayMs: 80 })
    const hub = new PaneHub(panes)
    const first = hub.subscribe('%1', () => {})
    await tick(120)

    const events: HubEvent[] = []
    const second = hub.subscribe('%1', (e) => events.push(e))
    await tick(5)
    expect(events).toHaveLength(1)
    expect(events[0]?.sample?.lines).toEqual(['a', 'b', 'c'])

    first()
    second()
  })

  it('stops polling once the last tab leaves', async () => {
    const panes = fakePanes({})
    const hub = new PaneHub(panes)
    const off = hub.subscribe('%1', () => {})
    await tick(BASE_MS * 1.5)
    const atStop = panes.reads
    off()
    await tick(BASE_MS * 3)
    expect(panes.reads).toBe(atStop)
    expect(hub.size).toBe(0)
  })

  it('does not serve a stale capture to the next attach', async () => {
    let content = 'old'
    const panes = fakePanes({ read: () => lines(content) })
    const hub = new PaneHub(panes)
    hub.subscribe('%1', () => {})()
    await tick(20)
    content = 'new'

    const events: HubEvent[] = []
    const off = hub.subscribe('%1', (e) => events.push(e))
    await tick(20)
    off()
    // Nothing survives a full release: what was on screen when the last tab
    // closed is not what this one should be told is current.
    expect(events.every((e) => e.sample?.lines?.[0] === 'new')).toBe(true)
    expect(events.length).toBeGreaterThan(0)
  })
})

describe('cadence', () => {
  it('never starts a read before the previous one finished', async () => {
    let concurrent = 0
    let peak = 0
    const panes = fakePanes({})
    const slow: PaneApi = {
      ...panes,
      async sample(paneId: string) {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await tick(60)
        concurrent -= 1
        return panes.sample!(paneId)
      },
    }
    const hub = new PaneHub(slow)
    const off = hub.subscribe('%1', () => {})
    await tick(500)
    off()
    // The old `setInterval` + `frameBusy` pair dropped ticks to achieve this;
    // re-arming after completion means there is nothing to drop.
    expect(peak).toBe(1)
  })

  it('backs off while a pane is unchanged and snaps back when it moves', async () => {
    let frozen = true
    const panes = fakePanes({ read: () => (frozen ? lines('same') : lines(`n${Date.now()}`)) })
    const hub = new PaneHub(panes)
    const off = hub.subscribe('%1', () => {})

    await tick(700)
    const idleReads = panes.reads
    // Seven reads a second on a pane redrawing nothing is the waste this
    // removes; at BASE_MS it would have been about five in that window.
    expect(idleReads).toBeLessThan(700 / BASE_MS)

    // Left alone, the next read is up to a second away — that is the price of
    // the backoff, and it is paid once. What must not happen is paying it
    // after the user types, so `wake` is what the paste and key routes call.
    frozen = false
    hub.wake('%1')
    await tick(400)
    const busyReads = panes.reads - idleReads
    expect(busyReads).toBeGreaterThan(1)
    off()
  })

  it('stays at full speed for a moment after a wake, even if nothing changed yet', async () => {
    // The echo is not instant. tmux takes the write, and the program in the
    // pane then decides when to redraw -- so the first read after a keystroke
    // routinely finds the pane unchanged. Treating that as "quiet" and backing
    // off is what put a whole extra interval between a keypress and seeing it.
    const panes = fakePanes({ read: () => lines('same') })
    const hub = new PaneHub(panes)
    const off = hub.subscribe('%1', () => {})
    await tick(MAX_MS * 1.5) // let it back off properly
    hub.wake('%1')

    const before = panes.reads
    await tick(BASE_MS * 3)
    const during = panes.reads - before
    // At BASE_MS this is ~3 reads; with the backoff still applying it was 1.
    expect(during).toBeGreaterThanOrEqual(2)
    off()
  })

  it('goes quiet again once the wake window has passed', async () => {
    const panes = fakePanes({ read: () => lines('same') })
    const hub = new PaneHub(panes)
    const off = hub.subscribe('%1', () => {})
    hub.wake('%1')
    await tick(1_400) // past the hot window
    const settled = panes.reads
    await tick(1_200)
    // Back to roughly one read a second, not seven.
    expect(panes.reads - settled).toBeLessThanOrEqual(3)
    off()
  })

  it('reads immediately when woken, rather than waiting out the backoff', async () => {
    const panes = fakePanes({ read: () => lines('same') })
    const hub = new PaneHub(panes)
    const off = hub.subscribe('%1', () => {})
    await tick(MAX_MS * 1.5)
    const beforeWake = panes.reads

    // A keystroke has just gone to this pane. The echo must not wait out an
    // interval that was chosen on the evidence that nothing was happening.
    hub.wake('%1')
    await tick(20)
    expect(panes.reads).toBe(beforeWake + 1)
    off()
  })

  it('never backs off past its ceiling', async () => {
    const panes = fakePanes({ read: () => lines('same') })
    const hub = new PaneHub(panes)
    const off = hub.subscribe('%1', () => {})
    await tick(MAX_MS * 2.5)
    off()
    expect(panes.reads).toBeGreaterThanOrEqual(2)
  })

  it('polls a newly attached tab at full speed even on a quiet pane', async () => {
    const panes = fakePanes({ read: () => lines('same') })
    const hub = new PaneHub(panes)
    const first = hub.subscribe('%1', () => {})
    await tick(MAX_MS)
    const beforeJoin = panes.reads

    const second = hub.subscribe('%1', () => {})
    await tick(BASE_MS * 2)
    // Someone just opened the terminal. Whatever the pane was doing before,
    // they get the fast cadence rather than inheriting a second-long backoff.
    expect(panes.reads - beforeJoin).toBeGreaterThanOrEqual(1)
    first()
    second()
  })
})

describe('failures', () => {
  it('keeps polling after a failed read', async () => {
    const panes = fakePanes({
      read: (n) => (n === 0 ? new Error('spawn tmux EAGAIN') : lines('recovered')),
    })
    const hub = new PaneHub(panes)
    const events: HubEvent[] = []
    const off = hub.subscribe('%1', (e) => events.push(e))
    await tick(BASE_MS * 3)
    off()

    expect(events[0]?.error?.message).toMatch(/EAGAIN/)
    // The read after the failure still happened, which is the whole point: a
    // machine briefly out of process slots is not a terminal that has ended.
    expect(events.some((e) => e.sample?.lines?.[0] === 'recovered')).toBe(true)
  })

  it('reports the error to every subscriber', async () => {
    const panes = fakePanes({ read: () => new Error('nope') })
    const hub = new PaneHub(panes)
    const a: HubEvent[] = []
    const b: HubEvent[] = []
    const offA = hub.subscribe('%1', (e) => a.push(e))
    const offB = hub.subscribe('%1', (e) => b.push(e))
    await tick(BASE_MS * 2)
    offA()
    offB()
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBe(a.length)
  })

  it('does not let one subscriber throwing stop the others', async () => {
    const panes = fakePanes({})
    const hub = new PaneHub(panes)
    const good: HubEvent[] = []
    const offBad = hub.subscribe('%1', () => {
      throw new Error('listener blew up')
    })
    const offGood = hub.subscribe('%1', (e) => good.push(e))
    await tick(BASE_MS * 2)
    offBad()
    offGood()
    expect(good.length).toBeGreaterThan(0)
  })
})

describe('adapters without a combined read', () => {
  it('falls back to meta then capture', async () => {
    const calls: string[] = []
    const api: PaneApi = {
      async meta(): Promise<PaneMeta> {
        calls.push('meta')
        return META
      },
      async capture(): Promise<string[]> {
        calls.push('capture')
        return ['x']
      },
      async paste(): Promise<void> {},
      async key(): Promise<void> {},
    }
    const hub = new PaneHub(api)
    const events: HubEvent[] = []
    const off = hub.subscribe('%1', (e) => events.push(e))
    await tick(30)
    off()
    expect(calls.slice(0, 2)).toEqual(['meta', 'capture'])
    expect(events[0]?.sample?.lines).toEqual(['x'])
  })
})

describe('pane ids stay separate', () => {
  it('runs one loop per pane', async () => {
    const panes = fakePanes({})
    const hub = new PaneHub(panes)
    const offs = [hub.subscribe('%1', () => {}), hub.subscribe('%2', () => {})]
    expect(hub.size).toBe(2)
    await tick(30)
    for (const off of offs) off()
    expect(hub.size).toBe(0)
  })
})

// Timers here are real rather than faked: the loop's whole job is to react to
// how long a read actually took, and a fake clock cannot express that.
vi.setConfig({ testTimeout: 15_000 })

describe('a wake that lands mid-read', () => {
  /*
   * The common case, not an edge one: reads take tens of milliseconds and the
   * loop is rarely idle, so a write very often finishes while a read is
   * already in flight. That read began before the write landed and cannot
   * contain the echo, and there is no timer for `wake` to cancel -- so without
   * handling this it did nothing at all and the echo waited for the next
   * scheduled read. End to end that was a keystroke taking 37ms or 224ms
   * depending purely on where in the cycle it fell.
   */
  it('starts the next read immediately instead of waiting its turn', async () => {
    const panes = fakePanes({ delayMs: 60 })
    const hub = new PaneHub(panes)
    const off = hub.subscribe('%1', () => {})

    await tick(30) // a read is now in flight
    hub.wake('%1')
    const before = panes.reads
    // The in-flight read finishes at ~60ms; the next must follow at once
    // rather than after BASE_MS.
    await tick(110)
    expect(panes.reads).toBeGreaterThan(before)
    off()
  })

  it('does not turn one wake into a permanently faster loop', async () => {
    const panes = fakePanes({ read: () => lines('same') })
    const hub = new PaneHub(panes)
    const off = hub.subscribe('%1', () => {})
    hub.wake('%1')
    await tick(1_400) // past the hot window
    const settled = panes.reads
    await tick(1_000)
    // One catch-up read, not a new cadence.
    expect(panes.reads - settled).toBeLessThanOrEqual(3)
    off()
  })
})

describe('while an echo is expected', () => {
  /*
   * The steady cadence is chosen for a pane redrawing on its own, where a
   * seventh of a second goes unnoticed. It is the wrong cadence for the moment
   * a user is watching for the character they just typed: measured through the
   * browser, the write finished in ~4ms and the frame carrying its echo
   * arrived at ~146ms, all of it this loop waiting out one full BASE_MS after
   * a read that was a fraction too early to see it.
   */
  it('looks far more often than the steady cadence', async () => {
    const panes = fakePanes({ read: () => lines('same') })
    const hub = new PaneHub(panes)
    const off = hub.subscribe('%1', () => {})
    await tick(50)
    const before = panes.reads

    hub.wake('%1') // a keystroke was just written
    await tick(BASE_MS) // one steady interval's worth of time
    // At BASE_MS this window allows about one read. Hurrying, it is several.
    expect(panes.reads - before).toBeGreaterThan(3)
    off()
  })

  it('stops hurrying as soon as the redraw arrives', async () => {
    let content = 'before'
    const panes = fakePanes({ read: () => lines(content) })
    const hub = new PaneHub(panes)
    const off = hub.subscribe('%1', () => {})
    await tick(50)

    hub.wake('%1')
    content = 'after' // the echo lands on the very next read
    await tick(60)
    const afterEcho = panes.reads
    await tick(BASE_MS)
    // Back to the steady cadence rather than 40Hz for the rest of the second:
    // the thing it was hurrying for has been seen.
    expect(panes.reads - afterEcho).toBeLessThanOrEqual(3)
    off()
  })
})
