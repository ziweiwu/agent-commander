import { specOf } from '../../shared/agent-kinds.ts'
import type { Agent, RateLimits } from '../../shared/types.ts'

/**
 * Time is returned as structured parts rather than English strings so the
 * wording lives in the dictionary. "5m ago" and "5 分钟前" put the number in
 * different places, which string concatenation cannot express.
 */
export interface Relative {
  unit: 'now' | 'sec' | 'min' | 'hour' | 'day'
  n: number
}

export function relative(at: number | undefined, now = Date.now()): Relative | null {
  if (!at) return null
  const secs = Math.max(0, Math.round((now - at) / 1000))
  if (secs < 10) return { unit: 'now', n: 0 }
  if (secs < 60) return { unit: 'sec', n: secs }
  const mins = Math.round(secs / 60)
  if (mins < 60) return { unit: 'min', n: mins }
  const hours = Math.round(mins / 60)
  if (hours < 24) return { unit: 'hour', n: hours }
  return { unit: 'day', n: Math.round(hours / 24) }
}

export interface Uptime {
  unit: 'day' | 'hour' | 'min'
  a: number
  b: number
}

export function uptimeParts(startedAt: number | undefined, now = Date.now()): Uptime | null {
  if (!startedAt) return null
  const secs = Math.max(0, Math.round((now - startedAt) / 1000))
  const days = Math.floor(secs / 86_400)
  if (days >= 1) return { unit: 'day', a: days, b: Math.floor((secs % 86_400) / 3600) }
  const hours = Math.floor(secs / 3600)
  const mins = Math.floor((secs % 3600) / 60)
  if (hours >= 1) return { unit: 'hour', a: hours, b: mins }
  return { unit: 'min', a: mins, b: 0 }
}

/**
 * Time remaining until `at`, in the shape `uptimeParts` already produces.
 *
 * A countdown is an uptime measured from now to then, so it renders through the
 * existing `formatUptime` and needs no second set of unit translations.
 *
 * Null at or past the reset: the window has rolled over but no session has
 * reported the new one yet, and "resetting" is the honest reading of that.
 * "0m" would claim a precision we do not have.
 */
export function countdownParts(at: number | undefined, now = Date.now()): Uptime | null {
  if (!at || at <= now) return null
  return uptimeParts(now, at)
}

/**
 * How full a quota window is. Three named steps rather than a raw percentage so
 * the colour is never the only thing carrying the state (WCAG 1.4.1).
 */
export type UsageLevel = 'normal' | 'high' | 'critical'

export function usageLevel(pct: number): UsageLevel {
  if (pct >= 90) return 'critical'
  if (pct >= 75) return 'high'
  return 'normal'
}

/**
 * The bridge only writes while a Claude Code session is rendering its footer,
 * so a quiet machine stops refreshing this. Past this age the meters are shown
 * dimmed and last-known rather than as current fact.
 */
export const LIMITS_STALE_MS = 20 * 60_000

export function limitsStale(limits: RateLimits, now = Date.now()): boolean {
  return now - limits.at > LIMITS_STALE_MS
}

export type DayMark = { kind: 'today' } | { kind: 'yesterday' } | { kind: 'date'; at: number }

export function dayMark(at: number, now = Date.now()): DayMark {
  const midnight = (ms: number): number => {
    const d = new Date(ms)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const diff = Math.round((midnight(now) - midnight(at)) / 86_400_000)
  if (diff <= 0) return { kind: 'today' }
  if (diff === 1) return { kind: 'yesterday' }
  return { kind: 'date', at }
}

export function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Token counts are digits in every language, so these stay plain. */
export function tokens(n: number | undefined): string {
  if (!n) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Shorten a home-relative path for display. */
export function tildePath(path: string): string {
  const match = /^\/(?:Users|home)\/[^/]+/.exec(path)
  return match ? `~${path.slice(match[0].length)}` : path
}

export const GROUPS = [
  { key: 'waiting', statuses: ['waiting'] },
  { key: 'busy', statuses: ['busy'] },
  { key: 'idle', statuses: ['idle', 'unknown'] },
] as const

export type GroupKey = (typeof GROUPS)[number]['key']

/**
 * Does this agent match the free-text filter?
 *
 * The kind is in here because it is on the card: typing `kiro` and being told
 * nothing matches, while a card two inches away wears a `Kiro` badge, is the
 * plainest kind of broken search there is. Both the id and the label are
 * checked, so `kiro` and `Kiro` find it and so would a future kind whose label
 * and id differ.
 */
export function matches(agent: Agent, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [
    agent.name,
    agent.cwd,
    agent.folder,
    agent.gitBranch,
    agent.activity,
    agent.running?.command,
    agent.status,
    agent.agentKind,
    specOf(agent.agentKind)?.label,
  ]
    .filter((v): v is string => typeof v === 'string')
    .some((v) => v.toLowerCase().includes(q))
}
