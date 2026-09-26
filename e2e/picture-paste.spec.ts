/**
 * A screenshot pasted into the composer goes where an attached one goes.
 *
 * The paste is dispatched rather than typed: Playwright cannot put an image
 * on the system clipboard, but a `paste` event carrying a `DataTransfer` is
 * exactly what the browser hands the page when one is there. What is real is
 * everything after it — the upload to this server, the path it answers with,
 * and the box it lands in, unsent.
 */
import { expect, test } from '@playwright/test'
import { AGENT, openAgent } from './helpers.ts'

/** The smallest valid PNG: one transparent pixel. */
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

test('a pasted screenshot becomes a path in the box and is not sent @desktop', async ({ page }) => {
  await openAgent(page, AGENT.idle)
  const box = page.getByTestId('composer-input')
  const messages = await page.getByTestId('message').count()

  await box.evaluate((el, base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const clipboard = new DataTransfer()
    clipboard.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
  }, ONE_PIXEL_PNG)

  await expect(box).toHaveValue(/\.png $/)
  expect(await page.getByTestId('message').count()).toBe(messages)
})
