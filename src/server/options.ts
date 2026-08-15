/**
 * Allow-lists for the values that reach a command line or a live agent's
 * prompt. Kept separate from control.ts so spawn.ts can validate without
 * pulling in the tmux control surface.
 */

/** Model aliases the CLI accepts. `--model` rejects anything else anyway; this
 * refuses it before it ever becomes an argv entry. */
export const MODEL_ALIASES = ['default', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan'] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

/**
 * Permission modes in the order Shift+Tab cycles them, per the CLI's own
 * documentation: `default → acceptEdits → plan → bypassPermissions → auto`,
 * where the last two appear only when available in that session.
 */
export const MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'] as const
export type PermissionMode = (typeof MODE_CYCLE)[number]

/** Modes settable at spawn time. `dontAsk` is reachable by flag but never cycles. */
export const SPAWN_MODES = [...MODE_CYCLE, 'dontAsk'] as const

export class SpawnOptionError extends Error {}

export function isModelAlias(value: unknown): value is ModelAlias {
  return typeof value === 'string' && (MODEL_ALIASES as readonly string[]).includes(value)
}

export function isPermissionMode(value: unknown): value is string {
  return typeof value === 'string' && (SPAWN_MODES as readonly string[]).includes(value)
}

/** Only the cycle is reachable on a running session. */
export function isCyclableMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (MODE_CYCLE as readonly string[]).includes(value)
}
