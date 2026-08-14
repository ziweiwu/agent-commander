/**
 * Keeps every fleet card's "what is it doing" line current.
 *
 * The detail view tails only the agent you have open. Without this, every other
 * card would sit blank — which is the opposite of the point, since the whole
 * value of the list is seeing what agents you are *not* looking at are doing.
 *
 * INV-4: this runs on a slow tick and each read is an incremental byte-offset
 * tail, so the steady-state cost is a few hundred bytes per agent per cycle.
 */
import type { Agent } from '../shared/types.ts'
import type { AgentSource, TailApi } from './sources.ts'

const TICK_MS = 5000

/** Fields the fleet card needs; anything else the tail reports is ignored here. */
const CARD_FIELDS = ['activity', 'lastActivityAt', 'tokens', 'subagents', 'gitBranch'] as const

export class FleetEnricher {
  #tails = new Map<string, TailApi>()
  #timer: NodeJS.Timeout | null = null
  #running = false

  constructor(
    private readonly source: AgentSource,
    private readonly makeTail: (sessionId: string) => TailApi,
    private readonly intervalMs = TICK_MS,
  ) {}

  start(): void {
    void this.tick()
    this.#timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.#tails.clear()
  }

  async tick(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      const agents = this.source.list()
      const live = new Set(agents.map((a) => a.sessionId))
      for (const id of this.#tails.keys()) {
        if (!live.has(id)) this.#tails.delete(id)
      }

      let changed = false
      for (const agent of agents) {
        let tail = this.#tails.get(agent.sessionId)
        if (!tail) {
          tail = this.makeTail(agent.sessionId)
          this.#tails.set(agent.sessionId, tail)
        }
        try {
          const { patch } = await tail.read()
          const card = pickCardFields(patch)
          if (card && differs(agent, card)) {
            this.source.enrich(agent.sessionId, card)
            changed = true
          }
        } catch {
          // INV-5: one unreadable transcript must not stall the other agents.
        }
      }
      if (changed) this.source.notify?.()
    } finally {
      this.#running = false
    }
  }
}

function pickCardFields(patch: Partial<Agent>): Partial<Agent> | null {
  const out: Partial<Agent> = {}
  let any = false
  for (const field of CARD_FIELDS) {
    const value = patch[field]
    if (value !== undefined) {
      Object.assign(out, { [field]: value })
      any = true
    }
  }
  return any ? out : null
}

function differs(agent: Agent, patch: Partial<Agent>): boolean {
  return CARD_FIELDS.some((field) => patch[field] !== undefined && patch[field] !== agent[field])
}
