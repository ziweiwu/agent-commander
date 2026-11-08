/**
 * FR-FLEET-11 and INV-11, end to end: nothing before the first live fleet
 * frame reads as a reading (round 3, R3).
 *
 * The socket is routed so the server's fleet frames are held until the test
 * lets them through, which is a slow tunnel with the slowness under control.
 * Everything else the server sends, the conversation and its question
 * included, passes at once: the gate is the fleet frame, not the socket.
 */
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import { AGENT, card } from './helpers.ts'

/** How long a reconnect may take once the route lets the socket through again. */
const RECONNECT_MS = 20_000

interface Held {
  release: () => void
}

/** Route `/ws` so fleet frames wait for `release`, and everything else flows. */
async function holdFleetFrames(page: Page): Promise<Held> {
  let released = false
  const waiting: { ws: WebSocketRoute; message: string | Buffer }[] = []
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer()
    server.onMessage((message) => {
      const fleet = typeof message === 'string' && message.startsWith('{"type":"fleet"')
      if (fleet && !released) waiting.push({ ws, message })
      else ws.send(message)
    })
    ws.onMessage((message) => server.send(message))
  })
  return {
    release: () => {
      released = true
      for (const { ws, message } of waiting.splice(0)) ws.send(message)
    },
  }
}

/** A first visit in this context, so the next page paints the stored fleet. */
async function rememberFleet(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'open')
  await expect(card(page, AGENT.busy)).toBeVisible()
  await page.close()
}

test.describe('FR-FLEET-11 a remembered fleet before the first live frame', () => {
  test('is captioned, says when it was seen, and lets nothing act on it', async ({ context }) => {
    await rememberFleet(await context.newPage())
    const page = await context.newPage()
    const held = await holdFleetFrames(page)
    await page.goto('/')

    await expect(card(page, AGENT.busy)).toBeVisible()
    await expect(page.getByTestId('fleet-stale')).toBeVisible()
    await expect(page.getByTestId('fleet-list')).toHaveAttribute('data-stale', 'true')
    await expect(page.getByTestId('connection-status')).not.toHaveAttribute('data-state', 'open')
    await expect(page.getByTestId('connection-status')).not.toHaveText('live')
    await expect(page.getByTestId('fleet-list')).not.toContainText('No prompts yet')
    await expect(page.getByTestId('fleet-list')).not.toContainText('terminal reachable')
    await expect(card(page, AGENT.busy).getByTestId('agent-activity')).toHaveText(
      /^Last seen .* — waiting for a live update$/,
    )
    await expect(page.getByTestId('agent-answer-cta')).toHaveCount(0)
    await expect(page.getByTestId('prune-button').first()).toBeDisabled()

    held.release()
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'open')
    await expect(page.getByTestId('fleet-stale')).toHaveCount(0)
    await expect(card(page, AGENT.busy).getByTestId('agent-activity')).not.toHaveText(/^Last seen/)
    await expect(page.getByTestId('prune-button').first()).toBeEnabled()
  })

  test('holds the answer options and the composer until the frame confirms the pane', async ({
    context,
  }) => {
    await rememberFleet(await context.newPage())
    const page = await context.newPage()
    const held = await holdFleetFrames(page)
    await page.goto(`/agent/${AGENT.waiting}`)

    const option = page.getByTestId('answer-option').first()
    await expect(option).toBeVisible()
    await expect(option).toBeDisabled()
    await expect(page.getByTestId('composer-offline')).toBeVisible()
    await expect(page.getByTestId('composer-send')).toBeDisabled()

    held.release()
    await expect(option).toBeEnabled()
    await expect(page.getByTestId('composer-offline')).toHaveCount(0)
  })
})

test.describe('FR-FLEET-11 a first visit before the first frame', () => {
  test('names no count in the status chips above "Connecting…"', async ({ page }) => {
    const held = await holdFleetFrames(page)
    await page.goto('/')
    await expect(page.getByTestId('fleet-loading')).toBeVisible()
    for (const chip of await page.getByTestId('filter-chip').all()) {
      await expect(chip).not.toHaveText(/\d/)
    }
    held.release()
    await expect(page.getByTestId('fleet-loading')).toHaveCount(0)
    await expect(page.locator('[data-testid="filter-chip"][data-key="all"]')).toHaveText(/^\d+ /)
  })
})

/**
 * Round 2's offline caption and pill, after a live session: the gate is "a
 * live frame has ever arrived", so a drop and a reconnect behave as before.
 */
test.describe('FR-FLEET-11 a drop after a live session', () => {
  test('captions the fleet at once and is live again on reconnect', async ({ page }) => {
    let down = false
    let link: WebSocketRoute | null = null
    await page.routeWebSocket(/\/ws/, (ws) => {
      if (down) return ws.close()
      ws.connectToServer()
      link = ws
    })
    await page.goto('/')
    const pill = page.getByTestId('connection-status')
    await expect(pill).toHaveAttribute('data-state', 'open')
    await expect(card(page, AGENT.busy)).toBeVisible()

    down = true
    await link!.close()
    await expect(page.getByTestId('fleet-stale')).toContainText(/Not connected/)
    await expect(pill).toHaveAttribute('data-state', 'closed')
    await expect(card(page, AGENT.busy).getByTestId('agent-activity')).not.toHaveText(/^Last seen/)

    down = false
    await expect(pill).toHaveAttribute('data-state', 'open', { timeout: RECONNECT_MS })
    await expect(page.getByTestId('fleet-stale')).toHaveCount(0)
    await expect(card(page, AGENT.busy).getByTestId('agent-activity')).not.toHaveText(/^Last seen/)
  })
})
