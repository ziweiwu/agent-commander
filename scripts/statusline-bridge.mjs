#!/usr/bin/env node
/**
 * Claude Code statusLine bridge.
 *
 * Account-level quota — the 5-hour session window and the 7-day weekly window —
 * never lands in a transcript. `~/.claude/projects/*.jsonl` carries per-request
 * token counts and nothing else, so the tailer in src/server/transcript.ts has
 * no way to see it. The one place Claude Code hands it out is the statusLine
 * command's stdin, which is why this file exists: it is a status line whose real
 * job is to spill `rate_limits` to a file the server can watch.
 *
 * Node rather than Python — the repo's usual default for scripts — though not
 * for speed: measured on this machine Python starts in ~45ms and Node in ~80ms,
 * so Python would actually be the cheaper interpreter, and both are well inside
 * a render Claude Code does out of band. The reason is agreement. This file and
 * src/server/limits.ts have to hold the identical path and the identical JSON
 * shape forever, and a cross-language pair is exactly where that rots. Keeping
 * it as `scripts/*.mjs` also keeps it inside the repo's typecheck and lint.
 *
 * Install with `agent-commander --install-statusline`, or by hand:
 *   "statusLine": { "type": "command", "command": "node <repo>/scripts/statusline-bridge.mjs" }
 */
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CACHE_DIR = join(homedir(), '.claude', 'agent-commander')
export const CACHE_FILE = join(CACHE_DIR, 'rate-limits.json')
/**
 * One file per session, named by `session_id`, for the figures that are
 * per-session rather than per-account: how full the context window is and
 * what the session has cost. `rust/src/usage.rs` reads them. The docs endorse
 * exactly this key — "stable for the lifetime of a session and unique per
 * session" — where a pid would change on every render.
 */
export const SESSIONS_DIR = join(CACHE_DIR, 'sessions')

/**
 * One window, normalised.
 *
 * `resets_at` is epoch *seconds* on the wire and epoch *milliseconds*
 * everywhere in this app. Converting here, once, means nothing downstream has
 * to remember which unit it is holding.
 */
function window(raw) {
  /*
   * `Number.isFinite`, not `typeof === 'number'`: JSON has no NaN literal but
   * it does have `1e999`, which parses to Infinity and is a number by every
   * check short of this one. Downstream that becomes a CSS width of
   * `Infinity%` and a meter reading "Infinity%".
   */
  if (!raw || !Number.isFinite(raw.used_percentage)) return undefined
  // Clamp rather than reject: a percentage slightly out of range is a
  // plausible rounding artefact upstream, and 103% is still worth showing as
  // "full". A NaN is not.
  const out = { pct: Math.max(0, Math.min(100, raw.used_percentage)) }
  if (Number.isFinite(raw.resets_at)) out.resetsAt = raw.resets_at * 1000
  return out
}

export function snapshot(input, now) {
  const limits = JSON.parse(input)?.rate_limits
  const fiveHour = window(limits?.five_hour)
  const sevenDay = window(limits?.seven_day)
  /*
   * Absent is not zero. `rate_limits` is missing for API-key users and for a
   * subscriber's session that has not had a response yet; writing {} for those
   * would replace a good reading with a fake one that says the quota is
   * untouched. Returning null means "leave the cache alone".
   */
  if (!fiveHour && !sevenDay) return null
  const out = { at: now }
  if (fiveHour) out.fiveHour = fiveHour
  if (sevenDay) out.sevenDay = sevenDay
  return out
}

/**
 * The per-session figures, or null when the frame carries none.
 *
 * `context_window.used_percentage` is input tokens over `context_window_size`
 * as the CLI computes it, and may be null early in a session and again right
 * after `/compact`; `cost.total_cost_usd` is the CLI's own list-price estimate.
 * Either alone is worth writing; neither means leave the file alone, for the
 * reason `snapshot` gives — absent is not zero.
 *
 * The id has to be a file name. Anything that is not letters, digits, `-`,
 * `_` or `.` is refused here and again by the reader, because a `..` in a
 * field this app did not write would name a path outside the directory.
 */
export function sessionUsage(input, now) {
  const frame = JSON.parse(input)
  const id = frame?.session_id
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id)) return null
  const out = { sessionId: id, at: now }
  const ctx = frame.context_window
  if (Number.isFinite(ctx?.used_percentage)) {
    out.contextPct = Math.max(0, Math.min(100, ctx.used_percentage))
  }
  if (Number.isFinite(ctx?.context_window_size)) out.contextSize = ctx.context_window_size
  const cost = frame.cost?.total_cost_usd
  if (Number.isFinite(cost) && cost >= 0) out.costUsd = cost
  if (out.contextPct === undefined && out.costUsd === undefined) return null
  return out
}

/** The same tmp-and-rename as `persist`, into the session's own file. */
export function persistSession(usage, dir = SESSIONS_DIR) {
  persist(usage, dir, join(dir, `${usage.sessionId}.json`))
}

export function render(snap) {
  if (!snap) return ''
  const parts = []
  if (snap.fiveHour) parts.push(`5h ${Math.round(snap.fiveHour.pct)}%`)
  if (snap.sevenDay) parts.push(`7d ${Math.round(snap.sevenDay.pct)}%`)
  return parts.length > 0 ? `⮕ ${parts.join('  ·  ')}` : ''
}

/**
 * Write via a pid-suffixed temp file and rename. Every live session runs this
 * command, so several writers overlap constantly; rename is atomic on the same
 * filesystem, so the watcher never reads a half-written file. Last write wins,
 * which is what we want — every session on one account reports the same
 * account-level numbers.
 */
export function persist(snap, dir = CACHE_DIR, file = CACHE_FILE) {
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(snap))
  renameSync(tmp, file)
}

async function main() {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) input += chunk

  const now = Date.now()
  // Each write decides for itself; a frame with no quota still has a context.
  const usage = sessionUsage(input, now)
  if (usage) persistSession(usage)
  const snap = snapshot(input, now)
  if (!snap) return
  persist(snap)
  process.stdout.write(render(snap))
}

/**
 * Was this file run as the program, rather than imported by a test?
 *
 * Not `import.meta.url === \`file://${process.argv[1]}\``, which is the same
 * mistake that shipped a do-nothing binary in agent-commander 0.1.0 through
 * 0.1.3. A file URL is percent-encoded, so a repo living in `~/My Projects`
 * makes `import.meta.url` end in `My%20Projects` while argv[1] has a literal
 * space — the two never match, `main` never runs, and the quota meters simply
 * never appear. INV-10 says a bug in here must be invisible; that one is
 * invisible in the wrong direction, because there is nothing to see either way.
 */
function invokedDirectly() {
  const arg = process.argv[1]
  if (!arg) return false
  const here = fileURLToPath(import.meta.url)
  if (resolve(arg) === here) return true
  // A statusLine command reached through a dotfiles symlink is still this file.
  try {
    return realpathSync(arg) === realpathSync(here)
  } catch {
    return false
  }
}

/*
 * Even the question is asked inside a catch. This runs inside the render loop
 * of every live Claude Code session, and INV-10's whole point is that nothing
 * in here may put a stack trace in the footer of the user's working session.
 */
let direct = false
try {
  direct = invokedDirectly()
} catch {
  direct = false
}

if (direct) {
  /* A bad frame must never put a stack trace in the user's status line. */
  main().catch(() => {})
}
