/** C1: which cards may say an API error stopped them, and when the fleet says it once. */
import { describe, expect, it } from 'vitest'
import { grouped, visibleAgents, type FleetState } from '../src/web/lib/filter.ts'
import { stopOf, stoppedGroup } from '../src/web/lib/stopped.ts'
import type { Agent, StopCause } from '../src/shared/types.ts'

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

const stopped = (sessionId: string, cause: StopCause, stoppedAt = 1_000): Agent =>
  agent({ sessionId, stoppedBy: { cause, at: stoppedAt } })

const state = (over: Partial<FleetState> = {}): FleetState => ({
  query: '',
  filter: 'all',
  sort: 'recent',
  dir: 'desc',
  kinds: 'claude',
  ...over,
})

describe('C1 INV-11 only an idle card carries the stop', () => {
  it('reads it on an idle card and nowhere else', () => {
    const stop = { cause: 'rate_limit', at: 5 } as const
    expect(stopOf(agent({ sessionId: 'i', stoppedBy: stop }))).toEqual(stop)
    expect(stopOf(agent({ sessionId: 'b', status: 'busy', stoppedBy: stop }))).toBeNull()
    expect(stopOf(agent({ sessionId: 'w', status: 'waiting', stoppedBy: stop }))).toBeNull()
    expect(stopOf(agent({ sessionId: 'n' }))).toBeNull()
  })
})

describe('C1 the strip appears only for one shared cause on two or more cards', () => {
  it('groups cards that share a cause, from the earliest stop', () => {
    const fleet = [
      stopped('a', 'authentication_failed', 300),
      stopped('b', 'authentication_failed', 100),
      agent({ sessionId: 'c' }),
    ]
    expect(stoppedGroup(fleet)).toEqual({ cause: 'authentication_failed', count: 2, since: 100 })
  })

  it('has nothing to say for one card', () => {
    expect(stoppedGroup([stopped('a', 'rate_limit')])).toBeNull()
  })

  it('leaves mixed causes to the cards, even when one group is the larger', () => {
    const mixed = [
      stopped('a', 'authentication_failed'),
      stopped('b', 'authentication_failed'),
      stopped('c', 'rate_limit'),
    ]
    expect(stoppedGroup(mixed)).toBeNull()
  })

  it('counts only cards that may show the marker', () => {
    const fleet = [stopped('a', 'server_error'), agent({ ...stopped('b', 'server_error'), status: 'busy' })]
    expect(stoppedGroup(fleet)).toBeNull()
  })
})

describe('C1 tapping the strip narrows the list to those cards', () => {
  const fleet = [
    stopped('a', 'authentication_failed'),
    stopped('b', 'authentication_failed'),
    agent({ sessionId: 'c' }),
    agent({ sessionId: 'd', status: 'busy' }),
  ]

  it('shows only the stopped cards', () => {
    const shown = visibleAgents(fleet, state({ stopped: 'authentication_failed' }))
    expect(shown.map((a) => a.sessionId)).toEqual(['a', 'b'])
  })

  it('opens up again when the strip is gone, so the list is never stranded', () => {
    const recovered = fleet.map((a) => (a.sessionId === 'b' ? agent({ sessionId: 'b' }) : a))
    const shown = visibleAgents(recovered, state({ stopped: 'authentication_failed' }))
    expect(shown.map((a) => a.sessionId)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('leaves the groups intact', () => {
    const groups = grouped(fleet, state({ stopped: 'authentication_failed' }))
    expect(groups.map((g) => g.key)).toEqual(['idle'])
  })
})
