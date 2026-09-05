/**
 * INV-17, in a real browser at every shape this app claims to support.
 *
 * The unit half of this invariant works with a stubbed `matchMedia` and jsdom's
 * zero-height layout, so it can prove a control is *in the tree* and nothing
 * about whether it is on the screen. This spec is the other half, and it earns
 * its place by running unchanged in all five projects — desktop, tablet and
 * phone on Chromium, phone and tablet again on WebKit — so the assertions below
 * are made five times at five real viewports on two engines.
 *
 * Three things are checked, in the order they would bite a user:
 *
 *  1. Nothing needs sideways scrolling. A document wider than the window is the
 *     single most common way a layout breaks on a phone, and this app has had
 *     it twice: a 300-character search term echoed into the empty state forced
 *     the document to 2175px, and a tablet spec exists because of the other.
 *  2. Every action is reachable, opening whatever disclosure this shape folds
 *     it behind. That is the property the invariant is *about*.
 *  3. Every visible control is big enough to hit and has a name to announce.
 *     WCAG 2.2 AA asks 24x24; a coarse pointer wants 44.
 */
import { expect, test, type Page } from '@playwright/test'
import { AGENT, openAgent, openFleet } from './helpers.ts'

/** WCAG 2.2 AA, 2.5.8. The audits hold the touch surfaces to 44. */
const MIN_TARGET = 24

/**
 * The actions an open agent offers. Kept in step with the list in
 * `test/ui/inv17-parity.test.tsx` by hand, and deliberately so: this one is
 * about whether they can be *seen and hit*, which is a different question from
 * whether they were rendered, and the two lists diverging is a fact worth
 * having to notice.
 */
const ACTIONS = [
  'tab-chat',
  'tab-attach',
  'fullscreen-toggle',
  'model-select',
  'clear-agent',
  'compact-agent',
  'composer-input',
  'composer-send',
  'send-mode-queue',
  'send-mode-interrupt',
  'goal-toggle',
  'quick-menu',
  'shift-tab',
]

/** Open every disclosure this shape has folded something behind. */
async function revealEverything(page: Page): Promise<void> {
  for (const id of ['controls-toggle', 'strip-toggle']) {
    const button = page.getByTestId(id)
    if ((await button.count()) === 0) continue
    if ((await button.getAttribute('aria-expanded')) === 'false') await button.click()
  }
}

/** How far the document overflows its window, in pixels. Zero is the pass. */
async function sidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement
    return Math.max(0, Math.round(doc.scrollWidth - window.innerWidth))
  })
}

test.describe('INV-17 every shape is the whole app', () => {
  test('the fleet does not scroll sideways', async ({ page }) => {
    await openFleet(page)
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1)
  })

  /*
   * The empty state rather than the full one, because that is where widths
   * have actually broken here: a long query is echoed into "No agent matches …"
   * and there is no card beside it to constrain the column.
   */
  test('nor does it with a long search term and nothing matching it', async ({ page }) => {
    await openFleet(page)
    await page.getByTestId('search').fill('n'.repeat(300))
    await expect(page.getByTestId('empty-state')).toBeVisible()
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1)
  })

  test('an open agent offers every action, and does not scroll sideways', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await revealEverything(page)

    const missing: string[] = []
    for (const id of ACTIONS) {
      // `first()`: `fullscreen-toggle` is rendered once per layout, in the
      // header on a desktop and in the tab row on a phone.
      const control = page.getByTestId(id).first()
      if (!(await control.isVisible().catch(() => false))) missing.push(id)
    }
    expect(missing, `unreachable at this viewport: ${missing.join(', ')}`).toEqual([])
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1)
  })

  /*
   * The shape none of the five projects is by default, and the one that used to
   * lose four features: at this height the composer strip is closed, so the
   * send-mode choice, the goal and the quick replies are behind the `⋯` beside
   * Send. Nothing else in the app offers them.
   */
  test('a landscape phone folds the strip away and still reaches it', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await page.setViewportSize({ width: 844, height: 380 })
    const toggle = page.getByTestId('strip-toggle')
    await expect(toggle).toBeVisible()
    // Closed by default: the conversation gets the height until it is asked for.
    await expect(page.getByTestId('composer-strip')).toBeHidden()
    await toggle.click()
    await expect(page.getByTestId('composer-strip')).toBeVisible()
    for (const id of ['send-mode-queue', 'send-mode-interrupt', 'goal-toggle', 'quick-menu']) {
      await expect(page.getByTestId(id).first()).toBeVisible()
    }
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1)
  })

  test('the terminal does not push the page sideways either', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await page.getByTestId('tab-attach').click()
    await expect(page.locator('[data-testid="terminal"] .xterm-rows')).toContainText(/\S/, {
      timeout: 15_000,
    })
    // The capture itself may pan — that is INV-1's answer to a 150-column pane
    // on a phone — but it must do that inside its own box.
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1)
  })

  test('every control on screen can be hit and announced', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await revealEverything(page)
    // 44 where the pointer is coarse (INV-17), and every touch-emulating
    // project is one. Measured at 24 everywhere, this sweep passed a phone
    // whose compact buttons had been 40px since a width rule was added after
    // the pointer rule in the cascade.
    const floor = test.info().project.use.hasTouch ? 44 : MIN_TARGET

    const bad = await page.$$eval(
      'button:not([disabled]), a[href], select, [role="tab"]:not([disabled])',
      (elements, floor) =>
        elements
          .filter((el) => el.checkVisibility())
          .map((el) => {
            const box = el.getBoundingClientRect()
            const name =
              el.getAttribute('aria-label') ??
              el.getAttribute('title') ??
              el.textContent?.trim() ??
              ''
            // A link inside a sentence is sized by the line it sits in, and
            // WCAG 2.5.8 exempts it for that reason (the inline exception). It
            // still has to be named; only the size floor is waived (INV-18).
            // `data-inline` is the one marker Message.tsx sets for this, and
            // `scripts/lib/targets.mjs` gives the audit scripts the same one.
            const inline = el.matches('[data-inline]')
            return {
              what: `${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? name.slice(0, 20)}]`,
              tooSmall: !inline && (box.width < floor || box.height < floor),
              unnamed: name === '',
            }
          })
          .filter((control) => control.tooSmall || control.unnamed),
      floor,
    )
    expect(bad, `controls too small or unnamed: ${JSON.stringify(bad)}`).toEqual([])
  })
})

/**
 * The on-screen keyboard, which is a fourth shape nothing else measures.
 *
 * A phone keyboard covers between a third and a half of the screen, and on iOS
 * Safari it does it in the one way CSS cannot see: the *layout* viewport keeps
 * its full height and `dvh` with it, only the *visual* viewport shrinks, and
 * Safari pans that visible rectangle down to follow the focused field. So a
 * layout that looks right in every test and every audit can still put the
 * composer — the reason the screen exists — under the keys.
 *
 * `useVisualViewport` writes the visible rectangle onto the root as `--vvh`
 * and `--vvt`, and every surface that has to stay above the keyboard lays out
 * from that pair. Playwright cannot raise a real keyboard, so these set the
 * same two variables to what one leaves and check what a reader would then be
 * able to see and reach. That is exactly the half that was broken: the hook
 * was right, its unit tests passed, and `.app`'s own `min-height: 100dvh`
 * floored the height the variable set, so nothing moved.
 */
const KEYBOARD_BAND = { top: 0, height: 444 }
/** Safari's pan: the visible rectangle slides down the layout viewport. */
const PANNED_BAND = { top: 120, height: 444 }

async function raiseKeyboard(page: Page, band: { top: number; height: number }): Promise<void> {
  await page.evaluate(({ top, height }) => {
    const root = document.documentElement
    root.style.setProperty('--vvh', `${height}px`)
    root.style.setProperty('--vvt', `${top}px`)
    root.dataset.keyboard = 'true'
  }, band)
}

/** Where a control sits, against the rectangle the keyboard left visible. */
async function withinBand(
  page: Page,
  testId: string,
  band: { top: number; height: number },
): Promise<boolean> {
  const box = await page.getByTestId(testId).first().boundingBox()
  if (!box) return false
  return box.y >= band.top - 1 && box.y + box.height <= band.top + band.height + 1
}

test.describe('an on-screen keyboard covers the keys, not the app', () => {
  /*
   * The sheet these lay out inside is the narrow layout's, and a desktop has
   * no software keyboard to lay out around in any case. Skipped by the
   * breakpoint rather than by device name, because the breakpoint is the
   * actual reason: the tablet is 834px in portrait and is therefore one of
   * the shapes this is about.
   */
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) > 900,
    'the sheet, and the keyboard it lays out around, live below 900px',
  )

  test('the composer stays above it, panned or not', async ({ page }) => {
    await openAgent(page, AGENT.idle)

    await raiseKeyboard(page, KEYBOARD_BAND)
    expect(await withinBand(page, 'composer-input', KEYBOARD_BAND), 'input under the keys').toBe(true)
    expect(await withinBand(page, 'composer-send', KEYBOARD_BAND), 'send under the keys').toBe(true)

    // The same again with the visible rectangle panned down, which is what
    // iOS does on top of shrinking it.
    await raiseKeyboard(page, PANNED_BAND)
    expect(await withinBand(page, 'composer-input', PANNED_BAND), 'input outside the pan').toBe(true)
    expect(await withinBand(page, 'composer-send', PANNED_BAND), 'send outside the pan').toBe(true)
  })

  test('the new-agent dialog stays inside it too', async ({ page }) => {
    await openFleet(page)
    await page.getByTestId('new-agent-button').click()
    await expect(page.getByTestId('new-agent-dir')).toBeVisible()

    await raiseKeyboard(page, PANNED_BAND)
    // The dialog scrolls inside itself, so what matters is that the box sits
    // in the visible rectangle rather than centred on a viewport half of
    // which is behind the keyboard.
    const modal = await page.getByTestId('new-agent-dialog').boundingBox()
    expect(modal).not.toBeNull()
    expect(modal!.y).toBeGreaterThanOrEqual(PANNED_BAND.top - 1)
    expect(modal!.y + modal!.height).toBeLessThanOrEqual(PANNED_BAND.top + PANNED_BAND.height + 1)
  })
})
