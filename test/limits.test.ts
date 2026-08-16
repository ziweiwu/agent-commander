import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseLimits, RateLimitWatcher } from '../src/server/limits.ts'
import { persist, render, snapshot } from '../scripts/statusline-bridge.mjs'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ac-limits-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Poll rather than sleep a fixed span. The chain under test is fs.watch ->
 * 200ms debounce -> read, with a 2s stat poll underneath it, so the honest
 * upper bound is a shade over 2s; a hardcoded wait is how this test would start
 * failing on a busy box for reasons that have nothing to do with the code.
 */
async function waitFor(check: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('condition not met in time')
}

const payload = (rateLimits: unknown): string =>
  JSON.stringify({ session_id: 'abc', model: { id: 'claude-opus-5' }, rate_limits: rateLimits })

describe('statusline bridge', () => {
  it('normalises both windows, converting resets_at from seconds to ms', () => {
    const snap = snapshot(
      payload({
        five_hour: { used_percentage: 61.4, resets_at: 1_786_000_000 },
        seven_day: { used_percentage: 34, resets_at: 1_786_500_000 },
      }),
      1000,
    )
    expect(snap).toEqual({
      at: 1000,
      fiveHour: { pct: 61.4, resetsAt: 1_786_000_000_000 },
      sevenDay: { pct: 34, resetsAt: 1_786_500_000_000 },
    })
  })

  it('keeps a window that has no resets_at', () => {
    const snap = snapshot(payload({ five_hour: { used_percentage: 12 } }), 1000)
    expect(snap).toEqual({ at: 1000, fiveHour: { pct: 12 } })
  })

  /*
   * The load-bearing case. `rate_limits` is absent on every session's first
   * render and absent entirely for non-subscribers, so a bridge that wrote an
   * empty document would blank a good reading several times a minute.
   */
  it('yields nothing when rate_limits is absent, leaving a good reading intact', () => {
    const file = join(dir, 'rate-limits.json')
    persist({ at: 1, fiveHour: { pct: 61 } }, dir, file)

    expect(snapshot(payload(undefined), 2000)).toBeNull()
    expect(snapshot(JSON.stringify({ model: { id: 'x' } }), 2000)).toBeNull()
    expect(snapshot(payload({ five_hour: {} }), 2000)).toBeNull()

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ at: 1, fiveHour: { pct: 61 } })
  })

  it('never throws on malformed stdin', () => {
    expect(() => snapshot('not json at all', 1000)).toThrow()
    // ...which is why the caller wraps it; the shipped entrypoint catches.
    const source = readFileSync(new URL('../scripts/statusline-bridge.mjs', import.meta.url), 'utf8')
    expect(source).toContain('main().catch(() => {})')
  })

  it('drops a non-finite percentage and clamps an out-of-range one', () => {
    // Infinity, spelt the way it actually arrives: JSON has no NaN or Infinity
    // literal, but an overflowing exponent parses to one.
    expect(snapshot('{"rate_limits":{"five_hour":{"used_percentage":1e999}}}', 1)).toBeNull()
    expect(snapshot(payload({ five_hour: { used_percentage: 140 } }), 1)).toEqual({
      at: 1,
      fiveHour: { pct: 100 },
    })
  })

  it('renders only the windows it has', () => {
    expect(render(snapshot(payload({ five_hour: { used_percentage: 61.4 } }), 0))).toBe('⮕ 5h 61%')
    expect(
      render(snapshot(payload({ five_hour: { used_percentage: 61 }, seven_day: { used_percentage: 34 } }), 0)),
    ).toBe('⮕ 5h 61%  ·  7d 34%')
  })

  /** The bridge and the watcher must agree on the file, forever. */
  it('writes the path the watcher reads', async () => {
    const bridge = await import('../scripts/statusline-bridge.mjs')
    const { LIMITS_FILE } = await import('../src/server/limits.ts')
    expect(bridge.CACHE_FILE).toBe(LIMITS_FILE)
  })
})

describe('parseLimits', () => {
  it('accepts a document with one window', () => {
    expect(parseLimits('{"at":5,"fiveHour":{"pct":10}}')).toEqual({ at: 5, fiveHour: { pct: 10 } })
  })

  /*
   * JSON has no NaN literal, but `1e999` parses to Infinity and is a number by
   * every check short of Number.isFinite — and lands in a CSS width.
   */
  it('rejects a non-finite percentage and clamps an out-of-range one', () => {
    expect(parseLimits('{"at":5,"fiveHour":{"pct":1e999}}')).toBeNull()
    expect(parseLimits('{"at":1e999,"fiveHour":{"pct":10}}')).toBeNull()
    expect(parseLimits('{"at":5,"fiveHour":{"pct":103}}')).toEqual({ at: 5, fiveHour: { pct: 100 } })
    expect(parseLimits('{"at":5,"fiveHour":{"pct":-4}}')).toEqual({ at: 5, fiveHour: { pct: 0 } })
    expect(parseLimits('{"at":5,"fiveHour":{"pct":10,"resetsAt":1e999}}')).toEqual({
      at: 5,
      fiveHour: { pct: 10 },
    })
  })

  it('rejects junk rather than throwing', () => {
    // A truncated read is the failure the atomic rename exists to prevent; if
    // it ever happens anyway it must degrade, not crash the server.
    expect(parseLimits('{"at":5,"fiveHo')).toBeNull()
    expect(parseLimits('null')).toBeNull()
    expect(parseLimits('{"fiveHour":{"pct":10}}')).toBeNull()
    expect(parseLimits('{"at":5}')).toBeNull()
  })
})

describe('RateLimitWatcher', () => {
  it('reads the file on start and reports it', () => {
    const file = join(dir, 'rate-limits.json')
    writeFileSync(file, JSON.stringify({ at: 7, sevenDay: { pct: 42 } }))
    const w = new RateLimitWatcher(file)
    w.start()
    expect(w.current()).toEqual({ at: 7, sevenDay: { pct: 42 } })
    w.stop()
  })

  it('starts empty and does not throw when the file is missing', () => {
    const w = new RateLimitWatcher(join(dir, 'nope', 'rate-limits.json'))
    expect(() => w.start()).not.toThrow()
    expect(w.current()).toBeNull()
    w.stop()
  })

  it('notifies on a rename-swapped write, and only when the value moves', async () => {
    const file = join(dir, 'rate-limits.json')
    persist({ at: 1, fiveHour: { pct: 10 } }, dir, file)
    const w = new RateLimitWatcher(file)
    w.start()

    const seen: unknown[] = []
    w.onChange((l) => seen.push(l))

    persist({ at: 2, fiveHour: { pct: 20 } }, dir, file)
    await waitFor(() => seen.length > 0)
    expect(seen).toEqual([{ at: 2, fiveHour: { pct: 20 } }])

    // Same content again: no second notification.
    persist({ at: 2, fiveHour: { pct: 20 } }, dir, file)
    await new Promise((r) => setTimeout(r, 800))
    expect(seen).toHaveLength(1)
    w.stop()
  })

  /*
   * The poll is the correctness guarantee, not a nicety. macOS fs.watch
   * silently drops writes that land within a few ms of the watch being
   * registered — measured at roughly one run in three, which is exactly the
   * shape of "server starts, a live session writes immediately". This asserts
   * the reading still arrives on a watcher polling fast enough that the test
   * cannot be passed by the fs.watch path alone being lucky.
   */
  it('picks up a write the directory watch never reported', async () => {
    const file = join(dir, 'rate-limits.json')
    persist({ at: 1, fiveHour: { pct: 10 } }, dir, file)
    const w = new RateLimitWatcher(file, 50)
    w.start()
    const seen: unknown[] = []
    w.onChange((l) => seen.push(l))

    persist({ at: 9, fiveHour: { pct: 90 } }, dir, file)
    await waitFor(() => seen.length > 0)
    expect(w.current()).toEqual({ at: 9, fiveHour: { pct: 90 } })
    w.stop()
  })

  /*
   * A transient ENOENT during the bridge's rename must not blank the meters —
   * that would make them flicker out several times a second while agents work.
   */
  it('keeps the last good reading when the file disappears', async () => {
    const file = join(dir, 'rate-limits.json')
    persist({ at: 1, fiveHour: { pct: 10 } }, dir, file)
    const w = new RateLimitWatcher(file)
    w.start()
    rmSync(file)
    await new Promise((r) => setTimeout(r, 500))
    expect(w.current()).toEqual({ at: 1, fiveHour: { pct: 10 } })
    w.stop()
  })
})

/**
 * The bridge only does anything if it recognises that it was the program.
 *
 * `import.meta.url === `file://${process.argv[1]}`` is the same comparison that
 * shipped a do-nothing binary in 0.1.0 through 0.1.3: a file URL is
 * percent-encoded, so a checkout under `~/My Projects` never matched its own
 * argv and the quota meters simply never appeared. Run for real from a path
 * with a space in it, because that is the only way to see it.
 */
describe('the bridge runs when it is the program', () => {
  const homes: string[] = []

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  /** Runs a copy of the bridge in `dir`, with HOME pointed somewhere disposable. */
  async function runBridge(dir: string): Promise<string | null> {
    const home = await mkdtemp(join(tmpdir(), 'ac-home-'))
    homes.push(home)
    await mkdir(dir, { recursive: true })
    const script = join(dir, 'statusline-bridge.mjs')
    await copyFile(new URL('../scripts/statusline-bridge.mjs', import.meta.url), script)

    const payload = JSON.stringify({
      rate_limits: { five_hour: { used_percentage: 42 }, seven_day: { used_percentage: 7 } },
    })
    execFileSync(process.execPath, [script], {
      input: payload,
      env: { ...process.env, HOME: home },
      timeout: 20_000,
      encoding: 'utf8',
    })

    try {
      return await readFile(join(home, '.claude', 'agent-commander', 'rate-limits.json'), 'utf8')
    } catch {
      return null
    }
  }

  it('writes the cache when its path contains a space', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ac-bridge-'))
    homes.push(base)
    const written = await runBridge(join(base, 'My Projects', 'agent commander'))
    expect(written).not.toBeNull()
    expect(JSON.parse(written as string)).toMatchObject({ fiveHour: { pct: 42 } })
  })

  it('writes the cache from an ordinary path too', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ac-bridge-'))
    homes.push(base)
    const written = await runBridge(join(base, 'plain'))
    expect(JSON.parse(written as string)).toMatchObject({ sevenDay: { pct: 7 } })
  })

  // Importing it must still be silent, which is what the unit tests above rely on.
  it('does nothing when it is merely imported', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ac-home-'))
    homes.push(home)
    const url = new URL('../scripts/statusline-bridge.mjs', import.meta.url).href
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], {
      env: { ...process.env, HOME: home },
      timeout: 20_000,
    })
    await expect(
      readFile(join(home, '.claude', 'agent-commander', 'rate-limits.json'), 'utf8'),
    ).rejects.toThrow()
  })
})
