/**
 * Permission modes, as the UI names them.
 *
 * Shared because two places offer the switch now: the detail panel's control
 * row, and the compact one in the chat composer. A second copy of this list is
 * how a mode ends up labelled one way in one place and another way elsewhere.
 */
import type { Key } from './i18n.ts'

/** Modes reachable on a running session, in cycle order. */
export const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'] as const

export const MODE_KEY: Record<string, Key> = {
  default: 'modeDefault',
  acceptEdits: 'modeAcceptEdits',
  plan: 'modePlan',
  bypassPermissions: 'modeBypassPermissions',
  auto: 'modeAuto',
  dontAsk: 'modeDontAsk',
}
