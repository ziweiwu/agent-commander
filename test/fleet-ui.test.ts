/**
 * Pure logic behind the fleet list: filtering, grouping, and the labels that
 * make nine similar-looking sessions distinguishable.
 */
import { describe, expect, it } from 'vitest'
import { countByGroup, visibleAgents, type FleetState } from '../src/web/fleet.ts'
import { ago, folderLabel, matches, tildePath, tokens, uptime } from '../src/web/format.ts'
import type { Agent } from '../src/shared/types.ts'

const agent = (over: Partial<Agent> & { sessionId: string }): Agent => ({
  pid: 1,
  name: over.sessionId,
  cwd: '/Users/me',
  folder: 'me',
  status: 'idle',
  kind: 'interactive',
  startedAt: 0,
  ...over,
})

const FLEET: Agent[] = [
  agent({ sessionId: 'a', name: 'blog-redesign', status: 'waiting', cwd: '/Users/me/Projects/blog', folder: 'blog' }),
  agent({ sessionId: 'b', name: 'monitor-50', status: 'busy', gitBranch: 'fix/locale', activity: 'Task → sweep' }),
  agent({ sessionId: 'c', name: 'ziweiwu-db', status: 'idle' }),
  agent({ sessionId: 'd', name: 'lego-scraper', status: 'idle', cwd: '/Users/me/Projects/lego-deals', folder: 'lego-deals' }),
  agent({ sessionId: 'e', name: 'odd-one', status: 'unknown' }),
]

const state = (over: Partial<FleetState> = {}): FleetState => ({ query: '', filter: 'all', ...over })

describe('countByGroup', () => {
  it('counts each group, folding unknown in with idle', () => {
    expect(countByGroup(FLEET)).toEqual({ waiting: 1, busy: 1, idle: 3 })
  })
})

describe('visibleAgents', () => {
  it('returns everything by default', () => {
    expect(visibleAgents(FLEET, state())).toHaveLength(5)
  })

  it('filters by status group', () => {
    expect(visibleAgents(FLEET, state({ filter: 'waiting' })).map((a) => a.sessionId)).toEqual(['a'])
    expect(visibleAgents(FLEET, state({ filter: 'idle' })).map((a) => a.sessionId)).toEqual(['c', 'd', 'e'])
  })

  it('filters by name, folder, branch and activity text', () => {
    expect(visibleAgents(FLEET, state({ query: 'lego' })).map((a) => a.sessionId)).toEqual(['d'])
    expect(visibleAgents(FLEET, state({ query: 'locale' })).map((a) => a.sessionId)).toEqual(['b'])
    expect(visibleAgents(FLEET, state({ query: 'sweep' })).map((a) => a.sessionId)).toEqual(['b'])
  })

  it('ignores case and surrounding whitespace', () => {
    expect(visibleAgents(FLEET, state({ query: '  LEGO ' })).map((a) => a.sessionId)).toEqual(['d'])
  })

  it('combines the status filter with the query', () => {
    expect(visibleAgents(FLEET, state({ filter: 'idle', query: 'lego' })).map((a) => a.sessionId)).toEqual(['d'])
    expect(visibleAgents(FLEET, state({ filter: 'busy', query: 'lego' }))).toEqual([])
  })
})

describe('matches', () => {
  it('matches on status so "waiting" is typeable', () => {
    expect(matches(FLEET[0] as Agent, 'waiting')).toBe(true)
  })

  it('does not match unrelated text', () => {
    expect(matches(FLEET[0] as Agent, 'zzz')).toBe(false)
  })
})

describe('folderLabel', () => {
  // Five sessions typically run from home, where the basename is the username
  // and distinguishes nothing.
  it('shows ~ for a session running in the home directory', () => {
    expect(folderLabel(agent({ sessionId: 'x', cwd: '/Users/me', folder: 'me' }))).toBe('~')
  })

  it('shows the project name for a session inside home', () => {
    expect(folderLabel(agent({ sessionId: 'x', cwd: '/Users/me/Projects/blog', folder: 'blog' }))).toBe('blog')
  })

  it('shows the full path when it is outside home', () => {
    expect(folderLabel(agent({ sessionId: 'x', cwd: '/opt/src', folder: 'src' }))).toBe('/opt/src')
  })
})

describe('tildePath', () => {
  it('abbreviates the home directory', () => {
    expect(tildePath('/Users/me/Projects/x')).toBe('~/Projects/x')
    expect(tildePath('/home/me/x')).toBe('~/x')
  })

  it('leaves other paths alone', () => {
    expect(tildePath('/opt/src')).toBe('/opt/src')
  })
})

describe('uptime', () => {
  const now = 1_000_000_000

  it('formats minutes, hours and days', () => {
    expect(uptime(now - 5 * 60_000, now)).toBe('5m')
    expect(uptime(now - (2 * 3600 + 5 * 60) * 1000, now)).toBe('2h 05m')
    expect(uptime(now - 26 * 3600 * 1000, now)).toBe('1d 2h')
  })

  it('returns empty for a missing start time', () => {
    expect(uptime(undefined, now)).toBe('')
  })
})

describe('ago', () => {
  const now = 1_000_000_000

  it('reads naturally across scales', () => {
    expect(ago(now - 3000, now)).toBe('just now')
    expect(ago(now - 30_000, now)).toBe('30s ago')
    expect(ago(now - 5 * 60_000, now)).toBe('5m ago')
    expect(ago(now - 3 * 3600_000, now)).toBe('3h ago')
    expect(ago(now - 2 * 86_400_000, now)).toBe('2d ago')
  })
})

describe('tokens', () => {
  it('abbreviates thousands and millions', () => {
    expect(tokens(950)).toBe('950')
    expect(tokens(48_120)).toBe('48.1k')
    expect(tokens(2_400_000)).toBe('2.4M')
  })

  it('renders nothing for zero or missing counts', () => {
    expect(tokens(0)).toBe('')
    expect(tokens(undefined)).toBe('')
  })
})
