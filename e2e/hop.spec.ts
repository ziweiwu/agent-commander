/**
 * F3 against the real server: "✋ 2 ›", the hand-off after an answer, and ⌥J.
 *
 * The mock fleet has four agents blocked at once — a question, a plan, a
 * permission and a question set — so from any one of them the chip has three
 * others to count and somewhere real to go.
 */
import { expect, test } from '@playwright/test'
import { AGENT, card, openFleet } from './helpers.ts'

/** The other blocked fixtures, any of which "next" may name depending on the sort. */
const OTHER_BLOCKED = new RegExp(`/agent/(${[AGENT.plan, AGENT.permission, AGENT.set].join('|')})$`)
const OTHER_BLOCKED_NAMES = /plan-the-migration|rebuild-dist|stock-the-shop/
/** The topbar row's height, which the chip must not move (AGENTS.md: a 16px hand did). */
const TOPBAR_CHIP_PX = 30

test('@phone the chip opens another blocked agent, and back returns to the fleet', async ({ page }) => {
  await openFleet(page)
  await card(page, AGENT.waiting).click()
  await expect(page).toHaveURL(new RegExp(`/agent/${AGENT.waiting}$`))

  const chip = page.getByTestId('waiting-chip')
  await expect(chip).toBeVisible()
  await expect(chip).toHaveAttribute('aria-label', /^\d+ other agents? needs? you — open «/)
  await chip.click()
  await expect(page).toHaveURL(OTHER_BLOCKED)
  await expect(page.getByTestId('agent-detail')).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('fleet-list')).toBeVisible()
})

test('@desktop with the column collapsed, ⌥J reaches the next agent and ⌥K comes back', async ({
  page,
}) => {
  await openFleet(page)
  await card(page, AGENT.waiting).click()
  await expect(page.getByTestId('waiting-chip')).toHaveCount(0)
  await page.getByTestId('sidebar-toggle').click()
  await expect(page.getByTestId('fleet-list')).toHaveCount(0)

  const chip = page.getByTestId('waiting-chip')
  await expect(chip).toBeVisible()
  expect((await chip.boundingBox())?.height).toBe(TOPBAR_CHIP_PX)

  await page.getByTestId('composer-input').focus()
  await page.keyboard.press('Alt+KeyJ')
  await expect(page).not.toHaveURL(new RegExp(`/agent/${AGENT.waiting}$`))
  await expect(page.getByTestId('agent-detail')).toBeVisible()
  await page.keyboard.press('Alt+KeyK')
  await expect(page).toHaveURL(new RegExp(`/agent/${AGENT.waiting}$`))
})

test('answering a blocked agent offers the next blocked one, and waits to be pressed', async ({
  page,
}) => {
  await page.goto(`/agent/${AGENT.waiting}`)
  const answer = page.getByTestId('answer-card')
  await expect(answer).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('answer-next')).toHaveCount(0)

  await answer.getByTestId('answer-option').first().click()
  const next = page.getByTestId('answer-next')
  await expect(next).toBeVisible({ timeout: 15_000 })
  await expect(next).toContainText(OTHER_BLOCKED_NAMES)
  await expect(next).toContainText('⌥H')
  await expect(page).toHaveURL(new RegExp(`/agent/${AGENT.waiting}$`))

  await next.click()
  await expect(page).toHaveURL(OTHER_BLOCKED)
})
