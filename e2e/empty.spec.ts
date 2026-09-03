/**
 * The confirmed-empty fleet, against `--mock-empty`.
 *
 * This is the one screen where the app has to explain itself once: the
 * server has said zero, so the loading outlines (INV-11) give way to the two
 * ways in — the command that starts an agent and the button that starts one
 * from here — and a pointer to the phone setup for whoever is reading this on
 * one.
 */
import { expect, test } from '@playwright/test'
import { EMPTY_URL } from '../playwright.config.ts'

test.use({ baseURL: EMPTY_URL })

test.describe('the first-run screen', () => {
  test('shows both ways in once the server has said zero', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'open')

    const empty = page.getByTestId('empty-state')
    await expect(empty).toBeVisible()
    await expect(page.getByTestId('fleet-loading')).toHaveCount(0)
    await expect(empty.getByTestId('empty-command')).toHaveText('claude')
    await expect(empty.getByTestId('empty-new-agent')).toBeVisible()
    await expect(empty.getByTestId('empty-help')).toBeVisible()
  })

  test('the button opens the new-agent dialog, browsing from home', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('empty-new-agent').click()
    await expect(page.getByTestId('new-agent-dialog')).toBeVisible()
    // A first run has no recent folders to offer, so the browser is open
    // rather than the form being a bare text field.
    await expect(page.getByTestId('new-agent-browse')).toHaveAttribute('aria-expanded', 'true')
  })

  test('the help link lands on the phone setup', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('empty-help').click()
    await expect(page).toHaveURL(/\/help/)
    await expect(page.getByText(/tailscale/i).first()).toBeVisible()
  })
})
