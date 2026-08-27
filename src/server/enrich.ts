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
import { hasTranscripts } from '../shared/agent-kinds.ts'
import type { AgentSource, TailApi } from './sources.ts'
import { Poller } from './poll.ts'

const TICK_MS = 5000

/** Fields the fleet card needs; anything else the tail reports is ignored here. */
const CARD_FIELDS = [
  'activity',
  'lastActivityAt',
  'tokens',
  'subagents',
  'delegating',
  'gitBranch',
  'aiTitle',
  'lastPrompt',
  'permissionMode',
  'model',
  'goal',
] as const

export class FleetEnricher {
  #tails = new Map<string, TailApi>()
  #poller: Poller
  #running = false
  #watched = true

  constructor(
    private readonly source: AgentSource,
    private readonly makeTail: (sessionId: string) => TailApi,
    intervalMs = TICK_MS,
  ) {
    /*
     * A `Poller`, not a `setInterval`.
     *
     * One tick tails every agent's transcript in turn, so its cost is a
     * function of how many agents are running — the one number this app has no
     * say over. On a fixed interval a fleet large enough to overrun 5s did not
     * slow the loop down; it made the `#running` guard drop ticks silently,
     * which is the failure INV-4 names and `pane-hub.ts` exists to have fixed
     * for the pane loop. Re-arming after the work turns that into a cadence
     * that backs itself off and can be reasoned about.
     */
    this.#poller = new Poller(intervalMs, () => this.tick())
  }

  start(): void {
    this.#poller.start(true)
  }

  /**
   * Whether anyone is looking at this.
   *
   * INV-4 opens with "nothing polls what nobody is watching", and this loop was
   * the one place that ignored it: with no browser connected at all it still
   * tailed every transcript on the machine every five seconds, feeding cards
   * nobody was going to see. The fleet list itself keeps refreshing — that is
   * the Registry's job and it is cheap — so what pauses here is only the
   * per-agent transcript read.
   *
   * Turning back on runs a pass immediately, because the tab that just
   * connected is about to paint those cards.
   */
  setWatched(watched: boolean): void {
    if (watched === this.#watched) return
    this.#watched = watched
    if (watched) this.#poller.start(true)
    else this.#poller.stop()
  }

  stop(): void {
    this.#poller.stop()
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
        /*
         * INV-4: never open a tail that cannot resolve. `findTranscript` stats
         * every directory under ~/.claude/projects looking for a file a Kiro
         * session will never have, misses, caches nothing, and would do it
         * again for every such agent every five seconds forever.
         */
        if (!hasTranscripts(agent.agentKind)) continue
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
  return CARD_FIELDS.some((field) => {
    const next = patch[field]
    if (next === undefined) return false
    // `goal` is the one field here that is an object. A fresh parse builds a
    // new one every tick, so identity would report a change on every read and
    // rebroadcast the whole fleet for nothing.
    if (typeof next === 'object') return JSON.stringify(next) !== JSON.stringify(agent[field])
    return next !== agent[field]
  })
}
