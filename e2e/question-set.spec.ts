/**
 * INV-16, TODO §13a and §11: a two-question `AskUserQuestion` — a single
 * choice, then a multi-select — answered to the end from the Chat tab.
 *
 * The fixture's pane is a transcription of the picker Claude Code 2.1.278
 * draws, and it moves under the digits the card sends the way that one moved:
 * a digit on the first question answers it and advances, a digit on the second
 * ticks a row, `→` opens the review page, and its first row submits. What this
 * proves is the whole loop the card used to stop one press into — and it
 * proves it against the same server path a real pane goes through, because the
 * mock's `key` is the only difference.
 *
 * Serial, and alone on its fixture (`AGENT.set`): the picker is shared state on
 * the one mock server every project uses, and it forgets a submission after a
 * few seconds so the next project finds the question asked again.
 */
import { expect, test } from '@playwright/test'
import { AGENT } from './helpers'

test.describe.configure({ mode: 'serial' })

test('walks a set to the end from the conversation', async ({ page }) => {
  await page.goto(`/agent/${AGENT.set}`)
  const card = page.getByTestId('answer-card')
  await expect(card).toBeVisible({ timeout: 15_000 })

  // Question one: the pane says which, and the card says where in the set.
  await expect(card.getByTestId('answer-progress')).toContainText('1 of 2')
  await expect(card.getByTestId('answer-question')).toContainText('Which colour')
  const options = card.getByTestId('answer-option')
  await expect(options).toHaveCount(3)
  await options.first().click()

  // The picker advanced, so the next question arrives under a new id and the
  // card opens again — for a multi-select, with its own flag (§13b).
  await expect(card.getByTestId('answer-progress')).toContainText('2 of 2', { timeout: 15_000 })
  await expect(card.getByTestId('answer-question')).toContainText('Which sizes')
  await expect(card.getByTestId('answer-multi')).toBeVisible()
  await expect(options).toHaveCount(3)
  await expect(options.first()).toBeEnabled()

  // Two ticks, then → to the review page, whose rows are read off the pane.
  await options.nth(0).click()
  await expect(page.getByTestId('toast')).toBeVisible()
  await options.nth(2).click()
  await card.getByTestId('answer-key-Right').click()
  await expect(card.getByTestId('answer-drawn')).toHaveAttribute('data-read', 'true', {
    timeout: 15_000,
  })
  await expect(options).toHaveCount(2)
  await expect(options.first()).toContainText('Submit answers')

  // Submitting closes the call, and with it the labelled answer.
  await options.first().click()
  await expect(card.getByTestId('answer-option')).toHaveCount(0, { timeout: 15_000 })
})
