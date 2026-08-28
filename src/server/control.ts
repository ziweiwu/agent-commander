/**
 * Acting on a running agent: closing it, and changing its mode or model.
 *
 * INV-8 guards these, and no longer with one rule for all of them. Closing an
 * agent and setting its goal are refused while it is busy: both submit an
 * instruction that changes what the session does next, and one arriving
 * mid-turn acts on a state nobody chose. Mode and model are allowed at any
 * point — mode because it sends a control key rather than typing at all, model
 * because it types through the same `paste` the message composer already uses
 * on working agents by design. Each function below says which it is and why.
 */
import { allowsSlashCommands } from '../shared/agent-kinds.ts'
import type { Agent, GoalState } from '../shared/types.ts'
import * as panes from './pane.ts'

import { isCyclableMode, isModelAlias, MODE_CYCLE } from './options.ts'

export class ControlError extends Error {}

export { MODE_CYCLE, isModelAlias, isCyclableMode }

/**
 * An agent this module is allowed to type into: it exists, and it has a pane.
 *
 * Spelling the pane out in the type is what lets every function below take the
 * lookup result directly. They used to take `Agent`, so `routes.ts` handed each
 * one an `agent as never` — five casts, all of them on the one path that types
 * into a live session, in a codebase with no other type escapes. The `undefined`
 * case really was handled, inside the assertion; the cast just stopped the
 * compiler checking that it stayed handled.
 */
export type Controllable = Agent & { paneId: string }

/** There is an agent, and there is a pane to reach it through. */
export function assertAttachable(agent: Agent | undefined): asserts agent is Controllable {
  if (!agent) throw new ControlError('agent is no longer available')
  if (!agent.paneId) throw new ControlError(agent.attachBlockedReason ?? 'agent is not attachable')
}

/**
 * INV-8: the shared guard in front of every action that types into the prompt.
 *
 * The busy refusal is about *text*. `/model`, `/goal` and `/exit` are pasted
 * into the agent's prompt buffer, and text arriving mid-tool-call interleaves
 * with work in flight — it lands in whatever the agent is drawing and submits
 * something nobody wrote. Anything that types is refused until the agent is
 * idle; see `setMode` for the one action that does not type.
 */
export function assertControllable(agent: Agent | undefined): asserts agent is Controllable {
  assertAttachable(agent)
  if (agent.status === 'busy') {
    throw new ControlError('agent is busy — wait until it is idle before changing it')
  }
}

/**
 * INV-7's other half: these actions are Claude Code's slash commands.
 *
 * Every one of them works by typing `/model`, `/goal` or `/exit` into a live
 * pane. Against another CLI that is not a feature that degrades — it is this
 * app typing a sentence of its own into somebody's prompt and pressing return.
 * The browser hides these controls for such agents; this is the boundary that
 * makes it true, because the UI is not one (INV-6).
 */
export function assertSlashCommandable(agent: Controllable): void {
  if (!allowsSlashCommands(agent.agentKind)) {
    throw new ControlError(
      `this action types a Claude Code command into the session, which ${agent.agentKind} does not understand`,
    )
  }
}

export interface ControlDeps {
  paste: (paneId: string, text: string, submit: boolean) => Promise<void>
  key: (paneId: string, key: string) => Promise<void>
  /** Reads the mode the session reports now; used to verify a switch landed. */
  readMode: () => Promise<string | undefined>
  /** Reads the goal the session reports now; used to verify one was set. */
  readGoal: () => Promise<GoalState | undefined>
  paneAlive: (paneId: string) => Promise<boolean>
  killSession: (tmuxSession: string) => Promise<void>
  wait: (ms: number) => Promise<void>
}

export const liveDeps = (
  readMode: () => Promise<string | undefined>,
  readGoal: () => Promise<GoalState | undefined>,
): ControlDeps => ({
  paste: panes.paste,
  key: panes.key,
  readMode,
  readGoal,
  paneAlive: async (paneId) => {
    try {
      const meta = await panes.meta(paneId)
      return !meta.dead
    } catch {
      return false
    }
  },
  killSession: async (session) => {
    await panes.killSession(session)
  },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
})

/**
 * Switch the model with the CLI's own `/model <alias>`.
 *
 * The alias is validated against the allow-list first, so nothing free-text is
 * ever typed into a live session.
 *
 * Allowed while the agent is working, and the reason is consistency rather than
 * safety: this pastes text through the very same `paste` primitive the message
 * composer uses, and `handlePaste` has never had a busy guard at all. Sending
 * "use opus instead" as a chat message to a working agent is a designed feature
 * — it is what the composer's Queue mode *is* — so refusing `/model opus`
 * forbade through one door exactly what the app permits through another, with
 * the same keystrokes reaching the same prompt.
 *
 * What that costs is immediacy, not correctness. Claude Code queues input that
 * arrives mid-turn and reads it when the turn ends, so the switch applies then
 * rather than now. The caller is told which of the two happened (`queued`) so
 * the interface can say so instead of claiming a change that has not landed
 * yet — INV-11.
 */
export async function setModel(
  agent: Agent | undefined,
  alias: string,
  deps: ControlDeps,
): Promise<{ queued: boolean }> {
  assertAttachable(agent)
  assertSlashCommandable(agent)
  if (!isModelAlias(alias)) throw new ControlError(`unknown model: ${alias}`)
  const queued = agent.status === 'busy'
  await deps.paste(agent.paneId, `/model ${alias}`, true)
  return { queued }
}

export interface ModeResult {
  ok: boolean
  mode: string | undefined
  steps: number
  /**
   * The press went out but the session never reported a different mode.
   *
   * Distinct from `ok: false` meaning "cycled and could not reach it": here we
   * do not know what happened. The mode may well have changed where this app
   * cannot see it, so the caller must not say the switch failed (INV-11).
   */
  unobserved?: boolean
}

/** How many Shift+Tab presses before giving up; the cycle is at most five long. */
const MAX_STEPS = 6

/**
 * How long to let the session report a press, and how often to look.
 *
 * This used to be a single read 250ms after the press, and that made the whole
 * control a coin toss: the mode is observed by reading a record the session
 * writes to its transcript, and when that record had not landed within the one
 * window we looked in, the press looked like it had done nothing. The loop then
 * stopped — correctly refusing to press blind — leaving the mode one step from
 * where it started rather than at the target, and reporting that it could not
 * confirm. Sometimes 250ms was enough. That is what "flaky" was.
 *
 * Polling instead of guessing a delay is the fix: the answer arrives when it
 * arrives, and the only thing a slow write costs now is a little latency
 * rather than a wrong mode. The window is generous because the alternative to
 * waiting is a wrong answer, and the whole call is a deliberate user action —
 * nobody is holding this key down.
 */
const SETTLE_WINDOW_MS = 2500
const SETTLE_POLL_MS = 120

/**
 * Switch permission mode by cycling Shift+Tab until the session reports the
 * target.
 *
 * Verified rather than counted: the cycle silently omits `bypassPermissions`
 * and `auto` when they are unavailable, so a fixed number of presses would land
 * somewhere else entirely. Gives up after a bounded number of steps and reports
 * where it actually ended up.
 *
 * **The one control action allowed while the agent is working**, and the reason
 * is what it sends. Every other action pastes text into the prompt buffer,
 * which mid-tool-call interleaves with work in flight and submits something
 * nobody wrote. This sends `BTab` — a control key Claude Code handles as a
 * toggle wherever it is, exactly as it would from the keyboard of the terminal
 * this app is standing in for. Refusing it was the app being stricter than the
 * thing it mirrors: deciding "this next step needs plan mode" happens *while*
 * the agent is running, which is the only time it matters.
 *
 * The verification loop is what makes this safe to allow. It re-reads the mode
 * the session reports rather than assuming a press landed, and reports where it
 * actually ended up — so a press swallowed by a busy redraw is visible as a
 * failure rather than a wrong mode nobody noticed.
 */
/**
 * The mode the session reports once it has had a chance to report it.
 *
 * Returns as soon as the reading differs from `from`, or gives `from` back
 * unchanged when the window closes — which is the caller's signal that the
 * press was never observed, not that it failed.
 */
async function settledMode(
  from: string | undefined,
  deps: ControlDeps,
  windowMs: number,
): Promise<string | undefined> {
  for (let waited = 0; waited < windowMs; waited += SETTLE_POLL_MS) {
    await deps.wait(SETTLE_POLL_MS)
    const seen = await deps.readMode()
    if (seen !== from) return seen
  }
  return from
}

export async function setMode(
  agent: Agent | undefined,
  target: string,
  deps: ControlDeps,
  maxSteps = MAX_STEPS,
  settleMs = SETTLE_WINDOW_MS,
): Promise<ModeResult> {
  assertAttachable(agent)
  assertSlashCommandable(agent)
  if (!isCyclableMode(target)) throw new ControlError(`unknown permission mode: ${target}`)

  let mode = await deps.readMode()
  if (mode === target) return { ok: true, mode, steps: 0 }

  for (let steps = 1; steps <= maxSteps; steps += 1) {
    // BTab is tmux's name for back-tab, which is what a terminal emits for Shift+Tab.
    await deps.key(agent.paneId, 'BTab')
    const seen = await settledMode(mode, deps, settleMs)
    if (seen === target) return { ok: true, mode: seen, steps }
    /*
     * The reading did not move, so this loop is now blind — and a blind loop
     * here is not a failed switch, it is five more Shift+Tabs into a live
     * session, leaving it in a mode nobody asked for and reporting an error
     * for the privilege.
     *
     * Two things cause it and neither is helped by pressing again: the session
     * reports no permission mode at all (real sessions do exist in that state),
     * or it is mid-turn and has not written the record where this app can read
     * it yet. Stop at one press, and say that the outcome is unknown rather
     * than that it failed.
     */
    if (seen === mode) return { ok: false, mode: seen, steps, unobserved: true }
    mode = seen
  }
  return { ok: false, mode, steps: maxSteps }
}

/**
 * The longest goal condition that will be typed into a live prompt.
 *
 * Claude Code has its own cap and refuses anything longer, so this is not the
 * boundary that matters for correctness — it is the boundary that keeps a
 * paste that is going to be rejected anyway from being typed into a session at
 * all.
 */
export const GOAL_MAX_CHARS = 400

/**
 * Check a goal condition before it becomes a line typed into a live agent.
 *
 * A newline is the dangerous character here, not a shell metacharacter: this
 * text is pasted into Claude Code's prompt and submitted, so an embedded
 * newline would submit early and send the remainder as a second, unreviewed
 * instruction. A leading `/` is refused for the same reason — the user asked
 * to set a goal, not to run some other slash command.
 */
export function assertGoalCondition(raw: string): string {
  const condition = raw.trim()
  if (condition.length === 0) throw new ControlError('a goal needs a condition')
  if (condition.length > GOAL_MAX_CHARS) {
    throw new ControlError(`a goal condition must be ${GOAL_MAX_CHARS} characters or fewer`)
  }
  for (const ch of condition) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      throw new ControlError('a goal condition must be a single line of text')
    }
  }
  if (condition.startsWith('/')) {
    throw new ControlError('a goal condition cannot start with / — that would run a command')
  }
  return condition
}

export interface GoalResult {
  ok: boolean
  goal: GoalState | undefined
}

/** How long to wait for the session to write the goal down before giving up. */
const GOAL_VERIFY_MS = 5000
const GOAL_POLL_MS = 250

/**
 * Set a session goal by typing Claude Code's own `/goal <condition>`.
 *
 * Verified, like the mode switch: setting a goal writes a `goal_status` record
 * into the transcript immediately, so a goal that never appears there is one
 * that never landed — the paste went into a dialog, or the session was not at
 * its prompt after all. Reporting that honestly matters more than usual here,
 * because a goal makes the session keep working until an evaluator agrees it
 * is done, and "did that take effect?" is not a question the user can answer
 * by looking at the chat.
 */
export async function setGoal(
  agent: Agent | undefined,
  rawCondition: string,
  deps: ControlDeps,
  verifyMs = GOAL_VERIFY_MS,
): Promise<GoalResult> {
  assertControllable(agent)
  assertSlashCommandable(agent)
  const condition = assertGoalCondition(rawCondition)

  const before = await deps.readGoal()
  await deps.paste(agent.paneId, `/goal ${condition}`, true)

  for (let waited = 0; waited < verifyMs; waited += GOAL_POLL_MS) {
    await deps.wait(GOAL_POLL_MS)
    const goal = await deps.readGoal()
    if (landed(before, goal)) return { ok: true, goal }
  }
  return { ok: false, goal: before }
}

/**
 * Is this record evidence that the goal we just typed was accepted?
 *
 * Two things are checked and neither is the condition text. Claude Code
 * canonicalises what it stores, so comparing text would report a perfectly
 * good goal as failed.
 *
 *   - It must be the *set* record. Every `/goal <condition>` writes one, and
 *     only setting one does; an evaluation landing while we waited says the
 *     session is working on the goal it already had.
 *   - It must be newer than whatever was there before we typed, so a session
 *     that ignored the paste keeps reading as unchanged.
 *
 * Erring towards "not set" is deliberate. A goal wrongly reported as failed is
 * visible — the meter appears anyway on the next enrichment tick and the toast
 * looks wrong. A goal wrongly reported as set is invisible, and the user walks
 * away believing the session will keep working when it will stop at the next
 * prompt.
 */
function landed(before: GoalState | undefined, goal: GoalState | undefined): boolean {
  if (!goal?.fresh) return false
  if (!before) return true
  return goal.at > before.at || goal.condition !== before.condition
}

/**
 * Clear the goal with `/goal clear`.
 *
 * Nothing is written to the transcript when a goal is cleared, so unlike every
 * other action here this one cannot be verified by reading the session back.
 * The caller drops its own copy instead; if the clear did not land, the next
 * evaluation writes a fresh record and the goal reappears on its own, which is
 * the right way round for a claim this app cannot check.
 */
export async function clearGoal(agent: Agent | undefined, deps: ControlDeps): Promise<void> {
  assertControllable(agent)
  assertSlashCommandable(agent)
  await deps.paste(agent.paneId, '/goal clear', true)
}

/** Seconds to let `/exit` shut the session down before forcing it. */
const GRACE_MS = 6000
const POLL_MS = 500

export interface CloseResult {
  closed: boolean
  forced: boolean
}

/**
 * Close a session.
 *
 * `/exit` is Claude Code's own shutdown path, so it gets the chance to finish
 * writing its transcript. Only a session that ignores it is killed outright.
 *
 * An agent that does not speak that command skips straight to closing its tmux
 * session. Typing `/exit` at it would not shut anything down -- it would leave
 * a stray line in the prompt of a session the user asked to close, and then
 * force-kill it six seconds later anyway.
 */
export async function closeAgent(agent: Agent | undefined, deps: ControlDeps): Promise<CloseResult> {
  assertControllable(agent)
  const paneId = agent.paneId

  if (!allowsSlashCommands(agent.agentKind)) {
    if (!agent.tmuxSession) {
      throw new ControlError('agent has no shutdown command and no tmux session to close')
    }
    await deps.killSession(agent.tmuxSession)
    return { closed: true, forced: true }
  }

  await deps.paste(paneId, '/exit', true)

  for (let waited = 0; waited < GRACE_MS; waited += POLL_MS) {
    await deps.wait(POLL_MS)
    if (!(await deps.paneAlive(paneId))) return { closed: true, forced: false }
  }

  if (!agent.tmuxSession) {
    throw new ControlError('agent ignored /exit and has no tmux session to close')
  }
  await deps.killSession(agent.tmuxSession)
  return { closed: true, forced: true }
}
