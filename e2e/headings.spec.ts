/**
 * One level-one heading an assistive technology can reach, on every route and
 * at every shape: the phone's sheet hid the app's h1 with the fleet, so an
 * agent open on a phone had none (axe page-has-heading-one), and nothing may
 * fix that by drawing a second.
 */
import { expect, test } from '@playwright/test'
import { AGENT } from './helpers.ts'

const ROUTES: Array<[string, string]> = [
  ['/', 'agent-card'],
  [`/agent/${AGENT.plan}`, 'agent-detail'],
  ['/help', 'help-page'],
]

test.describe('the page heading', () => {
  for (const [route, landed] of ROUTES) {
    test(`${route} has exactly one reachable h1`, async ({ page }) => {
      await page.goto(route)
      await expect(page.getByTestId(landed).first()).toBeVisible()
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
      expect(await page.locator('h1').count()).toBe(1)
    })
  }
})
