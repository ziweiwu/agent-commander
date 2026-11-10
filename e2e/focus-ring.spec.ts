/**
 * 2.4.7 judged by the pixels, not by the computed style.
 *
 * The conversation became a Tab stop and its computed outline was a 2px ring,
 * yet nothing blue reached the screen: while a question is open the box
 * carries the scroll-edge fade, a `mask-image`, and a mask clips everything
 * the element paints to its border box, the outline outside it included. A
 * tool result Tab scrolls flush against the conversation's edge loses the
 * outside half of its ring to the conversation's clip the same way. Both read
 * as focused to every check that asks the style.
 *
 * So these Tab to the box, take a screenshot, and look for the `--focus`
 * colour along each of its four edges (`scripts/lib/focus-ring.mjs`, which the
 * a11y audit reads too).
 */
import { expect, type Locator, type Page, test } from '@playwright/test'
import { RING_PAINTED, ringSides, untilStill } from '../scripts/lib/focus-ring.mjs'
import { AGENT, openAgent } from './helpers.ts'

async function expectRingPainted(page: Page, target: Locator): Promise<void> {
  const sides = await ringSides(page, target)
  for (const [side, share] of Object.entries(sides)) {
    expect(share ?? 0, `${side} edge of the focus ring`).toBeGreaterThanOrEqual(RING_PAINTED)
  }
}

/** Tab forward from `from` until `testId` holds the focus, the way a keyboard reader gets there. */
async function tabTo(page: Page, from: Locator, testId: string): Promise<void> {
  await from.focus()
  await expect
    .poll(
      async () => {
        await page.keyboard.press('Tab')
        return page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
      },
      { intervals: [0], timeout: 15_000 },
    )
    .toBe(testId)
}

test.describe('a focused scroll box shows its ring', () => {
  test('the conversation, with a question open, at its end and scrolled back', async ({ page }) => {
    await page.goto(`/agent/${AGENT.permission}`)
    await expect(page.getByTestId('answer-card')).toBeVisible()
    const scroll = page.getByTestId('chat-scroll')
    await tabTo(page, page.getByTestId('tab-chat'), 'chat-scroll')
    await expectRingPainted(page, scroll)

    await scroll.evaluate((el) => el.scrollTo({ top: 0 }))
    await expect(scroll).toHaveAttribute('data-overflow', /bottom/)
    await expect(scroll).toBeFocused()
    await expectRingPainted(page, scroll)
  })

  test('a tool result Tab scrolls in against the conversation edge', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    const edit = page.getByTitle('Edit: src/components/Header.astro')
    await edit.getByTestId('tool-expand').click()
    const body = page.getByTestId('tool-result-body')
    await expect(body).toBeVisible()
    await untilStill(page, '[data-testid="chat-scroll"]')
    await page.getByTestId('chat-scroll').evaluate((el) => el.scrollTo({ top: 0 }))
    await tabTo(page, edit.getByTestId('tool-expand'), 'tool-result-body')
    await expectRingPainted(page, body)
  })
})
