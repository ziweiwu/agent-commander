/**
 * Agents that have been started but have not registered themselves yet.
 *
 * A freshly spawned `claude` does not write its session file until it has
 * finished starting up — and in a directory it has not seen before, it stops on
 * a workspace-trust prompt first. Without this, such an agent is invisible in
 * the fleet, and the prompt blocking it can only be answered from the terminal
 * the user opened this app to avoid. So a spawned session is shown immediately,
 * attachable, until the real record replaces it.
 */
import { basename } from 'node:path'
import { CLAUDE_KIND } from '../shared/agent-kinds.ts'
import type { Agent } from '../shared/types.ts'
import { isMissingTarget, listPanes } from './pane.ts'

/** How long to keep showing a session that never registered before giving up. */
const EXPIRY_MS = 5 * 60_000

export interface PendingSession {
  tmuxSession: string
  cwd: string
  name: string
  startedAt: number
}

/** Injected so tests can drive the two answers apart without a tmux server. */
export interface PendingDeps {
  listPanes: (session: string) => Promise<string[]>
  isMissingTarget: (err: unknown) => boolean
}

const liveDeps: PendingDeps = { listPanes, isMissingTarget }

export class PendingStore {
  #sessions = new Map<string, PendingSession>()

  constructor(private readonly deps: PendingDeps = liveDeps) {}

  add(session: Omit<PendingSession, 'startedAt' | 'name'> & { name?: string }): void {
    this.#sessions.set(session.tmuxSession, {
      tmuxSession: session.tmuxSession,
      cwd: session.cwd,
      name: session.name || basename(session.cwd) || session.tmuxSession,
      startedAt: Date.now(),
    })
  }

  get size(): number {
    return this.#sessions.size
  }

  /**
   * Turn still-unregistered sessions into fleet entries.
   *
   * A pending session is dropped as soon as a real agent reports the same tmux
   * session, when its tmux session is gone, or when it has waited too long to
   * plausibly still be starting.
   */
  async merge(real: Agent[]): Promise<Agent[]> {
    if (this.#sessions.size === 0) return real

    const claimed = new Set(real.map((a) => a.tmuxSession).filter(Boolean))
    const now = Date.now()
    const out: Agent[] = []

    // Snapshot deliberately: entries are deleted inside this loop, and
    // iterating the live map while mutating it is exactly the kind of subtlety
    // worth spending one array allocation to avoid.
    // oxlint-disable-next-line no-useless-spread
    for (const session of [...this.#sessions.values()]) {
      if (claimed.has(session.tmuxSession) || now - session.startedAt > EXPIRY_MS) {
        this.#sessions.delete(session.tmuxSession)
        continue
      }

      /*
       * "Could not ask" is not "it is gone."
       *
       * This used to be a bare `execFile('tmux', …)` that resolved null on any
       * error, and null was read as "the window closed before the agent ever
       * came up" — so the entry was deleted. A `spawn tmux EAGAIN`, which
       * `pane.ts` documents as ordinary on a machine at its process cap, is
       * exactly such an error, and a machine at its process cap is exactly a
       * machine where a new agent takes a while to start. The result was that
       * the agent most in need of being visible — one sitting on a trust
       * prompt it cannot get past — vanished from the fleet instead.
       *
       * Going through `pane.ts` brings the control client and the EAGAIN
       * retry. What is left over is dropped only when tmux positively says the
       * session is not there; anything else keeps the entry, and the expiry
       * above is what stops it living forever.
       */
      let pane: string | undefined
      try {
        pane = (await this.deps.listPanes(session.tmuxSession))[0]
      } catch (err) {
        if (this.deps.isMissingTarget(err)) {
          this.#sessions.delete(session.tmuxSession)
        }
        continue
      }
      if (!pane) {
        // tmux answered, and the session has no panes: the window closed
        // before the agent ever came up.
        this.#sessions.delete(session.tmuxSession)
        continue
      }

      out.push({
        sessionId: `pending:${session.tmuxSession}`,
        pid: 0,
        name: session.name,
        cwd: session.cwd,
        folder: basename(session.cwd) || session.cwd,
        status: 'waiting',
        waitingFor: 'starting up',
        agentKind: CLAUDE_KIND,
        kind: 'interactive',
        startedAt: session.startedAt,
        paneId: pane,
        tmuxSession: session.tmuxSession,
        activity: 'Starting — it may be asking whether this folder is trusted.',
      })
    }

    return [...out, ...real]
  }
}
