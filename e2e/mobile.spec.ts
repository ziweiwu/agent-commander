/**
 * The phone layout, where height is the scarce resource.
 *
 * Below 900px the detail is a sheet that owns the screen, and everything above
 * it is competing with the conversation for pixels. `scripts/audit-mobile.mjs`
 * measures this too and is the better tool for judging it — it drives real
 * device profiles in both orientations. What it cannot do is fail a pull
 * request: it needs a running server and a real Chromium, so it is a habit
 * rather than a gate. These are the same measurements as a gate, on the two
 * shapes that were actually found to be wrong.
 *
 * The numbers are the audit's own threshold: a conversation pane worth less
 * than 30% of the viewport is one you cannot read. Measured before the topbar
 * was put on a diet: 149px of 568 on an iPhone SE, 76px of 380 in landscape.
 */
import { expect, test } from '@playwright/test'
import { AGENT, card, openAgent, openFleet } from './helpers.ts'

/** How much of the screen the conversation gets, as a fraction. */
async function conversationShare(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="chat-scroll"]')
    return scroll ? scroll.clientHeight / window.innerHeight : 0
  })
}

test.describe('@phone the sheet', () => {
  test('covers the fleet list rather than sitting beside it', async ({ page }) => {
    await openFleet(page)
    await card(page, AGENT.idle).click()

    await expect(page.getByTestId('agent-detail')).toBeVisible()
    await expect(page.getByTestId('fleet-list')).toBeHidden()
    // `‹ Agents` is the way back on a phone, and the only one — a second
    // Close button would be two answers to one question.
    await expect(page.getByTestId('back-button')).toBeVisible()
  })

  test('drops the app title, and keeps the quota on one row', async ({ page }) => {
    await openFleet(page)
    // On the list the title is the app's own name and there is height to spare.
    await expect(page.locator('header h1')).toBeVisible()

    await card(page, AGENT.idle).click()
    await expect(page.getByTestId('agent-detail')).toBeVisible()

    // In the sheet it is 21px that the conversation needs more: the sheet's own
    // header already names what you are looking at.
    await expect(page.locator('header h1')).toBeHidden()
    // Still there, because "can I keep working" is the one thing worth the
    // height — but on one row rather than two.
    const chips = page.getByTestId('usage-chips')
    if ((await chips.count()) > 0) {
      expect(await chips.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(40)
    }
  })

  test('gives the conversation a readable share of the screen', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    expect(await conversationShare(page)).toBeGreaterThan(0.3)
  })

  test('still does on the smallest phone still in use', async ({ page }) => {
    // An iPhone SE: 320px wide, which is where the quota chips used to wrap
    // onto a second row and take the topbar to 121px of a 568px screen.
    await page.setViewportSize({ width: 320, height: 568 })
    await openAgent(page, AGENT.idle)

    expect(await conversationShare(page)).toBeGreaterThan(0.3)
    // And the page must not gain a sideways scroll in the process.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    )
    expect(overflows).toBe(false)
  })

  test('and in landscape, where there is least of it', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 380 })
    await openAgent(page, AGENT.idle)

    expect(await conversationShare(page)).toBeGreaterThan(0.3)
  })

  test('keeps the message box on screen without scrolling to it', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await openAgent(page, AGENT.idle)

    // The composer below a conversation that scrolls the page instead of
    // itself is a message box you have to scroll past the whole history to
    // reach.
    const box = page.getByTestId('composer-input')
    await expect(box).toBeInViewport()
  })
})
