/**
 * Wire types shared by the server and the browser client.
 *
 * The types and the option lists are generated from `rust/src/types.rs` into
 * `wire.ts` by `npm run gen:types`; this module is the hand-written half. It
 * re-exports the generated contract and adds the two union types the browser
 * derives from the option lists, which no codegen can be asked for because
 * they exist only on this side.
 *
 * `types::tests::the_checked_in_wire_contract_is_current` fails `npm test`
 * when `wire.ts` and the Rust disagree, so this contract cannot drift the way
 * the hand-mirrored one it replaced could.
 */
export * from './wire.ts'
import type { MODEL_ALIASES, MODE_CYCLE } from './wire.ts'

export type ModelAlias = (typeof MODEL_ALIASES)[number]
export type PermissionMode = (typeof MODE_CYCLE)[number]
