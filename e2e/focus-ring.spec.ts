/**
 * 2.4.7 judged by the pixels, not by the computed style.
 *
 * The conversation became a Tab stop and its computed outline was a 2px ring,
 * yet nothing blue reached the screen: while a question is open the box
 * carries the scroll-edge fade, a `mask-image`, and a mask clips everything
 * the element paints to its border box, the outline outside it included. A
 * tool result Tab scrolls flush against the conversation's edge loses the
 * outside half of its ring to the conversation's clip the same way. Both read
 * as focused to every check that asks the style.
 *
 * So these Tab to the box, take a screenshot, and look for the `--focus`
 * colour along each of its four edges (`scripts/lib/focus-ring.mjs`, which the
 * a11y audit reads too).
 */
import { expect, type Locator, type Page, test } from '@playwright/test'
import { FULL_STRENGTH, RING_PAINTED, ringSides, unpaintedEdges, untilStill } from '../scripts/lib/focus-ring.mjs'
import { AGENT, openAgent } from './helpers.ts'

async function expectRingPainted(page: Page, target: Locator): Promise<void> {
  const sides = await ringSides(page, target)
  for (const [side, share] of Object.entries(sides)) {
    expect(share ?? 0, `${side} edge of the focus ring`).toBeGreaterThanOrEqual(RING_PAINTED)
  }
}

/** Tab forward from `from` until `testId` holds the focus, the way a keyboard reader gets there. */
async function tabTo(page: Page, from: Locator, testId: string): Promise<void> {
  await from.focus()
  await expect
    .poll(
      async () => {
        await page.keyboard.press('Tab')
        return page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
      },
      { intervals: [0], timeout: 15_000 },
    )
    .toBe(testId)
}

test.describe('a focused scroll box shows its ring', () => {
  test('the conversation, with a question open, at its end and scrolled back', async ({ page }) => {
    await page.goto(`/agent/${AGENT.permission}`)
    await expect(page.getByTestId('answer-card')).toBeVisible()
    const scroll = page.getByTestId('chat-scroll')
    await tabTo(page, page.getByTestId('tab-chat'), 'chat-scroll')
    await expectRingPainted(page, scroll)

    await scroll.evaluate((el) => el.scrollTo({ top: 0 }))
    await expect(scroll).toHaveAttribute('data-overflow', /bottom/)
    await expect(scroll).toBeFocused()
    await expectRingPainted(page, scroll)
  })

  test('the conversation keeps its ring off after a mouse click', async ({ page }) => {
    await page.goto(`/agent/${AGENT.permission}`)
    await expect(page.getByTestId('answer-card')).toBeVisible()
    const scroll = page.getByTestId('chat-scroll')
    await scroll.click({ position: { x: 4, y: 4 } })
    await expect(scroll).toBeFocused()
    const sides = await ringSides(page, scroll)
    for (const [side, share] of Object.entries(sides)) {
      expect(share ?? 0, `${side} edge of the focus ring`).toBeLessThan(RING_PAINTED)
    }
  })

  test('a tool result Tab scrolls in against the conversation edge', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    const edit = page.getByTitle('Edit: src/components/Header.astro')
    await edit.getByTestId('tool-expand').click()
    const body = page.getByTestId('tool-result-body')
    await expect(body).toBeVisible()
    await untilStill(page, '[data-testid="chat-scroll"]')
    await page.getByTestId('chat-scroll').evaluate((el) => el.scrollTo({ top: 0 }))
    await tabTo(page, edit.getByTestId('tool-expand'), 'tool-result-body')
    await expectRingPainted(page, body)
  })
})

/**
 * The key that walks every control. WebKit's Tab, as Safari's does by
 * default, stops only on fields and boxes and skips every button; Option+Tab
 * is the one a keyboard reader there walks the buttons with.
 */
const walkKey = (browserName: string): string => (browserName === 'webkit' ? 'Alt+Tab' : 'Tab')

/**
 * Where focus is, by test id, whether it sits inside the conversation's scroll
 * box, and whether it is an inline that wrapped. A link broken over two lines
 * is ringed line by line, so the edges of its bounding box are not where its
 * ring is, and the screenshot cannot judge it by them.
 */
async function focusStop(page: Page): Promise<{ testId: string; inConversation: boolean; wrapped: boolean }> {
  return page.evaluate(() => {
    const active = document.activeElement
    const scroll = document.querySelector('[data-testid="chat-scroll"]')
    return {
      testId: active?.getAttribute('data-testid') ?? active?.tagName ?? '',
      inConversation: Boolean(scroll && active && active !== scroll && scroll.contains(active)),
      wrapped: (active?.getClientRects().length ?? 0) > 1,
    }
  })
}

/** The conversation's stops, walked by keyboard from the Chat tab, each judged by the screenshot. */
async function unpaintedStopsInConversation(page: Page, key: string): Promise<{ judged: number; unpainted: string[] }> {
  const unpainted: string[] = []
  let judged = 0
  await page.getByTestId('tab-chat').focus()
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press(key)
    const stop = await focusStop(page)
    if (stop.testId === 'composer-input') break
    if (!stop.inConversation || stop.wrapped) continue
    judged += 1
    const edges = await unpaintedEdges(page, page.locator(':focus'))
    if (edges.length) unpainted.push(`${stop.testId}: ${edges.join(', ')}`)
  }
  return { judged, unpainted }
}

const ANSWER_KEYS = ['Up', 'Down', 'Space', 'Enter', 'Escape']

/**
 * Open the agent blocked on a permission and wait until its conversation has
 * stopped growing. The pane peek in its answer card lands a beat after the
 * card, and the height it adds moved a focused key into the fade after the
 * focus had been placed, with no Tab to scroll it clear.
 */
async function openQuestion(page: Page): Promise<void> {
  await page.goto(`/agent/${AGENT.permission}`)
  await expect(page.getByTestId('answer-card')).toBeVisible()
  await expect(page.getByTestId('pane-peek')).toBeVisible()
  await untilStill(page, '[data-testid="chat-scroll"]')
}

/**
 * The scroll-edge fade is a `mask-image`, so anything a keyboard reader stops
 * on inside its bottom 28px fades with it, ring included. Tab scrolls the next
 * control into view flush with the box's bottom edge, which is exactly there.
 * And the answer keys sit in a row muted by `opacity`, which an outline
 * cannot escape: the ring was painted, but blended a quarter of the way into
 * the card behind it.
 */
for (const [shape, use] of [
  ['', {}],
  ['@desktop at 1280x800', { viewport: { width: 1280, height: 800 } }],
  ['@phone held sideways', { viewport: { width: 844, height: 390 } }],
] as const) {
  test.describe(`a focus stop in a fading or muted box shows its ring ${shape}`.trim(), () => {
    test.use(use)

    test('every stop in a fading conversation clears the fade', async ({ page, browserName }) => {
      test.setTimeout(120_000)
      await openQuestion(page)
      const scroll = page.getByTestId('chat-scroll')
      await scroll.evaluate((el) => el.scrollTo({ top: 0 }))
      await expect(scroll).toHaveAttribute('data-overflow', /bottom/)
      const { judged, unpainted } = await unpaintedStopsInConversation(page, walkKey(browserName))
      expect(judged, 'stops walked inside the conversation').toBeGreaterThan(0)
      expect(unpainted, 'stops whose ring did not reach the screen').toEqual([])
    })

    test('every answer key is ringed at full strength in the muted row', async ({ page, browserName }) => {
      test.setTimeout(60_000)
      await openQuestion(page)
      await expect(page.getByTestId('answer-keys-fallback')).toBeVisible()
      const scroll = page.getByTestId('chat-scroll')
      const dimmed: string[] = []
      await page.getByTestId('answer-option').last().focus()
      for (const name of ANSWER_KEYS) {
        const target = page.getByTestId(`answer-key-${name}`)
        await expect
          .poll(
            async () => {
              await page.keyboard.press(walkKey(browserName))
              return (await focusStop(page)).testId
            },
            { intervals: [0], timeout: 15_000 },
          )
          .toBe(`answer-key-${name}`)
        await expect
          .poll(async () => {
            await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
            return (await scroll.getAttribute('data-overflow'))?.includes('bottom') ?? false
          })
          .toBe(false)
        const sides = await ringSides(page, target, { tolerance: FULL_STRENGTH })
        const weak = Object.entries(sides).filter(([, share]) => share !== null && share < RING_PAINTED)
        const said = weak.map(([side, share]) => `${side} ${share?.toFixed(2)}`)
        if (said.length) dimmed.push(`${name}: ${said.join(', ')}`)
      }
      expect(dimmed, 'answer keys whose ring is dimmed').toEqual([])
    })
  })
}

test.describe('the folder list @phone held sideways', () => {
  test.use({ viewport: { width: 844, height: 390 } })

  /**
   * The other box that fades and holds a column of stops. Held sideways it is
   * 30dvh, about two rows, so every Tab brings the next folder in at its foot.
   * The listing is this machine's home folder, so a home too small to scroll
   * has no fade to judge and the test says so rather than passing on nothing.
   * The pointer is moved off the list first: the tap that opened it leaves a
   * row hovered, and a hovered row's background covers the ring of the row
   * above it, which is a neighbour covering a ring rather than the fade.
   */
  test('every folder Tab reaches clears the fade', async ({ page, browserName }) => {
    test.setTimeout(60_000)
    await page.goto('/')
    await page.getByTestId('new-agent-button').click()
    await page.getByTestId('new-agent-browse').click()
    const entries = page.getByTestId('browse-entry')
    await expect(entries.first()).toBeVisible()
    const list = page.locator('[data-testid="folder-browser"] [data-overflow]')
    test.skip((await list.getAttribute('data-overflow')) !== 'bottom', 'the home folder is too short to scroll')
    await page.mouse.move(0, 0)
    await entries.first().focus()
    const unpainted: string[] = []
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press(walkKey(browserName))
      if ((await focusStop(page)).testId !== 'browse-entry') break
      const edges = await unpaintedEdges(page, page.locator(':focus'))
      if (edges.length) unpainted.push(`folder ${i + 2}: ${edges.join(', ')}`)
    }
    expect(unpainted, 'folders whose ring did not reach the screen').toEqual([])
  })
})
