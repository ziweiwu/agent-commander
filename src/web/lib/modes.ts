/**
 * Permission modes, as the UI names them.
 *
 * Shared because two places offer the switch now: the detail panel's control
 * row, and the compact one in the chat composer. A second copy of this list is
 * how a mode ends up labelled one way in one place and another way elsewhere.
 */
import type { Key } from './i18n.ts'
import { MODE_CYCLE, SPAWN_MODES } from '../../shared/types.ts'

/**
 * Modes reachable on a running session, in cycle order — the server's list,
 * not a copy of it. Only the labels below are the web layer's own.
 */
export const MODES = MODE_CYCLE

/** Modes offerable when starting a session; `dontAsk` is reachable by flag. */
export const NEW_AGENT_MODES = SPAWN_MODES

/**
 * How to write a mode where a user reads it.
 *
 * The fallback is the point. The server sends whatever the session recorded,
 * which is not necessarily a mode this build knows — a newer Claude Code can
 * name one that is not in `MODE_CYCLE`, and this app is an observer of its
 * work rather than the authority on it. Echoing the raw string reports what
 * the session actually said instead of silently dropping a mode we cannot
 * label, which would read as "no mode set" and be a claim of its own (INV-11).
 */
export function modeLabel(mode: string, translate: (key: Key) => string): string {
  const key = MODE_KEY[mode]
  return key ? translate(key) : mode
}

export const MODE_KEY: Record<string, Key> = {
  default: 'modeDefault',
  acceptEdits: 'modeAcceptEdits',
  plan: 'modePlan',
  bypassPermissions: 'modeBypassPermissions',
  auto: 'modeAuto',
  dontAsk: 'modeDontAsk',
}
