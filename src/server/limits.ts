/**
 * Account-level quota, read from the file the statusLine bridge writes.
 *
 * The 5-hour and 7-day windows are not in the transcripts — Claude Code hands
 * them to a statusLine command and nowhere else — so the flow is:
 * `scripts/statusline-bridge.mjs` (running inside every live Claude session)
 * writes `~/.claude/agent-commander/rate-limits.json`, and this watches it.
 */
import { readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RateLimits, UsageWindow } from '../shared/types.ts'
import type { LimitsApi } from './sources.ts'

export const LIMITS_FILE = join(homedir(), '.claude', 'agent-commander', 'rate-limits.json')

/**
 * `fs.watch` fires a burst per write on some platforms, and the bridge itself
 * runs once per statusline render across every session, so coalesce.
 */
const DEBOUNCE_MS = 200

/**
 * Backstop poll, and not an optional one.
 *
 * `fs.watch` on macOS silently drops writes that land within a few ms of the
 * watch being registered — measured here, about one run in three, with an
 * independent second watcher on the same directory seeing nothing either. That
 * is exactly our shape: the server starts, and a live Claude session writes
 * immediately. So the poll is the correctness guarantee and `fs.watch` is only
 * the low-latency path on top of it.
 *
 * The cost is one `stat` every two seconds on a file of a few hundred bytes,
 * matching the cadence the session list already runs at (INV-4). The file is
 * read only when its mtime has actually moved.
 */
const POLL_MS = 2000

/**
 * `Number.isFinite`, not `typeof === 'number'`. JSON cannot express NaN but it
 * can express `1e999`, which parses to Infinity and passes a typeof check — and
 * then renders as an `Infinity%` bar width. This file is written by a separate
 * process, so it is untrusted input like any other.
 */
function readWindow(v: unknown): UsageWindow | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const raw = v as { pct?: unknown; resetsAt?: unknown }
  if (!Number.isFinite(raw.pct)) return undefined
  const out: UsageWindow = { pct: Math.max(0, Math.min(100, raw.pct as number)) }
  if (Number.isFinite(raw.resetsAt)) out.resetsAt = raw.resetsAt as number
  return out
}

/**
 * Parse defensively. This file is written by a separate short-lived process, so
 * a torn or hand-edited read must yield null rather than throw into the server.
 */
export function parseLimits(text: string): RateLimits | null {
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) return null
    const rec = raw as Record<string, unknown>
    if (!Number.isFinite(rec.at)) return null
    const fiveHour = readWindow(rec.fiveHour)
    const sevenDay = readWindow(rec.sevenDay)
    if (!fiveHour && !sevenDay) return null
    const out: RateLimits = { at: rec.at as number }
    if (fiveHour) out.fiveHour = fiveHour
    if (sevenDay) out.sevenDay = sevenDay
    return out
  } catch {
    return null
  }
}

export class RateLimitWatcher implements LimitsApi {
  #limits: RateLimits | null = null
  #listeners = new Set<(limits: RateLimits | null) => void>()
  #watcher: FSWatcher | null = null
  #debounce: NodeJS.Timeout | null = null
  #poll: NodeJS.Timeout | null = null
  #mtime = 0

  constructor(
    private readonly file: string = LIMITS_FILE,
    private readonly pollMs: number = POLL_MS,
  ) {}

  current(): RateLimits | null {
    return this.#limits
  }

  onChange(fn: (limits: RateLimits | null) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  start(): void {
    this.#reload()
    /*
     * Watch the directory, not the file. The bridge writes to a temp file and
     * renames over the target, which swaps the inode — a watch bound to the
     * file goes deaf after the very first update.
     */
    try {
      this.#watcher = watch(dirname(this.file), () => this.#schedule())
    } catch {
      // Directory does not exist yet: the bridge is not installed. The poll
      // below will pick it up if that changes.
    }
    this.#poll = setInterval(() => this.#reload(), this.pollMs)
    this.#poll.unref?.()
  }

  stop(): void {
    this.#watcher?.close()
    this.#watcher = null
    if (this.#debounce) clearTimeout(this.#debounce)
    this.#debounce = null
    if (this.#poll) clearInterval(this.#poll)
    this.#poll = null
    this.#listeners.clear()
  }

  #schedule(): void {
    if (this.#debounce) clearTimeout(this.#debounce)
    this.#debounce = setTimeout(() => this.#reload(), DEBOUNCE_MS)
    this.#debounce.unref?.()
  }

  /** Read, and tell listeners only when the reading actually moved. */
  #reload(): void {
    let next: RateLimits | null = null
    try {
      // Cheap gate: on the poll path this is the only syscall most of the time.
      const mtime = statSync(this.file).mtimeMs
      if (mtime === this.#mtime) return
      this.#mtime = mtime
      next = parseLimits(readFileSync(this.file, 'utf8'))
    } catch {
      next = null
    }
    /*
     * A failed read leaves the last good value in place. The alternative —
     * blanking on a transient ENOENT during the bridge's rename — would make
     * the meters flicker out several times a second while agents are working.
     */
    if (next === null) return
    if (JSON.stringify(next) === JSON.stringify(this.#limits)) return
    this.#limits = next
    for (const fn of this.#listeners) fn(next)
  }
}
