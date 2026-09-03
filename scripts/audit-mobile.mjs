import { chromium, devices, webkit } from 'playwright'

const OUT = process.env.SHOTS ?? '/tmp/agent-commander-audit'
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 4400}/`
const findings = []
const add = (sev, area, msg) => findings.push({ sev, area, msg })

/*
 * The smallest text the attach view will draw before it pans instead — the
 * same number as `MIN_EFFECTIVE_FONT` in `src/web/lib/term.ts`. Text at the
 * floor that happens to fit exactly is the design working, not a finding; the
 * old threshold of 10 flagged it as unreadable half a pixel above the floor.
 */
const MIN_EFFECTIVE_FONT = 9.5
/** xterm's font when nothing has enlarged it — `BASE_FONT` in `term.ts`. */
const BASE_FONT = 13

const PROFILES = [
  { name: 'iphone14promax', device: devices['iPhone 14 Pro Max'] },
  { name: 'iphone-se', device: devices['iPhone SE'] },
  { name: 'iphone-landscape', device: devices['iPhone 14 Pro Max landscape'] },
  { name: 'ipad', device: devices['iPad Pro 11'] },
]

/*
 * Chromium by default, WebKit on request: `ENGINE=webkit npm run audit:mobile`.
 *
 * These profiles all name iOS devices, and every browser on iOS is WebKit — so
 * running them on Chromium alone measured an engine no iPhone has. Chromium
 * stays the default because CI and the other audits use it and a silent switch
 * would make two runs incomparable.
 */
const ENGINE = process.env.ENGINE === 'webkit' ? webkit : chromium
const browser = await ENGINE.launch()

for (const { name, device } of PROFILES) {
  const ctx = await browser.newContext({ ...device })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => add('high', 'js', `${name}: ${e.message}`))
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="agent-card"]')

  // 1. iOS zooms any input whose font-size is under 16px when it gets focus.
  const smallFonts = await page.$$eval('input, textarea, select', (els) =>
    els
      .filter((e) => e.offsetParent !== null)
      .map((e) => ({ tag: e.tagName, size: parseFloat(getComputedStyle(e).fontSize), cls: e.className }))
      .filter((x) => x.size < 16),
  )
  if (smallFonts.length) {
    add('high', 'ios-zoom', `${name}: ${smallFonts.length} input(s) under 16px will trigger iOS zoom-on-focus: ${smallFonts.map((f) => `${f.cls || f.tag}@${f.size}px`).join(', ')}`)
  }

  // 2. Safe-area insets (notch / home indicator).
  const usesSafeArea = await page.evaluate(() => {
    const css = [...document.styleSheets]
      .flatMap((s) => {
        try { return [...s.cssRules].map((r) => r.cssText) } catch { return [] }
      })
      .join('\n')
    return /env\(\s*safe-area-inset/.test(css)
  })
  if (!usesSafeArea && name.startsWith('iphone')) {
    add('high', 'safe-area', `${name}: no safe-area-inset usage — content can sit under the notch or home indicator`)
  }
  const viewportMeta = await page.$eval('meta[name=viewport]', (e) => e.content).catch(() => '')
  if (name.startsWith('iphone') && !viewportMeta.includes('viewport-fit=cover')) {
    add('med', 'safe-area', `${name}: viewport meta lacks viewport-fit=cover ("${viewportMeta}")`)
  }

  // 3. Horizontal overflow at rest.
  const ov = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, i: window.innerWidth }))
  if (ov.s > ov.i + 1) add('high', 'overflow', `${name}: list overflows horizontally (${ov.s} > ${ov.i})`)

  /*
   * 4. Open an agent -> chat. Asked for by capability, not by position: a
   * blocked agent opens on the terminal, and an agent whose CLI keeps no
   * transcript has no chat at all, so counting cards picks the wrong one as
   * soon as the fixture fleet gains a second kind.
   */
  const cards = await page.$$('[data-testid="agent-card"][data-transcripts="true"]:not([data-status="waiting"])')
  if (cards.length === 0) throw new Error('no chat-capable agent in the fixture fleet')
  await cards[0].click()
  await page.waitForSelector('[data-testid="message"]', { timeout: 6000 }).catch(() => add('high', 'chat', `${name}: chat did not render`))
  await page.waitForTimeout(400)

  const ov2 = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, i: window.innerWidth }))
  if (ov2.s > ov2.i + 1) add('high', 'overflow', `${name}: chat overflows horizontally (${ov2.s} > ${ov2.i})`)

  // 5. Is the composer reachable without scrolling past the whole conversation?
  const composer = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="composer-input"]')
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, visible: r.top < window.innerHeight && r.bottom > 0 }
  })
  if (composer && !composer.visible) {
    add('high', 'composer', `${name}: message box is offscreen on open (top=${composer.top}, viewport=${composer.vh})`)
  }

  // 6. Chat should use the available height, not a fixed vh slice.
  const chatH = await page.evaluate(() => {
    const s = document.querySelector('[data-testid="chat-scroll"]')
    return s ? { h: Math.round(s.clientHeight), vh: window.innerHeight } : null
  })
  if (chatH && chatH.h < chatH.vh * 0.3) {
    add('med', 'layout', `${name}: conversation pane is only ${chatH.h}px of ${chatH.vh}px viewport`)
  }

  await page.screenshot({ path: `${OUT}/30-${name}-chat.png`, fullPage: false })

  // 7. Terminal legibility.
  const attach = await page.$('[data-testid="tab-attach"]')
  const disabled = await attach.isDisabled()
  if (!disabled) {
    await attach.click()
    await page.waitForSelector('.xterm-screen', { timeout: 6000 }).catch(() => add('high', 'attach', `${name}: terminal did not render`))
    await page.waitForTimeout(900)
    const term = await page.evaluate(() => {
      const screen = document.querySelector('.xterm-screen')
      const wrap = document.querySelector('[data-testid="term-wrap"]')
      const scaler = document.querySelector('[data-testid="term-scale"]')
      if (!screen || !wrap) return null
      const t = getComputedStyle(scaler).transform
      // `none` does not mean 1: it means rescale() never ran, which leaves the
      // pane at full size inside a smaller box — clipped, with nothing to pan.
      const measured = Boolean(t) && t !== 'none'
      const m = measured ? parseFloat(t.split('(')[1]) : 1
      // Enlarging raises xterm's own font rather than the transform, so the
      // rendered size is the font it is drawing at times whatever transform is
      // left, not 13 times the transform.
      const xterm = scaler.querySelector('.xterm')
      const fontPx = xterm ? parseFloat(getComputedStyle(xterm).fontSize) || BASE_FONT : BASE_FONT
      const cols = screen.offsetWidth
      return {
        measured,
        /*
         * The rendered rect, not `scrollWidth`.
         *
         * The pane is shrunk with a CSS transform, which does not change its
         * layout size — and engines disagree about whether a transformed child
         * still counts toward its parent's `scrollWidth`. WebKit says yes and
         * Chromium says no, so the old check reported a 7px clip on WebKit
         * that measurement of the actual painted rects shows is not there: both
         * boxes span 25..789 exactly. What the user can or cannot see is the
         * rendered geometry, so that is what this asks about.
         */
        clipped: (() => {
          const inner = wrap.firstElementChild
          if (!inner) return false
          const wb = wrap.getBoundingClientRect()
          const ib = inner.getBoundingClientRect()
          return ib.right > wb.right + 1 || ib.left < wb.left - 1
        })(),
        scale: Math.round(m * 100) / 100,
        naturalW: screen.offsetWidth,
        shownW: Math.round(wrap.clientWidth),
        effectiveFontPx: Math.round(fontPx * m * 10) / 10,
        cols,
      }
    })
    if (term) {
      const overflowX = await page.evaluate(() => {
        const w = document.querySelector('[data-testid="term-wrap"]')
        return w ? getComputedStyle(w).overflowX : ''
      })
      term.pannable = overflowX === 'auto' || overflowX === 'scroll'

      if (!term.measured) {
        add('high', 'terminal', `${name}: terminal was never scaled to its container (transform: none)`)
      }
      if (term.clipped && !term.pannable) {
        add('high', 'terminal', `${name}: terminal is clipped with no way to pan to the rest of it`)
      }
      if (term.effectiveFontPx < 8) {
        add('high', 'terminal', `${name}: terminal renders at ${term.effectiveFontPx}px effective text (scale ${term.scale}) — illegible on a phone`)
      }
      if (term.effectiveFontPx < MIN_EFFECTIVE_FONT && !term.pannable) {
        add('med', 'terminal', `${name}: terminal is shrunk to fit with no way to scroll it at a readable size (overflow-x: ${overflowX})`)
      }
    }
    await page.screenshot({ path: `${OUT}/31-${name}-attach.png`, fullPage: false })
  }

  // 8. Tap targets across the whole UI.
  const small = await page.$$eval('button, a, input', (els) =>
    els
      .filter((e) => e.offsetParent !== null)
      .map((e) => ({ t: (e.textContent || e.tagName).trim().slice(0, 16), h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) }))
      .filter((x) => x.h > 0 && (x.h < 40 || x.w < 32)),
  )
  if (small.length) add('med', 'touch', `${name}: ${small.length} small target(s): ${small.map((s) => `${s.t}(${s.w}x${s.h})`).slice(0, 6).join(', ')}`)

  await ctx.close()
}

await browser.close()

const order = { high: 0, med: 1, low: 2, info: 3 }
const seen = new Set()
const unique = findings.filter((f) => (seen.has(f.sev + f.area + f.msg) ? false : (seen.add(f.sev + f.area + f.msg), true)))
unique.sort((a, b) => order[a.sev] - order[b.sev])
console.log(`\n===== MOBILE AUDIT: ${unique.length} findings =====\n`)
for (const f of unique) console.log(`[${f.sev.toUpperCase().padEnd(4)}] ${f.area.padEnd(10)} ${f.msg}`)

process.exit(unique.some((f) => f.sev !== 'info') ? 1 : 0)
