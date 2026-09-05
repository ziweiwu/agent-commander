/**
 * INV-2, across the whole join: "nothing reaches a live agent except from an
 * explicit user action... it is sent exactly once."
 *
 * The unit tests prove each half — `test/ui/burst-send.test.tsx` that three
 * Enters in one React batch send once, `test/chat.test.ts` that the echo is
 * reconciled by count. What neither can see is the round trip: the browser
 * draws an optimistic copy, the message crosses the socket, the server writes
 * it, a transcript tail brings it back, and the local copy is dropped in favour
 * of the confirmed one. Every duplicate this app has ever sent lived in that
 * gap, and the visible symptom is the same either way — one bubble or two.
 */
import { expect, test } from '@playwright/test'
import { AGENT, openAgent, said, settled, stamp } from './helpers.ts'

test.describe('sending a message', () => {
  test('appears once, and settles as delivered', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    const text = stamp('does this arrive')

    await page.getByTestId('composer-input').fill(text)
    await page.getByTestId('composer-send').click()

    // Drawn immediately, so sending feels instant...
    await expect(said(page, text)).toHaveCount(1)
    // ...and still exactly one once the transcript confirms it. Two here is the
    // optimistic copy failing to reconcile against its own confirmation, which
    // is what matching on text alone used to do.
    await expect(said(page, text)).toHaveCount(1, { timeout: 15_000 })
    await expect(page.getByTestId('message-failed')).toHaveCount(0)
    await expect(page.getByTestId('composer-input')).toHaveValue('')
  })

  test('a burst of Enters sends one message, not three', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    const text = stamp('burst')
    const input = page.getByTestId('composer-input')

    await input.fill(text)
    // No delay between them: `draft` is read from a closure and `setDraft('')`
    // does not land until React flushes, so all three used to read the same
    // uncleared draft and all three were sent to a live agent.
    await input.press('Enter')
    await input.press('Enter')
    await input.press('Enter')

    await expect(said(page, text)).toHaveCount(1)
    await page.waitForTimeout(3_000)
    await expect(said(page, text)).toHaveCount(1)
  })

  test('a quick reply picked twice inside a second sends one message', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    // The replies are behind one menu, which closes on a pick — so the reflex
    // this guards against is reopen-and-pick, not a second tap in place.
    const menu = page.getByTestId('quick-menu')
    await menu.click()
    const chip = page.getByTestId('quick-prompt').first()
    // The chip's visible text carries a ➤ that the message does not; the
    // prompt itself is the rest of it.
    const label = ((await chip.textContent()) ?? '').replace('\u27a4', '').trim()

    /*
     * Counted as a delta, not a total, and for the same reason the app's own
     * `reconcile()` counts: the text is fixed — "Continue" is a quick prompt,
     * not a stamped string — and the mock's echo log lives as long as the
     * server, which every project in this run shares. A total would be
     * measuring what earlier tests sent.
     */
    await settled(page)
    const before = await said(page, label).count()

    // ~100ms apart, which no same-batch check catches — the guard for this one
    // is a one-second window on the chip itself.
    await chip.click()
    await page.waitForTimeout(100)
    await menu.click()
    await page.getByTestId('quick-prompt').first().click()

    await page.waitForTimeout(3_000)
    expect((await said(page, label).count()) - before).toBe(1)
  })

  test('a message typed for one agent is not delivered to another', async ({ page }) => {
    // Switching agents flushes what was half-typed to the agent it was typed
    // for, and the conversation is reset rather than carried across.
    await openAgent(page, AGENT.idle)
    const text = stamp('meant for kb')
    await page.getByTestId('composer-input').fill(text)

    await page.goto(`/agent/${AGENT.idleAlt}`)
    await expect(page.getByTestId('message').first()).toBeVisible()
    await expect(page.getByTestId('composer-input')).toHaveValue('')

    await page.waitForTimeout(2_000)
    await expect(said(page, text)).toHaveCount(0)
  })

  test('the conversation scrolls and can be jumped back to the end @desktop', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    const scroll = page.getByTestId('chat-scroll')
    await expect(scroll).toBeVisible()

    // The pane has to be a scroller in its own right rather than growing the
    // page: on a phone that is the difference between a readable conversation
    // and one the composer has pushed off the bottom.
    // Past the pin slack, not merely past the box: within ~60px of the end the
    // app still counts the reader as at the end, so a conversation that
    // overflows by ten pixels has nothing to jump back to.
    const PIN_SLACK = 60
    const overflowing = await scroll.evaluate(
      (el, slack) => el.scrollHeight - el.clientHeight > slack,
      PIN_SLACK,
    )
    if (overflowing) {
      // The scroller is `scroll-behavior: smooth`, so the pin to the end on
      // mount is an animation that is still at the top when the first message
      // becomes visible. A `scrollTo(0)` issued then is a no-op — no scroll
      // event, so nothing unpins — and the animation carries on to the end.
      // Let it land first, then leave instantly so one scroll event carries
      // the whole distance.
      await expect
        .poll(() => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
        .toBeLessThan(2)
      await scroll.evaluate((el) => el.scrollTo({ top: 0, behavior: 'instant' }))
      await expect(page.getByTestId('jump-to-latest')).toBeVisible()
      await page.getByTestId('jump-to-latest').click()
      await expect(page.getByTestId('jump-to-latest')).toBeHidden()
    }
  })
})

/*
 * INV-18 against the real bundle. The fixture conversation carries one bare
 * URL followed by a full stop and one markdown link, so this is the shape a
 * user sees rather than a string a unit test chose.
 */
test.describe('links in the conversation', () => {
  test('a URL is a link that opens elsewhere, and its full stop is not', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    const bare = page.getByTestId('message-link').filter({ hasText: 'web.dev' })
    await expect(bare).toHaveAttribute('href', 'https://web.dev/articles/prefers-color-scheme')
    await expect(bare).toHaveAttribute('target', '_blank')
    await expect(bare).toHaveAttribute('rel', /noopener/)
    await expect(bare).toHaveAttribute('rel', /noreferrer/)
    await expect(bare).not.toHaveText(/\.$/)

    const labelled = page.getByTestId('message-link').filter({ hasText: 'MDN reference' })
    await expect(labelled).toHaveAttribute(
      'href',
      'https://developer.mozilla.org/docs/Web/CSS/color-scheme',
    )
  })
})
