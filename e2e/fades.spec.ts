/**
 * A container that scrolls says so.
 *
 * Overlay scrollbars and phones hide the bar at rest, so a landscape phone
 * showed the first answer option and nothing to say a second sat below the
 * fold. The fade is set from a measurement, so it has to be there when the
 * content overflows and gone when it does not.
 */
import { expect, test } from '@playwright/test'
import { AGENT, openAgent } from './helpers.ts'

test.describe('scroll edges', () => {
  test('the detail pane fades at the bottom only while content is past it', async ({ page }) => {
    // The blocked fixture was never prompted, so it is opened by URL rather
    // than through `openAgent`, which waits for a first message.
    await page.goto(`/agent/${AGENT.waiting}`)
    await expect(page.getByTestId('answer-card')).toBeVisible()
    const pane = page.getByTestId('detail-pane')

    // A landscape phone: the second option is below the fold.
    await page.setViewportSize({ width: 844, height: 390 })
    await expect(pane).toHaveAttribute('data-overflow', /bottom/)

    // Scrolled to the end, the fade lifts: nothing is past the edge any more.
    await pane.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    await expect(pane).toHaveAttribute('data-overflow', /^(none|right)$/)
  })

  test('a pane that holds its content draws no fade', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await page.setViewportSize({ width: 1280, height: 1200 })
    await expect(page.getByTestId('detail-pane')).toHaveAttribute('data-overflow', 'none')
  })
})
