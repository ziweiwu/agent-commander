import { chromium } from 'playwright'
import { TOUCH_TARGETS } from './lib/targets.mjs'

const OUT = process.env.SHOTS ?? '/tmp/agent-commander-audit'
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 4400}/`
const findings = []
const add = (sev, area, msg) => findings.push({ sev, area, msg })

// Stable hooks, not CSS class names: CSS Modules hashes classes at build time.
const T = (id) => `[data-testid="${id}"]`

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1180, height: 800 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'phone', width: 390, height: 844 },
]

const browser = await chromium.launch()

for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme })
  page.on('pageerror', (e) => add('high', 'js', `pageerror(${scheme}): ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') add('high', 'js', `console(${scheme}): ${m.text().slice(0, 140)}`)
  })
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector(T('agent-card'))
  await page.screenshot({ path: `${OUT}/01-fleet-${scheme}.png`, fullPage: true })

  const first = await page.$eval(T('agent-card'), (e) => e.dataset.status)
  if (first !== 'waiting') add('high', 'taskA', 'blocked agent is not first in the list')

  const groups = await page.$$eval(T('group-title'), (els) => els.map((e) => e.textContent))
  if (!groups.includes('Needs you')) add('med', 'grouping', `no "Needs you" group (saw: ${groups})`)

  const clipped = await page.$$eval(`${T('agent-name')}, ${T('agent-activity')}`, (els) =>
    els.filter((e) => e.scrollWidth > e.clientWidth + 1 && !e.title).length,
  )
  if (clipped) add('med', 'truncation', `${clipped} clipped element(s) with no title`)

  /*
   * That the filter narrows and that what survives matches — not a count.
   *
   * This asserted exactly one result, which was true of the fixture fleet on
   * the day it was written and became a false alarm the moment two fixtures
   * were added in the same folder. A count is a test of the fixtures; "fewer
   * than before, and every card shown is a match" is a test of the filter.
   */
  const allCards = await page.$$eval(T('agent-card'), (els) => els.length)
  await page.fill(T('search'), 'lego')
  await page.waitForTimeout(150)
  const matches = await page.$$eval(T('agent-card'), (els) =>
    els.map((e) => `${e.textContent}`.toLowerCase()),
  )
  if (matches.length === 0 || matches.length >= allCards) {
    add('high', 'search', `filtering by "lego" left ${matches.length} of ${allCards}`)
  }
  const strays = matches.filter((text) => !text.includes('lego')).length
  if (strays) add('high', 'search', `${strays} card(s) shown that do not match "lego"`)
  await page.fill(T('search'), '')
  await page.waitForTimeout(150)

  await page.keyboard.press('Tab')
  const noRing = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement)
    return s.outlineStyle === 'none' && s.boxShadow === 'none'
  })
  if (noRing) add('high', 'a11y', 'focused element has no visible focus indicator')

  const before = await page.evaluate(() => document.activeElement?.textContent?.slice(0, 20))
  await page.keyboard.press('ArrowDown')
  const after = await page.evaluate(() => document.activeElement?.textContent?.slice(0, 20))
  if (before === after) add('med', 'keyboard', 'ArrowDown does not move between agents')

  await page.click(T('agent-card'))
  await page.waitForSelector(T('agent-detail'))
  /*
   * A blocked agent used to be forced onto the terminal tab, and this checked
   * for it. It now opens on the conversation, because the Chat tab can answer
   * the question itself when the transcript names it (INV-16) — so what has to
   * be true is that the block is *explained* and *actionable*, not which tab is
   * showing. The terminal is still one click away, and is still the answer for
   * a prompt whose choices nothing wrote down.
   */
  if (!(await page.$(T('blocked-banner')))) add('high', 'taskC', 'no banner explaining the block')
  const answerable = (await page.$(T('answer-card'))) !== null
  const escapeHatch = (await page.$(T('unblock-button'))) !== null
  if (!answerable && !escapeHatch) add('high', 'taskC', 'no way to resolve the block')
  /*
   * A card with no option buttons is not a broken card.
   *
   * Only `AskUserQuestion` writes its choices down. `ExitPlanMode` and a tool
   * permission request write what is being asked and nothing about the
   * numbered list, so INV-16 has the card say so and offer the keys instead —
   * and the fleet now carries a fixture of each, so whichever sorts first is
   * whichever this opens. What has to be true either way is that the card
   * offers *something*: labelled options, or the stated absence plus the keys.
   */
  if (answerable) {
    const options = (await page.$$(T('answer-option'))).length
    const keysInstead =
      (await page.$(T('answer-no-options'))) !== null && (await page.$$('[data-testid^="answer-key-"]')).length > 0
    if (options === 0 && !keysInstead) add('med', 'taskC', 'answer card offers no way to answer')
  }
  if (!page.url().includes('/agent/')) add('high', 'routing', `opening an agent did not change the URL (${page.url()})`)
  await page.screenshot({ path: `${OUT}/02-blocked-${scheme}.png`, fullPage: true })

  await page.keyboard.press('Shift+Escape')
  await page.waitForTimeout(300)
  if (await page.$(T('agent-detail'))) add('high', 'keyboard', 'Shift+Escape does not close the agent')

  /*
   * Asked for, not counted. This used to take `cards[1]` on the reasoning that
   * the first card is blocked and opens on the terminal — but that quietly also
   * assumed every other card can hold a conversation, and the moment an agent
   * whose CLI keeps no transcript sorted into that slot the audit hung waiting
   * for a composer that was never going to render.
   */
  const chatCards = await page.$$(`${T('agent-card')}[data-transcripts="true"]:not([data-status="waiting"])`)
  if (chatCards.length === 0) throw new Error('no chat-capable agent in the fixture fleet')
  await chatCards[0].click()
  await page.waitForSelector(T('message'), { timeout: 5000 }).catch(() => add('high', 'chat', 'conversation never rendered'))
  const roles = await page.$$eval(T('message'), (els) => [...new Set(els.map((e) => e.dataset.role))])
  if (!roles.includes('you') || !roles.includes('agent')) {
    add('high', 'chat', `conversation does not distinguish speakers (${roles})`)
  }
  if (!(await page.$(`${T('tool-call')}, ${T('tools-toggle')}`))) {
    add('med', 'chat', 'tool calls are not folded into the agent message')
  }

  const mineBefore = (await page.$$(`${T('message')}[data-role="you"]`)).length
  await page.fill(T('composer-input'), 'ux probe message')
  await page.press(T('composer-input'), 'Enter')
  await page.waitForTimeout(300)
  const mineAfter = (await page.$$(`${T('message')}[data-role="you"]`)).length
  if (mineAfter <= mineBefore) add('high', 'chat', 'sent message does not appear immediately')
  if ((await page.inputValue(T('composer-input'))) !== '') add('med', 'chat', 'composer does not clear')

  await page.fill(T('composer-input'), 'line one')
  await page.press(T('composer-input'), 'Shift+Enter')
  await page.waitForTimeout(150)
  if (!(await page.inputValue(T('composer-input'))).includes('\n')) {
    add('med', 'chat', 'Shift+Enter does not insert a newline')
  }
  await page.fill(T('composer-input'), '')
  await page.screenshot({ path: `${OUT}/05-chat-${scheme}.png`, fullPage: true })

  await page.click(T('tab-attach'))
  await page.waitForSelector('.xterm-screen', { timeout: 5000 }).catch(() => add('high', 'attach', 'terminal did not render'))
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${OUT}/04-attach-${scheme}.png`, fullPage: true })

  await page.click(T('fullscreen-toggle'))
  await page.waitForTimeout(700)
  if (!(await page.$(T('fullscreen-view')))) add('high', 'fullscreen', 'expand did not open a full-page view')
  // Full screen must host either view, switchable without dropping out of it.
  await page.click(T('fullscreen-tab-chat'))
  await page.waitForTimeout(500)
  if (!(await page.$(T('fullscreen-view')))) add('high', 'fullscreen', 'switching to chat left full screen')
  if (!(await page.$(T('composer-input')))) add('high', 'fullscreen', 'chat did not render in full screen')
  await page.click(T('fullscreen-tab-attach'))
  await page.waitForTimeout(900)
  if (!(await page.$('.xterm-screen'))) add('high', 'fullscreen', 'terminal did not render after switching back')
  const full = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="fullscreen-view"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight }
  })
  if (full && (full.w < full.vw - 4 || full.h < full.vh - 4)) {
    add('med', 'fullscreen', `full screen does not fill the viewport (${full.w}x${full.h} of ${full.vw}x${full.vh})`)
  }
  await page.screenshot({ path: `${OUT}/06-fullscreen-${scheme}.png` })

  // Escape means two different things and the terminal is why. On the Attach
  // tab it belongs to the agent — it interrupts it, which is half the reason to
  // be in full screen at all — so it must NOT collapse the view. Shift+Escape
  // is the documented way out from there, and steps back one level rather than
  // leaving the agent entirely.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  if (!(await page.$(T('fullscreen-view')))) {
    add('high', 'fullscreen', 'Escape in the terminal left full screen instead of reaching the agent')
  }
  await page.keyboard.press('Shift+Escape')
  await page.waitForTimeout(400)
  if (await page.$(T('fullscreen-view'))) add('high', 'fullscreen', 'Shift+Escape does not leave full screen')
  if (!(await page.$(T('agent-detail')))) {
    add('high', 'fullscreen', 'Shift+Escape left the agent entirely instead of stepping back one level')
  }

  // On the chat tab there is no agent to interrupt, so plain Escape leaves.
  await page.click(T('fullscreen-toggle'))
  await page.waitForTimeout(500)
  await page.click(T('fullscreen-tab-chat'))
  await page.waitForTimeout(400)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  if (await page.$(T('fullscreen-view'))) add('high', 'fullscreen', 'Escape does not leave full screen from chat')

  await page.close()
}

// ---------- theme, language, help, new agent ----------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  page.on('pageerror', (e) => add('high', 'js', `pageerror: ${e.message}`))
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector(T('agent-card'))

  // Sorting reorders within groups without losing the blocked agent's place.
  await page.selectOption(T('sort-select'), 'tokens')
  await page.waitForTimeout(200)
  const firstStatus = await page.$eval(T('agent-card'), (e) => e.dataset.status)
  if (firstStatus !== 'waiting') add('high', 'sorting', 'sorting by tokens buried the blocked agent')
  const groupTitles = await page.$$eval(T('group-title'), (els) => els.map((e) => e.textContent))
  if (!groupTitles.includes('Needs you')) add('high', 'sorting', 'sorting dropped the groups')
  await page.selectOption(T('sort-select'), 'recent')

/*
 * Light and dark, compared with each other rather than with a remembered hex.
 *
 * This used to assert `bg === 'rgb(14, 17, 22)'`, which was true of the one
 * palette that existed when it was written. There are ten now, generated from
 * `scripts/gen-themes.py`, and the check failed the moment they were
 * regenerated — reporting "dark theme did not repaint the page" about a page
 * that had repainted perfectly well. An audit that has to be edited whenever a
 * colour changes is an audit that gets edited without being thought about.
 *
 * The property is what matters: choosing dark has to actually darken the page,
 * and choosing light has to lighten it. `audit-contrast.py` is what judges the
 * values themselves, across every palette.
 */
// sRGB luminance weights, from ITU-R BT.709 by way of WCAG 2.
const CHANNEL_MAX = 255
const RED_WEIGHT = 0.2126
const GREEN_WEIGHT = 0.7152
const BLUE_WEIGHT = 0.0722
// What counts as having actually repainted. A "dark" page above the first or a
// "light" one below the second is a theme that half applied — which comparing
// the two against each other alone would pass.
const DARK_ENOUGH = 0.35
const LIGHT_ENOUGH = 0.65

const luminance = (rgb) => {
  const [r, g, b] = (rgb.match(/\d+/g) ?? [0, 0, 0]).map(Number)
  return (RED_WEIGHT * r + GREEN_WEIGHT * g + BLUE_WEIGHT * b) / CHANNEL_MAX
}
const paint = async (which) => {
  await page.click(T('settings-button'))
  await page.click(T(`theme-${which}`))
  await page.waitForTimeout(250)
  return page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
  }))
}

const light = await paint('light')
if (light.attr !== 'light') add('high', 'theme', `light theme not applied (data-theme=${light.attr})`)
await page.screenshot({ path: `${OUT}/07-theme-light-forced.png` })

const themed = await paint('dark')
if (themed.attr !== 'dark') add('high', 'theme', `dark theme not applied (data-theme=${themed.attr})`)
if (luminance(themed.bg) >= luminance(light.bg)) {
  add('high', 'theme', `dark is not darker than light (${themed.bg} vs ${light.bg})`)
}
if (luminance(themed.bg) > DARK_ENOUGH) {
  add('high', 'theme', `dark theme did not repaint the page (bg=${themed.bg})`)
}
if (luminance(light.bg) < LIGHT_ENOUGH) {
  add('high', 'theme', `light theme did not repaint the page (bg=${light.bg})`)
}
await page.screenshot({ path: `${OUT}/07-theme-dark-forced.png` })

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  if ((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) !== 'dark') {
    add('med', 'theme', 'theme choice does not survive a reload')
  }

  await page.click(T('settings-button'))
  await page.click(T('lang-zh-CN'))
  await page.waitForTimeout(250)
  const zh = await page.$$eval(T('group-title'), (els) => els.map((e) => e.textContent))
  if (!zh.some((s) => /[一-龥]/.test(s ?? ''))) {
    add('high', 'i18n', `switching to Chinese did not translate the groups (${zh})`)
  }
  if ((await page.evaluate(() => document.documentElement.lang)) !== 'zh-CN') {
    add('med', 'i18n', 'html lang attribute not updated')
  }
  await page.screenshot({ path: `${OUT}/08-chinese.png`, fullPage: true })
  await page.click(T('settings-button'))
  await page.click(T('lang-en'))
  await page.waitForTimeout(250)

  await page.click(T('help-button'))
  await page.waitForSelector(T('help-page'))
  if (!page.url().endsWith('/help')) add('med', 'routing', 'help is not addressable at /help')
  const host = await page.textContent(T('tailscale-host')).catch(() => null)
  if (!host) add('high', 'help', 'help page does not show a detected Tailscale hostname')
  else if (!host.includes('.ts.net')) add('med', 'help', `tailscale host looks wrong: ${host}`)
  const helpText = await page.textContent(T('help-tailscale'))
  if (!/funnel/i.test(helpText)) add('med', 'help', 'help page omits the funnel warning')
  await page.screenshot({ path: `${OUT}/09-help.png`, fullPage: true })
  await page.click(T('help-close'))
  await page.waitForSelector(T('agent-card'))

  await page.click(T('new-agent-button'))
  await page.waitForSelector(T('new-agent-dialog'))
  await page.fill(T('new-agent-dir'), '/definitely/not/here')
  await page.click(T('new-agent-submit'))
  const err = await page.waitForSelector(T('new-agent-error'), { timeout: 4000 }).catch(() => null)
  if (!err) add('high', 'newAgent', 'a bad directory produced no error message')
  await page.screenshot({ path: `${OUT}/10-new-agent.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  if (await page.$(T('new-agent-dialog'))) add('med', 'newAgent', 'Escape does not close the dialog')

  await page.close()
}

// ---------- responsive ----------
for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } })
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector(T('agent-card'))

  const ov = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, i: innerWidth }))
  if (ov.s > ov.i + 1) add('high', 'responsive', `${vp.name}: horizontal overflow ${ov.s} > ${ov.i}`)

  /*
   * Asked for, not counted. This used to take `cards[1]` on the reasoning that
   * the first card is blocked and opens on the terminal — but that quietly also
   * assumed every other card can hold a conversation, and the moment an agent
   * whose CLI keeps no transcript sorted into that slot the audit hung waiting
   * for a composer that was never going to render.
   */
  const chatCards = await page.$$(`${T('agent-card')}[data-transcripts="true"]:not([data-status="waiting"])`)
  if (chatCards.length === 0) throw new Error('no chat-capable agent in the fixture fleet')
  await chatCards[0].click()
  await page.waitForSelector(T('agent-detail'))
  await page.waitForTimeout(400)

  const after = await page.evaluate(() => {
    const d = document.querySelector('[data-testid="agent-detail"]')
    const r = d?.getBoundingClientRect()
    return {
      s: document.documentElement.scrollWidth,
      i: innerWidth,
      visible: r ? r.top < innerHeight && r.bottom > 0 : false,
      top: r ? Math.round(r.top) : -1,
    }
  })
  if (after.s > after.i + 1) add('high', 'responsive', `${vp.name}: overflow after opening (${after.s} > ${after.i})`)
  if (vp.width < 900 && !after.visible) {
    add('high', 'responsive', `${vp.name}: detail offscreen at y=${after.top}`)
  }

  if (vp.width < 500) {
    const small = await page.$$eval(TOUCH_TARGETS, (els) =>
      els
        .filter((e) => e.offsetParent !== null)
        .map((e) => ({ t: (e.textContent || e.tagName).trim().slice(0, 14), h: Math.round(e.getBoundingClientRect().height) }))
        .filter((x) => x.h > 0 && x.h < 40),
    )
    if (small.length) add('med', 'touch', `${vp.name}: ${small.length} target(s) under 40px: ${small.map((s) => `${s.t}(${s.h})`).slice(0, 5)}`)
  }

  await page.screenshot({ path: `${OUT}/20-${vp.name}.png`, fullPage: true })
  await page.close()
}

await browser.close()

const order = { high: 0, med: 1, low: 2, info: 3 }
const seen = new Set()
const unique = findings.filter((f) => (seen.has(f.sev + f.area + f.msg) ? false : (seen.add(f.sev + f.area + f.msg), true)))
unique.sort((a, b) => order[a.sev] - order[b.sev])
console.log(`\n===== UX AUDIT: ${unique.length} findings =====\n`)
for (const f of unique) console.log(`[${f.sev.toUpperCase().padEnd(4)}] ${f.area.padEnd(11)} ${f.msg}`)

process.exit(unique.some((f) => f.sev !== 'info') ? 1 : 0)
