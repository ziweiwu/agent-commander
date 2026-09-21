/**
 * Types for the bridge, which is plain `.mjs` so Claude Code can run it with no
 * build step. Declared here rather than converted to TypeScript for that
 * reason: the path in `~/.claude/settings.json` has to work whether or not
 * anyone has run `npm run build`.
 */
import type { RateLimits, SessionUsage } from '../src/shared/types.ts'

export declare const CACHE_DIR: string
export declare const CACHE_FILE: string
export declare const SESSIONS_DIR: string

/** The bridge's per-session document: the wire type plus the file's own key. */
export type SessionUsageFile = SessionUsage & { sessionId: string }

/** Null when the frame carries neither a context reading nor a cost. */
export declare function sessionUsage(input: string, now: number): SessionUsageFile | null
export declare function persistSession(usage: SessionUsageFile, dir?: string): void

/** Null when the payload carries no `rate_limits` — see the note in the bridge. */
export declare function snapshot(input: string, now: number): RateLimits | null
export declare function render(snap: RateLimits | null): string
export declare function persist(snap: RateLimits, dir?: string, file?: string): void
