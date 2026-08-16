/**
 * What the New Agent dialog asks for is what gets started.
 *
 * The dialog has always offered a model and a permission mode, and the route
 * forwarded neither: `spawn({ cwd, name })` dropped them on the floor, so
 * choosing "plan" and "opus" produced a default agent and no error to say so.
 * Silently starting a session in a different permission mode than the one
 * asked for is the wrong direction to be wrong in, which is why this is a test
 * rather than a comment.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { createAppServer } from '../src/server/routes.ts'
import { MockPanes, MockSource, MockTail } from '../src/server/mock.ts'
import { checkSpawnRequest } from '../src/server/spawn.ts'
import type { NewAgentRequest, NewAgentResponse } from '../src/shared/types.ts'

const started: Server[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => new Promise((r) => s.close(r))))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** Boots the real route over a spawn that records instead of creating anything. */
async function serve(): Promise<{ base: string; seen: NewAgentRequest[] }> {
  const webRoot = await mkdtemp(join(tmpdir(), 'ac-new-'))
  dirs.push(webRoot)
  const seen: NewAgentRequest[] = []

  const server = createAppServer({
    source: new MockSource(),
    panes: new MockPanes(),
    makeTail: (id: string) => new MockTail(id),
    mock: false,
    webRoot,
    env: { tailscale: null, tmux: true, port: 0, platform: 'darwin' },
    spawn: async (req) => {
      // The same validation the live path runs, so a rejected alias is
      // rejected here too rather than being recorded as accepted.
      const cwd = await checkSpawnRequest(req)
      seen.push(req)
      return { tmuxSession: 'test-session', cwd }
    },
  })
  started.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, seen }
}

async function post(base: string, body: unknown): Promise<{ status: number; body: NewAgentResponse }> {
  const res = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as NewAgentResponse }
}

describe('POST /api/agents', () => {
  it('forwards the model and permission mode the dialog chose', async () => {
    const { base, seen } = await serve()
    const cwd = await mkdtemp(join(tmpdir(), 'ac-new-cwd-'))
    dirs.push(cwd)

    const { status, body } = await post(base, {
      cwd,
      name: 'dark-mode',
      model: 'opus',
      permissionMode: 'plan',
    })

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(seen[0]).toMatchObject({ name: 'dark-mode', model: 'opus', permissionMode: 'plan' })
  })

  it('starts a plain agent when the dialog left both at their defaults', async () => {
    const { base, seen } = await serve()
    const cwd = await mkdtemp(join(tmpdir(), 'ac-new-cwd-'))
    dirs.push(cwd)

    expect((await post(base, { cwd })).status).toBe(200)
    expect(seen[0]?.model).toBeUndefined()
    expect(seen[0]?.permissionMode).toBeUndefined()
  })

  /*
   * 400, not 500: a rejected alias is the caller's mistake, and the dialog
   * renders a 400 as a reason it can show beside the field rather than as an
   * "internal error" the user can do nothing with.
   */
  it('refuses an unknown model as a bad request', async () => {
    const { base, seen } = await serve()
    const cwd = await mkdtemp(join(tmpdir(), 'ac-new-cwd-'))
    dirs.push(cwd)

    const { status, body } = await post(base, { cwd, model: '--dangerously-skip' })
    expect(status).toBe(400)
    expect(body).toMatchObject({ ok: false })
    expect(seen).toHaveLength(0)
  })

  it('refuses an unknown permission mode as a bad request', async () => {
    const { base, seen } = await serve()
    const cwd = await mkdtemp(join(tmpdir(), 'ac-new-cwd-'))
    dirs.push(cwd)

    expect((await post(base, { cwd, permissionMode: 'yolo' })).status).toBe(400)
    expect(seen).toHaveLength(0)
  })

  it('still refuses a request with no directory at all', async () => {
    const { base } = await serve()
    expect((await post(base, { name: 'nowhere' })).status).toBe(400)
  })
})
