/**
 * Layout for the forest view: every session drawn as a *family* — itself plus
 * everything it delegated — against one shared time axis whose right-hand edge
 * is now.
 *
 * Pure arithmetic and text. No React, no DOM: the component owns the pixels,
 * this owns the claims, and the claims are the part that has to be right.
 *
 * Two rules from `INVARIANTS.md` run through all of it. INV-11 forbids
 * inventing a duration for something that has never been heard from, which is
 * why `secs` is nullable rather than 0. INV-13 forbids reading silence as
 * completion, which is why `quiet`, `done` and `stopped` are three marks and
 * not one.
 */
import type { Agent, AgentTree, SubagentNode, SubagentState } from '../../shared/types.ts'

/**
 * The axis is logarithmic, and clamped at both ends.
 *
 * What it has to show at once spans four orders of magnitude — a delegate that
 * wrote four seconds ago beside one that stopped six hours back — and on a
 * linear axis every live lane collapses onto the right-hand edge together,
 * which is exactly where the differences worth seeing are. Below the floor the
 * distinction is not worth drawing; above the ceiling it is "old" and nothing
 * finer is being claimed.
 */
export const AXIS_FLOOR_S = 10
export const AXIS_CEIL_S = 21_600
/** Lanes drawn per family before the rest are folded away behind a count. */
export const MAX_LANES = 6

const AXIS_SPAN = Math.log(AXIS_CEIL_S / AXIS_FLOOR_S)

/** Where a moment sits on the axis: the old edge is zero, now is one. */
export function place(secs: number): number {
  const clamped = Math.min(Math.max(secs, AXIS_FLOOR_S), AXIS_CEIL_S)
  return 1 - Math.log(clamped / AXIS_FLOOR_S) / AXIS_SPAN
}

const MINUTE_S = 60
const HOUR_S = 3600
const DAY_S = 86400

/**
 * Silence this long is the thing a family summary exists to surface. Shorter
 * than this is a delegate thinking, which is not news.
 */
const STALL_S = 600

/**
 * Where a mark with no duration would sit.
 *
 * `null` seconds have no position and the component draws no mark for them, so
 * this is never read — but the field is a number and has to hold one. The old
 * edge is the single value that would actively lie: it claims hours of silence
 * about something that has never been heard from at all (INV-11).
 */
const NO_POSITION = 1

export type MarkState = 'blocked' | 'writing' | 'quiet' | 'done' | 'stopped'

export interface Lane {
  key: string
  label: string
  /** Zero for the session itself; each delegate is one deeper than its parent. */
  depth: number
  /** Seconds since it last wrote. `null` = it never has, which is not zero. */
  secs: number | null
  /** `place(secs)`; meaningless when `secs` is null. */
  at: number
  state: MarkState
  inferred: boolean
  orphan: boolean
  /** The accessible name: everything the mark's position cannot say aloud. */
  describe: string
}

export interface Family {
  sessionId: string
  agent: Agent
  self: Lane
  /** Delegates only, already folded to `MAX_LANES`. */
  lanes: Lane[]
  hidden: number
  /** Lanes in `writing`, the session included, across the whole family. */
  running: number
  total: number
  /** The oldest delegate that has not finished, wherever it sits. */
  stalled: Lane | null
  unknownTree: boolean
  summary: string
}

/**
 * `stoppedByUser` is checked before this, because the server records a stopped
 * delegate as `done` and flags it. An ending it is, but not the same news as
 * finished, so it does not get the same mark (INV-13).
 */
const MARK_OF: Record<SubagentState, MarkState> = {
  active: 'writing',
  quiet: 'quiet',
  done: 'done',
}

const WORD_OF: Record<MarkState, string> = {
  blocked: 'blocked',
  writing: 'writing',
  quiet: 'quiet',
  done: 'done',
  stopped: 'stopped by the user',
}

/**
 * Seconds since `at`, or null when there is nothing to measure from.
 *
 * Never 0 for a missing timestamp. An earlier draft guarded the session and
 * not the delegates, and drew a delegate that had never written at the
 * six-hour tick — a mark asserting it had gone silent, about work nobody has
 * heard anything about either way (INV-11).
 */
function secondsSince(wroteAt: number | undefined, now: number): number | null {
  if (!wroteAt) return null
  return Math.max(0, (now - wroteAt) / 1000)
}

export function duration(secs: number): string {
  if (secs < MINUTE_S) return `${Math.round(secs)}s`
  if (secs < HOUR_S) return `${Math.round(secs / MINUTE_S)}m`
  if (secs < DAY_S) return `${Math.round(secs / HOUR_S)}h`
  // Matches `relative()` in format.ts, which the card list uses. Without this
  // step a session idle for a fortnight read "401h".
  return `${Math.round(secs / DAY_S)}d`
}

/**
 * The four things a mark means, in words.
 *
 * A mark says all of this with a `left` percentage and a colour, and a screen
 * reader gets neither. So the name, the state, whether that state was worked
 * out rather than reported, and the duration all travel as text — the same
 * device the fleet card already uses for an inferred status.
 */
interface Described {
  name: string
  state: MarkState
  secs: number | null
  inferred: boolean
  orphan: boolean
}

function describeLane({ name, state, secs, inferred, orphan }: Described): string {
  const notes: string[] = []
  if (inferred) notes.push('worked out, not reported')
  if (orphan) notes.push('parent not found')
  const parts = [name]
  // "quiet, never prompted" says one thing twice; every other state adds a
  // fact that "never prompted" does not already carry.
  if (state !== 'quiet' || secs !== null || notes.length > 0) {
    parts.push(notes.length > 0 ? `${WORD_OF[state]} (${notes.join('; ')})` : WORD_OF[state])
  }
  parts.push(secs === null ? 'never prompted' : `last wrote ${duration(secs)} ago`)
  return parts.join(', ')
}

function selfLane(agent: Agent, now: number): Lane {
  const secs = secondsSince(agent.lastActivityAt, now)
  const state: MarkState =
    agent.status === 'waiting' ? 'blocked' : agent.status === 'busy' ? 'writing' : 'quiet'
  const inferred = agent.statusInferred === true
  return {
    key: agent.sessionId,
    label: '',
    depth: 0,
    secs,
    at: secs === null ? NO_POSITION : place(secs),
    state,
    inferred,
    orphan: false,
    describe: describeLane({ name: agent.name, state, secs, inferred, orphan: false }),
  }
}

function delegateLane(node: SubagentNode, now: number): Lane {
  const secs = secondsSince(node.lastWriteAt, now)
  const state: MarkState = node.stoppedByUser === true ? 'stopped' : MARK_OF[node.state]
  const inferred = node.stateInferred === true
  const orphan = node.reparented === true
  return {
    key: node.agentId,
    label: node.agentType,
    depth: node.depth,
    secs,
    at: secs === null ? NO_POSITION : place(secs),
    state,
    inferred,
    orphan,
    describe: describeLane({ name: node.agentType, state, secs, inferred, orphan }),
  }
}

/** Depth-first, so a child is always listed under its own parent. */
function flatten(nodes: SubagentNode[]): SubagentNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)])
}

/**
 * The oldest delegate that has not finished.
 *
 * `done` and `stopped` are excluded because they are not holding anybody up,
 * and a delegate that never wrote is excluded because there is no duration to
 * call oldest — absence of evidence, not an old timestamp (INV-11).
 */
function oldestUnfinished(lanes: Lane[]): Lane | null {
  let worst: Lane | null = null
  let worstSecs = -1
  for (const lane of lanes) {
    if (lane.state === 'done' || lane.state === 'stopped' || lane.secs === null) continue
    if (lane.secs > worstSecs) {
      worst = lane
      worstSecs = lane.secs
    }
  }
  return worst
}

/**
 * Which delegates survive the fold, worst news first.
 *
 * Showing the six freshest and folding the quietest folds exactly where a
 * stall lives: a delegate that has silently died *is* the quietest one. So the
 * anomalies come first, then the straggler the parent is waiting on, then
 * everything else by recency.
 *
 * This decides *which* lanes are drawn and not what order they are drawn in —
 * they are put back in tree order afterwards, because indentation only means
 * anything while a child still sits under its parent. What the ranking earns is
 * that a stalled delegate is on screen at all; `stalled` is exported so the
 * component can mark it where it stands.
 */
function byPriority(lanes: Lane[], stalled: Lane | null): Lane[] {
  const rank = (lane: Lane): number => {
    if (lane.state === 'stopped' || lane.orphan) return 0
    if (lane === stalled) return 1
    return 2
  }
  /*
   * Freshest first, and one that has never written last — the rule
   * `sortAgents` already follows: no timestamp is a different claim from an
   * old one, and must not be ranked as either extreme.
   */
  const byRecency = (left: Lane, right: Lane): number => {
    if (left.secs === null && right.secs === null) return 0
    if (left.secs === null) return 1
    if (right.secs === null) return -1
    return left.secs - right.secs
  }
  // The key tiebreak keeps the order from jittering between polls.
  return [...lanes].sort(
    (left, right) =>
      rank(left) - rank(right) || byRecency(left, right) || left.key.localeCompare(right.key),
  )
}

/**
 * The family's headline.
 *
 * Driven by the straggler and not by `min(secs)`: a summary reading the
 * freshest lane loses sensitivity as fan-out grows, so a family of 37 only
 * looks quiet once the last of the 37 stops — the card that delegates hardest
 * would lie longest. The fraction is only printed when it is not whole,
 * because "all 4 writing" is the thing worth reading and "4 of 4" is arithmetic.
 */
function summarize(running: number, total: number, stalled: Lane | null): string {
  const head =
    running === 0
      ? 'nothing writing'
      : total === 1
        ? 'writing'
        : running === total
          ? `all ${total} writing`
          : `${running} of ${total} writing`
  if (stalled !== null && stalled.secs !== null && stalled.secs >= STALL_S) {
    return `${head} · one quiet ${duration(stalled.secs)}`
  }
  return head
}

function familyOf(agent: Agent, tree: AgentTree | undefined, now: number): Family {
  const delegates = flatten(tree?.children ?? []).map((node) => delegateLane(node, now))
  const self = selfLane(agent, now)
  const stalled = oldestUnfinished(delegates)
  const kept = new Set(byPriority(delegates, stalled).slice(0, MAX_LANES))
  const writing = delegates.filter((lane) => lane.state === 'writing').length
  const running = writing + (self.state === 'writing' ? 1 : 0)
  const total = delegates.length + 1
  return {
    sessionId: agent.sessionId,
    agent,
    self,
    lanes: delegates.filter((lane) => kept.has(lane)),
    hidden: delegates.length - kept.size,
    running,
    total,
    stalled,
    /*
     * An agent with no delegates and an agent this app cannot ask are
     * different claims, and collapsing them would put "delegated nothing" on a
     * CLI that simply keeps no transcript to read it from (INV-13).
     */
    unknownTree: tree?.unknown === true,
    summary: summarize(running, total, stalled),
  }
}

/** One family per agent, in the order the caller already sorted them. */
export function buildForest(agents: Agent[], trees: AgentTree[], now = Date.now()): Family[] {
  const byId = new Map(trees.map((tree) => [tree.sessionId, tree]))
  // A missing tree means no delegates drawn, never a throw: the graph is
  // polled separately from the fleet, so a family arrives before its tree does.
  return agents.map((agent) => familyOf(agent, byId.get(agent.sessionId), now))
}
