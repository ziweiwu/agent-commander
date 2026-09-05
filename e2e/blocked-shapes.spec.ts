/**
 * The two thinner blocked shapes, and a pane that has ended.
 *
 * `AskUserQuestion` writes its options down, so the card can name them. The
 * other two things an agent blocks on do not: `ExitPlanMode` writes the plan
 * but not the three approval choices, and a tool permission writes the tool
 * and its input but not the numbered list. INV-16 says the card then offers
 * the choices Claude Code *draws*, flagged as a claim about the CLI rather
 * than a reading of the agent, above a live capture of the pane they can be
 * checked against. And a pane whose process has exited keeps its last frame
 * on screen for as long as the tab is open — INV-1 forbids the pty that
 * would report the exit — so the Attach tab has to find out from tmux and
 * say so.
 *
 * All three fixtures were never prompted, so `openAgent` cannot open them (it
 * waits for a first message). Navigate directly.
 */
import { expect, test } from '@playwright/test'
import { AGENT } from './helpers.ts'

test.describe('a plan awaiting approval', () => {
  test('INV-16 shows the plan, the drawn choices marked as drawn, and the live pane', async ({
    page,
  }) => {
    await page.goto(`/agent/${AGENT.plan}`)
    await expect(page.getByTestId('answer-card')).toBeVisible()
    await expect(page.getByTestId('answer-detail')).toContainText('Backfill the index')
    await expect(page.getByTestId('answer-option')).toHaveCount(3)
    await expect(page.getByTestId('answer-option').last()).toContainText('No, keep planning')
    await expect(page.getByTestId('answer-drawn')).toBeVisible()
    await expect(page.getByTestId('answer-options')).toHaveAttribute('data-drawn', 'true')
    // The capture is the half that keeps a drawn label honest: a real pane,
    // read the way the Attach tab reads it, with the dialog's own numbering.
    // Looked at first: on a phone it sits below the fold, and xterm paints
    // nothing for a terminal that is off screen until it is scrolled into view.
    await page.getByTestId('pane-peek').scrollIntoViewIfNeeded()
    await expect(page.locator('[data-testid="pane-peek"] .xterm-rows')).toContainText(/\S/, {
      timeout: 15_000,
    })
    await expect(page.getByTestId('answer-key-Enter')).toBeEnabled()
    await expect(page.getByTestId('answer-key-Escape')).toBeEnabled()

    // INV-17's size floor, measured on the one control set the fleet-wide
    // sweep never opens: a blocked agent's answer keys. They were 40px on a
    // phone for as long as a width rule sat after the pointer rule.
    const floor = test.info().project.use.hasTouch ? 44 : 24
    const small = await page
      .getByTestId('answer-card')
      .locator('button:not([disabled])')
      .evaluateAll((buttons, min) =>
        buttons
          .map((b) => [b.getAttribute('data-testid') ?? b.textContent, b.getBoundingClientRect()] as const)
          .filter(([, box]) => box.width < min || box.height < min)
          .map(([name]) => name),
      floor)
    expect(small, `answer controls under ${floor}px`).toEqual([])
  })
})

test.describe('a tool awaiting permission', () => {
  test('INV-16 shows what the tool would do, and the drawn choices marked as drawn', async ({
    page,
  }) => {
    await page.goto(`/agent/${AGENT.permission}`)
    await expect(page.getByTestId('answer-card')).toBeVisible()
    await expect(page.getByTestId('answer-detail')).toContainText('rm -rf dist')
    await expect(page.getByTestId('answer-option')).toHaveCount(3)
    await expect(page.getByTestId('answer-option').first()).toContainText('Yes')
    await expect(page.getByTestId('answer-drawn')).toBeVisible()
    await expect(page.getByTestId('answer-peek')).toBeVisible()
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
