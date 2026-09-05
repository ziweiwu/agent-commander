/**
 * The fleet view, end to end: what the socket delivers, what the URL owns, and
 * what survives a reload.
 */
import { expect, test } from '@playwright/test'
import { AGENT, card, openFleet } from './helpers.ts'

test.describe('the fleet', () => {
  test('lists what the server has, and says it is not real', async ({ page }) => {
    await openFleet(page)

    // The banner is stamped into the document by the server rather than
    // arriving with the first frame — it used to shift the whole layout down
    // 28px when it appeared, a measured CLS of 0.121.
    await expect(page.locator('html')).toHaveAttribute('data-mock', 'true')
    await expect(page.getByText(/mock mode/)).toBeVisible()

    await expect(card(page, AGENT.waiting)).toBeVisible()
    await expect(card(page, AGENT.idle)).toBeVisible()
    // The blocked one is the reason to look at this screen at all, so its
    // status has to be legible as more than a colour.
    await expect(card(page, AGENT.waiting).getByTestId('agent-status')).toHaveText(/dialog open/i)
  })

  test('filters by status, and remembers the choice across a reload', async ({ page }) => {
    await openFleet(page)
    const waitingChip = page.locator('[data-testid="filter-chip"][data-key="waiting"]')
    await waitingChip.click()

    await expect(card(page, AGENT.waiting)).toBeVisible()
    await expect(card(page, AGENT.busy)).toHaveCount(0)

    /*
     * The filter surviving a reload is why the active chip carries a glyph as
     * well as a fill: arriving at an already-filtered dashboard without having
     * just clicked anything is how this app comes to look like agents vanished.
     */
    await page.reload()
    await expect(page.getByTestId('agent-card').first()).toBeVisible()
    await expect(waitingChip).toHaveAttribute('aria-pressed', 'true')
    await expect(card(page, AGENT.busy)).toHaveCount(0)

    await waitingChip.click()
    await expect(card(page, AGENT.busy)).toBeVisible()
  })

  test('INV-11 a CLI with no transcript still says what it is running', async ({ page }) => {
    await openFleet(page)
    // The Kiro fixture has no transcript to describe its work, so the process
    // under its pane is the only activity line it can honestly carry.
    const line = card(page, AGENT.noSidecars).getByTestId('agent-activity')
    await expect(line).toHaveText(/running npm test/)
    await expect(line).toHaveAttribute('data-running', 'true')
  })

  test('searches by name and folder', async ({ page }) => {
    await openFleet(page)
    await page.getByTestId('search').fill('kb-vault')

    await expect(card(page, AGENT.waiting)).toBeVisible()
    await expect(card(page, AGENT.idle)).toHaveCount(0)

    await page.getByTestId('search').fill('nothing matches this')
    await expect(page.getByTestId('empty-state')).toBeVisible()
  })

  test('opens an agent by URL and keeps it across a reload', async ({ page }) => {
    // The URL is the selection state, so a deep link is the same thing as a
    // click — including on a reload straight into /agent/:id, which is the case
    // that used to arrive with the transport pointing at nothing.
    await page.goto(`/agent/${AGENT.idle}`)
    await expect(page.getByTestId('detail-name')).toContainText('kb-operational-hardening')
    await expect(page.getByTestId('message').first()).toBeVisible()

    await page.reload()
    await expect(page.getByTestId('detail-name')).toContainText('kb-operational-hardening')
    await expect(page.getByTestId('message').first()).toBeVisible()
  })

  test('the back gesture closes the agent rather than leaving the app', async ({ page }) => {
    await openFleet(page)
    await card(page, AGENT.idle).click()
    await expect(page.getByTestId('agent-detail')).toBeVisible()

    await page.goBack()

    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('fleet-list')).toBeVisible()
  })

  test('an agent outside tmux says why it cannot be attached to @desktop', async ({ page }) => {
    // INV-5: one agent losing a capability degrades that agent and renders a
    // reason. It does not remove it from the fleet.
    await page.goto(`/agent/${AGENT.noTmux}`)
    await expect(page.getByTestId('agent-detail')).toBeVisible()

    const attach = page.getByTestId('tab-attach')
    await expect(attach).toBeDisabled()
    // A disabled control cannot carry a tooltip — no mouse events reach it —
    // so the reason has to be beside it rather than inside the view it is
    // stopping you opening.
    await expect(page.getByTestId('attach-blocked-note')).toHaveText(/not running inside tmux/i)
  })
})
