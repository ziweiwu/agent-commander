/**
 * The conversation opens at its latest message and keeps following it.
 *
 * Two ways a reader was left parked above the end on a phone: an agent with
 * more news than fits the view opened at the "new since you last opened this"
 * divider, unpinned; and a pinned view did not follow content that grew after
 * it was drawn. The first is built the way a reader meets it: the tab is
 * hidden while messages arrive, then the agent is opened from its card.
 */
import { expect, test, type Page } from '@playwright/test'
import { AGENT, card, openAgent, openFleet, said, stamp } from './helpers.ts'

const NEWS = 4
const GROWTH_PX = 900
const END_SLACK_PX = 2

const distanceFromEnd = (page: Page) =>
  page.getByTestId('chat-scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)

async function openWithMoreNewThanFits(page: Page, id: string): Promise<void> {
  await openAgent(page, id)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  for (let n = 0; n < NEWS; n += 1) {
    const text = stamp(`news while away ${'x'.repeat(200)}`)
    await page.getByTestId('composer-input').fill(text)
    await page.getByTestId('composer-send').click()
    await expect(said(page, text)).toHaveCount(1, { timeout: 15_000 })
  }
  await openFleet(page)
  await card(page, id).click()
  await expect(page.getByTestId('new-since')).toBeVisible()
  await expect(page.getByTestId('message').first()).toBeVisible()
}

test.describe('the conversation follows the latest message', () => {
  test('E21 an agent with more new than fits opens at the latest message and stays there @desktop', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 420 })
    await openWithMoreNewThanFits(page, AGENT.idleAlt)
    const taller = await page.evaluate(() => {
      const scroll = document.querySelector('[data-testid="chat-scroll"]') as HTMLElement
      const line = document.querySelector('[data-testid="new-since"]') as HTMLElement
      const top = line.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
      return scroll.scrollHeight - top > scroll.clientHeight
    })
    expect(taller, 'what is new fits the view; the test proves nothing').toBe(true)
    await expect.poll(() => distanceFromEnd(page)).toBeLessThan(END_SLACK_PX)
    await expect(page.getByTestId('jump-to-latest')).toHaveCount(0)

    const text = stamp('and one more')
    await page.getByTestId('composer-input').fill(text)
    await page.getByTestId('composer-send').click()
    await expect(said(page, text)).toHaveCount(1, { timeout: 15_000 })
    await expect.poll(() => distanceFromEnd(page)).toBeLessThan(END_SLACK_PX)
  })

  test('E21 the same on a phone @phone', async ({ page }) => {
    await openWithMoreNewThanFits(page, AGENT.idleAlt)
    await expect.poll(() => distanceFromEnd(page)).toBeLessThan(END_SLACK_PX)
    await expect(page.getByTestId('jump-to-latest')).toHaveCount(0)
  })

  test('E22 a pinned conversation follows content that grows after it was drawn', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await expect.poll(() => distanceFromEnd(page)).toBeLessThan(END_SLACK_PX)
    await page.getByTestId('chat-list').evaluate((list, px) => {
      const late = document.createElement('div')
      late.style.height = `${px}px`
      late.dataset.testid = 'late-growth'
      list.appendChild(late)
    }, GROWTH_PX)
    await expect.poll(() => distanceFromEnd(page)).toBeLessThan(END_SLACK_PX)
  })

  test('E22 a reader scrolled up is left where they are when content grows', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    const scroll = page.getByTestId('chat-scroll')
    await page.getByTestId('chat-list').evaluate((list, px) => {
      const spacer = document.createElement('div')
      spacer.style.height = `${px}px`
      list.appendChild(spacer)
    }, GROWTH_PX)
    await expect.poll(() => distanceFromEnd(page)).toBeLessThan(END_SLACK_PX)
    await scroll.evaluate((el) => el.scrollTo({ top: 0, behavior: 'instant' }))
    await expect(page.getByTestId('jump-to-latest')).toBeVisible()
    await page.getByTestId('chat-list').evaluate((list, px) => {
      const late = document.createElement('div')
      late.style.height = `${px}px`
      list.appendChild(late)
    }, GROWTH_PX)
    await page.waitForTimeout(300)
    expect(await scroll.evaluate((el) => el.scrollTop)).toBeLessThan(2)
  })
})
