/**
 * OS notifications for agents that have started waiting.
 *
 * INV-14 in one sentence: a notification is a *transition*, not a state. The
 * tab title and the aria-live region describe standing state and may say
 * "(2 blocked)" forever; a notification reaches out of the tab, so it fires
 * only for an agent this page has *watched become* waiting — never for the
 * backlog a fresh page load or the first fleet frame carries, and never a
 * second time while the same agent stays blocked. An agent that unblocks and
 * blocks again is news again.
 *
 * The preference is only half the gate. `Notification.permission` is read at
 * fire time, so revoking it in the browser's site settings wins immediately
 * over anything stored, and a visible tab never notifies — the fleet on screen
 * is already the notification.
 */
import type { Agent } from '../../shared/types.ts'
import { translate, type Lang } from './i18n.ts'
import { withTokenPath } from './token.ts'

/**
 * `null` until the first frame has been seen: everything in that frame is
 * backlog, however long it has been waiting, because this page never saw it
 * become blocked and cannot claim the event happened now.
 */
let seen: Set<string> | null = null

/** Test seam; a page has no reason to call this. */
export function resetBlockedTracking(): void {
  seen = null
}

/**
 * The agents that became waiting since the last frame — and the tracking side
 * effect, which runs on *every* frame regardless of any preference, so turning
 * notifications on later starts from "now" rather than dumping the backlog.
 */
export function freshlyBlocked(agents: Agent[]): Agent[] {
  const blocked = agents.filter((a) => a.status === 'waiting')
  const fresh = seen === null ? [] : blocked.filter((a) => seen !== null && !seen.has(a.sessionId))
  seen = new Set(blocked.map((a) => a.sessionId))
  return fresh
}

interface NotifyEnv {
  enabled: boolean
  lang: Lang
}

export function notifyBlocked(agents: Agent[], env: NotifyEnv): void {
  const fresh = freshlyBlocked(agents)
  if (fresh.length === 0 || !env.enabled) return
  // Feature-checked, not assumed: iOS Safari has no Notification constructor
  // at all outside an installed web app.
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  // A visible tab already shows the waiting group at the top of the screen.
  if (document.visibilityState === 'visible') return

  for (const agent of fresh) {
    try {
      const body = agent.waitingFor
        ? translate(env.lang, 'notifyBody', { reason: agent.waitingFor })
        : translate(env.lang, 'notifyBodyPlain')
      const note = new Notification(agent.name, {
        body,
        // One notification per agent: a re-fire for the same session replaces
        // rather than stacks, so a flapping agent cannot fill the tray.
        tag: `agent-commander:${agent.sessionId}`,
        icon: '/assets/icon-192.png',
      })
      note.onclick = () => {
        window.focus()
        // A full navigation rather than the router: this runs outside React,
        // and the page was hidden anyway — there is no in-progress state on
        // screen for a reload to lose.
        window.location.assign(withTokenPath(`/agent/${encodeURIComponent(agent.sessionId)}`))
      }
    } catch {
      // A refused constructor (browser quirk, permission revoked mid-loop) is
      // a notification that does not appear, not an error worth surfacing.
    }
  }
}
