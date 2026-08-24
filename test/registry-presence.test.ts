/**
 * How long a brand-new agent stays invisible.
 *
 * Two sources decide what the fleet contains: the session files, read every two
 * seconds and immediately on an `fs.watch` event, and `claude agents --json`,
 * which is authoritative for *presence* and costs ~680ms so it only runs every
 * thirty. A session id the CLI has not confirmed was simply skipped — which is
 * right for a ghost left behind by a reused pid, and wrong for the much more
 * common case of an agent someone just started in a terminal. That agent was
 * invisible for up to half a minute in an app whose entire claim is that you can
 * see every agent on the machine at a glance.
 *
 * So an unrecognised id asks the authority now. The thing that has to be true
 * for that to be safe is that it asks *once* — a ghost that is never confirmed
 * must not turn the 30s reconcile into a 2s one.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cli = {
  started: 0,
  /** Session ids the fake CLI will admit to knowing about. */
  known: ['live-one'] as string[],
}

vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cli.started += 1
    const rows = cli.known.map((sessionId) => ({ sessionId }))
    setTimeout(() => cb(null, JSON.stringify(rows), ''), 5)
  },
}))

let dir = ''

beforeEach(async () => {
  cli.started = 0
  cli.known = ['live-one']
  dir = await mkdtemp(join(tmpdir(), 'registry-presence-'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

const settle = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/** A session file for a process that really is alive, so `isAlive` passes. */
async function writeSession(sessionId: string): Promise<void> {
  await writeFile(
    join(dir, `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      pid: process.pid,
      cwd: '/tmp',
      name: sessionId,
      status: 'idle',
      tmux: 'claude-1:@1.%1',
    }),
  )
}

describe('INV-4 an unconfirmed session is asked about, once', () => {
  it('does not wait for the slow reconcile to show an agent that just started', async () => {
    const { Registry } = await import('../src/server/registry.ts')
    const reg = new Registry(dir)

    await writeSession('live-one')
    await reg.reconcile()
    expect(reg.list().map((a) => a.sessionId)).toEqual(['live-one'])
    const askedSoFar = cli.started

    // A second agent appears on disk. The CLI has not been asked about it yet,
    // so on the old behaviour this refresh dropped it silently.
    cli.known = ['live-one', 'live-two']
    await writeSession('live-two')
    await reg.refresh()

    // The refresh itself publishes what it already knows and fires the question
    // without waiting for it, so give the answer a moment to land.
    await settle(60)

    expect(cli.started).toBe(askedSoFar + 1)
    expect(reg.list().map((a) => a.sessionId).sort()).toEqual(['live-one', 'live-two'])
    reg.stop()
  })

  it('asks once for a ghost, not once per scan', async () => {
    const { Registry } = await import('../src/server/registry.ts')
    const reg = new Registry(dir)

    await writeSession('live-one')
    await reg.reconcile()
    const askedSoFar = cli.started

    // A session file whose process is alive but which the CLI will never
    // confirm: a reused pid, which is the case the presence check exists for.
    await writeSession('ghost')
    for (let i = 0; i < 5; i += 1) {
      await reg.refresh()
      await settle(20)
    }

    // Exactly one extra question for the whole run, and the ghost stays out.
    expect(cli.started).toBe(askedSoFar + 1)
    expect(reg.list().map((a) => a.sessionId)).toEqual(['live-one'])
    reg.stop()
  })

  it('asks again if the same id comes back after its file went away', async () => {
    const { Registry } = await import('../src/server/registry.ts')
    const reg = new Registry(dir)

    await writeSession('live-one')
    await reg.reconcile()
    const askedSoFar = cli.started

    await writeSession('ghost')
    await reg.refresh()
    await settle(20)
    expect(cli.started).toBe(askedSoFar + 1)

    // Gone, then back — a pid genuinely reused later deserves a fresh question
    // rather than being remembered as a ghost for the life of the process.
    await rm(join(dir, 'ghost.json'))
    await reg.refresh()
    await writeSession('ghost')
    await reg.refresh()
    await settle(20)

    expect(cli.started).toBe(askedSoFar + 2)
    reg.stop()
  })

  it('does not ask before the CLI has ever answered', async () => {
    const { Registry } = await import('../src/server/registry.ts')
    const reg = new Registry(dir)

    // With no presence answer yet there is nothing to be unrecognised against,
    // and everything on disk is shown. A refresh here must not spawn anything.
    await writeSession('live-one')
    await reg.refresh()
    await settle(20)

    expect(cli.started).toBe(0)
    expect(reg.list().map((a) => a.sessionId)).toEqual(['live-one'])
    reg.stop()
  })
})
