import { expect, test } from '@playwright/test'
import { openFleet } from './helpers.ts'

test.describe('reduced motion paints nothing in between', () => {
  test.use({ reducedMotion: 'reduce' })

  test('an agent name has no transition at all', async ({ page }) => {
    await openFleet(page)
    const durations = await page
      .getByTestId('agent-name')
      .first()
      .evaluate((name) => {
        const style = getComputedStyle(name)
        return { transition: style.transitionDuration, animation: style.animationDuration }
      })
    expect(durations).toEqual({ transition: '0s', animation: '0s' })
  })
})
