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
import type { PendingStore } from './pending.ts'
import { Poller } from './poll.ts'

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions')
const RECONCILE_MS = 30_000
const TICK_MS = 2_000

interface SessionFile {
  pid?: number
  nameSource?: string
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
  // Claude Code records this itself, so the app never has to guess whether a
  // name was chosen or invented.
  if (file.nameSource === 'derived') agent.derivedName = true
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
  #tick: Poller
  #reconcileLoop: Poller
  #listeners = new Set<(agents: Agent[]) => void>()
  #refreshing = false
  #reconciling = false
  #stopped = false
  #known: Set<string> | null = null
  /**
   * Session ids the CLI has not confirmed, that we have already asked about.
   *
   * A session written to disk but absent from `#known` is either brand new or a
   * ghost, and the two are told apart by asking the CLI — which happens on the
   * 30s reconcile. Waiting for it meant an agent started in a terminal stayed
   * invisible for up to half a minute, in an app whose whole claim is that you
   * can see every agent at a glance.
   *
   * So an unrecognised id triggers a reconcile now. This set is what keeps that
   * from becoming a 2s `claude agents --json` loop: a ghost is asked about
   * once, not once per scan. An id leaves the set when the CLI confirms it or
   * when its session file goes away, so a pid genuinely reused later is asked
   * about again.
   */
  #asked = new Set<string>()

  constructor(
    private readonly dir = SESSIONS_DIR,
    private readonly pending?: PendingStore,
  ) {
    this.#tick = new Poller(TICK_MS, () => this.refresh())
    this.#reconcileLoop = new Poller(RECONCILE_MS, () => this.reconcile())
  }

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
    this.#stopped = false
    await this.refresh()
    // Deliberately not awaited: the fleet is already usable from the local file
    // read above, and blocking startup on a ~680ms CLI call would delay the
    // first paint for a cross-check that only removes ghosts. What this used to
    // be missing is the guard inside `reconcile` — without it this pass and the
    // first scheduled one could both be in flight, spawning two
    // `claude agents --json` processes against a machine that may already be at
    // its process cap. INV-4: a poll cannot overlap itself.
    void this.reconcile()
    try {
      this.#watcher = watch(this.dir, () => void this.refresh())
    } catch {
      // fs.watch is unavailable on some filesystems; the tick below covers it.
    }
    // Both loops re-arm after their work rather than on a wall clock; see
    // `Poller`, which is INV-4's "cannot overlap itself or outrun its own
    // cost" written once instead of once per caller.
    this.#tick.start()
    this.#reconcileLoop.start()
  }

  stop(): void {
    this.#stopped = true
    this.#watcher?.close()
    this.#tick.stop()
    this.#reconcileLoop.stop()
    this.#watcher = null
  }

  /**
   * Cross-check presence against the supported CLI, dropping ghosts.
   *
   * Guarded like `refresh`. It was not, and it is the more expensive of the
   * two: one `claude agents --json` per call at ~680ms.
   */
  async reconcile(): Promise<void> {
    if (this.#reconciling) return
    this.#reconciling = true
    try {
      this.#known = await readCliSessionIds()
      if (this.#known) await this.refresh()
    } finally {
      this.#reconciling = false
    }
  }

  /**
   * Whether the CLI has yet to vouch for this session.
   *
   * A pid can be reused, so the CLI is the authority on what is really live.
   * Pending entries are ours rather than the CLI's, and are exempt.
   */
  #unconfirmed(agent: Agent): boolean {
    if (agent.sessionId.startsWith('pending:')) return false
    return !!this.#known && !this.#known.has(agent.sessionId)
  }

  /** Remember an id worth asking about; true if this is the first time. */
  #noteUnconfirmed(sessionId: string): boolean {
    if (this.#asked.has(sessionId)) return false
    this.#asked.add(sessionId)
    return true
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) return
    this.#refreshing = true
    try {
      const real = await readSessionFiles(this.dir)
      // Sessions started from this app appear immediately, before they have
      // registered themselves, so a trust prompt can be answered.
      const found = this.pending ? await this.pending.merge(real) : real
      const next = new Map<string, Agent>()
      const onDisk = new Set<string>(found.map((agent) => agent.sessionId))
      let unrecognised = false
      for (const agent of found) {
        if (this.#unconfirmed(agent)) {
          // Not a ghost yet — just unconfirmed. Ask the authority now rather
          // than at the next 30s reconcile; see `#asked` for why this cannot
          // become a loop.
          unrecognised = this.#noteUnconfirmed(agent.sessionId) || unrecognised
          continue
        }
        this.#asked.delete(agent.sessionId)
        const prev = this.#agents.get(agent.sessionId)
        next.set(agent.sessionId, prev ? { ...prev, ...agent } : agent)
      }
      // A session file that has gone away may come back on a reused pid, and
      // that one deserves a fresh question.
      for (const id of this.#asked) {
        if (!onDisk.has(id)) this.#asked.delete(id)
      }
      // Fired after the map is built, not awaited: this pass publishes what it
      // already knows, and the answer arrives on the reconcile's own refresh.
      if (unrecognised && !this.#stopped) void this.reconcile()
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
