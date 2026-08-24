/**
 * INV-2 across the two ways this app can reach tmux.
 *
 * Pane commands go through a long-lived control client when one is up and
 * through a freshly spawned tmux when it is not. Having two paths creates a
 * hazard that neither has on its own: a write that fails *after* it reached
 * tmux has an unknown outcome — a `load-buffer ; paste-buffer ; send-keys`
 * sequence that errors at the last step has already put the text in the pane —
 * and quietly trying the other path would type the user's instruction into a
 * live agent a second time.
 *
 * INV-2's answer is that re-sending is the user's decision, not the app's. So
 * writes pick their path before anything is sent and never change their mind;
 * reads, which change nothing, are free to retry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawned: string[][] = []
let spawnFails = false

vi.mock('node:child_process', () => ({
  execFile: (
    _bin: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    spawned.push(args)
    setTimeout(
      () => (spawnFails ? cb(new Error('spawned tmux failed'), '', 'nope') : cb(null, '80|24|0|0|0|0\n', '')),
      0,
    )
    return { stdin: { end: () => {} }, on: () => {} }
  },
}))

const control = {
  ready: false,
  commands: [] as string[][],
  fail: null as Error | null,
  reply: '80|24|0|0|0|0',
  run(commands: string[]) {
    control.commands.push(commands)
    return control.fail ? Promise.reject(control.fail) : Promise.resolve(control.reply)
  },
}

vi.mock('../src/server/tmux-client.ts', () => ({
  tmuxControl: control,
  TmuxControlError: class extends Error {},
}))

const { paste, key, sample, cleanup } = await import('../src/server/pane.ts')

/** Commands issued down either path, flattened, in order. */
function issued(): string[] {
  const fromSpawn = spawned.map((args) => args[0] as string)
  const fromControl = control.commands.flat().map((c) => c.split(' ')[0] as string)
  return [...fromControl, ...fromSpawn]
}

beforeEach(async () => {
  spawned.length = 0
  control.commands.length = 0
  control.fail = null
  control.ready = false
  spawnFails = false
  await cleanup()
})

describe('a write that fails after reaching tmux', () => {
  it('is not retried down the other path', async () => {
    control.ready = true
    control.fail = new Error("can't find pane: %76")

    await expect(paste('%76', 'deploy to production', true)).rejects.toThrow(/can't find pane/)

    // The one thing that must not appear here is a second delivery of the same
    // text. A `paste-buffer` reached tmux; whether it landed is unknowable
    // from here, and guessing wrong types into a live agent twice.
    expect(spawned.filter((args) => args.includes('paste-buffer'))).toEqual([])
  })

  it('still tidies up the buffer it may have left behind', async () => {
    control.ready = true
    control.fail = new Error('no such pane')
    await expect(paste('%76', 'text', false)).rejects.toThrow()
    // Deleting a buffer cannot deliver anything to an agent, so unlike the
    // paste it is safe to issue without knowing what happened.
    expect(control.commands.flat().some((c) => c.startsWith('delete-buffer'))).toBe(true)
  })

  it('does not retry a key either', async () => {
    control.ready = true
    control.fail = new Error('gone')
    await expect(key('%76', 'Enter')).rejects.toThrow(/gone/)
    expect(spawned).toEqual([])
  })
})

describe('a write with no client up', () => {
  it('goes down the spawn path without involving the control client', async () => {
    control.ready = false
    await paste('%76', 'hello', true)
    expect(control.commands).toEqual([])
    expect(issued()).toContain('load-buffer')
  })
})

describe('a read that fails', () => {
  it('is retried down the other path, because reading twice changes nothing', async () => {
    control.ready = true
    control.fail = new Error('control client exited')

    // The user is waiting on this frame. Reading the pane again costs a round
    // trip and nothing else, so the fallback is free here in a way it is not
    // for a write.
    const out = await sample('%76')
    expect(out.meta.cols).toBe(80)
    expect(spawned.length).toBeGreaterThan(0)
  })

  it('reports a failure when neither path works', async () => {
    control.ready = true
    control.fail = new Error('control client exited')
    spawnFails = true
    await expect(sample('%76')).rejects.toThrow(/nope/)
  })
})

describe('the control path stages text in a file', () => {
  it("never spells the user's text on a tmux command line", async () => {
    control.ready = true
    await paste('%76', "rm -rf ' ; kill-server ; #{q:x}", true)

    const line = control.commands.flat().join(' ')
    // The text travels through a 0600 file precisely so tmux's own argument
    // lexer never sees it — there is no quoting rule left to get wrong.
    expect(line).not.toContain('kill-server')
    expect(line).not.toContain('rm -rf')
    expect(line).toMatch(/load-buffer -b agent-commander-\d+-\d+ '[^']*'/)
  })

  it('sends the load, the paste and the submit as one sequence', async () => {
    control.ready = true
    await paste('%76', 'go', true)
    expect(control.commands).toHaveLength(1)
    expect(control.commands[0]?.map((c) => c.split(' ')[0])).toEqual([
      'load-buffer',
      'paste-buffer',
      'send-keys',
    ])
  })
})

describe('staging leftovers', () => {
  /*
   * `cleanup` runs on SIGINT and SIGTERM, which covers quitting. It does not
   * cover SIGKILL, a crash, or a reboot -- and the staging directory is made
   * once per run, so without a sweep they pile up in the temp root. Each paste
   * already unlinks its own file, so the usual leftover is an empty directory;
   * a run killed mid-paste can leave one 0600 file, which is the better reason
   * to clear them.
   */
  it('removes directories from runs that are gone, and spares live ones', async () => {
    const { mkdtemp, mkdir, readdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { sweepStaleStaging } = await import('../src/server/pane.ts')

    const root = await mkdtemp(join(tmpdir(), 'sweep-test-'))
    const dead = join(root, 'agent-commander-paste-999999-aaaaaa')
    const mine = join(root, `agent-commander-paste-${process.pid}-bbbbbb`)
    const alien = join(root, 'something-else-entirely')
    for (const dir of [dead, mine, alien]) await mkdir(dir)
    // A run killed mid-paste leaves the user's text behind; that is exactly
    // what should not survive.
    await writeFile(join(dead, 'buf'), 'a prompt nobody should find later')

    await sweepStaleStaging(root)

    const left = (await readdir(root)).sort()
    expect(left).toEqual(['agent-commander-paste-' + process.pid + '-bbbbbb', 'something-else-entirely'].sort())
  })

  it('says nothing and does nothing when the temp root cannot be read', async () => {
    const { sweepStaleStaging } = await import('../src/server/pane.ts')
    await expect(sweepStaleStaging('/definitely/not/a/directory')).resolves.toBe(0)
  })
})
