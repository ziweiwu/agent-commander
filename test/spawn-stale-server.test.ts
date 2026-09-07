/**
 * A server older than the page serving it.
 *
 * This app is a local server people leave running for days, and `npm run
 * build` rewrites `dist/web` underneath it — so a page newer than the binary
 * answering it is what a rebuild ordinarily produces, not an edge case. The
 * same trap is already recorded for the macOS bundle, which keeps serving the
 * code it started with.
 *
 * A route such a server has never heard of is not refused. It is answered with
 * the SPA shell — `200 text/html`, because the app is served from every path
 * that is not an endpoint — so `res.json()` throws, and without this the
 * *parser's* message reached the dialog dressed as the server's reason:
 * Safari's "The string did not match the expected pattern", reported to the
 * user as why their terminal could not be opened. That names the wrong thing
 * and tells them nothing (INV-11).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startAgent, startTerminal } from '../src/web/store/transport.ts'

/** What a server answers with for a path it does not recognise. */
const spaShell = () =>
  new Response('<!doctype html><title>agent-commander</title>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

afterEach(() => void vi.unstubAllGlobals())

describe('a request a server does not know', () => {
  it.each([
    ['a terminal', () => startTerminal('~/x')],
    ['an agent', () => startAgent('~/x')],
  ])('says the server is out of date rather than quoting a JSON parser, for %s', async (_what, call) => {
    vi.stubGlobal('fetch', vi.fn(async () => spaShell()))

    const result = await call()

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/older version/i)
    // The parser's words are what this exists to keep off the screen.
    expect(result.ok === false && result.error).not.toMatch(/expected pattern|JSON/i)
  })

  it('still reads a real answer, and a real refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, tmuxSession: 't', cwd: '/x' })))
    expect((await startTerminal('~/x')).ok).toBe(true)

    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: false, error: 'no such directory' })))
    const refused = await startTerminal('~/nope')
    expect(refused.ok === false && refused.error).toBe('no such directory')
  })

  // A dropped connection is a different thing and still reports as itself.
  it('leaves a network failure reporting as a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Load failed') }))
    const result = await startTerminal('~/x')
    expect(result.ok === false && result.error).toBe('Load failed')
  })
})
