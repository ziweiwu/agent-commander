/**
 * The delegation tree, end to end.
 *
 * The properties worth pinning here are INV-13's, and they are all about what a
 * row is *allowed to say*: a quiet delegate must not read as finished, a guessed
 * state must say it was guessed, and an agent this app cannot ask about must not
 * be reported as having delegated nothing.
 */
import { expect, test } from '@playwright/test'
import { openFleet } from './helpers.ts'

const openTree = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.goto('/tree')
  await expect(page.getByTestId('tree-view')).toBeVisible()
  await expect(page.getByTestId('tree-root').first()).toBeVisible()
}

test.describe('the delegation tree', () => {
  test('INV-13 shows a delegate of a delegate', async ({ page }) => {
    await openTree(page)

    // The mock fleet's deepest chain: a fork, its research delegate, and that
    // one's own. Depth is the thing the sidecars make readable at all.
    await expect(page.locator('[data-testid="tree-node"][data-depth="3"]').first()).toBeVisible()
  })

  test('INV-13 marks an inferred state as inferred', async ({ page }) => {
    await openTree(page)

    const inferred = page.locator('[data-testid="tree-state"][data-inferred="true"]').first()
    await expect(inferred).toBeVisible()
    await expect(inferred).toContainText(/inferred/i)
  })

  /*
   * The failure this view exists not to have. An agent that finished and one
   * that died both stop writing, so a quiet delegate drawn as done would tell
   * someone their work completed when nothing checked.
   */
  test('INV-13 never renders a quiet delegate as done', async ({ page }) => {
    await openTree(page)

    const quiet = page.locator('[data-testid="tree-state"][data-state="quiet"]').first()
    await expect(quiet).toBeVisible()
    await expect(quiet).not.toContainText(/done/i)
  })

  // An orphan is raised rather than dropped, and the view says which one.
  test('INV-13 says when a delegate was raised out of a missing parent', async ({ page }) => {
    await openTree(page)

    await expect(page.getByTestId('tree-reparented').first()).toBeVisible()
  })

  /*
   * Absence of evidence. The sidecars are written by Claude Code, so for a CLI
   * that keeps no transcript there is nothing to read — and "has not delegated"
   * would be a claim nobody could make (INV-11).
   */
  test('INV-13 distinguishes "delegated nothing" from "cannot tell"', async ({ page }) => {
    await openTree(page)

    const empties = page.getByTestId('tree-empty')
    await expect(empties.filter({ hasText: /has not delegated/i }).first()).toBeVisible()
    await expect(empties.filter({ hasText: /cannot tell/i }).first()).toBeVisible()
  })

  test('opens an agent from its tree row', async ({ page }) => {
    await openTree(page)

    await page.getByTestId('tree-open-agent').first().click()

    await expect(page.getByTestId('agent-detail')).toBeVisible()
    expect(page.url()).toContain('/agent/')
  })

  test('is reachable from the fleet and back again', async ({ page }) => {
    await openFleet(page)

    await page.getByTestId('tree-button').click()
    await expect(page.getByTestId('tree-view')).toBeVisible()

    await page.getByTestId('tree-button').click()
    await expect(page.getByTestId('agent-card').first()).toBeVisible()
  })

  // The whole document must never scroll sideways, whatever a delegate's brief
  // says — a long description is this view's version of the search term that
  // once forced the fleet to 2175px.
  test('does not scroll sideways at any width', async ({ page }) => {
    await openTree(page)

    for (const width of [1280, 768, 390]) {
      await page.setViewportSize({ width, height: 800 })
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, `overflow at ${width}px`).toBeLessThanOrEqual(1)
    }
  })
})
