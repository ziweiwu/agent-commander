/**
 * INV-3, second half: a browser is not a stranger on the network.
 *
 * Binding 127.0.0.1 keeps the network out and does nothing about the page the
 * user has open in another tab. WebSockets ignore CORS, and a POST with a
 * `text/plain` body is a CORS simple request sent with no preflight — so
 * without a same-origin gate, any site could open the socket, read every
 * agent's directory and prompts, and paste a shell command plus Enter into a
 * live session. These tests drive the server the way such a page would.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { connect as netConnect } from 'node:net'
import { WebSocket } from 'ws'
import { createAppServer } from '../src/server/routes.ts'
import { MockPanes, MockSource, MockTail } from '../src/server/mock.ts'

const DOC = '<!doctype html>\n<html lang="en">\n<body><div id="root"></div></body>\n</html>\n'
const EVIL = 'https://evil.example'

const started: Server[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => new Promise((r) => s.close(r))))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function serve(token?: string): Promise<{ base: string; ws: string; port: number }> {
  const webRoot = await mkdtemp(join(tmpdir(), 'ac-origin-'))
  dirs.push(webRoot)
  await writeFile(join(webRoot, 'index.html'), DOC)

  const server = createAppServer({
    source: new MockSource(),
    panes: new MockPanes(),
    makeTail: (id: string) => new MockTail(id),
    mock: true,
    webRoot,
    env: { tailscale: null, tmux: true, port: 0, platform: 'darwin' },
    ...(token ? { token } : {}),
    spawn: async (req) => ({ tmuxSession: 'test-session', cwd: req.cwd }),
  })
  started.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws`, port }
}

/** Resolves to 'open' or 'rejected' — never hangs the suite on either. */
function tryWebSocket(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers })
    const settle = (outcome: string): void => {
      socket.close()
      resolve(outcome)
    }
    socket.on('open', () => settle('open'))
    socket.on('error', () => settle('rejected'))
    setTimeout(() => settle('rejected'), 4000).unref?.()
  })
}

describe('the WebSocket refuses a cross-origin page', () => {
  it('rejects a handshake carrying a foreign Origin', async () => {
    const { ws } = await serve()
    expect(await tryWebSocket(ws, { origin: EVIL })).toBe('rejected')
  })

  // The dashboard's own page, which is the case that must keep working.
  it('accepts a handshake from the loopback origin it is served at', async () => {
    const { base, ws } = await serve()
    expect(await tryWebSocket(ws, { origin: base })).toBe('open')
  })

  // A CLI or a native client sends no Origin at all; only browsers are gated.
  it('accepts a handshake with no Origin at all', async () => {
    const { ws } = await serve()
    expect(await tryWebSocket(ws, {})).toBe('open')
  })
})

describe('state-changing requests refuse a cross-origin page', () => {
  /* A form POST needs no preflight, so the browser sends this for real. */
  it('refuses to start an agent for a foreign origin', async () => {
    const { base } = await serve()
    const res = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: { origin: EVIL, 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ cwd: '/tmp' }),
    })
    expect(res.status).toBe(403)
  })

  it('refuses to set a goal on a live agent for a foreign origin', async () => {
    const { base } = await serve()
    const res = await fetch(`${base}/api/agents/mock-idle-kb/goal`, {
      method: 'POST',
      headers: { origin: EVIL, 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ value: 'exfiltrate the repo' }),
    })
    expect(res.status).toBe(403)
  })

  it('refuses to hand the fleet listing to a foreign origin', async () => {
    const { base } = await serve()
    const res = await fetch(`${base}/api/agents`, { headers: { origin: EVIL } })
    expect(res.status).toBe(403)
  })

  it('still serves the app to its own origin', async () => {
    const { base } = await serve()
    const res = await fetch(`${base}/api/agents`, { headers: { origin: base } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { agents: unknown[] }).agents.length).toBeGreaterThan(0)
  })
})

/**
 * DNS rebinding is the case an Origin check alone misses: the attacker's name
 * is re-pointed at 127.0.0.1, so the page's origin and the Host it asks for
 * agree perfectly. What gives it away is that neither is a loopback name.
 *
 * Driven down a raw socket rather than through `fetch`, which refuses to let a
 * caller set `Host` — the request would then arrive with the honest loopback
 * host and be refused for its Origin instead, passing this test while proving
 * nothing about the header it names.
 */
function rawGet(port: number, headers: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write(`GET /api/agents HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`)
    })
    let out = ''
    socket.on('data', (chunk) => (out += String(chunk)))
    socket.on('close', () => resolve(out.split('\r\n')[0] ?? ''))
    socket.on('error', () => resolve('socket error'))
  })
}

describe('a rebound hostname is refused', () => {
  it('refuses a request whose Host is a foreign name, however consistent', async () => {
    const { port } = await serve()
    const status = await rawGet(port, 'Host: evil.example\r\nOrigin: http://evil.example')
    expect(status).toContain('403')
  })

  it('refuses a rebound name that sends no Origin either', async () => {
    const { port } = await serve()
    expect(await rawGet(port, 'Host: evil.example')).toContain('403')
  })

  it('serves every honest spelling of loopback', async () => {
    const { port } = await serve()
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      expect(await rawGet(port, `Host: ${host}`)).toContain('200')
    }
  })

  it('refuses the WebSocket from a rebound name too', async () => {
    const { ws } = await serve()
    const outcome = await tryWebSocket(ws, {
      host: 'evil.example',
      origin: 'http://evil.example',
    })
    expect(outcome).toBe('rejected')
  })
})

/**
 * A token is already proof of intent that no cross-origin page can produce: it
 * lives in the URL of the real origin. Gating those requests as well would
 * break the Tailscale flow, where the app is legitimately reached at a name
 * that is not loopback — and which INV-3 already requires a token for.
 */
describe('a token replaces the origin gate', () => {
  it('serves a tokened request from any name', async () => {
    const { base } = await serve('s3cret')
    const res = await fetch(`${base}/api/agents?token=s3cret`, {
      headers: { host: 'laptop.tailnet.ts.net', origin: 'http://laptop.tailnet.ts.net' },
    })
    expect(res.status).toBe(200)
  })

  it('still refuses a tokenless request, whatever its origin', async () => {
    const { base } = await serve('s3cret')
    expect((await fetch(`${base}/api/agents`, { headers: { origin: base } })).status).toBe(401)
  })
})
