import { describe, expect, it } from 'vitest'
import { FleetEnricher } from '../src/server/enrich.ts'
import type { AgentSource, TailApi } from '../src/server/sources.ts'
import type { Agent } from '../src/shared/types.ts'

const agent = (sessionId: string, extra: Partial<Agent> = {}): Agent => ({
  sessionId,
  pid: 1,
  name: sessionId,
  cwd: '/x',
  folder: 'x',
  status: 'idle',
  kind: 'interactive',
  startedAt: 0,
  ...extra,
})

class FakeSource implements AgentSource {
  agents = new Map<string, Agent>()
  notified = 0

  constructor(list: Agent[]) {
    for (const a of list) this.agents.set(a.sessionId, a)
  }

  list(): Agent[] {
    return [...this.agents.values()]
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id)
  }

  onChange(): () => void {
    return () => {}
  }

  enrich(id: string, patch: Partial<Agent>): void {
    const cur = this.agents.get(id)
    if (cur) this.agents.set(id, { ...cur, ...patch })
  }

  notify(): void {
    this.notified += 1
  }

  async start(): Promise<void> {}

  stop(): void {}
}

const settle = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const tailOf = (patch: Partial<Agent>): TailApi => ({
  read: async () => ({ events: [], patch, first: false }),
})

describe('FleetEnricher', () => {
  it('fills the activity line for agents nobody has open', async () => {
    const source = new FakeSource([agent('a'), agent('b')])
    const enricher = new FleetEnricher(source, (id) =>
      tailOf({ activity: `doing ${id}`, tokens: 10, gitBranch: 'main' }),
    )
    await enricher.tick()
    expect(source.get('a')?.activity).toBe('doing a')
    expect(source.get('b')?.activity).toBe('doing b')
    expect(source.get('a')?.gitBranch).toBe('main')
    expect(source.notified).toBe(1)
  })

  // INV-4: an unchanged fleet must not rebroadcast to every browser tab.
  it('INV-4 does not notify when nothing changed', async () => {
    const source = new FakeSource([agent('a', { activity: 'same', tokens: 5 })])
    const enricher = new FleetEnricher(source, () => tailOf({ activity: 'same', tokens: 5 }))
    await enricher.tick()
    expect(source.notified).toBe(0)
  })

  it('ignores a tail that reports nothing new', async () => {
    const source = new FakeSource([agent('a', { activity: 'kept' })])
    const enricher = new FleetEnricher(source, () => tailOf({}))
    await enricher.tick()
    expect(source.get('a')?.activity).toBe('kept')
    expect(source.notified).toBe(0)
  })

  // INV-5: one bad transcript must not stop the others from updating.
  it('INV-5 keeps going when one transcript throws', async () => {
    const source = new FakeSource([agent('bad'), agent('good')])
    const enricher = new FleetEnricher(source, (id) =>
      id === 'bad'
        ? { read: async () => { throw new Error('unreadable') } }
        : tailOf({ activity: 'fine' }),
    )
    await expect(enricher.tick()).resolves.toBeUndefined()
    expect(source.get('good')?.activity).toBe('fine')
  })

  /*
   * INV-4 opens with "nothing polls what nobody is watching", and this was the
   * loop that ignored it: with no browser connected at all it still tailed
   * every transcript on the machine every five seconds, to fill in cards nobody
   * was going to look at. The fleet list itself keeps refreshing — that is the
   * Registry's job and it is a directory of small file reads — so what pauses
   * here is only the per-agent transcript read, which is the expensive part.
   */
  it('INV-4 stops tailing while no browser is connected', async () => {
    let reads = 0
    const source = new FakeSource([agent('a')])
    const enricher = new FleetEnricher(
      source,
      () => ({
        read: async () => {
          reads += 1
          return { events: [], patch: { activity: `v${reads}` }, first: false }
        },
      }),
      10,
    )

    enricher.start()
    await settle(60)
    expect(reads).toBeGreaterThan(2)

    enricher.setWatched(false)
    await settle(20)
    const atPause = reads
    await settle(80)
    expect(reads).toBe(atPause)

    // A tab connecting is about to paint these cards, so it gets a pass now
    // rather than one interval from now.
    enricher.setWatched(true)
    await settle(5)
    expect(reads).toBeGreaterThan(atPause)
    enricher.stop()
  })

  it('INV-4 paces itself by the work rather than by a wall clock', async () => {
    let reads = 0
    const source = new FakeSource([agent('a')])
    const enricher = new FleetEnricher(
      source,
      () => ({
        read: async () => {
          reads += 1
          // A fleet large enough that one pass overruns its own interval.
          await settle(50)
          return { events: [], patch: {}, first: false }
        },
      }),
      10,
    )

    enricher.start()
    await settle(160)
    enricher.stop()

    // On a `setInterval(10)` this would have attempted ~16 passes and dropped
    // most of them against the busy flag, at a rate nobody chose. Re-arming
    // after the work turns that into a cadence set by the work itself.
    expect(reads).toBeLessThanOrEqual(4)
    expect(reads).toBeGreaterThan(1)
  })

  it('drops tails for agents that have exited', async () => {
    const source = new FakeSource([agent('a')])
    let built = 0
    const enricher = new FleetEnricher(source, () => {
      built += 1
      return tailOf({ activity: `v${built}` })
    })
    await enricher.tick()
    expect(built).toBe(1)
    source.agents.delete('a')
    await enricher.tick()
    source.agents.set('a', agent('a'))
    await enricher.tick()
    // A fresh tail, because the old one was pruned when the agent vanished.
    expect(built).toBe(2)
  })
})
