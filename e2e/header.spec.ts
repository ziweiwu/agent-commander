/**
 * FR-DET-2 on the desktop panel, across the band where it is narrowest.
 *
 * Between 901 and 1180px with the fleet column open, the agent header held to
 * one row by shrinking, and the only thing left to shrink was the name: the
 * mock fleet measured 0-36px of it at 901px and 20px at 1180px. The name now
 * keeps twelve characters, and when that, the status, the tabs and the actions
 * do not fit, the tabs and the actions drop to a second row together. This
 * checks both halves: the name is readable, and nothing that dropped has gone
 * past the panel's clipped edge.
 */
import { expect, test } from '@playwright/test'
import { AGENT, controlsThatCannotBeHit } from './helpers.ts'

/** The narrowest desktop, a 1024x768 screen, and the laptop the audit enforces. */
const DESKTOP_WIDTHS = [901, 1024, 1180]
/**
 * Twelve characters of the header's name at its own size measure ~112px; 96
 * leaves room for a narrower font and still reads as a name, where the old
 * header's 0-36px read as an ellipsis.
 */
const MIN_NAME_PX = 96
/** WCAG 2.2 AA, 2.5.8, as in `responsive.spec.ts`. */
const MIN_TARGET = 24

/**
 * The fixtures whose headers are fullest: the longest status word, the busy
 * ones whose facts run widest, and the one whose Attach tab carries a reason.
 */
const CROWDED = [AGENT.idle, AGENT.waiting, AGENT.busy, AGENT.movingFamily, AGENT.quietFamily, AGENT.noTmux]

test.describe('@desktop the agent header', () => {
  for (const width of DESKTOP_WIDTHS) {
    test(`keeps the name readable and every control inside the panel at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 })
      for (const sessionId of CROWDED) {
        await page.goto(`/agent/${sessionId}`)
        await expect(page.getByTestId('agent-detail')).toBeVisible()
        await expect(page.getByTestId('fleet-list')).toBeVisible()

        const name = await page.getByTestId('detail-name').boundingBox()
        expect(name?.width ?? 0, `${sessionId} at ${width}px: the agent's name`).toBeGreaterThanOrEqual(
          MIN_NAME_PX,
        )

        const bad = await controlsThatCannotBeHit(page, MIN_TARGET, '[data-testid="detail-head"]')
        expect(bad, `${sessionId} at ${width}px: header controls cut off`).toEqual([])
      }
    })
  }
})
