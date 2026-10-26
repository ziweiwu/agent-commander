/**
 * The bundle as the real build names it, served the way `routes.rs` promises.
 *
 * `routes::tests` prove the server's rules against files they lay out
 * themselves, which leaves the join between the two halves unproven: whether
 * the names Vite really writes are the ones `is_content_hashed` recognises,
 * and whether the build really wrote the compressed copies `serve_asset`
 * looks for. Either one drifting fails nothing else. The app just loads
 * slower — a year-long cache that never applies, or a compressed copy that is
 * never there to offer — so this reads both off a page a browser loaded.
 */
import { expect, test, type Response } from '@playwright/test'
import { openFleet } from './helpers.ts'

const BUNDLE_FILE = /^\/assets\/[^/]+\.(?:js|css)$/
const YEAR_LONG = 'public, max-age=31536000, immutable'

test.describe('the bundle a browser loads', () => {
  test('arrives compressed and is kept for a year, while the manifest revalidates', async ({
    page,
  }) => {
    const bundle: Response[] = []
    page.on('response', (res) => {
      if (BUNDLE_FILE.test(new URL(res.url()).pathname)) bundle.push(res)
    })
    await openFleet(page)

    expect(bundle.length).toBeGreaterThan(0)
    for (const res of bundle) {
      const headers = await res.allHeaders()
      expect(headers['cache-control'], res.url()).toBe(YEAR_LONG)
      expect(headers['content-encoding'], res.url()).toMatch(/^(?:br|gzip)$/)
      expect(headers['vary'], res.url()).toMatch(/accept-encoding/i)
    }

    const manifest = await page.request.get('/assets/manifest.webmanifest')
    expect(manifest.headers()['cache-control']).toBe('no-cache')
  })
})
