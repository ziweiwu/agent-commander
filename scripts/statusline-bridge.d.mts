/**
 * Types for the bridge, which is plain `.mjs` so Claude Code can run it with no
 * build step. Declared here rather than converted to TypeScript for that
 * reason: the path in `~/.claude/settings.json` has to work whether or not
 * anyone has run `npm run build`.
 */
import type { RateLimits } from '../src/shared/types.ts'

export declare const CACHE_DIR: string
export declare const CACHE_FILE: string

/** Null when the payload carries no `rate_limits` — see the note in the bridge. */
export declare function snapshot(input: string, now: number): RateLimits | null
export declare function render(snap: RateLimits | null): string
export declare function persist(snap: RateLimits, dir?: string, file?: string): void
