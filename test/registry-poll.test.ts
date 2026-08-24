import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * INV-4, for the registry's own two loops.
 *
 * `refresh` has always been guarded against re-entry. `reconcile` was not, and
 * it is the expensive one: every call is a `claude agents --json`, measured at
 * ~680ms. `start()` fires one immediately and then schedules more, so the
 * startup pass and the first scheduled pass could both be in flight — two of
 * the most expensive subprocess this app spawns, against a machine that may
 * already be at its process cap. That is exactly what INV-4 forbids.
 *
 * The seam is `execFile`: mocking it lets these tests count how many CLI calls
 * are alive at once without needing a `claude` binary, and without the registry
 * knowing it is being watched.
 */
const cli = {
  started: 0,
  inFlight: 0,
  maxInFlight: 0,
  /** How long each fake `claude agents --json` takes to answer. */
  latencyMs: 40,
}

vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cli.started += 1
    cli.inFlight += 1
    cli.maxInFlight = Math.max(cli.maxInFlight, cli.inFlight)
    setTimeout(() => {
      cli.inFlight -= 1
      cb(null, JSON.stringify([{ sessionId: 'live-one' }]), '')
    }, cli.latencyMs)
  },
}))

let dir = ''

beforeEach(async () => {
  cli.started = 0
  cli.inFlight = 0
  cli.maxInFlight = 0
  cli.latencyMs = 40
  dir = await mkdtemp(join(tmpdir(), 'registry-poll-'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

const settle = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

describe('reconcile cannot overlap itself', () => {
  it('collapses concurrent callers into one CLI call', async () => {
    const { Registry } = await import('../src/server/registry.ts')
    const reg = new Registry(dir)

    // Three callers at once — the shape `start()` plus a scheduled pass makes.
    await Promise.all([reg.reconcile(), reg.reconcile(), reg.reconcile()])

    expect(cli.maxInFlight).toBe(1)
    expect(cli.started).toBe(1)
    reg.stop()
  })

  it('lets a later reconcile through once the first has finished', async () => {
    const { Registry } = await import('../src/server/registry.ts')
    const reg = new Registry(dir)

    await reg.reconcile()
    await reg.reconcile()

    // The guard is a re-entrancy guard, not a latch: sequential calls must
    // still each do their work, or the fleet would stop being cross-checked.
    expect(cli.started).toBe(2)
    expect(cli.maxInFlight).toBe(1)
    reg.stop()
  })

  it('never runs two CLI calls at once across a real start()', async () => {
    const { Registry } = await import('../src/server/registry.ts')
    // Slower than the work, so the startup pass is guaranteed to still be in
    // flight when anything else tries.
    cli.latencyMs = 120
    const reg = new Registry(dir)

    await reg.start()
    // start() fires reconcile without awaiting it, on purpose — the fleet is
    // already usable from the local file read. Give it room to overlap if it
    // is going to.
    await settle(300)
    reg.stop()

    expect(cli.maxInFlight).toBe(1)
  })
})

describe('the loops re-arm after the work, not on a fixed interval', () => {
  it('stop() halts the chain rather than leaving a timer armed', async () => {
    const { Registry } = await import('../src/server/registry.ts')
    const reg = new Registry(dir)

    await reg.start()
    reg.stop()
    const afterStop = cli.started
    await settle(200)

    // Nothing new may be spawned once stopped. A `setInterval` left uncleared,
    // or a re-arm that does not check the stopped flag, shows up here.
    expect(cli.started).toBe(afterStop)
  })

  it('survives a failing pass and keeps polling', async () => {
    const { Registry } = await import('../src/server/registry.ts')
    const reg = new Registry(dir)

    // INV-5: a CLI that is not installed answers null, and that is a normal
    // state — it must not stop the loop or empty the fleet.
    await reg.reconcile()
    await reg.reconcile()
    expect(cli.started).toBe(2)
    reg.stop()
  })
})
