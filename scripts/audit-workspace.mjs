#!/usr/bin/env node
/*
 * How much of the screen is the work, and how much is this app talking about
 * itself.
 *
 * The dashboard exists to be read and typed into, so the number that matters is
 * the share of the viewport given to the transcript and the box you answer in.
 * Everything else — the topbar, the agent's header, the tab strip, the gaps —
 * is overhead, and overhead on a screen that does not scroll is taken directly
 * off the conversation rather than off the end of a document.
 *
 * Measured, never modelled. An earlier pass at this was modelled from the
 * stylesheets and reported 74% where the running app was at 48%: the model knew
 * the padding it had changed and not the four stacked bands it had not. So this
 * drives a real browser against the mock fleet and reads real boxes.
 *
 * The partition is deliberate and is the whole definition:
 *
 *   work  = the transcript's own scroll viewport, less any dead inset inside
 *           it, plus the composer's text field
 *   tax   = the viewport minus that
 *
 * The Send button is tax. That is not an accident of the arithmetic — it is a
 * control, and the bar is about the surface the work happens on.
 *
 * Run it against a --mock server on 4400. Never 4317: that port drives real
 * agents, and this navigates and clicks.
 */
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? 4400
const BASE = process.env.BASE ?? `http://127.0.0.1:${PORT}/`
const AGENT = process.env.AGENT ?? 'mock-busy'

if (String(PORT) === '4317') {
  console.error('refusing port 4317: that server drives real agents')
  process.exit(2)
}

/*
 * The shapes held to the bar, and the one that is not.
 *
 * The phone is measured and reported but not enforced. Its chrome is the same
 * absolute height as everywhere else against a fraction of the pixels, so
 * clearing 80% there means removing global controls rather than whitespace —
 * a product decision rather than a layout one, and not one to smuggle in behind
 * a threshold.
 */
const SHAPES = [
  { name: 'desktop', width: 1440, height: 900, enforced: true },
  { name: 'laptop', width: 1180, height: 800, enforced: true },
  /*
   * Measured with a coarse pointer, which is what a tablet has — and therefore
   * no longer enforced.
   *
   * It read 80.91% and passed while being opened with a viewport only, so every
   * `pointer: coarse` rule in the app was off during the measurement. With
   * `hasTouch` the same layout reads ~79.5%, because INV-17's 44px touch floors
   * are real on this device and cost about 1.4 points. Nothing recovers that:
   * the chrome reclaim is keyed `min-width: 901px`, and the rest would have to
   * come out of touch comfort, which INV-17 says a small screen must not be
   * charged for.
   *
   * So the 80% bar is a fine-pointer promise, and this row says what a tablet
   * actually gets. A number measured under a pointer the device does not have
   * is exactly the kind of claim INVARIANTS.md exists to forbid — applied here
   * to the gate rather than to the app.
   */
  { name: 'tablet', width: 834, height: 1112, enforced: false, touch: true },
  /*
   * Measured, not enforced, and it exists because this script had a blind band.
   *
   * Sampling 1440, 1180, 834 and 390 left 901-1071px unmeasured — a window
   * dragged to half a wide display, or a 1024x768 screen — and the agent header
   * was wrapping to two rows across the whole of it, costing 5.5 points that no
   * gate could see. The wrap is fixed; this row is here so the band cannot go
   * quiet again.
   *
   * Not enforced because 768px of height is the binding constraint rather than
   * the layout: the fixed chrome is the same absolute height as at 900px with
   * 132 fewer pixels to spread it over, so clearing 80% here needs chrome
   * removed rather than trimmed — the same argument as the phone.
   */
  { name: 'half-width', width: 1024, height: 768, enforced: false },
  { name: 'phone', width: 390, height: 844, enforced: false, touch: true },
]

const BAR = Number(process.env.BAR ?? 80)

/** The transcript lands over the socket a beat after the pane does. */
const TRANSCRIPT_SETTLE_MS = 900

const census = (page) =>
  page.evaluate(() => {
    const vw = innerWidth
    const vh = innerHeight
    const clip = (rect) => ({
      w: Math.max(0, Math.min(vw, rect.right) - Math.max(0, rect.left)),
      h: Math.max(0, Math.min(vh, rect.bottom) - Math.max(0, rect.top)),
    })
    const box = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const c = clip(el.getBoundingClientRect())
      return { w: Math.round(c.w), h: Math.round(c.h) }
    }
    const list = document.querySelector('[data-testid="chat-list"]')
    return {
      area: vw * vh,
      scroll: box('[data-testid="chat-scroll"]'),
      composer: box('[data-testid="composer-input"]'),
      // Padding inside the scroller is not surface the conversation can use.
      gutter: list ? parseFloat(getComputedStyle(list).paddingLeft) || 0 : 0,
      sideways: document.documentElement.scrollWidth > vw + 1,
    }
  })

const browser = await chromium.launch()
const rows = []

for (const shape of SHAPES) {
  const page = await browser.newPage({
    viewport: { width: shape.width, height: shape.height },
    // A touch device gets the touch floors; measuring it without them measures
    // a device nobody is holding.
    ...(shape.touch ? { hasTouch: true, isMobile: true } : {}),
  })
  /*
   * Collapsed, because that is the state the bar is a promise about. Expanding
   * the fleet column spends roughly 17 points of it on the agents' names, which
   * is a trade a reader makes deliberately and knowingly — this script does not
   * measure that state, and the bar is not a claim about it.
   */
  await page.addInitScript(() => {
    try {
      localStorage.setItem('agent-commander.sidebar', 'collapsed')
    } catch {
      /* private mode; the default is expanded and the row will say so */
    }
  })
  /*
   * The mock banner is not part of the layout being measured.
   *
   * `--mock` draws a warning strip across the top so nobody mistakes fixtures
   * for their real fleet. It is ~27px that a production server never renders,
   * and leaving it in understates every shape by about 2 points — which is the
   * difference between passing this bar and failing it, so it is worth being
   * explicit rather than quietly right.
   */
  const hideBanner = '[class*="mockBanner"]{display:none !important}'
  await page.addStyleTag({ content: hideBanner }).catch(() => {})
  await page.goto(`${BASE}agent/${AGENT}`, { waitUntil: 'networkidle' })
  await page.addStyleTag({ content: hideBanner }).catch(() => {})
  await page.waitForSelector('[data-testid="message"]', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(TRANSCRIPT_SETTLE_MS)

  const c = await census(page)
  const work =
    (c.scroll ? Math.max(0, c.scroll.w - c.gutter) * c.scroll.h : 0) +
    (c.composer ? c.composer.w * c.composer.h : 0)
  const pct = +((work / c.area) * 100).toFixed(1)
  rows.push({ ...shape, pct, sideways: c.sideways })
  await page.close()
}

let failed = false
console.log(`\nwork surface, fleet column collapsed — bar ${BAR}%\n`)
for (const r of rows) {
  const ok = r.pct >= BAR
  const verdict = !r.enforced ? 'not enforced' : ok ? 'PASSES' : 'FAILS'
  if (r.enforced && !ok) failed = true
  // A layout that scrolls sideways has found width nobody asked for, which
  // would flatter every number above it (INV-17).
  if (r.sideways) {
    failed = true
    console.log(`  ${r.name.padEnd(8)} ${String(r.width)}x${r.height}  SCROLLS SIDEWAYS`)
  }
  console.log(
    `  ${r.name.padEnd(8)} ${`${r.width}x${r.height}`.padEnd(10)} ${String(r.pct).padStart(5)}%   ${verdict}`,
  )
}
console.log('')

await browser.close()
process.exit(failed ? 1 : 0)
