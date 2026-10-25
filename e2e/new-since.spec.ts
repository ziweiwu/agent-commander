/**
 * F6 across the whole join: "new since you last opened it in this app".
 *
 * The record lives on the server so the laptop and the phone agree, and it
 * moves only while a tab that is on screen has the session open. So the path
 * worth proving end to end is the one no unit test can see: something lands
 * while the only tab holding the session is hidden, the card says "new", and
 * opening it on screen takes the mark away again.
 *
 * The tab is hidden the way a phone hides it: `visibilityState` reads
 * `hidden` and `visibilitychange` fires, which is what makes the page tell the
 * server it is off screen. The mock moves a fixture's activity when a message
 * is sent to it, as a real transcript does.
 */
import { expect, test } from '@playwright/test'
import { AGENT, card, entry, openAgent, openFleet, said, stamp } from './helpers.ts'

test.describe('new since opened in this app', () => {
  test('an idle agent that moved while its tab was hidden is marked, and opening it clears the mark', async ({
    page,
  }) => {
    const id = AGENT.idleAlt
    await openAgent(page, id)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const text = stamp('while nobody was looking')
    await page.getByTestId('composer-input').fill(text)
    await page.getByTestId('composer-send').click()
    await expect(said(page, text)).toHaveCount(1, { timeout: 15_000 })

    await openFleet(page)
    await expect(entry(page, id).getByTestId('agent-new')).toHaveText('new')
    await expect(page.getByTestId('group-new')).toContainText('new')

    await card(page, id).click()
    await expect(page.getByTestId('new-since')).toContainText('New since you last opened this')

    await openFleet(page)
    await expect(entry(page, id).getByTestId('agent-new')).toHaveCount(0)
  })
})
