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
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import type { Agent } from '../shared/types.ts'

/** How long to keep showing a session that never registered before giving up. */
const EXPIRY_MS = 5 * 60_000

export interface PendingSession {
  tmuxSession: string
  cwd: string
  name: string
  startedAt: number
}

function tmux(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('tmux', args, { timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout))
  })
}

export class PendingStore {
  #sessions = new Map<string, PendingSession>()

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

      const pane = (await tmux(['list-panes', '-t', session.tmuxSession, '-F', '#{pane_id}']))
        ?.trim()
        .split('\n')[0]
      if (!pane) {
        // The window closed before the agent ever came up.
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
