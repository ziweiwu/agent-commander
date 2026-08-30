/**
 * `/api/tree` over HTTP, and specifically that it does not re-send a graph the
 * browser already has.
 *
 * INV-4 said nothing polls what nobody is watching. It did not say anything
 * about what a poll costs once somebody *is* watching, and this route was the
 * gap: measured against 53 real sessions the body is 54.6 KB and byte-identical
 * from one three-second poll to the next — 64 MB an hour to a phone on
 * Tailscale. The pane path has always diffed its frames; this is the same rule
 * for the graph.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { createAppServer } from '../src/server/routes.ts'
import { MockPanes, MockSource, MockTail } from '../src/server/mock.ts'
import type { Agent, AgentTree, FleetTree } from '../src/shared/types.ts'

const started: Server[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => new Promise((r) => s.close(r))))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** A server whose graph this test controls, so "changed" is a real change. */
async function serve(read: () => AgentTree['children']): Promise<string> {
  const webRoot = await mkdtemp(join(tmpdir(), 'ac-tree-'))
  dirs.push(webRoot)
  const server = createAppServer({
    source: new MockSource(),
    panes: new MockPanes(),
    makeTail: (id: string) => new MockTail(id),
    mock: false,
    webRoot,
    env: { tailscale: null, tmux: true, port: 0, platform: 'darwin' },
    tree: async (agent: Agent): Promise<AgentTree> => ({
      sessionId: agent.sessionId,
      children: read(),
    }),
  })
  started.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return `http://127.0.0.1:${port}`
}

const node = (agentId: string): AgentTree['children'][number] => ({
  agentId,
  agentType: 'Explore',
  description: 'look at something',
  depth: 1,
  lastWriteAt: 1_000,
  bytes: 42,
  state: 'quiet',
  children: [],
})

describe('INV-4 the delegation graph is not re-sent unchanged', () => {
  it('serves the graph with an ETag', async () => {
    const base = await serve(() => [node('a')])

    const res = await fetch(`${base}/api/tree`)
    const body = (await res.json()) as FleetTree

    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBeTruthy()
    expect(body.trees.length).toBeGreaterThan(0)
    expect(body.trees[0]?.children[0]?.agentId).toBe('a')
  })

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const base = await serve(() => [node('a')])
    const first = await fetch(`${base}/api/tree`)
    const etag = first.headers.get('etag') as string
    await first.text()

    const second = await fetch(`${base}/api/tree`, { headers: { 'if-none-match': etag } })

    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')
    // The tag comes back so a client that dropped its copy can still match.
    expect(second.headers.get('etag')).toBe(etag)
  })

  it('sends the graph again, under a new ETag, once it actually changes', async () => {
    let agentId = 'a'
    const base = await serve(() => [node(agentId)])
    const first = await fetch(`${base}/api/tree`)
    const etag = first.headers.get('etag') as string
    await first.text()

    agentId = 'b'
    const res = await fetch(`${base}/api/tree`, { headers: { 'if-none-match': etag } })
    const body = (await res.json()) as FleetTree

    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).not.toBe(etag)
    expect(body.trees[0]?.children[0]?.agentId).toBe('b')
  })

  it('does not 304 a client that sends someone else’s tag', async () => {
    const base = await serve(() => [node('a')])

    const res = await fetch(`${base}/api/tree`, { headers: { 'if-none-match': '"nonsense"' } })

    expect(res.status).toBe(200)
  })
})
