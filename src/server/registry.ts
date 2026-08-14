/**
 * Discovers the Claude Code sessions running on this machine.
 *
 * Two sources, deliberately:
 *   - `~/.claude/sessions/<pid>.json` is the fast path. It is read on a short
 *     tick because it is a local file read (sub-millisecond) and it carries the
 *     `tmux` pane id, which the supported CLI does not expose.
 *   - `claude agents --json` is authoritative for *presence*, but costs ~680ms
 *     per call, so it only runs as a periodic reconcile (INV-4).
 *
 * INV-5: the session file is an internal format. If it disappears or changes
 * shape, agents still list — they just lose the attach capability.
 */
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Agent, AgentStatus } from '../shared/types.ts'

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions')
const RECONCILE_MS = 30_000
const TICK_MS = 2_000

interface SessionFile {
  pid?: number
  sessionId?: string
  cwd?: string
  startedAt?: number
  version?: string
  kind?: string
  tmux?: string
  name?: string
  status?: string
  updatedAt?: number
  waitingFor?: string
}

function toStatus(raw: unknown): AgentStatus {
  return raw === 'busy' || raw === 'idle' || raw === 'waiting' ? raw : 'unknown'
}

/** `claude-1786666491:@65.%77` -> session name and pane id. */
export function parseTmuxRef(ref: string | undefined): { session?: string; pane?: string } {
  if (!ref) return {}
  const colon = ref.indexOf(':')
  if (colon < 0) return {}
  const session = ref.slice(0, colon)
  const dot = ref.lastIndexOf('.')
  if (dot < colon) return { session }
  const pane = ref.slice(dot + 1)
  return /^%\d+$/.test(pane) ? { session, pane } : { session }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function toAgent(file: SessionFile): Agent | null {
  if (!file.sessionId || typeof file.pid !== 'number' || !file.cwd) return null
  const { session, pane } = parseTmuxRef(file.tmux)
  const agent: Agent = {
    sessionId: file.sessionId,
    pid: file.pid,
    name: file.name || `pid ${file.pid}`,
    cwd: file.cwd,
    folder: basename(file.cwd) || file.cwd,
    status: toStatus(file.status),
    kind: file.kind || 'interactive',
    startedAt: file.startedAt ?? 0,
  }
  if (file.version) agent.version = file.version
  if (file.waitingFor) agent.waitingFor = file.waitingFor
  if (session) agent.tmuxSession = session
  if (pane) {
    agent.paneId = pane
  } else {
    agent.attachBlockedReason = file.tmux
      ? 'tmux pane id could not be parsed'
      : 'session is not running inside tmux'
  }
  return agent
}

/** Read every session record, keeping only those whose process is still alive. */
export async function readSessionFiles(dir = SESSIONS_DIR): Promise<Agent[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const agents: Agent[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await readFile(join(dir, name), 'utf8')
      const parsed = JSON.parse(raw) as SessionFile
      const agent = toAgent(parsed)
      if (agent && isAlive(agent.pid)) agents.push(agent)
    } catch {
      // A malformed or half-written record must not take down the fleet (INV-5).
    }
  }
  return agents
}

/** The supported presence check. Returns null if the CLI is unavailable. */
export async function readCliSessionIds(): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    execFile(
      'claude',
      ['agents', '--json'],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        try {
          const rows = JSON.parse(stdout) as Array<{ sessionId?: string }>
          resolve(new Set(rows.map((r) => r.sessionId).filter((s): s is string => !!s)))
        } catch {
          resolve(null)
        }
      },
    )
  })
}

export function sortAgents(agents: Agent[]): Agent[] {
  const rank: Record<AgentStatus, number> = { waiting: 0, busy: 1, idle: 2, unknown: 3 }
  return [...agents].sort(
    (a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name),
  )
}

export class Registry {
  #agents = new Map<string, Agent>()
  #watcher: FSWatcher | null = null
  #tick: NodeJS.Timeout | null = null
  #reconcile: NodeJS.Timeout | null = null
  #listeners = new Set<(agents: Agent[]) => void>()
  #refreshing = false
  #known: Set<string> | null = null

  constructor(private readonly dir = SESSIONS_DIR) {}

  list(): Agent[] {
    return sortAgents([...this.#agents.values()])
  }

  get(sessionId: string): Agent | undefined {
    return this.#agents.get(sessionId)
  }

  onChange(fn: (agents: Agent[]) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  /** Push the current list to listeners after out-of-band enrichment. */
  notify(): void {
    const list = this.list()
    for (const fn of this.#listeners) fn(list)
  }

  /** Merge transcript-derived detail onto an agent without a full refresh. */
  enrich(sessionId: string, patch: Partial<Agent>): void {
    const current = this.#agents.get(sessionId)
    if (!current) return
    this.#agents.set(sessionId, { ...current, ...patch })
  }

  async start(): Promise<void> {
    await this.refresh()
    void this.reconcile()
    try {
      this.#watcher = watch(this.dir, () => void this.refresh())
    } catch {
      // fs.watch is unavailable on some filesystems; the tick below covers it.
    }
    this.#tick = setInterval(() => void this.refresh(), TICK_MS)
    this.#reconcile = setInterval(() => void this.reconcile(), RECONCILE_MS)
  }

  stop(): void {
    this.#watcher?.close()
    if (this.#tick) clearInterval(this.#tick)
    if (this.#reconcile) clearInterval(this.#reconcile)
    this.#watcher = null
    this.#tick = null
    this.#reconcile = null
  }

  /** Cross-check presence against the supported CLI, dropping ghosts. */
  async reconcile(): Promise<void> {
    this.#known = await readCliSessionIds()
    if (this.#known) await this.refresh()
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) return
    this.#refreshing = true
    try {
      const found = await readSessionFiles(this.dir)
      const next = new Map<string, Agent>()
      for (const agent of found) {
        // A pid can be reused; the CLI is the authority on what is really live.
        if (this.#known && !this.#known.has(agent.sessionId)) continue
        const prev = this.#agents.get(agent.sessionId)
        next.set(agent.sessionId, prev ? { ...prev, ...agent } : agent)
      }
      if (!changed(this.#agents, next)) return
      this.#agents = next
      const list = this.list()
      for (const fn of this.#listeners) fn(list)
    } finally {
      this.#refreshing = false
    }
  }
}

function changed(a: Map<string, Agent>, b: Map<string, Agent>): boolean {
  if (a.size !== b.size) return true
  for (const [id, agent] of b) {
    const prev = a.get(id)
    if (!prev) return true
    if (
      prev.status !== agent.status ||
      prev.name !== agent.name ||
      prev.cwd !== agent.cwd ||
      prev.waitingFor !== agent.waitingFor ||
      prev.paneId !== agent.paneId
    ) {
      return true
    }
  }
  return false
}
