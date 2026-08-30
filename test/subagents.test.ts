/**
 * INV-13: a subagent tree claims only what the sidecars say.
 *
 * The structure is not derived here — Claude Code writes it down, one small
 * `agent-<id>.meta.json` beside every delegate transcript. What this file pins
 * is the two places that judgement still enters: how a tree is rebuilt when a
 * sidecar is missing or malformed, and how much a node's state is allowed to
 * claim.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { forgetSidecars, readTree } from '../src/server/subagents.ts'
import type { Agent } from '../src/shared/types.ts'

const NOW = 1_786_600_000_000

const agent = (over: Partial<Agent> = {}): Agent => ({
  sessionId: 'sess-1',
  pid: 1,
  name: 'agent',
  cwd: '/x',
  folder: 'x',
  status: 'idle',
  agentKind: 'claude',
  kind: 'interactive',
  startedAt: 0,
  paneId: '%1',
  ...over,
})

interface Fixture {
  id: string
  meta?: Record<string, unknown> | string
  wroteAgo?: number
  bytes?: number
}

/** A project directory holding one session's transcript and its delegates. */
async function project(fixtures: Fixture[], sessionId = 'sess-1'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-commander-tree-'))
  const transcript = join(root, `${sessionId}.jsonl`)
  await writeFile(transcript, '')
  const dir = join(root, sessionId, 'subagents')
  await mkdir(dir, { recursive: true })
  for (const f of fixtures) {
    await writeFile(join(dir, `agent-${f.id}.jsonl`), 'x'.repeat(f.bytes ?? 10))
    if (f.meta !== undefined) {
      const body = typeof f.meta === 'string' ? f.meta : JSON.stringify(f.meta)
      await writeFile(join(dir, `agent-${f.id}.meta.json`), body)
    }
    // Age is what separates `active` from `quiet`, so it has to be settable.
    if (f.wroteAgo !== undefined) {
      const at = new Date(NOW - f.wroteAgo)
      const { utimes } = await import('node:fs/promises')
      await utimes(join(dir, `agent-${f.id}.jsonl`), at, at)
    }
  }
  return transcript
}

beforeEach(() => {
  // Sidecars are cached by path for the life of the process; two fixtures in
  // one run must not see each other's.
  forgetSidecars()
})

describe('INV-13 structure comes from the sidecars', () => {
  it('builds a three-deep tree from parentAgentId', async () => {
    const transcript = await project([
      { id: 'a1', meta: { agentType: 'qa-bar-raiser', description: 'sweep', spawnDepth: 1 } },
      {
        id: 'a2',
        meta: { agentType: 'general-purpose', description: 'dig', spawnDepth: 2, parentAgentId: 'a1' },
      },
      {
        id: 'a3',
        meta: { agentType: 'Explore', description: 'read', spawnDepth: 3, parentAgentId: 'a2' },
      },
    ])

    const tree = await readTree(agent(), transcript, NOW)

    expect(tree.children).toHaveLength(1)
    expect(tree.children[0]).toMatchObject({ agentId: 'a1', agentType: 'qa-bar-raiser' })
    expect(tree.children[0]?.children[0]).toMatchObject({ agentId: 'a2', depth: 2 })
    expect(tree.children[0]?.children[0]?.children[0]).toMatchObject({ agentId: 'a3', depth: 3 })
  })

  /*
   * The one structural judgement call, and it goes the safe way. A sidecar that
   * is missing or half-written takes its whole subtree with it if children are
   * only ever attached to a parent that exists — and silently losing a branch
   * of somebody's work is a worse failure than showing it at the wrong depth
   * (INV-5). It is marked so the view can say what happened.
   */
  it('raises an orphan to the top rather than dropping it', async () => {
    const transcript = await project([
      { id: 'a9', meta: { agentType: 'Explore', description: 'sweep', spawnDepth: 2, parentAgentId: 'gone' } },
    ])

    const tree = await readTree(agent(), transcript, NOW)

    expect(tree.children).toHaveLength(1)
    expect(tree.children[0]).toMatchObject({ agentId: 'a9', reparented: true })
  })

  /*
   * Real sidecars cannot describe a loop — `spawnDepth` only ever increases —
   * but nothing validates these files, and a loop is the one malformed shape
   * that loses data *silently*: two nodes naming each other land in each
   * other's `children`, neither is a root, and the whole branch vanishes from
   * the view with no error anywhere.
   */
  it('raises a parent loop to the top rather than losing both nodes', async () => {
    const transcript = await project([
      { id: 'x', meta: { agentType: 'a', description: 'x', spawnDepth: 2, parentAgentId: 'y' } },
      { id: 'y', meta: { agentType: 'b', description: 'y', spawnDepth: 2, parentAgentId: 'x' } },
    ])

    const tree = await readTree(agent(), transcript, NOW)

    // Both still reachable, and one of them broke the loop by being raised.
    const seen: string[] = []
    const walk = (nodes: typeof tree.children): void => {
      for (const n of nodes) {
        seen.push(n.agentId)
        walk(n.children)
      }
    }
    walk(tree.children)
    expect(seen.sort()).toEqual(['x', 'y'])
    expect(tree.children.some((c) => c.reparented === true)).toBe(true)
  })

  it('does not attach a delegate to itself', async () => {
    const transcript = await project([
      { id: 'self', meta: { agentType: 'a', description: 'x', spawnDepth: 2, parentAgentId: 'self' } },
    ])

    const tree = await readTree(agent(), transcript, NOW)

    expect(tree.children).toHaveLength(1)
    expect(tree.children[0]).toMatchObject({ agentId: 'self', reparented: true })
    expect(tree.children[0]?.children).toHaveLength(0)
  })

  it('keeps the rest of a tree when one sidecar is malformed', async () => {
    const transcript = await project([
      { id: 'good', meta: { agentType: 'qa-triage', description: 'check', spawnDepth: 1 } },
      { id: 'torn', meta: '{"agentType":"gener' },
    ])

    const tree = await readTree(agent(), transcript, NOW)

    expect(tree.children.map((c) => c.agentId)).toEqual(['good'])
  })

  // Observed variants: a forked skill carries `name` and no `agentType`, and a
  // killed delegate carries `stoppedByUser`.
  it('reads a forked skill and a stopped delegate', async () => {
    const transcript = await project([
      { id: 'fork', meta: { name: 'code-review', description: 'review', spawnDepth: 1, isFork: true } },
      { id: 'kill', meta: { agentType: 'Explore', description: 'x', spawnDepth: 1, stoppedByUser: true } },
    ])

    const tree = await readTree(agent(), transcript, NOW)
    const byId = new Map(tree.children.map((c) => [c.agentId, c]))

    expect(byId.get('fork')?.agentType).toBe('code-review')
    expect(byId.get('kill')).toMatchObject({ stoppedByUser: true, state: 'done' })
  })

  it('returns an empty tree rather than throwing when nothing was delegated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-commander-tree-'))
    const transcript = join(root, 'sess-1.jsonl')
    await writeFile(transcript, '')

    const tree = await readTree(agent(), transcript, NOW)

    expect(tree).toMatchObject({ sessionId: 'sess-1', children: [] })
    expect(tree.unknown).toBeUndefined()
  })

  /*
   * INV-11's rule, which is why this is not the same answer as the one above.
   * The files this reads are written by Claude Code, so for a CLI that keeps no
   * transcript there is nothing to read — and "has not delegated" would be a
   * claim nobody checked.
   */
  it('reports unknown, not empty, for a CLI that keeps no transcript', async () => {
    const tree = await readTree(agent({ agentKind: 'kiro' }), null, NOW)

    expect(tree).toMatchObject({ children: [], unknown: true })
  })
})

describe('INV-13 a state claims only what is known', () => {
  const busy = agent({ status: 'busy' })

  /*
   * `active` is a guess: a recent write plus a busy parent. It is marked as one
   * so the view can never draw it beside an evidenced `done` as an equal — the
   * same device the fleet card uses for `statusInferred`.
   */
  it('marks a recently written delegate of a busy agent as inferred', async () => {
    const transcript = await project([
      { id: 'a1', meta: { agentType: 'x', description: 'y', spawnDepth: 1 }, wroteAgo: 3_000 },
    ])

    const tree = await readTree(busy, transcript, NOW)

    expect(tree.children[0]).toMatchObject({ state: 'active', stateInferred: true })
  })

  /*
   * The rule that removed a feature elsewhere in this app, applied here. An
   * agent that finished and an agent that died both stop writing, and no
   * timestamp separates them — so silence is `quiet`, never `done`.
   */
  it('calls a long-silent delegate quiet, never done', async () => {
    const transcript = await project([
      { id: 'a1', meta: { agentType: 'x', description: 'y', spawnDepth: 1 }, wroteAgo: 30 * 60_000 },
    ])

    const tree = await readTree(busy, transcript, NOW)

    expect(tree.children[0]?.state).toBe('quiet')
    expect(tree.children[0]?.stateInferred).toBeUndefined()
  })

  // A parent that is not working cannot have a delegate that is, however
  // recently that delegate's file was touched.
  it('does not call a delegate active while its parent is idle', async () => {
    const transcript = await project([
      { id: 'a1', meta: { agentType: 'x', description: 'y', spawnDepth: 1 }, wroteAgo: 1_000 },
    ])

    const tree = await readTree(agent({ status: 'idle' }), transcript, NOW)

    expect(tree.children[0]?.state).toBe('quiet')
  })

  it('reports transcript size as a size', async () => {
    const transcript = await project([
      { id: 'a1', meta: { agentType: 'x', description: 'y', spawnDepth: 1 }, bytes: 4096 },
    ])

    const tree = await readTree(busy, transcript, NOW)

    expect(tree.children[0]?.bytes).toBe(4096)
  })
})
