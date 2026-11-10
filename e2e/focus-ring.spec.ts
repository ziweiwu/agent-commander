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
import { AGENT, openAgent, openFleet } from './helpers.ts'

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
 * The fleet's own edges, where the clip is a scroller's overflow rather than a
 * mask. The desk's column scrolls, so a card, its Details button or a toolbar
 * control flush against the column loses the ring's outside half to the
 * column's clip; the phone's filter strip scrolls sideways, and a horizontal
 * scroller clips vertically too, so each chip loses its top and bottom. And a
 * card's right edge meets its own Details button, which is drawn after it.
 * WebKit's Tab passes buttons by, as Safari's does by default, so there the
 * strip's sweep judges the kind select and the Chromium phone judges the chips.
 */

/** Generous: a fleet sweep reads one screenshot per Tab stop. */
const SWEEP_TIMEOUT_MS = 150_000
/** More Tab stops than the fleet column or the filter strip holds. */
const SWEEP_STOP_LIMIT = 80

/** What a stop is called in a failure: its test id, and the card it belongs to. */
async function stopName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    const id = el?.getAttribute('data-testid') ?? el?.tagName.toLowerCase() ?? '?'
    const session = el?.closest('[data-session-id]')?.getAttribute('data-session-id')
    const key = el?.getAttribute('data-key')
    return [id, session, key].filter(Boolean).join(' ')
  })
}

/**
 * Each on-screen edge of the focused element's ring that is short of painted.
 * An edge a scroller holds out of view is not judged, as the audit judges it.
 */
async function shortEdges(page: Page): Promise<string[]> {
  const active = await page.evaluateHandle(() => document.activeElement as HTMLElement)
  const edges = await unpaintedEdges(page, active)
  await active.dispose()
  return edges
}

/**
 * Tab from the top of the page through every stop inside `scope`, judging
 * each by the screenshot, and name the ones whose ring did not reach the
 * screen on every edge. Stops before the scope are passed over; the first stop after it ends
 * the sweep.
 */
async function sweepRings(page: Page, scope: Locator): Promise<string[]> {
  const inside = await scope.elementHandle()
  if (!inside) throw new Error('the sweep has no scope to walk')
  const failures: string[] = []
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  let entered = false
  for (let i = 0; i < SWEEP_STOP_LIMIT; i += 1) {
    await page.keyboard.press('Tab')
    const within = await inside.evaluate((box) => box.contains(document.activeElement))
    if (!within) {
      if (entered) break
      continue
    }
    entered = true
    const edges = await shortEdges(page)
    if (edges.length) failures.push(`${await stopName(page)}: ${edges.join(', ')}`)
  }
  await inside.dispose()
  expect(entered, 'the sweep reached the scope').toBe(true)
  return failures
}

const fleetColumn = (page: Page) => page.getByTestId('fleet-list').locator('xpath=..')

test.describe('a focus stop at the fleet edge shows its ring', () => {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1280, height: 720 },
  ]) {
    test(`@desktop the fleet column on its own at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      test.setTimeout(SWEEP_TIMEOUT_MS)
      await page.setViewportSize(viewport)
      await openFleet(page)
      const failures = await sweepRings(page, fleetColumn(page))
      expect(failures, 'stops whose ring was clipped').toEqual([])
    })

    test(`@desktop the fleet column beside an open agent at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      test.setTimeout(SWEEP_TIMEOUT_MS)
      await page.setViewportSize(viewport)
      await page.goto(`/agent/${AGENT.idle}`)
      await expect(page.getByTestId('agent-detail')).toBeVisible()
      await expect(page.getByTestId('agent-card').first()).toBeVisible()
      const failures = await sweepRings(page, fleetColumn(page))
      expect(failures, 'stops whose ring was clipped').toEqual([])
    })
  }

  for (const [shape, viewport] of [
    ['portrait', { width: 390, height: 844 }],
    ['landscape', { width: 844, height: 390 }],
  ] as const) {
    test(`@phone the filter strip, every chip and the kind select, in ${shape}`, async ({ page }) => {
      test.setTimeout(SWEEP_TIMEOUT_MS)
      await page.setViewportSize(viewport)
      await openFleet(page)
      await expect(page.getByTestId('kind-select')).toBeVisible()
      const strip = page.getByTestId('kind-select').locator('xpath=..')
      const failures = await sweepRings(page, strip)
      expect(failures, 'stops whose ring was clipped').toEqual([])
    })

    test(`@phone the fleet, where the window is the scroller, in ${shape}`, async ({ page }) => {
      test.setTimeout(SWEEP_TIMEOUT_MS)
      await page.setViewportSize(viewport)
      await openFleet(page)
      const failures = await sweepRings(page, fleetColumn(page))
      expect(failures, 'stops whose ring was clipped').toEqual([])
    })
  }

  /**
   * Moved to from the filter box rather than Tabbed to: WebKit's Tab passes a
   * button by, as Safari's does unless asked not to, and focus moved on from a
   * field still shows its ring.
   */
  test('a card beside its Details button shows its ring on all four sides', async ({ page }) => {
    await openFleet(page)
    const first = page.getByTestId('agent-card').first()
    await page.getByTestId('search').focus()
    await first.focus()
    expect(await first.evaluate((el) => el.matches(':focus-visible'))).toBe(true)
    await expectRingPainted(page, first)
  })

  /**
   * The rows sit 1px apart and a hovered row paints its background, so the
   * row under the pointer, or under the hover a tap leaves on a phone, covered
   * the bottom of the ring on the row above it. The row is reached by a key
   * from the one before it, so the browser knows the keyboard is in use.
   */
  test('a folder row keeps its ring with the row under it hovered', async ({ page, browserName }) => {
    await openFleet(page)
    await page.getByTestId('new-agent-button').click()
    const browse = page.getByTestId('new-agent-browse')
    if ((await browse.getAttribute('aria-expanded')) !== 'true') await browse.click()
    const rows = page.getByTestId('browse-entry')
    await expect(rows.nth(2)).toBeVisible()
    await rows.nth(2).hover()
    await rows.nth(0).focus()
    await page.keyboard.press(walkKey(browserName))
    await expect(rows.nth(1)).toBeFocused()
    expect(await rows.nth(1).evaluate((el) => el.matches(':focus-visible'))).toBe(true)
    await expectRingPainted(page, rows.nth(1))
  })
})

test.describe('a focus stop in a strip Tab must scroll', () => {
  test('@phone Tab brings the kind select into the filter strip with its ring', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openFleet(page)
    const select = page.getByTestId('kind-select')
    const strip = select.locator('xpath=..')
    await tabTo(page, page.getByTestId('search'), 'kind-select')
    await page.waitForTimeout(300)
    const [inner, outer] = await Promise.all([select.boundingBox(), strip.boundingBox()])
    if (!inner || !outer) throw new Error('the select or its strip has no box')
    expect(inner.x, 'left of the select inside the strip').toBeGreaterThanOrEqual(outer.x)
    expect(inner.x + inner.width, 'right of the select inside the strip').toBeLessThanOrEqual(outer.x + outer.width)
    const sides = await ringSides(page, select)
    for (const [side, share] of Object.entries(sides)) {
      expect(share ?? 0, `${side} edge of the focus ring`).toBeGreaterThanOrEqual(RING_PAINTED)
    }
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
   * The e2e server roots the picker at `node_modules`, long enough to scroll
   * on every machine, so the fade is always there to judge.
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
    await expect(list).toHaveAttribute('data-overflow', 'bottom')
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
