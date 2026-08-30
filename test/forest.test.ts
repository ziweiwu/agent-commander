/**
 * Pure layout for the forest view: a session and everything it delegated, on
 * one shared logarithmic axis ending at now.
 *
 * What is pinned here is not the geometry — it is the claims. Every case below
 * is one the naive version got wrong: a mark drawn for a duration nobody knows
 * (INV-11), a delegate the fold hid precisely because it had stalled, a
 * summary that reads the freshest lane and goes blind as the family grows, and
 * an ending reported as a completion (INV-13).
 */
import { describe, expect, it } from 'vitest'
import {
  AXIS_CEIL_S,
  AXIS_FLOOR_S,
  MAX_LANES,
  buildForest,
  place,
  type Family,
} from '../src/web/lib/forest.ts'
import type { Agent, AgentTree, SubagentNode } from '../src/shared/types.ts'

const NOW = 1_786_600_000_000

const agoS = (secs: number): number => NOW - secs * 1000

const agent = (over: Partial<Agent> = {}): Agent => ({
  sessionId: 'sess-1',
  pid: 1,
  name: 'ziweiwu-35',
  cwd: '/Users/me',
  folder: 'me',
  status: 'idle',
  agentKind: 'claude',
  kind: 'interactive',
  startedAt: 0,
  lastActivityAt: agoS(4),
  ...over,
})

const node = (over: Partial<SubagentNode> & { agentId: string }): SubagentNode => ({
  agentType: 'general-purpose',
  description: 'do a thing',
  depth: 1,
  lastWriteAt: agoS(4),
  bytes: 100,
  state: 'quiet',
  children: [],
  ...over,
})

const tree = (children: SubagentNode[], over: Partial<AgentTree> = {}): AgentTree => ({
  sessionId: 'sess-1',
  children,
  ...over,
})

/** The one family the fixtures build, since every case below has a single agent. */
const familyOf = (session: Agent, trees: AgentTree[] = []): Family => {
  const [family] = buildForest([session], trees, NOW)
  if (!family) throw new Error('buildForest returned no family')
  return family
}

const keys = (family: Family): string[] => family.lanes.map((lane) => lane.key)

describe('the axis', () => {
  it('puts now at the right-hand edge and six hours at the left', () => {
    expect(place(AXIS_FLOOR_S)).toBe(1)
    expect(place(AXIS_CEIL_S)).toBe(0)
  })

  it('clamps at both ends rather than running off the axis', () => {
    expect(place(0)).toBe(1)
    expect(place(AXIS_CEIL_S * 10)).toBe(0)
  })

  /*
   * The whole reason it is logarithmic: four orders of magnitude have to be on
   * screen at once, and on a linear axis every live lane collapses onto the
   * right-hand edge together — which is where the differences worth seeing are.
   */
  it('spends the same width on every factor of ten', () => {
    const first = place(10) - place(100)
    const second = place(100) - place(1000)
    expect(second).toBeCloseTo(first, 10)
  })
})

describe('INV-11 the forest never invents a duration', () => {
  it('gives a never-prompted session no duration rather than a duration of zero', () => {
    const family = familyOf(agent({ lastActivityAt: undefined }))
    expect(family.self.secs).toBeNull()
    expect(family.self.describe).toBe('ziweiwu-35, never prompted')
  })

  /*
   * An earlier draft guarded the session and not its delegates, so a delegate
   * with no write timestamp was drawn at the six-hour tick — a mark asserting
   * hours of silence about work nothing has heard anything about either way.
   */
  it('gives a never-written delegate no duration either', () => {
    const family = familyOf(agent(), [tree([node({ agentId: 'a', lastWriteAt: 0 })])])
    expect(family.lanes[0]?.secs).toBeNull()
    expect(family.lanes[0]?.describe).toContain('never prompted')
  })

  it('never parks a missing duration on the old edge, where it would claim silence', () => {
    const family = familyOf(agent({ lastActivityAt: undefined }), [
      tree([node({ agentId: 'a', lastWriteAt: 0 })]),
    ])
    expect(family.self.at).not.toBe(0)
    expect(family.lanes[0]?.at).not.toBe(0)
  })

  it('carries the state and the inferred marker into the accessible name', () => {
    const family = familyOf(agent(), [
      tree([
        node({
          agentId: 'a',
          agentType: 'qa-bar-raiser',
          state: 'active',
          stateInferred: true,
          lastWriteAt: agoS(4),
        }),
      ]),
    ])
    expect(family.lanes[0]?.describe).toBe(
      'qa-bar-raiser, writing (worked out, not reported), last wrote 4s ago',
    )
  })

  it('does not mark a reported state as worked out', () => {
    const family = familyOf(agent({ status: 'waiting' }))
    expect(family.self.state).toBe('blocked')
    expect(family.self.describe).toBe('ziweiwu-35, blocked, last wrote 4s ago')
  })

  it('marks an inferred session status the way the fleet card does', () => {
    const family = familyOf(agent({ status: 'busy', statusInferred: true }))
    expect(family.self.describe).toContain('writing (worked out, not reported)')
  })
})

describe('the session lane', () => {
  it('reads waiting as blocked, busy as writing, and everything else as quiet', () => {
    expect(familyOf(agent({ status: 'waiting' })).self.state).toBe('blocked')
    expect(familyOf(agent({ status: 'busy' })).self.state).toBe('writing')
    expect(familyOf(agent({ status: 'idle' })).self.state).toBe('quiet')
    expect(familyOf(agent({ status: 'unknown' })).self.state).toBe('quiet')
  })

  it('sits at depth 0 and carries no delegate label', () => {
    const family = familyOf(agent())
    expect(family.self.depth).toBe(0)
    expect(family.self.label).toBe('')
  })
})

describe('the fold', () => {
  /*
   * Folding the quietest folds exactly where a stall lives: a delegate that has
   * silently died IS the quietest one. Six fresh healthy delegates would bury
   * both of the anomalies below if recency picked the survivors.
   */
  const crowded = (): Family =>
    familyOf(agent(), [
      tree([
        node({ agentId: 'stopped-one', stoppedByUser: true, state: 'done', lastWriteAt: agoS(5) }),
        node({ agentId: 'orphan-one', reparented: true, lastWriteAt: agoS(5) }),
        ...[1, 2, 3, 4, 5, 6].map((n) =>
          node({ agentId: `fresh-${n}`, state: 'active', lastWriteAt: agoS(n) }),
        ),
      ]),
    ])

  it('surfaces a stopped delegate over fresher healthy ones', () => {
    expect(keys(crowded())).toContain('stopped-one')
  })

  it('surfaces an orphan over fresher healthy ones', () => {
    expect(keys(crowded())).toContain('orphan-one')
  })

  it('keeps the straggler the parent is waiting on', () => {
    expect(keys(crowded())).toContain('fresh-6')
  })

  it('never drops what it folds silently', () => {
    const family = crowded()
    expect(family.lanes).toHaveLength(MAX_LANES)
    expect(family.hidden).toBe(2)
    expect(family.total).toBe(9)
  })

  /*
   * The ranking chooses who is drawn; it does not choose the running order.
   * Indentation is only worth anything while a child still sits under its
   * parent, so the survivors go back into tree order and the component marks
   * the straggler where it stands.
   */
  it('keeps the two anomalies, the straggler and the freshest, in tree order', () => {
    expect(keys(crowded())).toEqual([
      'stopped-one',
      'orphan-one',
      'fresh-1',
      'fresh-2',
      'fresh-3',
      'fresh-6',
    ])
  })

  it('folds nothing when the family fits', () => {
    const family = familyOf(agent(), [tree([node({ agentId: 'a' })])])
    expect(family.hidden).toBe(0)
    expect(family.lanes).toHaveLength(1)
  })
})

describe('the straggler', () => {
  /*
   * A summary driven by min(secs) loses sensitivity as fan-out grows: a family
   * of 37 only looks quiet once the last of the 37 stops, so the card that
   * delegates hardest is the one that lies longest.
   */
  it('is the oldest unfinished delegate, not the oldest one', () => {
    const family = familyOf(agent(), [
      tree([
        node({ agentId: 'ancient-done', state: 'done', lastWriteAt: agoS(3 * 3600) }),
        node({ agentId: 'straggler', state: 'quiet', lastWriteAt: agoS(40 * 60) }),
        node({ agentId: 'fresh', state: 'active', lastWriteAt: agoS(5) }),
      ]),
    ])
    expect(family.stalled?.key).toBe('straggler')
  })

  it('is not a delegate the user stopped, which is an ending and not a stall', () => {
    const family = familyOf(agent(), [
      tree([
        node({ agentId: 'stopped', stoppedByUser: true, state: 'done', lastWriteAt: agoS(3600) }),
        node({ agentId: 'working', state: 'active', lastWriteAt: agoS(5) }),
      ]),
    ])
    expect(family.stalled?.key).toBe('working')
  })

  it('is nobody when a delegate that never wrote is the only candidate', () => {
    const family = familyOf(agent(), [tree([node({ agentId: 'a', lastWriteAt: 0 })])])
    expect(family.stalled).toBeNull()
  })

  it('is nobody in a family that has not delegated', () => {
    expect(familyOf(agent()).stalled).toBeNull()
  })
})

describe('the summary', () => {
  const busy = agent({ status: 'busy' })
  const active = (id: string): SubagentNode =>
    node({ agentId: id, state: 'active', lastWriteAt: agoS(5) })

  it('says writing, with no fraction, for a session working alone', () => {
    expect(familyOf(busy).summary).toBe('writing')
    expect(familyOf(busy).running).toBe(1)
  })

  it('says nothing is writing when nothing is', () => {
    expect(familyOf(agent({ status: 'idle' })).summary).toBe('nothing writing')
  })

  it('names the whole family rather than printing a fraction of itself', () => {
    const family = familyOf(busy, [tree([active('a'), active('b'), active('c')])])
    expect(family.summary).toBe('all 4 writing')
  })

  it('prints the fraction only when it is not whole', () => {
    const family = familyOf(busy, [
      tree([
        active('a'),
        active('b'),
        node({ agentId: 'c', state: 'quiet', lastWriteAt: agoS(5) }),
        node({ agentId: 'd', state: 'done', lastWriteAt: agoS(5) }),
      ]),
    ])
    expect(family.summary).toBe('3 of 5 writing')
  })

  it('counts hidden delegates too, so the fold cannot flatter a family', () => {
    const family = familyOf(busy, [
      tree([1, 2, 3, 4, 5, 6, 7, 8].map((n) => active(`a${n}`))),
    ])
    expect(family.hidden).toBe(2)
    expect(family.summary).toBe('all 9 writing')
  })

  it('appends the straggler once it has been silent ten minutes', () => {
    const family = familyOf(busy, [
      tree([active('a'), node({ agentId: 'b', state: 'quiet', lastWriteAt: agoS(40 * 60) })]),
    ])
    expect(family.summary).toBe('2 of 3 writing · one quiet 40m')
  })

  it('says nothing about a delegate that has merely paused to think', () => {
    const family = familyOf(busy, [
      tree([active('a'), node({ agentId: 'b', state: 'quiet', lastWriteAt: agoS(60) })]),
    ])
    expect(family.summary).toBe('2 of 3 writing')
  })
})

describe('INV-13 a lane claims only what the sidecars say', () => {
  it('does not read a delegate the user stopped as one that finished', () => {
    const family = familyOf(agent(), [
      tree([
        node({ agentId: 'a', agentType: 'researcher', stoppedByUser: true, state: 'done' }),
      ]),
    ])
    expect(family.lanes[0]?.state).toBe('stopped')
    expect(family.lanes[0]?.describe).toContain('stopped by the user')
    expect(family.lanes[0]?.describe).not.toContain('done')
  })

  it('still reads an evidenced ending as done', () => {
    const family = familyOf(agent(), [tree([node({ agentId: 'a', state: 'done' })])])
    expect(family.lanes[0]?.state).toBe('done')
  })

  it('never draws a quiet delegate as done', () => {
    const family = familyOf(agent(), [
      tree([node({ agentId: 'a', state: 'quiet', lastWriteAt: agoS(3600) })]),
    ])
    expect(family.lanes[0]?.state).toBe('quiet')
  })

  it('tells a tree it could not read apart from one with no delegates', () => {
    const unknown = familyOf(agent(), [tree([], { unknown: true })])
    const empty = familyOf(agent(), [tree([])])
    expect(unknown.unknownTree).toBe(true)
    expect(empty.unknownTree).toBe(false)
    expect(unknown.lanes).toEqual(empty.lanes)
  })

  it('marks a re-parented delegate rather than presenting it as a root', () => {
    const family = familyOf(agent(), [tree([node({ agentId: 'a', reparented: true, depth: 2 })])])
    expect(family.lanes[0]?.orphan).toBe(true)
    expect(family.lanes[0]?.describe).toContain('parent not found')
  })
})

describe('buildForest', () => {
  it('flattens depth first and keeps each delegate depth for indentation', () => {
    const family = familyOf(agent(), [
      tree([
        node({
          agentId: 'parent',
          depth: 1,
          lastWriteAt: agoS(1),
          children: [
            node({
              agentId: 'child',
              depth: 2,
              lastWriteAt: agoS(2),
              children: [node({ agentId: 'grandchild', depth: 3, lastWriteAt: agoS(3) })],
            }),
          ],
        }),
      ]),
    ])
    expect(keys(family)).toEqual(['parent', 'child', 'grandchild'])
    expect(family.lanes.map((lane) => lane.depth)).toEqual([1, 2, 3])
    expect(family.total).toBe(4)
  })

  /*
   * The fleet and the delegation graph are polled separately, so a family
   * arrives on screen before its tree does. That is one fewer delegate to draw,
   * never an exception (INV-5).
   */
  it('draws a family whose tree has not arrived yet', () => {
    const family = familyOf(agent(), [])
    expect(family.lanes).toEqual([])
    expect(family.unknownTree).toBe(false)
    expect(family.total).toBe(1)
  })

  it('matches each tree to its own session and keeps the caller order', () => {
    const families = buildForest(
      [agent({ sessionId: 'a', name: 'a' }), agent({ sessionId: 'b', name: 'b' })],
      [{ sessionId: 'b', children: [node({ agentId: 'only' })] }],
      NOW,
    )
    expect(families.map((f) => f.sessionId)).toEqual(['a', 'b'])
    expect(families[0]?.lanes).toEqual([])
    expect(families[1]?.lanes.map((lane) => lane.key)).toEqual(['only'])
  })
})
