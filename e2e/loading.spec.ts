/**
 * INV-11 before the first frame.
 *
 * Over Tailscale on a phone the gap between the page painting and the first
 * fleet frame landing is measured in seconds, and the fleet used to fill it
 * with "No Claude Code sessions found" — a guess wearing the words of a
 * reading. The socket is intercepted here so that frame never arrives, which
 * is the slow connection with the slowness taken to its limit.
 */
import { expect, test } from '@playwright/test'

test.describe('INV-11 the fleet before its first frame', () => {
  test('shows outlines and "connecting", never the confirmed-empty copy', async ({ page }) => {
    // A routed socket with no server behind it opens and then says nothing.
    await page.routeWebSocket(/\/ws/, () => {})
    await page.goto('/')

    const loading = page.getByTestId('fleet-loading')
    await expect(loading).toBeVisible()
    await expect(loading).toHaveText(/connecting/i)
    await expect(page.getByTestId('empty-state')).toHaveCount(0)
    // Not a claim about the fleet: no headings, no counts.
    await expect(page.getByTestId('group-head')).toHaveCount(0)
  })

  test('gives way to the fleet the moment the frame arrives', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('agent-card').first()).toBeVisible()
    await expect(page.getByTestId('fleet-loading')).toHaveCount(0)
  })
})
