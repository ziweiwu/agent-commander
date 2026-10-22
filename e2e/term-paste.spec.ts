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
    // Stage is text, not a submission (INV-2).
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

/** Every `paste` frame, parsed. */
function watchFrames(page: import('@playwright/test').Page): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = []
  page.on('websocket', (ws) =>
    ws.on('framesent', (frame) => {
      const payload = typeof frame.payload === 'string' ? frame.payload : ''
      if (payload.includes('"type":"paste"') || payload.includes('"type":"key"'))
        sent.push(JSON.parse(payload))
    }),
  )
  return sent
}

test.describe('Enter in the box runs the text', () => {
  test('Enter puts it at the prompt and runs it, once', async ({ page }) => {
    const sent = watchFrames(page)
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    await expect(page.getByTestId('term-wrap')).toBeVisible()

    const box = page.getByTestId('term-compose-input')
    await box.fill('echo run-me')
    // Three presses in a row: a key repeat, or a double tap on a return key.
    await box.press('Enter')
    await box.press('Enter')
    await box.press('Enter')

    await expect.poll(() => sent.length).toBe(1)
    await page.waitForTimeout(500)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'paste', text: 'echo run-me', submit: true })
    await expect(box).toHaveValue('')
    await expect(page.getByTestId('toast')).toHaveCount(0)
  })

  test('Shift+Enter types a newline and sends nothing', async ({ page }) => {
    const sent = watchFrames(page)
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    await expect(page.getByTestId('term-wrap')).toBeVisible()

    const box = page.getByTestId('term-compose-input')
    await box.fill('one')
    await box.press('Shift+Enter')
    await box.pressSequentially('two')

    await expect(box).toHaveValue('one\ntwo')
    await page.waitForTimeout(500)
    expect(sent).toHaveLength(0)
  })

  test('the Run button runs it once, and Stage stays text-only', async ({ page }) => {
    const sent = watchFrames(page)
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    await expect(page.getByTestId('term-wrap')).toBeVisible()

    const box = page.getByTestId('term-compose-input')
    await box.fill('make it so')
    await page.getByTestId('term-compose-run').dblclick()
    await expect.poll(() => sent.length).toBe(1)
    expect(sent[0]).toMatchObject({ text: 'make it so', submit: true })

    await box.fill('read me first')
    await page.getByTestId('term-compose-send').click()
    await expect.poll(() => sent.length).toBe(2)
    expect(sent[1]).toMatchObject({ text: 'read me first', submit: false })
  })
})

/*
 * Typing in the pane itself on a touch screen. @phone: the phone projects have
 * `hasTouch` and `isMobile` (Chromium and WebKit); a pointer-fine desktop
 * focuses on mount, which is the other half of the contract. Playwright's
 * emulation delivers a real tap and a real focus, but it cannot raise iOS's
 * keyboard, so that last step remains a manual check on a device.
 */
test.describe('tapping the pane on a touch screen', () => {
  const helperFocused = (page: import('@playwright/test').Page) =>
    page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false)

  test('does not take focus on mount, @phone', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    await expect(page.getByTestId('term-wrap')).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toHaveCount(1)
    await page.waitForTimeout(500)
    expect(await helperFocused(page)).toBe(false)
  })

  test('a tap focuses the terminal input and typed keys reach the pane, @phone', async ({
    page,
  }) => {
    const sent = watchFrames(page)
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    const wrap = page.getByTestId('term-wrap')
    await expect(wrap).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toHaveCount(1)

    await wrap.tap()
    await expect.poll(() => helperFocused(page)).toBe(true)
    // The tap itself sends nothing (INV-2).
    expect(sent).toHaveLength(0)

    // 16px, or iOS zooms the page when this takes focus.
    const size = await page
      .locator('.xterm-helper-textarea')
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
    expect(size).toBeGreaterThanOrEqual(16)

    await page.keyboard.type('ls')
    await expect
      .poll(() => sent.filter((f) => f.type === 'paste').map((f) => f.text).join(''))
      .toBe('ls')
    expect(sent.every((f) => f.submit !== true)).toBe(true)

    // The same key mapping as desktop: Enter is a key, not text.
    await page.keyboard.press('Enter')
    await expect.poll(() => sent.some((f) => f.type === 'key' && f.key === 'Enter')).toBe(true)
  })
})
