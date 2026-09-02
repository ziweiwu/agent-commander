/**
 * The Attach view: a capture of a pane, and the guard in front of the keys that
 * can throw away an agent's work.
 *
 * INV-1 is why this is a capture rather than a pty, and the property it asserts
 * — that watching an agent never resizes it — is verified against a live tmux
 * server by `npm run verify:inv1`, which cannot run here. What *can* be checked
 * here is the consequence the user sees: frames arrive, the terminal is drawn
 * from the pane's own geometry, and the browser's width never travels back.
 */
import { expect, test } from '@playwright/test'
import { AGENT, openAgent } from './helpers.ts'

test.describe('the terminal', () => {
  test('paints frames captured from the pane', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()

    await expect(page.getByTestId('term-wrap')).toBeVisible()
    // xterm renders into its own DOM; the text arriving is the whole pipeline
    // working — capture, diff, frame, replay.
    await expect(page.locator('[data-testid="terminal"] .xterm-rows')).toContainText(/\S/, {
      timeout: 15_000,
    })
  })

  test('does not resize the pane when the window changes @desktop', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    await expect(page.locator('[data-testid="terminal"] .xterm-rows')).toContainText(/\S/, {
      timeout: 15_000,
    })

    const cols = () =>
      page.locator('[data-testid="terminal"] .xterm-rows > div').first().evaluate((el) => el.textContent?.length ?? 0)
    const before = await cols()

    await page.setViewportSize({ width: 700, height: 700 })
    await page.waitForTimeout(600)

    // INV-1: the browser's width is a CSS transform and nothing else. A pane
    // that reflowed to the window would change how many columns it holds.
    expect(await cols()).toBe(before)
  })

  test('re-fits the capture when the window changes shape @desktop', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    await expect(page.locator('[data-testid="terminal"] .xterm-rows')).toContainText(/\S/, {
      timeout: 15_000,
    })
    const rendered = async () => {
      const wrap = await page.getByTestId('term-wrap').boundingBox()
      return wrap?.width ?? 0
    }
    const wide = await rendered()
    expect(wide).toBeGreaterThan(0)

    // Narrower than the capture needs at its current size. Nothing redraws the
    // pane — the fixture is idle — so only the container observer can re-fit it.
    await page.setViewportSize({ width: 600, height: 700 })
    await expect.poll(rendered, { timeout: 5_000 }).toBeLessThan(wide)
    expect(await rendered()).toBeLessThanOrEqual(600)
  })

  test('INV-6 asks before sending a key that discards work', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    await expect(page.getByTestId('term-wrap')).toBeVisible()

    const asked: string[] = []
    page.on('dialog', (dialog) => {
      asked.push(dialog.message())
      // Answering "no" is the half that matters: the key must not be sent, and
      // the server refuses it anyway without the confirmation flag.
      void dialog.dismiss()
    })

    await page.getByTestId('term-wrap').click()
    await page.keyboard.press('Control+c')

    await expect.poll(() => asked.length).toBe(1)
    expect(asked[0]).toMatch(/C-c|interrupt|discard/i)
    // Refusing the dialog is not an error, so nothing should be reported.
    await expect(page.getByTestId('toast')).toHaveCount(0)
  })

  test('INV-6 sends it once the user has said yes', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    await expect(page.getByTestId('term-wrap')).toBeVisible()

    page.on('dialog', (dialog) => void dialog.accept())
    await page.getByTestId('term-wrap').click()
    await page.keyboard.press('Control+c')

    // The server refuses a destructive key that does not carry the
    // confirmation, and reports the refusal as an error. Accepting means the
    // flag travels, so no error comes back.
    await page.waitForTimeout(1_500)
    await expect(page.getByTestId('toast')).toHaveCount(0)
  })

  test('Escape belongs to the agent inside the terminal', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    await expect(page.getByTestId('term-wrap')).toBeVisible()

    let asked = 0
    page.on('dialog', (dialog) => {
      asked += 1
      void dialog.dismiss()
    })

    await page.getByTestId('term-wrap').click()
    await page.keyboard.press('Escape')

    // Escape interrupts the agent, so it is confirmed like the others — and
    // answering the dialog must not also collapse the view out from under it,
    // which is what closing on Escape used to do.
    await expect.poll(() => asked).toBe(1)
    await expect(page.getByTestId('term-wrap')).toBeVisible()
  })

  test('Shift+Escape is the way out @desktop', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    await expect(page.getByTestId('term-wrap')).toBeVisible()

    await page.getByTestId('term-wrap').click()
    await page.keyboard.press('Shift+Escape')

    await expect(page).toHaveURL(/\/$/)
  })
})
