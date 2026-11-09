/**
 * The phone layout, where height is the scarce resource.
 *
 * Below 900px the detail is a sheet that owns the screen, and everything above
 * it is competing with the conversation for pixels. `scripts/audit-mobile.mjs`
 * measures this too and is the better tool for judging it — it drives real
 * device profiles in both orientations. What it cannot do is fail a pull
 * request: it needs a running server and a real Chromium, so it is a habit
 * rather than a gate. These are the same measurements as a gate, on the two
 * shapes that were actually found to be wrong.
 *
 * The numbers are the audit's own threshold: a conversation pane worth less
 * than 30% of the viewport is one you cannot read. Measured before the topbar
 * was put on a diet: 149px of 568 on an iPhone SE, 76px of 380 in landscape.
 */
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import { AGENT, card, openAgent, openFleet, stamp } from './helpers.ts'

/** How much of the screen the conversation gets, as a fraction. */
async function conversationShare(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="chat-scroll"]')
    return scroll ? scroll.clientHeight / window.innerHeight : 0
  })
}

test.describe('@phone the sheet', () => {
  test('covers the fleet list rather than sitting beside it', async ({ page }) => {
    await openFleet(page)
    await card(page, AGENT.idle).click()

    await expect(page.getByTestId('agent-detail')).toBeVisible()
    await expect(page.getByTestId('fleet-list')).toBeHidden()
    // `‹ Agents` is the way back on a phone, and the only one — a second
    // Close button would be two answers to one question.
    await expect(page.getByTestId('back-button')).toBeVisible()
  })

  test('drops the app title, and keeps the quota on one row', async ({ page }) => {
    await openFleet(page)
    // On the list the title is the app's own name and there is height to spare.
    await expect(page.locator('header h1')).toBeVisible()

    await card(page, AGENT.idle).click()
    await expect(page.getByTestId('agent-detail')).toBeVisible()

    // In the sheet it is 21px that the conversation needs more: the sheet's own
    // header already names what you are looking at.
    await expect(page.locator('header h1')).toBeHidden()
    // Still there, because "can I keep working" is the one thing worth the
    // height — but on one row rather than two.
    const chips = page.getByTestId('usage-chips')
    if ((await chips.count()) > 0) {
      expect(await chips.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(40)
    }
  })

  test('gives the conversation a readable share of the screen', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    expect(await conversationShare(page)).toBeGreaterThan(0.3)
  })

  test('still does on the smallest phone still in use', async ({ page }) => {
    // An iPhone SE: 320px wide, which is where the quota chips used to wrap
    // onto a second row and take the topbar to 121px of a 568px screen.
    await page.setViewportSize({ width: 320, height: 568 })
    await openAgent(page, AGENT.idle)

    expect(await conversationShare(page)).toBeGreaterThan(0.3)
    // And the page must not gain a sideways scroll in the process.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    )
    expect(overflows).toBe(false)
  })

  test('and in landscape, where there is least of it', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 380 })
    await openAgent(page, AGENT.idle)

    expect(await conversationShare(page)).toBeGreaterThan(0.3)
  })

  test('keeps the message box on screen without scrolling to it', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await openAgent(page, AGENT.idle)

    // The composer below a conversation that scrolls the page instead of
    // itself is a message box you have to scroll past the whole history to
    // reach.
    const box = page.getByTestId('composer-input')
    await expect(box).toBeInViewport()
  })

  /**
   * F1. ‹ Agents unmounts the sheet, and the draft used to be component state
   * inside it, so a reply half-written on the bus was gone by the time the
   * reader had checked the fleet and come back.
   */
  test('keeps a half-typed message through ‹ Agents and back', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    const draft = stamp('half a reply, not sent')
    await page.getByTestId('composer-input').fill(draft)

    await page.getByTestId('back-button').click()
    await expect(page.getByTestId('fleet-list')).toBeVisible()
    await card(page, AGENT.idle).click()

    await expect(page.getByTestId('composer-input')).toHaveValue(draft)
  })
})

/** The phone widths the sheet has to hold its header at: an SE, a mini, a 13/14, a Pro Max. */
const PHONE_WIDTHS = [320, 375, 390, 430]
/** Enough of the agent's name to tell one agent from the next. */
const MIN_NAME_PX = 60

/**
 * FR-DET-2 on a phone. The sheet's header was `flex-wrap: nowrap`, so the back
 * link, the status, the tabs and the actions came to about 340px in a row with
 * nothing allowed to drop: at 320px ⤢ sat at x 325-369, past the sheet's own
 * `overflow: hidden` edge and impossible to press, and from 320 to 390 the
 * agent's name got about 0px. The tabs now drop to a second row instead.
 */
test.describe('@phone the sheet header', () => {
  for (const [what, sessionId] of [
    ['an idle agent', AGENT.idle],
    ['a blocked one, whose status is the longest word', AGENT.waiting],
  ] as const) {
    test(`keeps every control inside the sheet and the name readable, for ${what}`, async ({
      page,
    }) => {
      for (const width of PHONE_WIDTHS) {
        await page.setViewportSize({ width, height: 740 })
        await page.goto(`/agent/${sessionId}`)
        await expect(page.getByTestId('agent-detail')).toBeVisible()

        const header = await page.evaluate(() => {
          const sheet = document.querySelector('[data-testid="agent-detail"]')?.getBoundingClientRect()
          const head = document.querySelector('[data-testid="detail-head"]')
          const name = document.querySelector('[data-testid="detail-name"]')?.getBoundingClientRect()
          if (!sheet || !head || !name) return null
          const outside = [...head.querySelectorAll('button')]
            .filter((button) => button.checkVisibility())
            .filter((button) => {
              const box = button.getBoundingClientRect()
              return (
                box.left < sheet.left - 0.5 ||
                box.right > sheet.right + 0.5 ||
                box.top < sheet.top - 0.5 ||
                box.bottom > sheet.bottom + 0.5
              )
            })
            .map((button) => button.dataset.testid ?? button.textContent ?? '')
          return { outside, name: name.width }
        })

        expect(header, `${width}px: the sheet header did not render`).not.toBeNull()
        expect(header?.outside, `${width}px: header controls past the sheet's edge`).toEqual([])
        expect(header?.name ?? 0, `${width}px: the agent's name`).toBeGreaterThanOrEqual(MIN_NAME_PX)
      }
    })
  }
})

/**
 * INV-17 with F7's expansion open: a recorded diff is as wide as its longest
 * line, and the fixture edit carries one far wider than a phone. The box
 * scrolls; the page does not.
 */
test.describe('@phone a tool call that says what happened', () => {
  test('opens an edit in a box that scrolls inside itself', async ({ page }) => {
    await openAgent(page, AGENT.idle)
    await expect(page.getByTestId('tool-outcome').filter({ hasText: 'refused · auto mode' })).toBeVisible()
    const edit = page.getByTitle('Edit: src/components/Header.astro')
    await expect(edit.getByTestId('tool-outcome')).toHaveText('+12 −3')

    await edit.getByTestId('tool-expand').click()
    const body = page.getByTestId('tool-result-body')
    await expect(body).toContainText('<ThemeToggle client:load')
    await expect(page.getByTestId('tool-result-caption')).toContainText(
      'the file may have changed since · you changed this before it was applied',
    )
    expect(await body.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })
})


/** How long a reconnect may take: the transport's backoff doubles to 10s. */
const RECONNECT_MS = 20_000

/** The topbar's height and the first answer option's top, the two things a thumb is aimed by. */
async function aim(page: Page): Promise<{ header: number; option: number }> {
  return page.evaluate(() => {
    const header = document.querySelector('header')?.getBoundingClientRect().height ?? -1
    const option = document.querySelector('[data-testid="answer-option"]')?.getBoundingClientRect().top ?? -1
    return { header: Math.round(header), option: Math.round(option) }
  })
}

/**
 * The tunnel down under an open question, and back. The socket is routed so a
 * test can drop it without stopping the shared server: while `down`, every
 * reconnect is refused before it opens and the reachability probe fails, which
 * is the phone's view of Tailscale being off — "server unreachable".
 *
 * In the sheet the topbar is one row. That caption wrapped to five lines in it,
 * the header went from 53px to 105px, and the answer options dropped 52px —
 * then jumped back up on reconnect, in the frame they became live again.
 */
/**
 * The widths to hold it at, and whether the whole pill fits at each. At 320 the
 * chip and the three icon buttons leave the pill 80px before the screen's edge,
 * which cuts "offline · 2m ago" short — as it cuts the quota chips after it at
 * every phone width, live or not — so there only its start is held on screen.
 */
const OFFLINE_WIDTHS = [
  { width: 390, wholePill: true },
  { width: 320, wholePill: false },
]

test.describe('@phone offline, the topbar holds still', () => {
  for (const { width, wholePill } of OFFLINE_WIDTHS) {
    test(`at ${width}px, across a drop and a reconnect`, async ({ page }) => {
      await page.setViewportSize({ width, height: 664 })
      let down = false
      let link: WebSocketRoute | null = null
      await page.routeWebSocket(/\/ws/, (ws) => {
        if (down) return ws.close()
        ws.connectToServer()
        link = ws
      })
      await page.route('**/api/env', (route) => (down ? route.abort() : route.fallback()))

      await page.goto(`/agent/${AGENT.waiting}`)
      const pill = page.getByTestId('connection-status')
      const option = page.getByTestId('answer-option').first()
      await expect(pill).toHaveAttribute('data-state', 'open')
      await expect(option).toBeEnabled()
      const live = await aim(page)

      down = true
      await link!.close()
      await expect(pill).toHaveAttribute('data-reach', 'unreachable')
      await expect(option).toBeDisabled()
      expect(await aim(page), `${width}px offline`).toEqual(live)
      await expect(pill.locator('[aria-hidden="true"]')).toHaveText(/^offline · /)
      await expect(pill).toHaveAttribute('title', /Tailscale/)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      const box = (await pill.boundingBox())!
      expect(box.x + (wholePill ? box.width : 0), `${width}px: the pill's edge`).toBeLessThanOrEqual(width)

      down = false
      await expect(pill).toHaveAttribute('data-state', 'open', { timeout: RECONNECT_MS })
      await expect(option).toBeEnabled()
      expect(await aim(page), `${width}px back`).toEqual(live)
    })
  }
})

/**
 * Round 4's A3: two rows of toolbar on a phone, not three.
 *
 * The verdict's line is y=330 on a 390px WebKit viewport, set before the
 * stopped strip existed. The strip is drawn only while agents are stopped and
 * sits between the toolbar and the first card, so its share of the height is
 * taken back out and the comparison stays the one the verdict meant.
 */
const FIRST_CARD_LINE = 330
const SAME_ROW_TOLERANCE = 2
/** The gap `.column` leaves below the strip, which the strip takes with it. */
const STRIP_GAP = 12
const TOUCH_TARGET = 44
const NO_ZOOM_FONT = '16px'
/** Below this a filter box stops showing a useful part of what is typed. */
const SEARCH_FLOOR = 120
/** The width of the native select's arrow, which `clientWidth` includes. */
const SELECT_ARROW = 12

interface ToolbarMeasure {
  search: { y: number; width: number; height: number; font: string }
  sort: { y: number; width: number; height: number; font: string }
  newAgentTop: number
  firstCardTop: number
  stripSpace: number
  optionWiderThanSelect: string[]
  sideways: number
}

function measureToolbar(page: Page): Promise<ToolbarMeasure> {
  return page.evaluate(({ gap, arrow }) => {
    const element = <T extends Element>(id: string) =>
      document.querySelector<T>(`[data-testid="${id}"]`)!
    const metrics = (control: HTMLElement) => {
      const box = control.getBoundingClientRect()
      return { y: box.y, width: box.width, height: box.height, font: getComputedStyle(control).fontSize }
    }
    const select = element<HTMLSelectElement>('sort-select')
    const strip = document.querySelector('[data-testid="stopped-strip"]')
    const pen = document.createElement('canvas').getContext('2d')!
    const style = getComputedStyle(select)
    pen.font = `${style.fontSize} ${style.fontFamily}`
    const textRoom =
      select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - arrow
    return {
      search: metrics(element('search')),
      sort: metrics(select),
      newAgentTop: element('new-agent-button').getBoundingClientRect().y,
      firstCardTop: element('agent-card').getBoundingClientRect().y,
      stripSpace: strip ? strip.getBoundingClientRect().height + gap : 0,
      optionWiderThanSelect: [...select.options]
        .filter((option) => pen.measureText(option.textContent ?? '').width > textRoom)
        .map((option) => option.textContent ?? ''),
      sideways: document.documentElement.scrollWidth - innerWidth,
    }
  }, { gap: STRIP_GAP, arrow: SELECT_ARROW })
}

function expectUsableRow(measure: ToolbarMeasure): void {
  expect(Math.abs(measure.search.y - measure.sort.y)).toBeLessThanOrEqual(SAME_ROW_TOLERANCE)
  expect(measure.newAgentTop).toBeGreaterThan(measure.search.y + measure.search.height - 1)
  expect(measure.search.width).toBeGreaterThanOrEqual(SEARCH_FLOOR)
  expect(measure.search.height).toBeGreaterThanOrEqual(TOUCH_TARGET)
  expect(measure.sort.height).toBeGreaterThanOrEqual(TOUCH_TARGET)
  expect(measure.search.font).toBe(NO_ZOOM_FONT)
  expect(measure.sort.font).toBe(NO_ZOOM_FONT)
  expect(measure.optionWiderThanSelect).toEqual([])
  expect(measure.sideways).toBeLessThanOrEqual(1)
}

for (const locale of ['en-US', 'zh-CN']) {
  test.describe(`@phone the fleet toolbar, ${locale}`, () => {
    test.use({ locale })

    test('search and sort share a row and the first card comes up', async ({ page }) => {
      await openFleet(page)
      const measure = await measureToolbar(page)
      expectUsableRow(measure)
      expect(measure.firstCardTop - measure.stripSpace).toBeLessThan(FIRST_CARD_LINE)
    })

    test('and still fit at the narrowest supported width', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 })
      await openFleet(page)
      expectUsableRow(await measureToolbar(page))
    })
  })
}
