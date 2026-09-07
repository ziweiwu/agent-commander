/**
 * INV-17 / INV-2: text reaches a pane from a shape with no keyboard.
 *
 * The Attach tab's capture is drawn by xterm, which reads typing and pastes
 * through a hidden 1px textarea behind it — both of which need a hardware
 * keyboard. On a phone there is no Cmd+V and nothing on that surface to
 * long-press for the OS's own Paste menu.
 *
 * Reading the clipboard for the user was tried first and does not work where
 * it is needed: on WebKit, the engine behind every browser on iOS,
 * `navigator.clipboard.readText()` is refused with `NotAllowedError` even from
 * inside a tap. So the surface carries a real input, the paste belongs to the
 * operating system, and this spec runs on every project — WebKit included,
 * which is the one that refuted the first attempt.
 */
import { expect, test } from '@playwright/test'
import { AGENT, openAgent } from './helpers.ts'

/** The `paste` frames this page put on the wire. */
function watchPastes(page: import('@playwright/test').Page): string[] {
  const sent: string[] = []
  page.on('websocket', (ws) =>
    ws.on('framesent', (frame) => {
      const payload = typeof frame.payload === 'string' ? frame.payload : ''
      if (payload.includes('"type":"paste"')) sent.push(payload)
    }),
  )
  return sent
}

test.describe('the terminal takes text without a keyboard', () => {
  test('a pasted line reaches the pane, and is not run', async ({ page }) => {
    const sent = watchPastes(page)
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    await expect(page.getByTestId('term-wrap')).toBeVisible()

    // `fill` sets the value and fires `input`, which is what the OS's own
    // paste into a text field does; the paste itself is the browser's job.
    await page.getByTestId('term-compose-input').fill('echo from-a-phone')
    await page.getByTestId('term-compose-send').click()

    await expect.poll(() => sent.length).toBe(1)
    expect(sent[0]).toContain('echo from-a-phone')
    // Text, not a submission: Enter is the key beside it (INV-2).
    expect(sent[0]).toContain('"submit":false')
    // The server accepted it; a refusal would come back as a toast.
    await expect(page.getByTestId('toast')).toHaveCount(0)
  })

  test('the line is a real field, so the OS can paste into it', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    const box = page.getByTestId('term-compose-input')
    await expect(box).toBeVisible()
    await expect(box).toBeEditable()
    // Named for a screen reader, and large enough that iOS does not zoom the
    // page when it takes focus (INV-17).
    await expect(box).toHaveAccessibleName(/prompt/i)
    const size = await box.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
    if (coarse) expect(size).toBeGreaterThanOrEqual(16)
  })

  /*
   * The payload this exists for. An `<input>` strips CR and LF through the
   * value sanitisation algorithm, so a pasted snippet reached the agent as one
   * run-together command — text altered on its way to a live session, which is
   * the worst way this could fail. The field is a textarea for that reason.
   */
  test('a multi-line paste keeps its lines', async ({ page }) => {
    const sent = watchPastes(page)
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    await expect(page.getByTestId('term-wrap')).toBeVisible()

    const snippet = 'cd /tmp\nnpm ci\nnpm test'
    await page.getByTestId('term-compose-input').fill(snippet)
    await page.getByTestId('term-compose-send').click()

    await expect.poll(() => sent.length).toBe(1)
    const [frame = ''] = sent
    expect(JSON.parse(frame).text).toBe(snippet)
  })

  test('a double press sends it once', async ({ page }) => {
    const sent = watchPastes(page)
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    await expect(page.getByTestId('term-wrap')).toBeVisible()

    await page.getByTestId('term-compose-input').fill('deploy')
    await page.getByTestId('term-compose-send').dblclick()

    await page.waitForTimeout(1_000)
    expect(sent).toHaveLength(1)
  })
})
