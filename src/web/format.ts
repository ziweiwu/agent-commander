import type { Agent } from '../shared/types.ts'

export function ago(at: number | undefined, now = Date.now()): string {
  if (!at) return '—'
  const secs = Math.max(0, Math.round((now - at) / 1000))
  if (secs < 10) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Compact elapsed time, e.g. "2h 05m" — used for how long a session has been up. */
export function uptime(startedAt: number | undefined, now = Date.now()): string {
  if (!startedAt) return ''
  const secs = Math.max(0, Math.round((now - startedAt) / 1000))
  const days = Math.floor(secs / 86_400)
  if (days >= 1) return `${days}d ${Math.floor((secs % 86_400) / 3600)}h`
  const hours = Math.floor(secs / 3600)
  const mins = Math.floor((secs % 3600) / 60)
  if (hours >= 1) return `${hours}h ${String(mins).padStart(2, '0')}m`
  return `${mins}m`
}

export function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "Today" / "Yesterday" / a date, used as a separator in the conversation. */
export function dayLabel(at: number, now = Date.now()): string {
  const day = (ms: number): number => {
    const d = new Date(ms)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const diff = Math.round((day(now) - day(at)) / 86_400_000)
  if (diff <= 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function tokens(n: number | undefined): string {
  if (!n) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function statusLabel(agent: Agent): string {
  if (agent.status === 'waiting') return agent.waitingFor ? `waiting · ${agent.waitingFor}` : 'waiting'
  return agent.status
}

/** Shorten a home-relative path for display. */
export function tildePath(path: string): string {
  const match = /^\/(?:Users|home)\/[^/]+/.exec(path)
  return match ? `~${path.slice(match[0].length)}` : path
}

/**
 * The label for the folder chip.
 *
 * Several sessions typically run straight from the home directory, where the
 * basename is the username and tells you nothing. Showing `~` is both shorter
 * and more honest about the fact that they are not scoped to a project.
 */
export function folderLabel(agent: Agent): string {
  const short = tildePath(agent.cwd)
  if (short === '~') return '~'
  return short.startsWith('~/') ? agent.folder : short
}

export const GROUPS = [
  { key: 'waiting', title: 'Needs you', statuses: ['waiting'] },
  { key: 'busy', title: 'Working', statuses: ['busy'] },
  { key: 'idle', title: 'Idle', statuses: ['idle', 'unknown'] },
] as const

export type GroupKey = (typeof GROUPS)[number]['key']

/** Does this agent match the free-text filter? */
export function matches(agent: Agent, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [agent.name, agent.cwd, agent.folder, agent.gitBranch, agent.activity, agent.status]
    .filter((v): v is string => typeof v === 'string')
    .some((v) => v.toLowerCase().includes(q))
}
