/**
 * INV-2 against the real server: the gesture that opened something never
 * sends from the control it lands on.
 *
 * Three routes, one cause. Opening a blocked agent puts focus (desk) or the
 * finger (phone) on option one — on a permission dialog, "Yes" — and opening
 * the composer's menu focuses its first reply, "continue". The tail of the
 * same gesture then landed there: the second tap of a double tap, or the
 * auto-repeat of a held Enter. Each of these sent on 3cc6501.
 *
 * What is asserted is the wire: no `answer`, `key` or `paste` frame leaves the
 * page. Nothing is answered on success, so the shared mock fixtures are left
 * as every other spec expects to find them.
 */
import { expect, test, type Page } from '@playwright/test'
import { AGENT, card, openFleet } from './helpers.ts'

/** A double tap's second tap, as B and the judge timed it. */
const DOUBLE_TAP_GAP_MS = 150
/** Longer than any arrival window, so only the repeat check can stop it. */
const LONG_HOLD_MS = 800
/** How long a send would take to reach the socket, were one made. */
const SETTLE_MS = 600

/** Every frame the page writes that would type into an agent. */
function sendsOf(page: Page): string[] {
  const sent: string[] = []
  page.on('websocket', (ws) => {
    ws.on('framesent', (frame) => {
      const text = String(frame.payload)
      if (/"type":"(answer|key|paste)"/.test(text)) sent.push(text)
    })
  })
  return sent
}

/** Press Enter, keep it held for `heldForMs`, and let the OS send its repeat. */
async function holdEnter(page: Page, heldForMs: number): Promise<void> {
  await page.keyboard.down('Enter')
  await page.waitForTimeout(heldForMs)
  await page.keyboard.down('Enter')
  await page.keyboard.up('Enter')
  await page.waitForTimeout(SETTLE_MS)
}

test('@phone INV-2 a double tap on a waiting card’s Answer does not answer the dialog', async ({
  page,
}) => {
  const sent = sendsOf(page)
  await openFleet(page)
  const cta = card(page, AGENT.permission).getByTestId('agent-answer-cta')
  await cta.scrollIntoViewIfNeeded()
  const box = await cta.boundingBox()
  if (!box) throw new Error('the waiting card shows no Answer')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2

  await page.touchscreen.tap(x, y)
  await page.waitForTimeout(DOUBLE_TAP_GAP_MS)
  await page.touchscreen.tap(x, y)
  await page.waitForTimeout(SETTLE_MS)

  await expect(page).toHaveURL(new RegExp(`/agent/${AGENT.permission}$`))
  const under = await page.evaluate(
    ([px, py]) => document.elementFromPoint(px!, py!)?.closest('[data-testid="answer-option"]') !== null,
    [x, y],
  )
  expect(under, 'the second tap must land on an answer option for this to prove anything').toBe(true)
  expect(sent).toEqual([])
  await expect(page.getByTestId('answer-option').first()).toBeEnabled()
})

test('@desktop INV-2 holding Enter on a waiting card opens it and answers nothing', async ({ page }) => {
  const sent = sendsOf(page)
  await openFleet(page)
  await card(page, AGENT.permission).focus()
  await holdEnter(page, LONG_HOLD_MS)

  expect(sent).toEqual([])
  await expect(page).toHaveURL(new RegExp(`/agent/${AGENT.permission}$`))
  await expect(page.getByTestId('answer-option').first()).toBeFocused()
})

test('@desktop INV-2 holding Enter on “More” opens the menu and sends no reply', async ({ page }) => {
  const sent = sendsOf(page)
  await page.goto(`/agent/${AGENT.idle}`)
  const toggle = page.getByTestId('strip-toggle')
  await expect(toggle).toBeEnabled()
  await toggle.focus()
  await holdEnter(page, LONG_HOLD_MS)

  expect(sent).toEqual([])
  await expect(page.getByTestId('composer-strip')).toBeVisible()
  await expect(page.getByTestId('quick-prompt').first()).toBeFocused()
})
