/**
 * WCAG 2.2 AA audit of agent-commander.
 *
 * Implements the P0 set from the ux-ui-agent-skills a11y checklist: keyboard
 * navigable, focus visible, accessible name/role/state, target size, no
 * colour-only signalling, focus not obscured (2.4.11), plus reduced motion.
 * Contrast is measured separately against the design tokens.
 */
import { chromium, devices } from 'playwright'

const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 4400}/`
const T = (id) => `[data-testid="${id}"]`
const findings = []
const add = (wcag, sev, detail) => findings.push({ wcag, sev, detail })

const browser = await chromium.launch()

/** Walk the app into each of its main states so the audit sees all of it. */
async function visitStates(page) {
  const states = []
  await page.waitForSelector(T('agent-card'))
  states.push('fleet')

  const cards = await page.$$(T('agent-card'))
  await cards[1].click()
  await page.waitForSelector(T('agent-detail'))
  states.push('chat')

  await page.click(T('tab-attach'))
  await page.waitForSelector('.xterm-screen', { timeout: 6000 }).catch(() => {})
  await page.waitForTimeout(600)
  states.push('terminal')

  return states
}

/*
 * The three shapes INV-17 names, not two.
 *
 * This ran desktop and phone for its first five releases, which left the
 * tablet — the only device that crosses the 900px breakpoint in normal use, by
 * being turned over — judged by nothing. Landscape is in the list for the same
 * reason: it is the shape with the least height, where a row of controls is
 * likeliest to be dropped rather than moved.
 */
for (const [profile, options] of [
  ['desktop', { viewport: { width: 1440, height: 900 } }],
  ['tablet', { ...devices['iPad Pro 11'] }],
  ['tablet-landscape', { ...devices['iPad Pro 11 landscape'] }],
  ['phone', { ...devices['iPhone 14 Pro Max'] }],
  ['phone-landscape', { ...devices['iPhone 14 Pro Max landscape'] }],
]) {
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ ...options, colorScheme: scheme })
    const page = await context.newPage()
    await page.goto(BASE, { waitUntil: 'networkidle' })
    const tag = `${profile}/${scheme}`

    await visitStates(page)

    // 4.1.2 — every interactive control needs an accessible name.
    const unnamed = await page.$$eval(
      'button:not([disabled]), a[href], input, select, textarea, [role="tab"]',
      (els) =>
        els
          .filter((e) => e.offsetParent !== null)
          .filter((e) => {
            const name =
              e.getAttribute('aria-label') ||
              e.getAttribute('title') ||
              (e.getAttribute('aria-labelledby') &&
                document.getElementById(e.getAttribute('aria-labelledby'))?.textContent) ||
              e.textContent?.trim() ||
              e.closest('label')?.textContent?.trim() ||
              (e.id && document.querySelector(`label[for="${e.id}"]`)?.textContent?.trim()) ||
              e.getAttribute('placeholder')
            return !name
          })
          .map((e) => `${e.tagName.toLowerCase()}${e.className ? '.' + String(e.className).slice(0, 30) : ''}`),
    )
    if (unnamed.length) {
      add('4.1.2', 'P0', `${tag}: ${unnamed.length} control(s) with no accessible name: ${unnamed.slice(0, 5).join(', ')}`)
    }

    // 2.5.8 — target size. AA is 24x24; anything under is a failure.
    const tiny = await page.$$eval('button, a[href], [role="tab"], input[type="checkbox"]', (els) =>
      els
        .filter((e) => e.offsetParent !== null)
        .map((e) => {
          const r = e.getBoundingClientRect()
          return { label: (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) }
        })
        .filter((x) => x.w > 0 && (x.w < 24 || x.h < 24)),
    )
    if (tiny.length) {
      add('2.5.8', 'P0', `${tag}: ${tiny.length} target(s) under 24x24: ${tiny.slice(0, 5).map((t) => `${t.label}(${t.w}x${t.h})`).join(', ')}`)
    }

    // 2.4.7 + 2.4.11 — focus must be visible and not hidden behind the sticky
    // header. Tabbed with the real keyboard: `:focus-visible` deliberately does
    // not match programmatic .focus(), so driving this from script would report
    // a ring that a keyboard user actually sees as missing.
    const invisible = []
    const obscured = []
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab')
      const stop = await page.evaluate(() => {
        const el = document.activeElement
        if (!el || el === document.body) return null
        const style = getComputedStyle(el)
        const label = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 24)
        const visible =
          el.matches(':focus-visible') && (style.outlineStyle !== 'none' || style.boxShadow !== 'none')
        const r = el.getBoundingClientRect()
        let covered = false
        if (r.width > 0 && r.top >= 0 && r.bottom <= innerHeight) {
          const mid = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          covered = Boolean(mid) && !el.contains(mid) && !mid.contains(el)
        }
        return { label, visible, covered }
      })
      if (!stop) continue
      if (!stop.visible) invisible.push(stop)
      if (stop.covered) obscured.push(stop)
    }
    if (invisible.length) add('2.4.7', 'P0', `${tag}: ${invisible.length} focus stop(s) with no visible indicator: ${invisible.slice(0, 4).map((p) => p.label).join(', ')}`)
    if (obscured.length) add('2.4.11', 'P1', `${tag}: ${obscured.length} focus stop(s) obscured by another element: ${obscured.slice(0, 4).map((p) => p.label).join(', ')}`)

    // 1.3.1 — structure: one h1, headings in order, a main landmark.
    const structure = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]))
      let skipped = false
      for (let i = 1; i < heads.length; i += 1) if (heads[i] - heads[i - 1] > 1) skipped = true
      return {
        h1: document.querySelectorAll('h1').length,
        skipped,
        main: document.querySelectorAll('main').length,
        lang: document.documentElement.lang,
      }
    })
    if (structure.h1 !== 1) add('1.3.1', 'P1', `${tag}: expected exactly one h1, found ${structure.h1}`)
    if (structure.skipped) add('1.3.1', 'P2', `${tag}: heading levels skip a rank`)
    if (structure.main < 1) add('1.3.1', 'P1', `${tag}: no <main> landmark`)
    if (!structure.lang) add('3.1.1', 'P1', `${tag}: <html> has no lang attribute`)

    // 4.1.2 — tabs must expose selected state.
    const tabState = await page.$$eval('[role="tab"]', (els) => els.filter((e) => !e.hasAttribute('aria-selected')).length)
    if (tabState) add('4.1.2', 'P1', `${tag}: ${tabState} tab(s) missing aria-selected`)

    // 1.4.1 — status must not be conveyed by colour alone.
    const colourOnly = await page.$$eval(T('agent-status'), (els) => els.filter((e) => !e.textContent?.trim()).length)
    if (colourOnly) add('1.4.1', 'P0', `${tag}: ${colourOnly} status indicator(s) with no text`)

    // 2.3.3 / reduced motion.
    if (profile === 'desktop' && scheme === 'light') {
      const reduced = await page.evaluate(() =>
        [...document.styleSheets]
          .flatMap((s) => {
            try {
              return [...s.cssRules].map((r) => r.cssText)
            } catch {
              return []
            }
          })
          .some((t) => t.includes('prefers-reduced-motion')),
      )
      if (!reduced) add('2.3.3', 'P1', 'no prefers-reduced-motion handling in the stylesheet')
    }

    await context.close()
  }
}

await browser.close()

const order = { P0: 0, P1: 1, P2: 2 }
const seen = new Set()
const unique = findings.filter((f) => (seen.has(f.wcag + f.detail) ? false : (seen.add(f.wcag + f.detail), true)))
unique.sort((a, b) => order[a.sev] - order[b.sev])

console.log(`\n===== WCAG 2.2 AA AUDIT: ${unique.length} findings =====\n`)
for (const f of unique) console.log(`[${f.sev}] ${f.wcag.padEnd(7)} ${f.detail}`)

process.exit(unique.some((f) => f.sev !== 'info') ? 1 : 0)
