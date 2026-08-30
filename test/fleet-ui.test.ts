/**
 * Pure logic behind the fleet list: filtering, grouping, and the labels that
 * make nine similar-looking sessions distinguishable.
 */
import { describe, expect, it } from 'vitest'
import { countByGroup, grouped, sortAgents, visibleAgents, type FleetState } from '../src/web/lib/filter.ts'
import { matches, relative, tildePath, tokens, uptimeParts } from '../src/web/lib/format.ts'
import { formatRelative, formatUptime } from '../src/web/lib/i18n.ts'
import type { Agent } from '../src/shared/types.ts'

const agent = (over: Partial<Agent> & { sessionId: string }): Agent => ({
  pid: 1,
  name: over.sessionId,
  cwd: '/Users/me',
  folder: 'me',
  status: 'idle',
  agentKind: 'claude',
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

const state = (over: Partial<FleetState> = {}): FleetState => ({
  query: '',
  filter: 'all',
  sort: 'recent',
  dir: 'desc',
  ...over,
})

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
  const en = (at: number | undefined) => formatUptime('en', uptimeParts(at, now))

  it('formats minutes, hours and days', () => {
    expect(en(now - 5 * 60_000)).toBe('5m')
    expect(en(now - (2 * 3600 + 5 * 60) * 1000)).toBe('2h 05m')
    expect(en(now - 26 * 3600 * 1000)).toBe('1d 2h')
  })

  it('returns empty for a missing start time', () => {
    expect(en(undefined)).toBe('')
  })

  // Word order differs, which is why the parts are structured rather than strings.
  it('reads naturally in Chinese', () => {
    expect(formatUptime('zh-CN', uptimeParts(now - 2 * 3600_000, now))).toBe('2 小时 0 分')
    expect(formatUptime('zh-CN', uptimeParts(now - 5 * 60_000, now))).toBe('5 分钟')
  })
})

describe('relative time', () => {
  const now = 1_000_000_000
  const en = (at: number) => formatRelative('en', relative(at, now))
  const zh = (at: number) => formatRelative('zh-CN', relative(at, now))

  it('reads naturally across scales', () => {
    expect(en(now - 3000)).toBe('just now')
    expect(en(now - 30_000)).toBe('30s ago')
    expect(en(now - 5 * 60_000)).toBe('5m ago')
    expect(en(now - 3 * 3600_000)).toBe('3h ago')
    expect(en(now - 2 * 86_400_000)).toBe('2d ago')
  })

  it('reads naturally in Chinese', () => {
    expect(zh(now - 3000)).toBe('刚刚')
    expect(zh(now - 5 * 60_000)).toBe('5 分钟前')
    expect(zh(now - 2 * 86_400_000)).toBe('2 天前')
  })

  it('returns nothing when there is no timestamp', () => {
    expect(formatRelative('en', relative(undefined, now))).toBe('')
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

describe('sortAgents', () => {
  const now = Date.now()
  const make = (name: string, over: Partial<Agent> = {}): Agent =>
    agent({ sessionId: name, name, ...over })

  it('orders by most recent activity by default', () => {
    const list = [
      make('old', { lastActivityAt: now - 60_000 }),
      make('new', { lastActivityAt: now - 1000 }),
      make('mid', { lastActivityAt: now - 10_000 }),
    ]
    expect(sortAgents(list, 'recent').map((a) => a.name)).toEqual(['new', 'mid', 'old'])
  })

  it('orders by token spend, biggest first', () => {
    const list = [make('small', { tokens: 100 }), make('big', { tokens: 90_000 })]
    expect(sortAgents(list, 'tokens').map((a) => a.name)).toEqual(['big', 'small'])
  })

  it('orders by duration, longest-running first', () => {
    const list = [
      make('young', { startedAt: now - 60_000 }),
      make('ancient', { startedAt: now - 86_400_000 }),
    ]
    expect(sortAgents(list, 'duration').map((a) => a.name)).toEqual(['ancient', 'young'])
  })

  it('orders by name', () => {
    expect(sortAgents([make('beta'), make('alpha')], 'name').map((a) => a.name)).toEqual([
      'alpha',
      'beta',
    ])
  })

  // Unknown is not the same claim as zero: a session never prompted has no
  // spend, and ranking it as cheapest would be a lie. This has to hold in BOTH
  // directions — flipping the whole comparator sends unknowns to the top of
  // "least spent", which is exactly the bug this guards.
  it.each(['desc', 'asc'] as const)('puts agents missing the value last (%s)', (dir) => {
    const tokens = [make('none'), make('some', { tokens: 5 }), make('more', { tokens: 50 })]
    expect(sortAgents(tokens, 'tokens', dir).at(-1)?.name).toBe('none')

    const recent = [make('never'), make('did', { lastActivityAt: now })]
    expect(sortAgents(recent, 'recent', dir).at(-1)?.name).toBe('never')

    const started = [make('unknown', { startedAt: 0 }), make('known', { startedAt: now - 1000 })]
    expect(sortAgents(started, 'duration', dir).at(-1)?.name).toBe('unknown')
  })

  it('still orders the known values correctly around the unknown one', () => {
    const list = [make('none'), make('small', { tokens: 5 }), make('big', { tokens: 50 })]
    expect(sortAgents(list, 'tokens', 'asc').map((a) => a.name)).toEqual(['small', 'big', 'none'])
    expect(sortAgents(list, 'tokens', 'desc').map((a) => a.name)).toEqual(['big', 'small', 'none'])
  })

  it('breaks ties by name so the order never jitters between renders', () => {
    const list = [make('b', { tokens: 10 }), make('a', { tokens: 10 })]
    expect(sortAgents(list, 'tokens').map((a) => a.name)).toEqual(['a', 'b'])
  })

  it('does not mutate the array it was given', () => {
    const list = [make('b'), make('a')]
    sortAgents(list, 'name')
    expect(list.map((a) => a.name)).toEqual(['b', 'a'])
  })
})

describe('grouped with sorting', () => {
  const now = Date.now()
  it('sorts inside groups without letting a blocked agent sink', () => {
    const list = [
      agent({ sessionId: 'w', name: 'blocked', status: 'waiting', tokens: 1 }),
      agent({ sessionId: 'b1', name: 'cheap', status: 'busy', tokens: 10 }),
      agent({ sessionId: 'b2', name: 'costly', status: 'busy', tokens: 999, lastActivityAt: now }),
    ]
    const groups = grouped(list, state({ sort: 'tokens' }))
    expect(groups[0]?.key).toBe('waiting')
    expect(groups[1]?.agents.map((a) => a.name)).toEqual(['costly', 'cheap'])
  })
})

describe('sort direction', () => {
  const now = Date.now()
  const make = (name: string, over: Partial<Agent> = {}): Agent =>
    agent({ sessionId: name, name, ...over })

  it('reverses the primary comparison', () => {
    const list = [make('small', { tokens: 100 }), make('big', { tokens: 90_000 })]
    expect(sortAgents(list, 'tokens', 'desc').map((a) => a.name)).toEqual(['big', 'small'])
    expect(sortAgents(list, 'tokens', 'asc').map((a) => a.name)).toEqual(['small', 'big'])
  })

  it('reverses every key', () => {
    const list = [
      make('a', { lastActivityAt: now - 1000, startedAt: now - 1000 }),
      make('b', { lastActivityAt: now - 90_000, startedAt: now - 90_000 }),
    ]
    expect(sortAgents(list, 'recent', 'asc').map((a) => a.name)).toEqual(['b', 'a'])
    expect(sortAgents(list, 'duration', 'asc').map((a) => a.name)).toEqual(['a', 'b'])
    expect(sortAgents(list, 'name', 'asc').map((a) => a.name)).toEqual(['b', 'a'])
  })

  // Otherwise the list reshuffles between renders for equal values.
  it('keeps the name tiebreak ascending in both directions', () => {
    const tied = [make('b', { tokens: 10 }), make('a', { tokens: 10 })]
    expect(sortAgents(tied, 'tokens', 'desc').map((a) => a.name)).toEqual(['a', 'b'])
    expect(sortAgents(tied, 'tokens', 'asc').map((a) => a.name)).toEqual(['a', 'b'])
  })

  it('defaults to descending', () => {
    const list = [make('small', { tokens: 1 }), make('big', { tokens: 2 })]
    expect(sortAgents(list, 'tokens').map((a) => a.name)).toEqual(['big', 'small'])
  })

  it('still sorts within groups, never across them', () => {
    const list = [
      agent({ sessionId: 'w', name: 'blocked', status: 'waiting', tokens: 1 }),
      agent({ sessionId: 'b', name: 'busy-one', status: 'busy', tokens: 999 }),
    ]
    const groups = grouped(list, state({ sort: 'tokens', dir: 'asc' }))
    expect(groups[0]?.key).toBe('waiting')
  })
})
