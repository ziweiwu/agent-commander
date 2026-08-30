/**
 * The forest's delegation lanes, end to end.
 *
 * The properties worth pinning here are INV-13's, and they are all about what a
 * lane is *allowed to say*: a quiet delegate must not read as finished, a
 * guessed state must say it was guessed, and an agent this app cannot ask about
 * must not be reported as having delegated nothing. The mark is a dot, so the
 * words live in its `aria-label` and the drawing in `data-state` — both are
 * read here, because either channel alone can lie while the other tells the
 * truth.
 */
import { expect, test } from '@playwright/test'
import { pinView } from './helpers.ts'

const openForest = async (page: import('@playwright/test').Page): Promise<void> => {
  // Pinned rather than inherited from the default, so this suite does not move
  // when the default does — the same reason `openFleet` pins the card list.
  await pinView(page, 'forest')
  await page.goto('/')
  await expect(page.getByTestId('forest-view')).toBeVisible()
  await expect(page.getByTestId('forest-lane').first()).toBeVisible()
}

test.describe('the forest', () => {
  test('INV-13 shows a delegate of a delegate', async ({ page }) => {
    await openForest(page)

    // The mock fleet's deepest chain: a fork, its research delegate, and that
    // one's own. Depth is the thing the sidecars make readable at all.
    await expect(page.locator('[data-testid="forest-lane"][data-depth="3"]').first()).toBeVisible()
  })

  test('INV-13 marks an inferred state as inferred', async ({ page }) => {
    await openForest(page)

    const inferred = page.locator('[data-testid="forest-mark"][data-inferred="true"]').first()
    await expect(inferred).toBeVisible()
    await expect(inferred).toHaveAttribute('aria-label', /worked out, not reported/)
  })

  /*
   * The failure this view exists not to have. An agent that finished and one
   * that died both stop writing, so a quiet delegate drawn as done would tell
   * someone their work completed when nothing checked.
   */
  test('INV-13 never renders a quiet delegate as done', async ({ page }) => {
    await openForest(page)

    const quiet = page.locator('[data-testid="forest-mark"][data-state="quiet"]').first()
    await expect(quiet).toBeVisible()
    await expect(quiet).not.toHaveAttribute('aria-label', /done/)
  })

  // An orphan is raised rather than dropped, and the lane says which one.
  test('INV-13 says when a delegate was raised out of a missing parent', async ({ page }) => {
    await openForest(page)

    await expect(page.getByTestId('forest-orphan').first()).toBeVisible()
  })

  /*
   * Absence of evidence. The sidecars are written by Claude Code, so for a CLI
   * that keeps no transcript there is nothing to read — and an empty family,
   * which is how the forest states "delegated nothing", would be a claim
   * nobody could make (INV-11). The note is the difference.
   */
  test('INV-13 distinguishes "delegated nothing" from "cannot tell"', async ({ page }) => {
    await openForest(page)

    await expect(page.getByTestId('forest-unknown').first()).toBeVisible()
    await expect(page.getByTestId('forest-unknown').first()).toContainText(/cannot tell/i)

    // And at least one family with no delegate lanes carries no note at all —
    // the two claims must not collapse into the same rendering.
    const families = page.getByTestId('forest-family')
    const bare = families
      .filter({ hasNot: page.locator('[data-testid="forest-lane"][data-depth="1"]') })
      .filter({ hasNot: page.getByTestId('forest-unknown') })
    await expect(bare.first()).toBeVisible()
  })

  // The same query narrows both renderings — AGENTS.md's "true in both" rule,
  // and the sharpest case of it: two views disagreeing about which agents
  // exist would be worse than either view alone.
  test('narrows to what the search matches, and says so when nothing does', async ({ page }) => {
    await openForest(page)
    const before = await page.getByTestId('forest-family').count()
    expect(before).toBeGreaterThan(1)

    await page.getByTestId('search').fill('kb-vault')
    await expect(page.getByTestId('forest-family')).toHaveCount(1)

    await page.getByTestId('search').fill('nothing-is-called-this')
    await expect(page.getByTestId('empty-state')).toContainText('nothing-is-called-this')
    await page.getByTestId('search').fill('')
    await expect(page.getByTestId('forest-family')).toHaveCount(before)
  })

  test('opens an agent from its lane', async ({ page }) => {
    await openForest(page)

    await page.getByTestId('forest-lane').first().click()

    await expect(page.getByTestId('agent-detail')).toBeVisible()
    expect(page.url()).toContain('/agent/')
  })

  // The whole document must never scroll sideways, whatever a delegate's brief
  // says — a long label is this view's version of the search term that once
  // forced the fleet to 2175px.
  test('does not scroll sideways at any width', async ({ page }) => {
    await openForest(page)

    for (const width of [1280, 768, 390]) {
      await page.setViewportSize({ width, height: 800 })
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, `overflow at ${width}px`).toBeLessThanOrEqual(1)
    }
  })
})
