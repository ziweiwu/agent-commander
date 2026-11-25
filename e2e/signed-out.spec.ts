/**
 * C1 and A3: a server that wants a token says so, and the page speaks what
 * happens to its connection.
 *
 * The token server is `--mock --token`, the one place a browser with no
 * cookie, or one whose cookie the server no longer honours, can be looked at.
 */
import { expect, test, type WebSocketRoute } from '@playwright/test'
import { TOKEN, TOKEN_URL } from '../playwright.config.ts'

const LOSS_SPOKEN_MS = 5000

test.describe('a browser with no cookie', () => {
  test.use({ baseURL: TOKEN_URL })

  test('is told where the token comes from, in its own language', async ({ page }) => {
    const answer = await page.goto('/')
    expect(answer?.status()).toBe(401)
    await expect(page.locator('body')).toContainText('--print-url')
    await expect(page.locator('body')).not.toContainText(TOKEN)
    await expect(page.locator('h1')).toHaveCount(1)
  })

  test('is told in Chinese when the browser asks for it', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: TOKEN_URL, locale: 'zh-CN' })
    const page = await context.newPage()
    await page.goto('/')
    await expect(page.locator('body')).toContainText('这个地址需要令牌')
    await expect(page.locator('body')).toContainText('--print-url')
    await context.close()
  })

  test('keeps the plain refusal for the API', async ({ request }) => {
    const answer = await request.get('/api/env', { headers: { accept: 'text/html' } })
    expect(answer.status()).toBe(401)
    expect(answer.headers()['content-type']).toContain('text/plain')
  })
})

test.describe('a page whose session the server stops honouring', () => {
  test.use({ baseURL: TOKEN_URL })

  test('reads signed out, and says so through the live region', async ({ page }) => {
    let down = false
    await page.routeWebSocket(/\/ws/, (ws) => {
      if (down) return ws.close()
      ws.connectToServer()
    })
    await page.route('**/api/env', (route) =>
      down ? route.fulfill({ status: 401, body: 'unauthorized' }) : route.fallback(),
    )
    await page.goto(`/?token=${TOKEN}`)
    const pill = page.getByTestId('connection-status')
    await expect(pill).toHaveAttribute('data-state', 'open')

    down = true
    await page.reload()
    await expect(pill).toHaveAttribute('data-reach', 'signedOut')
    await expect(pill).toContainText('signed out')
    await expect(page.locator('#live-region')).toHaveText(
      /signed out — open your saved link again/,
      { timeout: LOSS_SPOKEN_MS + 5000 },
    )
  })
})

test.describe('the connection is spoken', () => {
  test('a loss that lasts is announced, and the return too', async ({ page }) => {
    let down = false
    let link: WebSocketRoute | null = null
    await page.routeWebSocket(/\/ws/, (ws) => {
      if (down) return ws.close()
      ws.connectToServer()
      link = ws
    })
    await page.route('**/api/env', (route) => (down ? route.abort() : route.fallback()))
    await page.goto('/')
    const pill = page.getByTestId('connection-status')
    await expect(pill).toHaveAttribute('data-state', 'open')
    const region = page.locator('#live-region')
    await expect(region).toContainText('need you')

    down = true
    await link!.close()
    await expect(region).toHaveText('Connection lost. Reconnecting.', { timeout: LOSS_SPOKEN_MS + 5000 })

    down = false
    await expect(region).toHaveText('Connected again.', { timeout: 20_000 })
  })
})
