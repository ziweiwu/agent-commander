/**
 * Acting on a running agent: closing it, clearing or compacting its context,
 * and changing its mode or model.
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
import { readSessionId } from './registry.ts'

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
 * idle; see `cycleMode` for the one action that does not type.
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
  /**
   * Reads the session id this process is running now.
   *
   * `/clear` replaces the session rather than editing it, so this is how the
   * clear is verified — see `clearContext`.
   */
  readSessionId: (pid: number) => Promise<string | undefined>
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
  readSessionId,
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
  /**
   * The press went out but the session never reported a different mode.
   *
   * Not a failure. The key reached the pane; only the *reading* is missing, and
   * a busy session does not write its permission mode down until its turn ends.
   * Saying the switch failed would assert something nobody checked (INV-11).
   */
  unobserved?: boolean
}

/**
 * How long to let the session report a press, and how often to look.
 *
 * The mode is observed by reading a record the session writes to its
 * transcript, and that record arrives when it arrives. Polling instead of
 * guessing a delay means a slow write costs a little latency rather than a
 * wrong answer. The window is generous because the whole call is a deliberate
 * user action — nobody is holding this key down.
 */
const SETTLE_WINDOW_MS = 2500
const SETTLE_POLL_MS = 120

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

/**
 * Advance the permission mode by one Shift+Tab, exactly as the CLI's own
 * keyboard does, and report where the session says it landed.
 *
 * **This used to chase a named mode and that is what made it a coin toss.** The
 * old `setMode(target)` pressed `BTab` and re-read, up to six times, until the
 * session reported the mode the user had picked from a `<select>`. Against an
 * idle agent it worked. Against a busy one the reading cannot move — Claude
 * Code writes its permission mode at the end of a turn — so the settle window
 * closed unchanged, the loop correctly refused to press blind, and by then it
 * had already pressed twice: the session was left one or two steps past where
 * it started, in a mode nobody asked for, reported as `unverified`. Two more
 * causes had the same shape, a session that reports no mode at all and a cycle
 * that silently omits `bypassPermissions` and `auto` when they are unavailable,
 * which is why counting presses was never an option either.
 *
 * A target is the thing that cannot be delivered. Without one there is nothing
 * to chase: one press is one step, the failure mode is gone rather than
 * narrowed, and the app now mirrors the CLI, which also only cycles (INV-7).
 *
 * **The one control action allowed while the agent is working**, and the reason
 * is what it sends. Every other action pastes text into the prompt buffer,
 * which mid-tool-call interleaves with work in flight and submits something
 * nobody wrote. This sends `BTab` — a control key Claude Code handles as a
 * toggle wherever it is, exactly as it would from the keyboard of the terminal
 * this app is standing in for. Deciding "this next step needs plan mode"
 * happens *while* the agent is running, which is the only time it matters.
 */
export async function cycleMode(
  agent: Agent | undefined,
  deps: ControlDeps,
  settleMs = SETTLE_WINDOW_MS,
): Promise<ModeResult> {
  assertAttachable(agent)
  assertSlashCommandable(agent)

  const before = await deps.readMode()
  // BTab is tmux's name for back-tab, which is what a terminal emits for Shift+Tab.
  await deps.key(agent.paneId, 'BTab')
  const seen = await settledMode(before, deps, settleMs)
  if (seen === before) return { ok: true, mode: seen, unobserved: true }
  return { ok: true, mode: seen }
}

export interface ClearResult {
  ok: boolean
  /** The id the session is running now, when it was observed to change. */
  sessionId?: string
  /**
   * The paste went out and the session id never changed inside the window.
   *
   * Not a failure, for the same reason `cycleMode` reports one: `/clear` is
   * slower on a large conversation than any window worth blocking on, and a
   * clear that lands late is indistinguishable from here to one that never
   * landed at all. Saying it failed asserts something nobody checked (INV-11).
   */
  unobserved?: boolean
}

/** How long to watch for the session id to turn over, and how often to look. */
const CLEAR_VERIFY_MS = 6000
const CLEAR_POLL_MS = 250

/**
 * Discard the agent's conversation with Claude Code's own `/clear`.
 *
 * Refused while the agent is busy, like everything else that types: this is
 * pasted into the prompt buffer and submitted, and text arriving mid-tool-call
 * interleaves with work in flight.
 *
 * **Verified by watching the session id turn over, not the transcript.**
 * `/clear` does not edit a conversation, it replaces one: Claude Code opens a
 * fresh transcript under a new session id and rewrites
 * `~/.claude/sessions/<pid>.json` to point at it. So there is nothing to read
 * back in the old file — it simply stops growing, which is also what a
 * `/clear` that never arrived looks like. The id is the only signal that
 * separates them, it costs one small read, and it is written by Claude Code
 * rather than inferred here.
 *
 * The caller needs that new id for a second reason: the agent the user was
 * looking at is now addressed differently, and every route, socket focus and
 * URL naming the old id is dead the moment this returns.
 */
export async function clearContext(
  agent: Agent | undefined,
  deps: ControlDeps,
  verifyMs = CLEAR_VERIFY_MS,
): Promise<ClearResult> {
  assertControllable(agent)
  assertSlashCommandable(agent)

  const before = await deps.readSessionId(agent.pid)
  await deps.paste(agent.paneId, '/clear', true)

  for (let waited = 0; waited < verifyMs; waited += CLEAR_POLL_MS) {
    await deps.wait(CLEAR_POLL_MS)
    const now = await deps.readSessionId(agent.pid)
    if (now !== undefined && now !== before) return { ok: true, sessionId: now }
  }
  return { ok: true, unobserved: true }
}

/**
 * Ask the agent to compact its own context with Claude Code's `/compact`.
 *
 * Refused while busy for the same reason `/clear` is: it types.
 *
 * **Deliberately not verified here, and the number is why.** A compaction
 * writes a `compact_boundary` record when it finishes, and the one real sample
 * on this machine reports `durationMs: 157676` — over two and a half minutes.
 * Holding a request open for that is not a verification strategy, it is a hung
 * button. So this returns as soon as the text is submitted, the interface says
 * the compaction was *asked for* rather than that it happened (INV-11), and the
 * result arrives on its own: the transcript tail turns that boundary record
 * into a timeline event, through the loop that is already reading the file.
 */
export async function compactContext(
  agent: Agent | undefined,
  deps: ControlDeps,
): Promise<void> {
  assertControllable(agent)
  assertSlashCommandable(agent)
  await deps.paste(agent.paneId, '/compact', true)
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
