import type { Agent } from '../../shared/types.ts'

/**
 * Recognising an agent again after its session id has changed.
 *
 * `/clear` does not edit a session, it replaces one: Claude Code opens a fresh
 * transcript under a new id and rewrites `~/.claude/sessions/<pid>.json` to
 * name it. Nothing else about the agent moves — same process, same pane, same
 * folder — so an id vanishing from the fleet is not, on its own, an agent
 * ending. The button's clear learns the new id from the server's reply; a
 * `/clear` typed into the message box or into the terminal itself is text like
 * any other (INV-2) and reports nothing back. This is how the browser follows
 * those.
 */

/** Enough of an agent to know it again under another id. */
export type Identity = Pick<Agent, 'sessionId' | 'pid' | 'paneId'>

/**
 * What `pending.rs` writes for a session that has not registered itself yet.
 * It is not a process, so it cannot be followed and cannot be a successor.
 */
const PLACEHOLDER_PID = 0

/**
 * The namespace `pending.rs` gives a session it has started and nobody has
 * found yet. Its id is temporary by construction: the placeholder is dropped
 * the moment the real session reports the same tmux session.
 */
export const PENDING_PREFIX = 'pending:'

/** The id a just-started session is listed under until it registers. */
export function placeholderId(tmuxSession: string): string {
  return `${PENDING_PREFIX}${tmuxSession}`
}

/**
 * The real session that has replaced a placeholder, if the fleet lists one.
 *
 * Followed by tmux session rather than by process: a placeholder has no pid to
 * follow, which is why `successorOf` refuses it, and that refusal is what
 * closed a just-started agent the moment it registered. A fast start can also
 * register before the placeholder is ever listed, so this asks the fleet
 * directly instead of waiting to have seen the placeholder first.
 */
export function claimantOf(sessionId: string, agents: readonly Agent[]): Agent | null {
  if (!sessionId.startsWith(PENDING_PREFIX)) return null
  const tmuxSession = sessionId.slice(PENDING_PREFIX.length)
  return (
    agents.find(
      (candidate) =>
        candidate.tmuxSession === tmuxSession && !candidate.sessionId.startsWith(PENDING_PREFIX),
    ) ?? null
  )
}

/**
 * The agent now running where `prior` was, if the fleet lists one.
 *
 * The process is the thread to follow: the id is what changed. The pane is
 * corroboration rather than the key — a kernel reuses pids, tmux does not
 * reuse pane ids for the life of the server — so when both sides name a pane
 * the panes have to agree, and when either does not, the pid decides alone.
 */
export function successorOf(prior: Identity, agents: readonly Agent[]): Agent | null {
  if (prior.pid === PLACEHOLDER_PID) return null
  const heir = agents.find(
    (candidate) =>
      candidate.sessionId !== prior.sessionId &&
      candidate.pid === prior.pid &&
      inTheSamePane(prior, candidate),
  )
  return heir ?? null
}

function inTheSamePane(prior: Identity, candidate: Identity): boolean {
  return !prior.paneId || !candidate.paneId || prior.paneId === candidate.paneId
}
