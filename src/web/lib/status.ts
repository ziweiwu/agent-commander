/**
 * What the status rail says about a session, and what it refuses to say.
 *
 * The fleet card used to answer "which agent needs me" with a coloured word in
 * the top-right corner — eight cards, eight reads, and the colour doing the
 * work that the shape should. The rail is one fixed gutter down the left of
 * every row, so the question is answered before the names are in focus.
 *
 * This module is the pure half, here rather than in the component for the
 * reason `delegation.ts` and `trail.ts` are: what a card may *claim* is the
 * part worth testing without a DOM.
 *
 * **Two channels, and they never mix.** `railOf` says what the session is
 * doing; `reachOf` says whether this app can still drive it. They are different
 * facts with different evidence — an agent can be perfectly reachable and
 * unknowable (a CLI that reports nothing), or blocked on you and unreachable
 * (its pane is gone). Collapsing them is what made `attachBlockedReason`
 * homeless: it is not a status, and it never was.
 */
import type { Agent } from '../../shared/types.ts'

/** The four shapes the rail can draw. `hand` is the fifth, and is `waiting`. */
export type RailState = 'working' | 'waiting' | 'idle' | 'gone'

export interface Rail {
  state: RailState
  /**
   * The state was worked out here rather than reported (INV-11).
   *
   * Drawn as a dashed ring, the same device the status pill has always used
   * for an inferred claim. Never true for `waiting`: see below.
   */
  inferred: boolean
  /**
   * Handed its work to delegates and is doing nothing itself.
   *
   * A modifier on `working`, not a state of its own. "It is working" and "its
   * delegates are working and it is not" are different answers to "should I
   * wait?", but they are both *not* something you have to act on — and the
   * registry keeps `delegating` deliberately separate from `status`, which
   * this preserves rather than fights.
   */
  delegated: boolean
}

/**
 * What the rail draws for this agent.
 *
 * **`gone` outranks everything, including `waiting`.** A session blocked on a
 * question whose pane has exited cannot be answered from here or from the
 * terminal, and drawing the hand over it would be an invitation to a surface
 * that no longer exists — the one mark in this app that is supposed to be
 * worth crossing the room for.
 *
 * **An inferred status is never `waiting`**, and that is guaranteed upstream
 * rather than here: `tmux_agents.rs` has no branch that returns it
 * (`inv11_an_inferred_status_is_never_waiting`). The assertion below is a
 * second lock on the same door, because this is the one place a future writer
 * could hand the rail a fabricated hand.
 */
export function railOf(agent: Agent, exited: readonly string[] = []): Rail {
  const inferred = agent.statusInferred === true
  if (reachOf(agent, exited).reach === 'gone') {
    return { state: 'gone', inferred, delegated: false }
  }
  if (agent.status === 'waiting' && !inferred) {
    return { state: 'waiting', inferred: false, delegated: false }
  }
  if (agent.status === 'busy') {
    return { state: 'working', inferred, delegated: agent.delegating === true }
  }
  return { state: 'idle', inferred, delegated: false }
}

/** Whether this app can still send anything to the agent's terminal. */
export type Reach = 'reachable' | 'gone'

export interface Reachability {
  reach: Reach
  /** Why not, in the server's own words. Absent when it is reachable. */
  reason?: string
}

/**
 * Whether the pane behind this session is still there.
 *
 * The fact the mobile app draws as a struck-through device and this one had
 * nowhere to put: `paneId` absent means it was never attachable, and
 * `attachBlockedReason` means the server looked and said why not. Both are
 * "you cannot drive this from here", which is one thing to a reader and two
 * things to the wire.
 */
export function reachOf(agent: Agent, exited: readonly string[] = []): Reachability {
  /*
   * A pane whose process has exited is not reachable, and the app has known
   * that all along — the server sends `kind: 'pane-exited'` and the store
   * remembers which sessions it applied to. Only the Attach tab consulted it.
   *
   * A `pane_id` says a pane *reference* exists, not that anything is behind it
   * to receive a keystroke, and the registry never revisits the field: it is
   * set from whether the session file's tmux reference parses. So an agent
   * whose pane has gone kept "terminal reachable" on its card for ever, beside
   * its own line reading `idle · exited`. INV-11 defines reachability as
   * whether this app can still send anything there, and for a dead pane that
   * is simply false.
   *
   * The list is passed in rather than read here so this stays a pure function
   * of what it is told, like the rest of the module.
   */
  if (exited.includes(agent.sessionId)) {
    return { reach: 'gone', reason: agent.attachBlockedReason }
  }
  /*
   * The pane id decides, and the reason only explains its absence. They are
   * mutually exclusive on the wire — `read_session_file` sets one or the other
   * — and `overlay` now keeps them that way across a merge, which it did not
   * always: an agent first seen before its pane existed kept the reason for
   * ever and ended up carrying both.
   *
   * Reading them in this order means the card cannot contradict itself even if
   * a server ever sends both, and it is the same fact the Answer verb and the
   * answer card's own `disabled` already key on. A rail saying "unreachable"
   * beside a live Answer button is worse than either alone.
   */
  if (agent.paneId !== undefined) return { reach: 'reachable' }
  if (agent.attachBlockedReason !== undefined) {
    return { reach: 'gone', reason: agent.attachBlockedReason }
  }
  return { reach: 'gone' }
}

/**
 * The timestamp the card's age should count from, or null when there is none.
 *
 * For a blocked session this is the moment it stopped, so the row reads "14m"
 * meaning *blocked for fourteen minutes* rather than *last wrote fourteen
 * minutes ago*. Those are the same number and a different fact, and only one
 * of them tells you whether to go and look.
 *
 * It is the same field either way — `lastActivityAt` is the last thing that
 * happened, and for an agent that is now waiting, the last thing that happened
 * is that it stopped and asked. Nothing new is measured and nothing is
 * inferred; what changes is only what the card *calls* it. An agent with no
 * recorded activity gets null rather than its start time: how long it has been
 * blocked is then not something this app knows (INV-11).
 */
export function ageFrom(agent: Agent): number | null {
  return agent.lastActivityAt ?? null
}

/** Whether the age should be read as "in this state for", not "last seen". */
export function ageIsTimeInState(agent: Agent): boolean {
  return agent.status === 'waiting' && agent.statusInferred !== true
}
