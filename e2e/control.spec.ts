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
import { expect, test, type Page } from '@playwright/test'
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
  test('INV-8 advances the permission mode through the server', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    // Two of these are on screen — the composer strip and the detail panel's
    // control row — and they show the same setting. Scoped to the composer.
    const button = page.getByTestId('chat-controls').getByTestId('mode-cycle')
    await expect(button).toBeEnabled()
    const before = (await button.textContent()) ?? ''

    await button.click()

    /*
     * The mock's control deps advance a real `MODE_CYCLE` on each key and
     * report the mode they land on, which is what `cycleMode` reads back. One
     * press is one step, so the label has to change — and it changes to
     * whatever the session says, not to something the browser worked out.
     */
    await expect(button).not.toHaveText(before)
    await expect(button).toHaveAttribute('data-unreported', 'false')
  })

  test('INV-8 refuses to type at a busy agent, and says why', async ({ page }) => {
    await openAgent(page, AGENT.busy)

    // Typing into the prompt of an agent that is mid-tool-call would interleave
    // with work in flight, so the controls that type are drawn as unavailable
    // rather than being offered and then refused.
    await expect(page.getByTestId('goal-toggle')).toBeDisabled()
  })

  /*
   * INV-8's one exception, end to end. Mode is switched by sending `BTab` — a
   * control key the agent handles wherever it is — rather than by typing into
   * its prompt, so it stays available mid-run. That is the only time it is
   * wanted: the decision that the next step needs plan mode is made while the
   * agent is working.
   */
  test('INV-8 still changes the mode of a busy agent', async ({ page }) => {
    await openAgent(page, AGENT.busy)

    // Two of these are on screen — the composer strip and the detail panel's
    // control row — and they show the same setting. Scoped to the composer.
    const button = page.getByTestId('chat-controls').getByTestId('mode-cycle')
    await expect(button).toBeEnabled()
    const before = (await button.textContent()) ?? ''

    await button.click()

    // Exactly as for an idle agent above: the press goes out and the label
    // follows what the session reports. A refusal would surface as a toast.
    await expect(button).not.toHaveText(before)
    await expect(page.getByTestId('toast')).toHaveCount(0)
  })

  /**
   * Reveal the detail panel's control row.
   *
   * On a phone and a tablet it collapses behind the `⋯` disclosure, because the
   * row cost 111px of a 568px screen. Clear and Compact live in that row, so a
   * spec that only ever ran on a desktop would say nothing about the two
   * viewports this app is most used from.
   */
  const controls = async (page: Page) => {
    const toggle = page.getByTestId('controls-toggle')
    if (await toggle.isVisible()) await toggle.click()
    return page.getByTestId('agent-controls')
  }

  /*
   * The sharp edge in `/clear`, and the reason it has an end-to-end test at all.
   *
   * `/clear` does not edit a conversation, it replaces one: Claude Code opens a
   * fresh transcript under a new session id. So the id in the address bar stops
   * existing the moment it lands, and without following it `focusAgent` points
   * at nothing, the route bails to the fleet, and the agent reappears further
   * down the page as a stranger. From the user's side, the panel closed itself.
   *
   * `@once` because it is destructive in exactly that way: the fixture it
   * clears stops existing under the name it had, and all five projects share
   * one mock server. Nothing about this is viewport-dependent, so running it in
   * one project loses no coverage.
   */
  test('INV-8 follows the agent to the session it is now running @once', async ({ page }) => {
    await openAgent(page, AGENT.clearable)

    await (await controls(page)).getByTestId('clear-agent').click()
    await page.getByTestId('confirm-accept').click()

    // A different id, and still on an agent rather than back at the fleet.
    await expect(page).not.toHaveURL(new RegExp(AGENT.clearable))
    await expect(page).toHaveURL(/\/agent\//)
    await expect(page.getByTestId('agent-detail')).toBeVisible()
  })

  // There is no undo, so it asks — and a refused dialog must send nothing.
  test('INV-8 sends no /clear when the confirmation is refused', async ({ page }) => {
    await openAgent(page, AGENT.idle)

    await (await controls(page)).getByTestId('clear-agent').click()
    await page.getByTestId('confirm-cancel').click()

    // The dialog is gone and nothing happened: same agent, same session.
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(AGENT.idle))
  })

  /*
   * Compaction runs for minutes, so nothing waits for it. The only honest thing
   * to say when the button returns is that it was asked for (INV-11).
   */
  test('INV-8 reports a compaction as requested rather than done', async ({ page }) => {
    await openAgent(page, AGENT.idle)

    await (await controls(page)).getByTestId('compact-agent').click()

    await expect(page.getByTestId('toast')).toContainText(/requested/i)
  })

  // Both type into the prompt, so both wait for idle exactly as Close does.
  test('INV-8 offers neither clear nor compact to a busy agent', async ({ page }) => {
    await openAgent(page, AGENT.busy)
    const row = await controls(page)

    await expect(row.getByTestId('clear-agent')).toBeDisabled()
    await expect(row.getByTestId('compact-agent')).toBeDisabled()
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
