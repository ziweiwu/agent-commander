/**
 * Randomised UI exploration.
 *
 * Clicks and types semi-randomly around the app looking for crashes, console
 * errors, stuck overlays and layout breakage. Deterministic for a given
 * `--seed`, so anything it finds can be handed back as a reproduction rather
 * than a story.
 *
 *   node scripts/qa-fuzz.mjs --seed 1 --steps 120 --profile phone
 *
 * Always point it at a --mock server. It types into whatever it finds, and in
 * mock mode nothing it does can reach a real agent.
 */
import { chromium, devices } from '/Users/ziweiwu/Projects/my-workout-tracker/node_modules/playwright/index.mjs'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i]?.replace(/^--/, ''), process.argv[i + 1])
}

const SEED = Number(args.get('seed') ?? 1)
const STEPS = Number(args.get('steps') ?? 120)
const PROFILE = args.get('profile') ?? 'desktop'
const BASE = args.get('base') ?? 'http://127.0.0.1:4500/'

const PROFILES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  laptop: { viewport: { width: 1180, height: 800 } },
  phone: { ...devices['iPhone 14 Pro Max'] },
  small: { ...devices['iPhone SE'] },
  landscape: { ...devices['iPhone 14 Pro Max landscape'] },
  tablet: { ...devices['iPad Pro 11'] },
}

/** Deterministic PRNG, so a seed reproduces a run exactly. */
function rng(seed) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) % 100000) / 100000
  }
}

const findings = []
const log = []
const add = (kind, detail, step) => findings.push({ kind, detail, step, seed: SEED, profile: PROFILE })

/** Things worth typing into a text field, including a few nasty ones. */
const TEXTS = [
  'hello',
  '',
  '   ',
  '/exit',
  '<script>alert(1)</script>',
  '~/Projects',
  '../../etc/passwd',
  'a'.repeat(300),
  '🛰 emoji ✓',
  "'; DROP TABLE agents;--",
]

const KEYS = ['Escape', 'Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'Shift+Escape', '/', 'j', 'k']

const browser = await chromium.launch()
const context = await browser.newContext(PROFILES[PROFILE] ?? PROFILES.desktop)
const page = await context.newPage()

page.on('pageerror', (e) => {
  const frames = (e.stack || '').split('\n').slice(1, 5).map((l) => l.trim()).join(' | ')
  add('pageerror', `${e.message}${frames ? ' :: ' + frames : ''}`, log.length)
})
page.on('console', (m) => {
  const text = m.text()
  // React logs key warnings etc. as errors; those are real defects too.
  if (m.type() === 'error' && !text.includes('Failed to load resource')) {
    add('console-error', text.slice(0, 300), log.length)
  }
})
page.on('crash', () => add('crash', 'page crashed', log.length))
// Dialogs would block the run; accept them and note it.
page.on('dialog', (d) => {
  log.push(`dialog:${d.type()}:${d.message().slice(0, 60)}`)
  d.accept().catch(() => {})
})

const random = rng(SEED)
const pick = (list) => list[Math.floor(random() * list.length)]

/**
 * Is this element actually the thing at its own centre point?
 *
 * A control behind an open modal is still "visible" to a selector, but clicking
 * it correctly times out — the backdrop is doing its job. Hit-testing first
 * keeps the fuzzer from reporting working modal semantics as a defect.
 */
const hittable = async (handle) =>
  handle
    .evaluate((el) => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return false
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false
      const top = document.elementFromPoint(x, y)
      return Boolean(top) && (el === top || el.contains(top) || top.contains(el))
    })
    .catch(() => false)

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('[data-testid="agent-card"]', { timeout: 15000 }).catch(() => {
  add('blank', 'no agent cards rendered on load', 0)
})

for (let step = 0; step < STEPS; step += 1) {
  const action = pick(['click', 'click', 'click', 'type', 'key', 'select', 'toggle', 'back'])

  try {
    if (action === 'click') {
      const targets = await page.$$(
        'button:visible:not([disabled]), a:visible, [role="tab"]:visible:not([disabled])',
      )
      if (targets.length === 0) {
        add('blank', 'no clickable control on the page', step)
        break
      }
      const target = pick(targets)
      if (await hittable(target)) {
        const label = (await target.textContent().catch(() => ''))?.trim().slice(0, 28) ?? ''
        const testid = await target.getAttribute('data-testid').catch(() => null)
        log.push(`click:${testid ?? label}`)
        await target.click({ timeout: 2000, force: false })
      }
    } else if (action === 'type') {
      // Checkboxes and radios are toggled, not filled — Playwright refuses to
      // fill them, and a user cannot type into one either.
      const fields = await page.$$(
        'input:visible:not([disabled]):not([type=checkbox]):not([type=radio]), textarea:visible:not([disabled])',
      )
      if (fields.length > 0) {
        const field = pick(fields)
        if (await hittable(field)) {
          const text = pick(TEXTS)
          log.push(`type:${text.slice(0, 20)}`)
          await field.fill(text, { timeout: 2000 })
        }
      }
    } else if (action === 'toggle') {
      const boxes = await page.$$('input[type=checkbox]:visible:not([disabled])')
      if (boxes.length > 0) {
        const box = pick(boxes)
        if (await hittable(box)) {
          log.push('toggle')
          await box.click({ timeout: 2000 })
        }
      }
    } else if (action === 'select') {
      const selects = await page.$$('select:visible:not([disabled])')
      if (selects.length > 0) {
        const select = pick(selects)
        if (!(await hittable(select))) continue
        const values = await select.$$eval('option', (opts) => opts.map((o) => o.value))
        if (values.length > 0) {
          const value = pick(values)
          log.push(`select:${value}`)
          await select.selectOption(value, { timeout: 2000 })
        }
      }
    } else if (action === 'key') {
      const key = pick(KEYS)
      log.push(`key:${key}`)
      await page.keyboard.press(key)
    } else if (action === 'back') {
      log.push('back')
      await page.goBack({ timeout: 2000 }).catch(() => {})
      // Going back past the first entry leaves the app entirely; that is the
      // harness wandering off, not a defect, so walk it back in.
      if (!page.url().startsWith(BASE.replace(/\/$/, ''))) {
        await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {})
      }
    }

    await page.waitForTimeout(35)

    // The app must never scroll sideways. Name the culprit: "something is wide"
    // is not a bug report anyone can act on.
    const overflow = await page.evaluate(() => {
      const s = document.documentElement.scrollWidth
      const i = window.innerWidth
      if (s <= i + 1) return { s, i, who: null }
      let worst = null
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        if (r.right > i + 1 && (!worst || r.right > worst.right)) {
          worst = {
            right: Math.round(r.right),
            width: Math.round(r.width),
            tag: el.tagName.toLowerCase(),
            id: el.getAttribute('data-testid') || String(el.className).slice(0, 40),
          }
        }
      }
      return { s, i, who: worst }
    })
    if (overflow.who) {
      add(
        'overflow',
        `horizontal overflow ${overflow.s} > ${overflow.i}; widest: ${overflow.who.tag} ${overflow.who.id} w=${overflow.who.width} right=${overflow.who.right}`,
        step,
      )
    }

    // Something must always be on screen.
    const empty = await page.evaluate(() => document.body.innerText.trim().length === 0)
    if (empty) {
      add('blank', `page rendered no text at ${page.url()}`, step)
      break
    }
  } catch (err) {
    const message = String(err?.message ?? err)
    // A control disappearing between query and click is the app re-rendering,
    // which is expected here; only report it if it took the page down.
    if (!/detached|not visible|Element is not attached|intercepts pointer/i.test(message)) {
      add('action-failed', `${action}: ${message.slice(0, 200)}`, step)
    }
  }
}

// An overlay that cannot be escaped is a trap, so check we can always get out.
try {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const stuck = await page.evaluate(() => {
    const modal = document.querySelector('[data-testid="new-agent-dialog"]')
    const full = document.querySelector('[data-testid="fullscreen-view"]')
    return { modal: Boolean(modal), full: Boolean(full) }
  })
  if (stuck.modal) add('stuck', 'new-agent dialog survived two Escapes', STEPS)
  if (stuck.full) add('stuck', 'full screen survived two Escapes', STEPS)
} catch {
  /* the checks below still report whatever was found */
}

await browser.close()

const unique = []
const seen = new Set()
for (const f of findings) {
  const key = `${f.kind}|${f.detail}`
  if (seen.has(key)) continue
  seen.add(key)
  unique.push(f)
}

console.log(
  JSON.stringify(
    {
      seed: SEED,
      profile: PROFILE,
      steps: STEPS,
      ok: unique.length === 0,
      findings: unique,
      // The last actions before the first finding are the reproduction.
      trail: log.slice(-40),
    },
    null,
    2,
  ),
)

process.exit(unique.length === 0 ? 0 : 1)
