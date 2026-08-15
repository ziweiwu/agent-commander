/**
 * Mock mode is stamped into the document rather than announced over the socket.
 *
 * The banner used to arrive with the first WebSocket frame — after the page had
 * painted — and inserting it pushed the whole layout down by its own height.
 * That measured as a Cumulative Layout Shift of 0.156, effectively all of the
 * page's CLS, and it was invisible in the unit tests because it is a timing
 * property of a real browser. Knowing the mode before the first render is what
 * removes it: 0.156 → 0.001.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAppServer } from '../src/server/routes.ts'
import { MockPanes, MockSource, MockTail } from '../src/server/mock.ts'
import type { Server } from 'node:http'

const DOC = '<!doctype html>\n<html lang="en">\n<body><div id="root"></div></body>\n</html>\n'

const started: Server[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => new Promise((r) => s.close(r))))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function serve(mock: boolean): Promise<string> {
  const webRoot = await mkdtemp(join(tmpdir(), 'ac-stamp-'))
  dirs.push(webRoot)
  await writeFile(join(webRoot, 'index.html'), DOC)

  const source = new MockSource()
  const server = createAppServer({
    source,
    panes: new MockPanes(),
    makeTail: (id: string) => new MockTail(id),
    mock,
    webRoot,
    env: { tailscale: null, tmux: true, port: 0, platform: 'darwin' },
  })
  started.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return `http://127.0.0.1:${port}`
}

describe('mock stamping', () => {
  it('marks the document when the server is in mock mode', async () => {
    const base = await serve(true)
    const html = await (await fetch(`${base}/`)).text()
    expect(html).toContain('data-mock="true"')
  })

  it('leaves the document alone when it is serving real agents', async () => {
    const base = await serve(false)
    const html = await (await fetch(`${base}/`)).text()
    expect(html).not.toContain('data-mock')
    expect(html).toContain('<html lang="en">')
  })

  // /agent/<id> is a client route that falls through to the same document.
  it('stamps the SPA fallback too, not just the root', async () => {
    const base = await serve(true)
    const html = await (await fetch(`${base}/agent/mock-busy`)).text()
    expect(html).toContain('data-mock="true"')
  })

  it('keeps the document valid and complete', async () => {
    const base = await serve(true)
    const res = await fetch(`${base}/`)
    const html = await res.text()
    expect(res.headers.get('content-type')).toContain('text/html')
    // The rewrite must not truncate: content-length is recomputed, not reused.
    expect(Number(res.headers.get('content-length'))).toBe(Buffer.byteLength(html))
    expect(html).toContain('<div id="root">')
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })
})
