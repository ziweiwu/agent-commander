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
import { AGENT, entry, openFleet } from './helpers.ts'

/** Open the fleet and expand one agent's delegates. */
async function openDelegates(page: Page, sessionId: string): Promise<void> {
  await openFleet(page)
  const row = entry(page, sessionId)
  await expect(row.getByTestId('agent-delegates')).toBeVisible()
  await row.getByTestId('details-toggle').click()
  await expect(row.getByTestId('delegation-tree')).toBeVisible()
}

test.describe('delegates on the card', () => {
  /*
   * At rest the tree leads with what is moving; the rest of a family waits
   * behind a count, because a long session's tree is mostly history.
   */
  test('INV-13 leads with the moving delegates and folds the rest', async ({ page }) => {
    await openDelegates(page, AGENT.movingFamily)
    const row = entry(page, AGENT.movingFamily)
    const drawn = row.locator('[data-testid="delegate"]')
    const total = 4
    await expect(drawn).not.toHaveCount(total)
    // What is drawn at rest is the subtree that leads to something moving —
    // its finished ancestors included, since a child is drawn under its parent.
    await expect(
      drawn.locator('[data-testid="delegate-state"][data-state="active"]').first(),
    ).toBeVisible()
    const fold = row.getByTestId('delegates-show-rest')
    await expect(fold).toContainText(/more/)
    await fold.click()
    await expect(drawn).toHaveCount(total)
  })

  test('INV-13 draws a delegate of a delegate', async ({ page }) => {
    await openDelegates(page, AGENT.movingFamily)
    await entry(page, AGENT.movingFamily).getByTestId('delegates-show-rest').click()

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
    // It is not moving, so at rest it waits behind the fold.
    await entry(page, AGENT.busy).getByTestId('delegates-show-rest').click()
    const unreadable = entry(page, AGENT.busy)
      .getByTestId('delegate')
      .filter({ hasText: 'qa-triage' })
    await expect(unreadable).toHaveCount(1)
    await expect(unreadable.getByTestId('delegate-effort')).toHaveCount(0)
  })

  test('INV-13 says when a delegate was raised out of a missing parent', async ({ page }) => {
    await openDelegates(page, AGENT.movingFamily)
    // The orphan is quiet, so at rest it waits behind the fold with the rest.
    await entry(page, AGENT.movingFamily).getByTestId('delegates-show-rest').click()

    await expect(entry(page, AGENT.movingFamily).getByTestId('delegate-orphan')).toBeVisible()
  })

  /*
   * "Delegated nothing" is a sentence, not a silence — and on an idle card it
   * is in the fold rather than on the face. (The other sentence, "cannot
   * tell", belongs to a kind with no transcript; the plain terminal is out of
   * the fleet at rest, so `test/ui/fleet-delegates.test.tsx` carries it.)
   */
  test('INV-13 says "delegated nothing" in the fold of an idle card', async ({ page }) => {
    await openFleet(page)

    const idle = entry(page, AGENT.idle)
    await expect(idle.getByTestId('agent-delegates')).toHaveCount(0)
    await idle.getByTestId('details-toggle').click()
    const nothing = idle.getByTestId('agent-delegates')
    await expect(nothing).toHaveAttribute('data-claim', 'none')
    await expect(nothing).not.toContainText(/cannot tell/i)
  })
})

test.describe('a family that has gone quiet', () => {
  /*
   * In the fold since the status rail took over the face. The face answers
   * "which of these needs me" in one column of shapes; this asks a second
   * question — and how long has it been like that — which is what a reader
   * goes looking for once the first is answered (INV-15, amended).
   */
  test('INV-15 asks about it rather than declaring it stalled', async ({ page }) => {
    await openFleet(page)

    // `entry`, not `card`: the disclosure is a sibling of the card button,
    // because a button inside a button is not one.
    const row = entry(page, AGENT.quietFamily)
    await row.getByTestId('details-toggle').click()
    const question = row.getByTestId('stall-candidate')
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

    const row = entry(page, AGENT.movingFamily)
    // "still moving" is an answer, not a question, so it stays on the face.
    await expect(row.getByTestId('delegates-moving')).toContainText(/not a stall/i)
    await row.getByTestId('details-toggle').click()
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
