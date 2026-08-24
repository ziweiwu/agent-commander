/**
 * The tablet, which is the only shape that crosses the layout's breakpoint.
 *
 * At 900px the app changes shape: above it the fleet list and the detail are
 * two columns, below it the detail is a sheet that covers the list and the back
 * gesture is what closes it. A phone is always on one side of that line and a
 * desktop always on the other. An iPad in portrait is 834px and in landscape is
 * 1194px, so it is the one device that goes back and forth — by being turned
 * over, mid-conversation, which is not an exotic thing to do with a tablet.
 *
 * What has to survive that is agreement about state: which agent is open, which
 * tab it is on, and what is half-typed into the box. All three live outside the
 * layout — the URL owns the selection and the transport owns the socket — so
 * these tests are really asking whether that separation holds when the tree
 * they are rendered by is replaced.
 */
import { expect, test } from '@playwright/test'
import { AGENT, card, openAgent, openFleet, said, stamp } from './helpers.ts'

const PORTRAIT = { width: 834, height: 1194 }
const LANDSCAPE = { width: 1194, height: 834 }

test.describe('@tablet held upright', () => {
  test('is below the breakpoint, so the detail covers the list', async ({ page }) => {
    await page.setViewportSize(PORTRAIT)
    await openFleet(page)
    await card(page, AGENT.idle).click()

    await expect(page.getByTestId('agent-detail')).toBeVisible()
    await expect(page.getByTestId('fleet-list')).toBeHidden()
    await expect(page.getByTestId('back-button')).toBeVisible()
  })

  test('leaves the conversation a readable share of the screen', async ({ page }) => {
    await page.setViewportSize(PORTRAIT)
    await openAgent(page, AGENT.idle)

    const share = await page.evaluate(() => {
      const scroll = document.querySelector('[data-testid="chat-scroll"]')
      return scroll ? scroll.clientHeight / window.innerHeight : 0
    })
    expect(share).toBeGreaterThan(0.3)
  })

  test('does not scroll sideways', async ({ page }) => {
    await page.setViewportSize(PORTRAIT)
    await openAgent(page, AGENT.idle)

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    )
    expect(overflows).toBe(false)
  })
})

test.describe('@tablet turned on its side', () => {
  test('is above the breakpoint, so both columns are visible at once', async ({ page }) => {
    await page.setViewportSize(LANDSCAPE)
    await openFleet(page)
    await card(page, AGENT.idle).click()

    await expect(page.getByTestId('agent-detail')).toBeVisible()
    // The list stays: there is room for both, and the point of the wide layout
    // is being able to watch the fleet while reading one agent.
    await expect(page.getByTestId('fleet-list')).toBeVisible()
  })

  test('switches agents from the list without losing the detail', async ({ page }) => {
    await page.setViewportSize(LANDSCAPE)
    await openFleet(page)

    /*
     * Identified by the panel's accessible name rather than by the heading:
     * the heading shows the title the agent generated for itself where it has
     * one, which is the right thing for a person to read and the wrong thing
     * for a test to pin a fixture to.
     */
    await card(page, AGENT.idle).click()
    await expect(page.getByTestId('agent-detail')).toHaveAttribute('aria-label', 'kb-operational-hardening')

    await card(page, AGENT.idleAlt).click()
    await expect(page.getByTestId('agent-detail')).toHaveAttribute('aria-label', 'ziweiwu-ce')
    await expect(page).toHaveURL(new RegExp(`/agent/${AGENT.idleAlt}$`))
    await expect(page.getByTestId('message').first()).toBeVisible()
  })
})

test.describe('@tablet rotated mid-conversation', () => {
  test('keeps the agent open across the breakpoint, both ways', async ({ page }) => {
    await page.setViewportSize(PORTRAIT)
    await openAgent(page, AGENT.idle)
    await expect(page.getByTestId('fleet-list')).toBeHidden()

    // Portrait -> landscape: the sheet becomes a column, and the list appears
    // beside it rather than replacing it.
    await page.setViewportSize(LANDSCAPE)
    await expect(page.getByTestId('fleet-list')).toBeVisible()
    await expect(page.getByTestId('agent-detail')).toHaveAttribute('aria-label', 'kb-operational-hardening')

    // And back. The URL owns the selection, so neither direction may drop it.
    await page.setViewportSize(PORTRAIT)
    await expect(page.getByTestId('fleet-list')).toBeHidden()
    await expect(page.getByTestId('agent-detail')).toHaveAttribute('aria-label', 'kb-operational-hardening')
    await expect(page).toHaveURL(new RegExp(`/agent/${AGENT.idle}$`))
  })

  test('keeps the terminal attached, and does not resize the pane', async ({ page }) => {
    await page.setViewportSize(PORTRAIT)
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    const rows = page.locator('[data-testid="terminal"] .xterm-rows')
    await expect(rows).toContainText(/\S/, { timeout: 15_000 })

    const cols = () =>
      rows.locator('> div').first().evaluate((el) => el.textContent?.length ?? 0)
    const before = await cols()

    await page.setViewportSize(LANDSCAPE)
    await page.waitForTimeout(800)

    /*
     * INV-1, at the one moment it is most tempting to break: the window has
     * genuinely changed size and the obvious thing to do is tell tmux. The
     * Attach view is a capture sized from the pane's own geometry, and the
     * browser's width only ever moves a CSS transform — so the column count
     * cannot change, whichever way the tablet is held.
     */
    await expect(rows).toContainText(/\S/)
    expect(await cols()).toBe(before)
    await expect(page).toHaveURL(/\/term$/)
  })

  test('does not lose what was half-typed', async ({ page }) => {
    await page.setViewportSize(PORTRAIT)
    await openAgent(page, AGENT.idle)

    const text = stamp('typed before rotating')
    await page.getByTestId('composer-input').fill(text)

    await page.setViewportSize(LANDSCAPE)

    // Still in the box, and — just as important — not sent by the rotation.
    await expect(page.getByTestId('composer-input')).toHaveValue(text)
    await expect(said(page, text)).toHaveCount(0)
  })
})
