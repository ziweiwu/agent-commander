/**
 * The two thinner blocked shapes, and a pane that has ended.
 *
 * `AskUserQuestion` writes its options down, so the card can name them. The
 * other two things an agent blocks on do not: `ExitPlanMode` writes the plan
 * but not the three approval choices, and a tool permission writes the tool
 * and its input but not the numbered list. INV-16 says the card then offers
 * keys rather than labels it would have had to invent. And a pane whose
 * process has exited keeps its last frame on screen for as long as the tab is
 * open — INV-1 forbids the pty that would report the exit — so the Attach tab
 * has to find out from tmux and say so.
 *
 * All three fixtures were never prompted, so `openAgent` cannot open them (it
 * waits for a first message). Navigate directly.
 */
import { expect, test } from '@playwright/test'
import { AGENT } from './helpers.ts'

test.describe('a plan awaiting approval', () => {
  test('INV-16 shows the plan and offers keys, never invented options', async ({ page }) => {
    await page.goto(`/agent/${AGENT.plan}`)
    await expect(page.getByTestId('answer-card')).toBeVisible()
    await expect(page.getByTestId('answer-detail')).toContainText('Backfill the index')
    await expect(page.getByTestId('answer-no-options')).toBeVisible()
    await expect(page.getByTestId('answer-option')).toHaveCount(0)
    await expect(page.getByTestId('answer-key-Enter')).toBeEnabled()
    await expect(page.getByTestId('answer-key-Escape')).toBeEnabled()
  })
})

test.describe('a tool awaiting permission', () => {
  test('INV-16 shows what the tool would do, and nothing it did not say', async ({ page }) => {
    await page.goto(`/agent/${AGENT.permission}`)
    await expect(page.getByTestId('answer-card')).toBeVisible()
    await expect(page.getByTestId('answer-detail')).toContainText('rm -rf dist')
    await expect(page.getByTestId('answer-no-options')).toBeVisible()
    await expect(page.getByTestId('answer-option')).toHaveCount(0)
  })
})

test.describe('a pane that has exited', () => {
  test('says so on the Attach tab and takes the keys away', async ({ page }) => {
    await page.goto(`/agent/${AGENT.gone}`)
    await page.getByTestId('tab-attach').click()
    await expect(page.getByTestId('pane-exited')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('pane-exited-caption')).toBeVisible()
    // Nothing typed can reach a pane that has gone (INV-2), so the row that
    // would type is really disabled, not dimmed.
    const keybar = page.getByTestId('keybar')
    await expect(keybar.getByRole('button', { name: 'Enter' })).toBeDisabled()
    await expect(keybar.getByRole('button', { name: 'Ctrl-C' })).toBeDisabled()
  })
})
