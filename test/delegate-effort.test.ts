/**
 * INV-13: what a delegate *did*, as against what became of it.
 *
 * `quiet` is the honest answer about almost every delegate's outcome and will
 * stay that way — nothing on disk separates finished from dead. That makes it
 * uninformative on its own: a tree of seven quiet rows says nothing. These
 * measurements are what stop the row being empty of meaning, and the whole
 * point of them is that they are measurements: every case below is about
 * refusing to report a number that was not read.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { forgetEfforts, forgetSidecars, readTree } from '../src/server/subagents.ts'
import type { Agent, SubagentNode } from '../src/shared/types.ts'

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

const record = (iso: string, body: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: iso, ...body })

const turn = (iso: string, tools: number): string =>
  record(iso, {
    type: 'assistant',
    message: { content: Array.from({ length: tools }, () => ({ type: 'tool_use' })) },
  })

/** One session with one delegate, whose transcript is exactly `lines`. */
async function tree(lines: string[]): Promise<SubagentNode> {
  const root = await mkdtemp(join(tmpdir(), 'agent-commander-effort-'))
  const transcript = join(root, 'sess-1.jsonl')
  await writeFile(transcript, '')
  const dir = join(root, 'sess-1', 'subagents')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'agent-a1.jsonl'), lines.join('\n'))
  await writeFile(
    join(dir, 'agent-a1.meta.json'),
    JSON.stringify({ agentType: 'Explore', description: 'look', spawnDepth: 1 }),
  )
  const built = await readTree(agent(), transcript)
  return built.children[0] as SubagentNode
}

beforeEach(() => {
  forgetSidecars()
  forgetEfforts()
})

describe('INV-13 a delegate reports what it did, measured', () => {
  it('counts tool calls rather than turns', async () => {
    // One turn that called nine tools and one that called none are not the
    // same amount of work, and counting messages would say they were.
    const node = await tree([
      turn('2026-08-30T12:00:00.000Z', 9),
      turn('2026-08-30T12:01:00.000Z', 0),
    ])
    expect(node.calls).toBe(9)
  })

  it('measures the span between the first and last record', async () => {
    const node = await tree([
      record('2026-08-30T12:00:00.000Z', { type: 'user' }),
      turn('2026-08-30T12:13:00.000Z', 1),
    ])
    expect(node.workedMs).toBe(13 * 60_000)
  })

  // The span is read off the records, never off the file's mtime: a transcript
  // copied or touched would otherwise report a duration nobody worked.
  it('reports no span when nothing carries a timestamp', async () => {
    const node = await tree([JSON.stringify({ type: 'assistant', message: { content: [] } })])
    expect(node.calls).toBe(0)
    expect(node.workedMs).toBe(0)
  })
})

describe('INV-11 a number that was not read is not reported', () => {
  /*
   * The distinction this whole feature turns on. `0 calls` says "I read the
   * transcript and there were none"; nothing at all says "I could not read it".
   * Collapsing them would put a confident zero under a delegate that may have
   * done a great deal.
   */
  it('says nothing at all for a transcript it cannot parse', async () => {
    const node = await tree(['this is not json', 'neither is this'])
    expect(node.calls).toBeUndefined()
    expect(node.workedMs).toBeUndefined()
  })

  it('says nothing at all for an empty transcript', async () => {
    const node = await tree([])
    expect(node.calls).toBeUndefined()
  })

  it('still reports zero when it really did read a transcript with no calls', async () => {
    const node = await tree([record('2026-08-30T12:00:00.000Z', { type: 'user' })])
    expect(node.calls).toBe(0)
  })

  // A half-written last line is the normal state of a file being appended to.
  it('survives a partial trailing line', async () => {
    const node = await tree([turn('2026-08-30T12:00:00.000Z', 2), '{"type":"assis'])
    expect(node.calls).toBe(2)
  })
})

describe('INV-4 a transcript that cannot have changed is not re-read', () => {
  /*
   * The entire affordability argument. A delegate that has gone quiet never
   * writes again, so parsing it once and answering from memory is what keeps
   * this inside INV-4 — measured at 13 ms for seven delegates on the first pass
   * and nothing after it. Proven by rewriting the file *without* disturbing
   * either half of the cache key: a re-read would see the new content.
   */
  it('answers from cache while mtime and size are unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-commander-effort-'))
    const transcript = join(root, 'sess-1.jsonl')
    await writeFile(transcript, '')
    const dir = join(root, 'sess-1', 'subagents')
    await mkdir(dir, { recursive: true })
    const jsonl = join(dir, 'agent-a1.jsonl')
    await writeFile(jsonl, turn('2026-08-30T12:00:00.000Z', 3))
    await writeFile(
      join(dir, 'agent-a1.meta.json'),
      JSON.stringify({ agentType: 'Explore', description: 'look', spawnDepth: 1 }),
    )
    /*
     * Pinned to a whole millisecond before anything reads it. A file written
     * normally gets a sub-millisecond mtime that `utimes` cannot give back —
     * measured here as …498.5278 becoming …499 — so without this the restore
     * below silently changes the cache key and the test fails as though the
     * cache were broken.
     */
    const { stat, utimes } = await import('node:fs/promises')
    const pinned = new Date(1_788_000_000_000)
    await utimes(jsonl, pinned, pinned)

    const first = await readTree(agent(), transcript)
    expect((first.children[0] as SubagentNode).calls).toBe(3)

    const before = await stat(jsonl)
    // Same length, no tool calls left, same mtime: everything the key looks at
    // is untouched, so the answer must not move.
    const replaced = turn('2026-08-30T12:00:00.000Z', 3).replaceAll('tool_use', 'tool_USE')
    await writeFile(jsonl, replaced)
    await utimes(jsonl, before.atime, before.mtime)

    // Asserted rather than assumed: if the filesystem will not give the file
    // back its old timestamp, the premise is gone and this should say so rather
    // than fail as though the cache were broken.
    const after = await stat(jsonl)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)

    const again = await readTree(agent(), transcript)
    expect((again.children[0] as SubagentNode).calls).toBe(3)

    // And once the cache is dropped, the same file reads as what it now says.
    forgetEfforts()
    const fresh = await readTree(agent(), transcript)
    expect((fresh.children[0] as SubagentNode).calls).toBe(0)
  })
})
