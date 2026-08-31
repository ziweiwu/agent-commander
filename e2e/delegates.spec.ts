/**
 * Delegates on the fleet card, end to end.
 *
 * The properties worth pinning here are INV-13's and INV-15's, and they are all
 * about what a card is *allowed to say*: a quiet delegate must not read as
 * finished, a guessed state must say it was guessed, an agent this app cannot
 * ask about must not be reported as having delegated nothing, and a family that
 * has gone silent must be asked about rather than pronounced dead.
 *
 * Against the real server and the real sidecar shapes, because the unit tests
 * hand the card a tree directly and structurally cannot catch a graph that
 * never arrives.
 */
import { expect, test, type Page } from '@playwright/test'
import { AGENT, card, entry, openFleet } from './helpers.ts'

/** Open the fleet and expand one agent's delegates. */
async function openDelegates(page: Page, sessionId: string): Promise<void> {
  await openFleet(page)
  const row = entry(page, sessionId)
  await expect(row.getByTestId('agent-delegates')).toBeVisible()
  await row.getByTestId('delegates-toggle').click()
  await expect(row.getByTestId('delegation-tree')).toBeVisible()
}

test.describe('delegates on the card', () => {
  test('INV-13 draws a delegate of a delegate', async ({ page }) => {
    await openDelegates(page, AGENT.movingFamily)

    // The mock fleet's deepest chain: a research delegate and its own.
    await expect(entry(page, AGENT.movingFamily).getByTestId('delegate')).toHaveCount(4)
  })

  test('INV-13 marks an inferred state as inferred', async ({ page }) => {
    await openDelegates(page, AGENT.movingFamily)

    const guessed = entry(page, AGENT.movingFamily)
      .locator('[data-testid="delegate-state"][data-inferred="true"]')
      .first()
    await expect(guessed).toBeVisible()
    await expect(guessed).toContainText('inferred')
  })

  /*
   * The failure this exists not to have. An agent that finished and one that
   * died both stop writing, so a quiet delegate drawn as done would tell
   * somebody their work completed when nothing checked.
   */
  test('INV-13 never renders a quiet delegate as done', async ({ page }) => {
    await openDelegates(page, AGENT.quietFamily)

    const quiet = entry(page, AGENT.quietFamily).locator(
      '[data-testid="delegate-state"][data-state="quiet"]',
    )
    await expect(quiet.first()).toBeVisible()
    await expect(quiet.first()).not.toContainText('done')
  })

  /*
   * `quiet` is almost every delegate's state, so a tree of them says nothing
   * without this. One fixture deliberately carries no effort at all, and the
   * two cases have to look different on screen rather than both showing a zero.
   */
  test('INV-13 says what a delegate did, and admits when it cannot', async ({ page }) => {
    await openDelegates(page, AGENT.quietFamily)
    const worked = entry(page, AGENT.quietFamily).getByTestId('delegate-effort').first()
    await expect(worked).toContainText(/\d+ calls/)

    // The one fixture with no effort at all lives under `busy`, beside two
    // that have it — so the difference is visible on one screen.
    await openDelegates(page, AGENT.busy)
    const unreadable = entry(page, AGENT.busy)
      .getByTestId('delegate')
      .filter({ hasText: 'qa-triage' })
    await expect(unreadable).toHaveCount(1)
    await expect(unreadable.getByTestId('delegate-effort')).toHaveCount(0)
  })

  test('INV-13 says when a delegate was raised out of a missing parent', async ({ page }) => {
    await openDelegates(page, AGENT.movingFamily)

    await expect(entry(page, AGENT.movingFamily).getByTestId('delegate-orphan')).toBeVisible()
  })

  /*
   * Two agents with no delegates on screen, for two different reasons, and the
   * card has to make them different sentences rather than the same silence.
   */
  test('INV-13 separates "delegated nothing" from "cannot tell"', async ({ page }) => {
    await openFleet(page)

    const cannotTell = card(page, AGENT.noSidecars).getByTestId('agent-delegates')
    await expect(cannotTell).toHaveAttribute('data-claim', 'unknown')
    await expect(cannotTell).toContainText(/cannot tell/i)

    const nothing = card(page, AGENT.idle).getByTestId('agent-delegates')
    await expect(nothing).toHaveAttribute('data-claim', 'none')
    await expect(nothing).not.toContainText(/cannot tell/i)
  })
})

test.describe('a family that has gone quiet', () => {
  test('INV-15 asks about it rather than declaring it stalled', async ({ page }) => {
    await openFleet(page)

    const question = card(page, AGENT.quietFamily).getByTestId('stall-candidate')
    await expect(question).toBeVisible()
    await expect(question).toContainText('still working?')
    await expect(question).not.toContainText(/stalled|dead|failed/i)
  })

  /*
   * The same shape with one delegate still moving, and it must reach the
   * opposite answer in the same slot — otherwise the question above is just
   * noise that appears on every delegating agent.
   */
  test('INV-15 says the opposite while a delegate is still moving', async ({ page }) => {
    await openFleet(page)

    const row = card(page, AGENT.movingFamily)
    await expect(row.getByTestId('delegates-moving')).toContainText(/not a stall/i)
    await expect(row.getByTestId('stall-candidate')).toHaveCount(0)
  })
})

test.describe('delegates on a narrow screen', () => {
  test('INV-13 an expanded tree never scrolls the page sideways', async ({ page }) => {
    await openDelegates(page, AGENT.movingFamily)

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
