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
import { RING_PAINTED, ringSides, untilStill } from '../scripts/lib/focus-ring.mjs'
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
 * The fleet's own edges, where the clip is a scroller's overflow rather than a
 * mask. The desk's column scrolls, so a card, its Details button or a toolbar
 * control flush against the column loses the ring's outside half to the
 * column's clip; the phone's filter strip scrolls sideways, and a horizontal
 * scroller clips vertically too, so each chip loses its top and bottom. And a
 * card's right edge meets its own Details button, which is drawn after it.
 * WebKit's Tab passes buttons by, as Safari's does by default, so there the
 * strip's sweep judges the kind select and the Chromium phone judges the chips.
 */
import { unpaintedEdges } from '../scripts/lib/focus-ring.mjs'
import { openFleet } from './helpers.ts'

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
 * An edge a scroller holds out of view is not judged, as the audit judges it:
 * Chromium does not scroll the phone strip to a focused kind select, so its
 * right edge sits past the strip's clip, where no ring could show.
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
   * the bottom of the ring on the row above it. The row is focused by script
   * after a click opened the dialog, so a key is pressed to say the keyboard
   * is in use, which is what shows the ring.
   */
  test('a folder row keeps its ring with the row under it hovered', async ({ page }) => {
    await openFleet(page)
    await page.getByTestId('new-agent-button').click()
    await page.getByTestId('new-agent-dir').fill('~')
    const browse = page.getByTestId('new-agent-browse')
    if ((await browse.getAttribute('aria-expanded')) !== 'true') await browse.click()
    const rows = page.getByTestId('browse-entry')
    await expect(rows.nth(2)).toBeVisible()
    await rows.nth(2).hover()
    await rows.nth(1).focus()
    await page.keyboard.press('Shift')
    expect(await rows.nth(1).evaluate((el) => el.matches(':focus-visible'))).toBe(true)
    await expectRingPainted(page, rows.nth(1))
  })
})
