/**
 * The fleet, from more than one place.
 *
 * `Registry` finds Claude sessions by reading the files Claude Code writes
 * about itself. `TmuxProvider` finds everything else by asking tmux what is
 * running. `CompositeSource` puts the two behind the one `AgentSource` the rest
 * of the server already talks to, so nothing downstream learns that agents now
 * come from two places.
 */
import type { Agent } from '../shared/types.ts'
import { fleetFacts, type PaneFacts } from './pane.ts'
import { Poller } from './poll.ts'
import { sortAgents } from './registry.ts'
import type { AgentSource } from './sources.ts'
import { agentsFromPanes } from './tmux-agents.ts'

const TICK_MS = 3_000

/** Fields worth a broadcast, mirroring `Registry.changed`. */
function changed(before: Agent, after: Agent): boolean {
  return (
    before.status !== after.status ||
    before.name !== after.name ||
    before.cwd !== after.cwd ||
    before.paneId !== after.paneId ||
    before.lastActivityAt !== after.lastActivityAt
  )
}

function differs(prev: Agent[], next: Agent[]): boolean {
  if (prev.length !== next.length) return true
  const byId = new Map(prev.map((a) => [a.sessionId, a]))
  return next.some((a) => {
    const before = byId.get(a.sessionId)
    return !before || changed(before, a)
  })
}

export class TmuxProvider {
  #agents: Agent[] = []
  #listeners = new Set<() => void>()
  #tick: Poller
  #refreshing = false

  constructor(private readonly read: () => Promise<PaneFacts[]> = fleetFacts) {
    this.#tick = new Poller(TICK_MS, () => this.refresh())
  }

  list(): Agent[] {
    return this.#agents
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  async start(): Promise<void> {
    await this.refresh()
    this.#tick.start()
  }

  stop(): void {
    this.#tick.stop()
    this.#listeners.clear()
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) return
    this.#refreshing = true
    try {
      const rows = await this.read()
      const next = agentsFromPanes(rows, Date.now())
      if (differs(this.#agents, next)) {
        this.#agents = next
        for (const fn of this.#listeners) fn()
      } else {
        this.#agents = next
      }
    } catch {
      /*
       * A question that could not be put is not an answer (INV-5). Emptying the
       * fleet because one tmux call failed would blink every agent off the
       * dashboard and, worse, make it look like they had exited.
       */
    } finally {
      this.#refreshing = false
    }
  }
}

/** What `CompositeSource` needs from anything that produces agents. */
export interface AgentProvider {
  list(): Agent[]
  onChange(fn: () => void): () => void
  start(): Promise<void>
  stop(): void
}

export class CompositeSource implements AgentSource {
  #listeners = new Set<(agents: Agent[]) => void>()
  #unsubscribes: Array<() => void> = []
  #patches = new Map<string, Partial<Agent>>()

  constructor(private readonly providers: AgentProvider[]) {}

  list(): Agent[] {
    const out: Agent[] = []
    const claimed = new Set<string>()
    for (const provider of this.providers) {
      for (const agent of provider.list()) {
        /*
         * An earlier provider wins a tmux session outright. Claude is first, and
         * what it says about itself — a real status, a reason for waiting — is
         * always better evidence than what this app can infer from a pane.
         */
        if (agent.tmuxSession && claimed.has(agent.tmuxSession)) continue
        if (agent.tmuxSession) claimed.add(agent.tmuxSession)
        const patch = this.#patches.get(agent.sessionId)
        out.push(patch ? { ...agent, ...patch } : agent)
      }
    }
    return sortAgents(out)
  }

  get(sessionId: string): Agent | undefined {
    return this.list().find((a) => a.sessionId === sessionId)
  }

  enrich(sessionId: string, patch: Partial<Agent>): void {
    this.#patches.set(sessionId, { ...this.#patches.get(sessionId), ...patch })
  }

  notify(): void {
    const agents = this.list()
    for (const fn of this.#listeners) fn(agents)
  }

  onChange(fn: (agents: Agent[]) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  async start(): Promise<void> {
    for (const provider of this.providers) {
      this.#unsubscribes.push(provider.onChange(() => this.notify()))
    }
    // One provider failing to start must not stop the others (INV-5).
    await Promise.allSettled(this.providers.map((p) => p.start()))
  }

  stop(): void {
    for (const off of this.#unsubscribes) off()
    this.#unsubscribes = []
    for (const provider of this.providers) provider.stop()
    this.#listeners.clear()
  }
}
