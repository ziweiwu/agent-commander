/**
 * The control actions over HTTP, which is where they are actually reached.
 *
 * `test/control.test.ts` covers the guards and the verification; this covers
 * the route, and it exists because of a bug that suite could not have caught.
 * Mode, clear and compact carry **no value**, so the browser sends no body —
 * and `readJson` did `JSON.parse('')`, which throws. Every unit test passed
 * while pressing the mode button reported "that did not take effect:
 * Unexpected end of JSON input" about a control the server had never called.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { createAppServer } from '../src/server/routes.ts'
import { MockPanes, MockSource, MockTail } from '../src/server/mock.ts'
import type { ControlDeps } from '../src/server/control.ts'
import type { ControlResponse } from '../src/shared/types.ts'

const started: Server[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => new Promise((r) => s.close(r))))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

interface Harness {
  base: string
  pasted: string[]
}

async function serve(over: Partial<ControlDeps> = {}): Promise<Harness> {
  const webRoot = await mkdtemp(join(tmpdir(), 'ac-ctl-'))
  dirs.push(webRoot)
  const pasted: string[] = []
  let mode = 'default'
  let sessionId = 'before'

  const server = createAppServer({
    source: new MockSource(),
    panes: new MockPanes(),
    makeTail: (id: string) => new MockTail(id),
    mock: false,
    webRoot,
    env: { tailscale: null, tmux: true, port: 0, platform: 'darwin' },
    control: {
      paste: async (_pane: string, text: string) => {
        pasted.push(text)
        if (text === '/clear') sessionId = 'after'
      },
      key: async () => {
        mode = 'plan'
      },
      readMode: async () => mode,
      readGoal: async () => undefined,
      readSessionId: async () => sessionId,
      paneAlive: async () => false,
      killSession: async () => {},
      wait: async () => {},
      ...over,
    },
  })
  started.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, pasted }
}

/** Exactly what the browser sends for an action with no value: no body at all. */
async function post(
  base: string,
  action: string,
  body?: unknown,
): Promise<{ status: number; body: ControlResponse }> {
  const res = await fetch(`${base}/api/agents/mock-idle-kb/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as ControlResponse }
}

describe('an action that carries no value', () => {
  it('advances the mode with no request body', async () => {
    const { base } = await serve()

    const { status, body } = await post(base, 'mode')

    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, detail: 'plan' })
  })

  it('reports an unobserved press rather than an error', async () => {
    const { base } = await serve({ key: async () => {} })

    const { body } = await post(base, 'mode')

    expect(body).toMatchObject({ ok: true, detail: 'unverified' })
  })

  it('clears and answers with the id the session is now running', async () => {
    const { base, pasted } = await serve()

    const { status, body } = await post(base, 'clear')

    expect(status).toBe(200)
    expect(pasted).toEqual(['/clear'])
    expect(body).toMatchObject({ ok: true, detail: 'after' })
  })

  it('requests a compaction without waiting for it', async () => {
    const { base, pasted } = await serve()

    const { status, body } = await post(base, 'compact')

    expect(status).toBe(200)
    expect(pasted).toEqual(['/compact'])
    expect(body).toMatchObject({ ok: true, detail: 'requested' })
  })
})

describe('a body-reading action sent no body', () => {
  /*
   * The other half of the same bug, and the durable half.
   *
   * Moving mode, clear and compact above `readJson` stopped them reaching it;
   * this pins the parse itself, so an action that *does* read a body cannot be
   * broken by an absent one either. An empty body is a request carrying no
   * value, not a malformed request — which for the goal toggle is exactly how
   * it is turned off.
   */
  it('reads an absent body as no value rather than throwing', async () => {
    const { base, pasted } = await serve()

    const { status, body } = await post(base, 'goal')

    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, detail: 'cleared' })
    expect(pasted).toEqual(['/goal clear'])
  })
})

describe('an action that carries one', () => {
  it('still reads the value it was sent', async () => {
    const { base, pasted } = await serve()

    const { status, body } = await post(base, 'model', { value: 'opus' })

    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true })
    expect(pasted).toEqual(['/model opus'])
  })

  it('refuses an action that is not on the route', async () => {
    const { base } = await serve()

    const res = await fetch(`${base}/api/agents/mock-idle-kb/rm`, { method: 'POST' })

    // Falls through to the static handler rather than reaching any control.
    expect(res.status).not.toBe(200)
  })
})
