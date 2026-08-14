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
