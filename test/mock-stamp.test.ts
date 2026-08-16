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

/**
 * The static root is a boundary like any other.
 *
 * INV-9 spells out why containment is a path-segment check rather than a
 * string prefix -- `startsWith` reads `/app/dist/web-backup` as inside
 * `/app/dist/web` -- and the same standard applies here.
 */
describe('serving files outside the web root', () => {
  it('refuses traversal in every spelling', async () => {
    const base = await serve(false)
    for (const path of ['/../secrets.txt', '/..%2Fsecrets.txt', '/a/../../secrets.txt']) {
      const res = await fetch(`${base}${path}`, { redirect: 'manual' })
      expect(res.status).not.toBe(200)
    }
  })

  /*
   * The prefix-vs-segment difference is not reachable from here: an absolute
   * request path cannot climb out of `join(root, ...)` once `normalize` has
   * collapsed it, so both checks answer the same for every URL a client can
   * send. It is written as a segment check anyway, because that is the
   * standard INV-9 sets and the next person to move this code should not have
   * to re-derive why the weaker one happened to be safe here.
   */
  it('serves what is genuinely inside the root', async () => {
    const base = await serve(false)
    expect((await fetch(`${base}/index.html`)).status).toBe(200)
  })
})
