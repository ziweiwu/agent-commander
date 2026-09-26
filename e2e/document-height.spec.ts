/**
 * A desktop is one screenful, and the page itself never scrolls.
 *
 * The two columns scroll inside the screen, so anything that makes the
 * document taller than the viewport is empty space Chrome will scroll into.
 * It happened: every card carries an `.sr-only` label, which is absolutely
 * positioned, and with no positioned ancestor it resolved against the page and
 * escaped the fleet column's `overflow: auto`. At 1440x900 on the mock fleet
 * the document was 988px tall, and the wheel scrolled 88px of nothing into
 * view below the app.
 */
import { expect, test, type Page } from '@playwright/test'
import { AGENT, openAgent, openFleet } from './helpers.ts'

/** Short enough that the mock fleet overflows its column. */
const LAPTOP = { width: 1440, height: 900 }

async function documentOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
}

test.describe('the desktop document fits the viewport @desktop', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(LAPTOP)
  })

  test('with the fleet column overflowing', async ({ page }) => {
    await openFleet(page)
    const column = page.getByTestId('agent-card').first().locator('xpath=ancestor::*[contains(@class, "column")][1]')
    const overflows = await column.evaluate((el) => el.scrollHeight > el.clientHeight)
    expect(overflows, 'the fixture fleet no longer overflows; the test proves nothing').toBe(true)

    await expect.poll(() => documentOverflow(page)).toBe(0)
  })

  test('with an agent open', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await expect.poll(() => documentOverflow(page)).toBe(0)
  })

  /*
   * The report that followed the fix: with an agent open and the sessions
   * column expanded, wheeling past the end of the list still dragged blank
   * space into view. The column is the only thing that may scroll there.
   */
  test('wheeling past the end of the sessions column scrolls nothing else', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    const card = page.getByTestId('agent-card').first()
    await card.hover()
    for (let turn = 0; turn < 10; turn++) await page.mouse.wheel(0, 2000)

    const column = card.locator('xpath=ancestor::*[contains(@class, "column")][1]')
    const atEnd = await column.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)
    expect(atEnd, 'the wheel never reached the end of the column').toBe(true)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).toBe('hidden')
  })
})

/*
 * Opening an agent lands on the end of its conversation without animating
 * there. The scroller was `scroll-behavior: smooth`, so every open scrolled
 * the whole conversation past before stopping at the last message.
 */
test('opening an agent lands on the latest message at once @desktop', async ({ page }) => {
  // Short enough that the fixture conversation overflows, still a desktop.
  await page.setViewportSize({ width: LAPTOP.width, height: 480 })
  await openAgent(page, AGENT.idle)
  const scroll = page.getByTestId('chat-scroll')
  const overflowing = await scroll.evaluate((el) => el.scrollHeight > el.clientHeight + 1)
  expect(overflowing, 'the fixture conversation no longer overflows; the test proves nothing').toBe(true)

  expect(await scroll.evaluate((el) => getComputedStyle(el).scrollBehavior)).toBe('auto')
  const fromEnd = await scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
  expect(fromEnd).toBeLessThan(2)
})
