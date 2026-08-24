/**
 * Allow-lists for the values that reach a command line or a live agent's
 * prompt. Kept separate from control.ts so spawn.ts can validate without
 * pulling in the tmux control surface.
 *
 * The lists themselves live in `shared/types.ts`, because the browser offers
 * exactly what this file accepts and a second copy is how those two stop
 * agreeing. What lives here is the checking — the part that only the server
 * does, and the only part that is load-bearing (INV-7: "Model and permission
 * mode are checked against the fixed allow-lists", not "the UI only offers
 * good ones").
 */
import {
  MODEL_ALIASES,
  MODE_CYCLE,
  SPAWN_MODES,
  type ModelAlias,
  type PermissionMode,
} from '../shared/types.ts'

export { MODEL_ALIASES, MODE_CYCLE, SPAWN_MODES }
export type { ModelAlias, PermissionMode }

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
