/**
 * The control surface: starting an agent, and acting on one that is running.
 *
 * These are worth an end-to-end test more than anything else in the app,
 * because mock mode does not stub them out. `--mock` runs the *same*
 * `checkSpawnRequest` the real path runs (INV-7), and its control deps are a
 * closed loop rather than a no-op: pressing the mode key cycles a real
 * `MODE_CYCLE`, and setting a goal is verified by reading it back the way it is
 * verified against a live session (INV-8). So the failure a user sees here is
 * the failure they would get for real.
 */
import { expect, test } from '@playwright/test'
import { AGENT, openAgent, openFleet, stamp } from './helpers.ts'

test.describe('starting an agent', () => {
  test('INV-7 refuses a directory that is not there, and says so', async ({ page }) => {
    await openFleet(page)
    await page.getByTestId('new-agent-button').click()
    await expect(page.getByTestId('new-agent-dialog')).toBeVisible()

    await page.getByTestId('new-agent-dir').fill('/definitely/not/a/real/directory')
    await page.getByTestId('new-agent-submit').click()

    // The server's own reason, not a guess made in the browser — and the dialog
    // stays open so the path can be corrected rather than retyped.
    await expect(page.getByTestId('new-agent-error')).toBeVisible()
    await expect(page.getByTestId('new-agent-dialog')).toBeVisible()
  })

  test('INV-7 refuses a relative path before it can become a tmux argument', async ({ page }) => {
    await openFleet(page)
    await page.getByTestId('new-agent-button').click()
    await page.getByTestId('new-agent-dir').fill('some/relative/path')
    await page.getByTestId('new-agent-submit').click()

    await expect(page.getByTestId('new-agent-error')).toBeVisible()
  })

  test('offers exactly the models and modes the server will accept', async ({ page }) => {
    await openFleet(page)
    await page.getByTestId('new-agent-button').click()

    // One list, in `shared/types.ts`. A model the UI offers and the server
    // rejects is a click that becomes a toast; one the server takes and the UI
    // never shows is invisible. Asserted against the real values rather than a
    // count, so a silent truncation fails too.
    // The values, not the labels: the labels are translated, and it is the
    // value that travels to the server and is checked against the allow-list.
    const models = await page
      .getByTestId('new-agent-model')
      .locator('option')
      .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))
    expect(models).toEqual(['default', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan'])

    const modes = await page
      .getByTestId('new-agent-mode')
      .locator('option')
      .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))
    // `dontAsk` is reachable by flag and never cycles, so it belongs here and
    // not in the running-session switch.
    expect(modes).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
      'auto',
      'dontAsk',
    ])
  })

  test('closes on Escape without starting anything', async ({ page }) => {
    await openFleet(page)
    await page.getByTestId('new-agent-button').click()
    await expect(page.getByTestId('new-agent-dialog')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('new-agent-dialog')).toHaveCount(0)
  })
})

test.describe('acting on a running agent', () => {
  test('INV-8 changes the permission mode through the server', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    const select = page.getByTestId('chat-mode-select')
    await expect(select).toBeEnabled()

    await select.selectOption('plan')

    /*
     * The mock's control deps cycle a real `MODE_CYCLE` on each key and report
     * the mode they land on, which is what `setMode` verifies against — it
     * presses Shift+Tab and re-reads until the session agrees, because the
     * cycle silently omits modes that are unavailable. Success is the absence
     * of the failure toast; a mode that could not be reached is a 409 and says
     * where it actually ended up.
     */
    await page.waitForTimeout(3_000)
    await expect(page.getByTestId('toast')).toHaveCount(0)
    await expect(select).toBeEnabled()
  })

  test('INV-8 refuses to act on a busy agent, and says why', async ({ page }) => {
    await openAgent(page, AGENT.busy)

    // Typing into the prompt of an agent that is mid-tool-call would interleave
    // with work in flight, so the controls are drawn as unavailable rather than
    // being offered and then refused.
    await expect(page.getByTestId('chat-mode-select')).toBeDisabled()
    await expect(page.getByTestId('goal-toggle')).toBeDisabled()
  })

  test('INV-8 sets a goal and clears it again', async ({ page }) => {
    await openAgent(page, AGENT.idleAlt)
    const toggle = page.getByTestId('goal-toggle')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

    const condition = stamp('all the tests pass')
    await toggle.click()
    await page.getByTestId('goal-input').fill(condition)
    await page.getByTestId('goal-apply').click()

    // Verified by reading the goal back, not assumed: a goal makes the session
    // keep working until an evaluator agrees it is done, and "did that take
    // effect?" is not a question the user can answer from the chat.
    await expect(toggle).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
    await expect(toggle).toContainText(condition)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 })
  })

  test('INV-8 refuses a goal condition that would submit early', async ({ page }) => {
    await openAgent(page, AGENT.idleAlt)
    await page.getByTestId('goal-toggle').click()

    // A leading slash would run some other slash command in a live prompt
    // instead of setting a goal. The server is what refuses it; the browser is
    // where the refusal has to be visible.
    await page.getByTestId('goal-input').fill('/exit')
    await page.getByTestId('goal-apply').click()

    await expect(page.getByTestId('toast')).toBeVisible({ timeout: 15_000 })
    // The field stays open with the text in it, so the condition can be fixed
    // rather than retyped — a refusal is not a reason to throw the input away.
    await expect(page.getByTestId('goal-form')).toBeVisible()
    await expect(page.getByTestId('goal-input')).toHaveValue('/exit')
  })
})
