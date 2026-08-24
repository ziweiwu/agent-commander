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

export const MODE_KEY: Record<string, Key> = {
  default: 'modeDefault',
  acceptEdits: 'modeAcceptEdits',
  plan: 'modePlan',
  bypassPermissions: 'modeBypassPermissions',
  auto: 'modeAuto',
  dontAsk: 'modeDontAsk',
}
