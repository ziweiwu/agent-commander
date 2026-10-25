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
import { AGENT, card, openAgent, openFleet, stamp } from './helpers.ts'

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

  /**
   * F1. ‹ Agents unmounts the sheet, and the draft used to be component state
   * inside it, so a reply half-written on the bus was gone by the time the
   * reader had checked the fleet and come back.
   */
  test('keeps a half-typed message through ‹ Agents and back', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    const draft = stamp('half a reply, not sent')
    await page.getByTestId('composer-input').fill(draft)

    await page.getByTestId('back-button').click()
    await expect(page.getByTestId('fleet-list')).toBeVisible()
    await card(page, AGENT.idle).click()

    await expect(page.getByTestId('composer-input')).toHaveValue(draft)
  })
})

/** The phone widths the sheet has to hold its header at: an SE, a mini, a 13/14, a Pro Max. */
const PHONE_WIDTHS = [320, 375, 390, 430]
/** Enough of the agent's name to tell one agent from the next. */
const MIN_NAME_PX = 60

/**
 * FR-DET-2 on a phone. The sheet's header was `flex-wrap: nowrap`, so the back
 * link, the status, the tabs and the actions came to about 340px in a row with
 * nothing allowed to drop: at 320px ⤢ sat at x 325-369, past the sheet's own
 * `overflow: hidden` edge and impossible to press, and from 320 to 390 the
 * agent's name got about 0px. The tabs now drop to a second row instead.
 */
test.describe('@phone the sheet header', () => {
  for (const [what, sessionId] of [
    ['an idle agent', AGENT.idle],
    ['a blocked one, whose status is the longest word', AGENT.waiting],
  ] as const) {
    test(`keeps every control inside the sheet and the name readable, for ${what}`, async ({
      page,
    }) => {
      for (const width of PHONE_WIDTHS) {
        await page.setViewportSize({ width, height: 740 })
        await page.goto(`/agent/${sessionId}`)
        await expect(page.getByTestId('agent-detail')).toBeVisible()

        const header = await page.evaluate(() => {
          const sheet = document.querySelector('[data-testid="agent-detail"]')?.getBoundingClientRect()
          const head = document.querySelector('[data-testid="detail-head"]')
          const name = document.querySelector('[data-testid="detail-name"]')?.getBoundingClientRect()
          if (!sheet || !head || !name) return null
          const outside = [...head.querySelectorAll('button')]
            .filter((button) => button.checkVisibility())
            .filter((button) => {
              const box = button.getBoundingClientRect()
              return (
                box.left < sheet.left - 0.5 ||
                box.right > sheet.right + 0.5 ||
                box.top < sheet.top - 0.5 ||
                box.bottom > sheet.bottom + 0.5
              )
            })
            .map((button) => button.dataset.testid ?? button.textContent ?? '')
          return { outside, name: name.width }
        })

        expect(header, `${width}px: the sheet header did not render`).not.toBeNull()
        expect(header?.outside, `${width}px: header controls past the sheet's edge`).toEqual([])
        expect(header?.name ?? 0, `${width}px: the agent's name`).toBeGreaterThanOrEqual(MIN_NAME_PX)
      }
    })
  }
})
