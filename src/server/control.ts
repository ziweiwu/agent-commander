/**
 * Acting on a running agent: closing it, and changing its mode or model.
 *
 * INV-8: every action here refuses an agent that is busy. These work by typing
 * into the agent's own prompt, and a keystroke that lands in the middle of a
 * tool call would be interleaved with work in flight. Idle and waiting are
 * fine — a waiting agent is precisely the one you may want to redirect.
 */
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

/** INV-8: the shared guard in front of every action. */
export function assertControllable(agent: Agent | undefined): asserts agent is Controllable {
  if (!agent) throw new ControlError('agent is no longer available')
  if (!agent.paneId) throw new ControlError(agent.attachBlockedReason ?? 'agent is not attachable')
  if (agent.status === 'busy') {
    throw new ControlError('agent is busy — wait until it is idle before changing it')
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
 * Switch the model by typing the CLI's own `/model` command.
 *
 * The alias is validated against the allow-list first, so nothing free-text is
 * ever typed into a live session.
 */
export async function setModel(
  agent: Agent | undefined,
  alias: string,
  deps: ControlDeps,
): Promise<void> {
  assertControllable(agent)
  if (!isModelAlias(alias)) throw new ControlError(`unknown model: ${alias}`)
  await deps.paste(agent.paneId, `/model ${alias}`, true)
}

export interface ModeResult {
  ok: boolean
  mode: string | undefined
  steps: number
}

/** How many Shift+Tab presses before giving up; the cycle is at most five long. */
const MAX_STEPS = 6

/**
 * Switch permission mode by cycling Shift+Tab until the session reports the
 * target.
 *
 * Verified rather than counted: the cycle silently omits `bypassPermissions`
 * and `auto` when they are unavailable, so a fixed number of presses would land
 * somewhere else entirely. Gives up after a bounded number of steps and reports
 * where it actually ended up.
 */
export async function setMode(
  agent: Agent | undefined,
  target: string,
  deps: ControlDeps,
  maxSteps = MAX_STEPS,
): Promise<ModeResult> {
  assertControllable(agent)
  if (!isCyclableMode(target)) throw new ControlError(`unknown permission mode: ${target}`)

  let mode = await deps.readMode()
  if (mode === target) return { ok: true, mode, steps: 0 }

  for (let steps = 1; steps <= maxSteps; steps += 1) {
    // BTab is tmux's name for back-tab, which is what a terminal emits for Shift+Tab.
    await deps.key(agent.paneId, 'BTab')
    await deps.wait(250)
    mode = await deps.readMode()
    if (mode === target) return { ok: true, mode, steps }
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
 */
export async function closeAgent(agent: Agent | undefined, deps: ControlDeps): Promise<CloseResult> {
  assertControllable(agent)
  const paneId = agent.paneId

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
