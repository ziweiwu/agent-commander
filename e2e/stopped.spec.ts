/**
 * C1 end to end: the mock's two sign-in-failed agents, on every width. Fixture
 * data comes over the real socket, so the marker and the strip are the bundle
 * reading the wire rather than a component handed a prop.
 */
import { expect, test } from '@playwright/test'
import { AGENT, card, openFleet } from './helpers.ts'

const STRIP_SENTENCE = /^2 agents stopped: sign-in failed since .*\d\d:\d\d\. Sign in again, then message them\./

test.describe('an agent stopped by an API error', () => {
  test('says so on its idle card, and the fleet says it once', async ({ page }) => {
    await openFleet(page)
    await expect(card(page, AGENT.idle).getByTestId('agent-stopped')).toHaveText(/^Stopped · sign-in failed /)
    await expect(card(page, AGENT.idleAlt).getByTestId('agent-stopped')).toHaveText(/^Stopped · sign-in failed /)
    await expect(card(page, AGENT.waiting).getByTestId('agent-stopped')).toHaveCount(0)
    const strip = page.getByTestId('stopped-strip')
    await expect(strip).toHaveText(STRIP_SENTENCE)
    await expect(strip).toHaveAttribute('data-cause', 'authentication_failed')
    const box = await strip.boundingBox()
    const list = await page.getByTestId('fleet-list').boundingBox()
    expect(box!.y + box!.height).toBeLessThanOrEqual(list!.y + 1)
    const width = page.viewportSize()!.width
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('tapping the strip filters to those agents, and tapping it again shows all', async ({ page }) => {
    await openFleet(page)
    const strip = page.getByTestId('stopped-strip')
    const before = await page.getByTestId('agent-card').count()
    expect(before).toBeGreaterThan(2)
    await strip.click()
    await expect(page.getByTestId('agent-card')).toHaveCount(2)
    await expect(card(page, AGENT.idle)).toBeVisible()
    await expect(card(page, AGENT.idleAlt)).toBeVisible()
    await expect(strip).toHaveAttribute('aria-pressed', 'true')
    await strip.click()
    await expect(page.getByTestId('agent-card')).toHaveCount(before)
  })

  test('offers no way to act on the agents: the strip is one button, and it filters', async ({ page }) => {
    await openFleet(page)
    const strip = page.getByTestId('stopped-strip')
    await expect(strip.locator('button, a, input')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /retry/i })).toHaveCount(0)
    await expect(strip).toHaveJSProperty('tagName', 'BUTTON')
  })
})
