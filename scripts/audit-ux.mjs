import { chromium } from 'playwright'

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

  await page.fill(T('search'), 'lego')
  await page.waitForTimeout(150)
  const filtered = await page.$$eval(T('agent-name'), (els) => els.map((e) => e.textContent))
  if (filtered.length !== 1) add('high', 'search', `filtering by "lego" gave ${filtered.length}`)
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
  const tab = await page.getAttribute(T('tab-attach'), 'aria-selected')
  if (tab !== 'true') add('high', 'taskC', 'blocked agent does not open on the terminal tab')
  if (!(await page.$(T('blocked-banner')))) add('high', 'taskC', 'no banner explaining the block')
  if (!(await page.$(T('unblock-button')))) add('med', 'taskC', 'no action to resolve the block')
  if (!page.url().includes('/agent/')) add('high', 'routing', `opening an agent did not change the URL (${page.url()})`)
  await page.screenshot({ path: `${OUT}/02-blocked-${scheme}.png`, fullPage: true })

  await page.keyboard.press('Shift+Escape')
  await page.waitForTimeout(300)
  if (await page.$(T('agent-detail'))) add('high', 'keyboard', 'Shift+Escape does not close the agent')

  const cards = await page.$$(T('agent-card'))
  await cards[1].click()
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

  await page.click(T('settings-button'))
  await page.click(T('theme-dark'))
  await page.waitForTimeout(250)
  const themed = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
  }))
  if (themed.attr !== 'dark') add('high', 'theme', `dark theme not applied (data-theme=${themed.attr})`)
  if (themed.bg !== 'rgb(14, 17, 22)') add('high', 'theme', `dark theme did not repaint the page (bg=${themed.bg})`)
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

  const cards = await page.$$(T('agent-card'))
  await cards[1].click()
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
    const small = await page.$$eval('button, a, input', (els) =>
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
