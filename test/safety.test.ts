/** Tests for the guardrails: what may bind, and what may reach a live agent. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEV_PORT, defaultWebRoot, parseArgs, PROD_PORT } from '../src/server/cli.ts'
import { capture, key, meta, paste, PaneError } from '../src/server/pane.ts'
import { ALLOWED_KEYS, DESTRUCTIVE_KEYS } from '../src/shared/types.ts'

/**
 * npm installs `bin` as a symlink, so argv[1] is `<prefix>/bin/agent-commander`
 * while import.meta.url is the real dist/server/cli.js. 0.1.0 through 0.1.3
 * compared those as strings, decided it had been imported rather than run, and
 * shipped a binary that started a process which did nothing at all -- no
 * output, no port, no error. A unit test cannot see that, so this runs the
 * built CLI through a symlink the way npm would.
 */
describe('the installed binary actually runs', () => {
  it(
    'starts when invoked through a bin symlink',
    () => {
      /*
       * Compiled here rather than read out of dist/, which is gitignored and
       * tied to nothing. Skipping when dist/ is absent made this pass silently
       * everywhere it mattered -- CI tests before it builds -- and a dist/ left
       * over from before a regression would vouch for source that has the bug.
       */
      execFileSync('npm', ['run', 'build:server'], { stdio: 'pipe', timeout: 180_000 })
      const dir = mkdtempSync(join(tmpdir(), 'ac-bin-'))
      try {
        const link = join(dir, 'agent-commander')
        symlinkSync(resolve('dist/server/cli.js'), link)
        // Timed, because execFileSync blocks the worker: a CLI that stopped
        // exiting on --help would otherwise hang the suite rather than fail it.
        const out = execFileSync(process.execPath, [link, '--help'], {
          encoding: 'utf8',
          timeout: 20_000,
        })
        expect(out).toContain('Usage: agent-commander')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    240_000,
  )
})

describe('parseArgs', () => {
  it('defaults to loopback', () => {
    const opts = parseArgs([])
    expect(opts.host).toBe('127.0.0.1')
    expect(opts.token).toBeUndefined()
  })

  // INV-3: this app can approve permission prompts, so an open bind needs a secret.
  it('INV-3 refuses a non-loopback bind without a token', () => {
    expect(() => parseArgs(['--host', '0.0.0.0'])).toThrow(/refusing to bind/)
    expect(() => parseArgs(['--host', '192.168.1.5'])).toThrow(/refusing to bind/)
  })

  it('INV-3 allows a non-loopback bind once a token is supplied', () => {
    expect(parseArgs(['--host', '0.0.0.0', '--token', 's3cret']).token).toBe('s3cret')
  })

  it('INV-3 treats every loopback spelling as safe', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(() => parseArgs(['--host', host])).not.toThrow()
    }
  })

  /*
   * Fixtures at the production address are indistinguishable, to the person
   * looking at them, from their real fleet having disappeared -- and the
   * composer on that page would be typing into nothing.
   */
  it('refuses to serve mock fixtures on the production port', () => {
    expect(() => parseArgs(['--mock'])).toThrow(/production port/)
    expect(() => parseArgs(['--mock', '--port', String(PROD_PORT)])).toThrow(/production port/)
    expect(() => parseArgs(['--mock-transitions'])).toThrow(/production port/)
  })

  it('serves mock fixtures anywhere else, and real agents on the production port', () => {
    expect(parseArgs(['--mock', '--port', String(DEV_PORT)]).port).toBe(DEV_PORT)
    expect(parseArgs([]).port).toBe(PROD_PORT)
    expect(parseArgs([]).mock).toBe(false)
  })

  /** The npm scripts pass a dev port; an explicit one after it must still win. */
  it('lets a later --port override an earlier one', () => {
    expect(parseArgs(['--mock', '--port', String(DEV_PORT), '--port', '4501']).port).toBe(4501)
  })

  it('generates a token for --token auto', () => {
    const opts = parseArgs(['--host', '0.0.0.0', '--token', 'auto'])
    expect(opts.token).toMatch(/^[0-9a-f]{32}$/)
  })

  it('accepts --flag=value as well as --flag value', () => {
    expect(parseArgs(['--port=5000']).port).toBe(5000)
    expect(parseArgs(['--port', '5001']).port).toBe(5001)
  })

  it('rejects a nonsense port instead of binding one', () => {
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/invalid port/)
    expect(() => parseArgs(['--port', '99999'])).toThrow(/invalid port/)
  })

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/unknown flag/)
  })
})

describe('pane id validation', () => {
  const hostile = ['%77; rm -rf /', '$(whoami)', '../%1', '%', 'claude-1:@2.%77', '']

  // INV-2: pane ids reach argv, so anything not %N is refused before tmux runs.
  it.each(hostile)('INV-2 refuses pane id %j on every entry point', async (bad) => {
    await expect(meta(bad)).rejects.toBeInstanceOf(PaneError)
    await expect(capture(bad, 10)).rejects.toBeInstanceOf(PaneError)
    await expect(paste(bad, 'x', true)).rejects.toBeInstanceOf(PaneError)
    await expect(key(bad, 'Enter')).rejects.toBeInstanceOf(PaneError)
  })
})

describe('key allowlist', () => {
  it('INV-6 marks the work-destroying keys as needing confirmation', () => {
    for (const k of ['C-c', 'C-d', 'Escape']) expect(DESTRUCTIVE_KEYS.has(k)).toBe(true)
    expect(DESTRUCTIVE_KEYS.has('Enter')).toBe(false)
  })

  /*
   * The set is a shared constant, not a browser one. It was imported by
   * `Terminal.tsx` and nothing else, which is how INV-6 came to be enforced
   * only by the code most easily bypassed. `test/destructive-keys.test.ts`
   * covers the behaviour; this covers the wiring, because deleting the server's
   * use of it would leave that suite passing only if it also deleted the guard.
   */
  it('INV-6 is read by the server, not only by the browser', async () => {
    const routes = await readFile(resolve('src/server/routes.ts'), 'utf8')
    expect(routes).toMatch(/DESTRUCTIVE_KEYS/)
  })

  it('every destructive key is itself an allowed key', () => {
    for (const k of DESTRUCTIVE_KEYS) expect(ALLOWED_KEYS).toContain(k)
  })
})

describe('INV-1 source guarantee', () => {
  /** Source with comments stripped, so prose about attaching is not evidence. */
  async function codeOf(file: string): Promise<string> {
    const source = await readFile(resolve(file), 'utf8')
    return source.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '')
  }

  // The capture-based design exists so that watching an agent never resizes it.
  it('INV-1 never attaches or creates a session from the pane adapters', async () => {
    expect(await codeOf('src/server/pane.ts')).not.toMatch(/attach-session|new-session|attach\b/)
  })

  /*
   * The one amendment — and the property is not the flag.
   *
   * `ignore-size` was asserted here first and it was the wrong assertion. A
   * controlled matrix on a fresh tmux server: a regular client attaching at
   * 80x24 to a 200x50 window shrinks it to 80x21 with `-f ignore-size`, with
   * `-r`, with `-f read-only,ignore-size`, and with no flags. All four. The
   * flag governs how a client affects *other clients*, not whether the window
   * follows it.
   *
   * What holds is that a CONTROL-MODE client has no size to impose — tmux
   * reports its height as empty — and only acquires one by asking for it with
   * `refresh-client -C`. Never sending that is the guarantee, so that is what
   * is asserted. `ignore-size` stays as defence in depth, not as the promise.
   */
  it('INV-1 only ever attaches in control mode', async () => {
    const code = await codeOf('src/server/tmux-client.ts')
    for (const call of code.match(/spawn\([^)]*\)/gs) ?? []) {
      if (call.includes("'attach'")) expect(call).toContain("'-C'")
    }
  })

  it('INV-1 never asks tmux for a size', async () => {
    // `refresh-client -C <width>x<height>` is the one way a control client can
    // acquire a size, and therefore the one way this app could resize a pane.
    for (const file of ['src/server/tmux-client.ts', 'src/server/pane.ts']) {
      expect(await codeOf(file)).not.toMatch(/refresh-client[^\n]*-C\b/)
    }
  })

  it('INV-1 never creates a session from the control client either', async () => {
    expect(await codeOf('src/server/tmux-client.ts')).not.toMatch(/new-session/)
  })
})

/*
 * The lists that decide what may be typed into a live agent exist once.
 *
 * They existed three times each — `server/options.ts` validated, two
 * components offered, `web/lib/modes.ts` labelled — and drift between those
 * copies is asymmetric and silent in both directions: a model the server
 * accepts but no UI offers is invisible, and one the UI offers but the server
 * rejects is a click that becomes a toast. Behaviour cannot catch a re-added
 * copy, because a fresh copy starts out identical; only the source can.
 */
describe('the model and mode allow-lists have one home', () => {
  const OFFERS = [
    'src/web/components/AgentControls.tsx',
    'src/web/components/NewAgentDialog.tsx',
    'src/web/lib/modes.ts',
  ]

  it('INV-7 keeps the values in shared/types.ts', async () => {
    const shared = await readFile(resolve('src/shared/types.ts'), 'utf8')
    expect(shared).toMatch(/MODEL_ALIASES\s*=/)
    expect(shared).toMatch(/MODE_CYCLE\s*=/)
    expect(shared).toMatch(/SPAWN_MODES\s*=/)
  })

  it('INV-7 has the server validate against the shared list, not its own', async () => {
    const options = await readFile(resolve('src/server/options.ts'), 'utf8')
    expect(options).toMatch(/from '\.\.\/shared\/types\.ts'/)
    // A literal here would be a second list wearing the same name.
    expect(options).not.toMatch(/=\s*\[\s*'default'/)
  })

  it('INV-7 leaves the browser with no list of its own', async () => {
    for (const file of OFFERS) {
      const source = await readFile(resolve(file), 'utf8')
      expect(source, file).not.toMatch(/\[\s*'default',\s*'opus'/)
      expect(source, file).not.toMatch(/\[\s*'default',\s*'acceptEdits'/)
    }
  })
})

describe('defaultWebRoot', () => {
  it('points at dist/web when running compiled from dist/server', () => {
    expect(defaultWebRoot('/app/dist/server')).toBe('/app/dist/web')
  })

  // Running via tsx from source must not serve the unbuilt index.html.
  it('points at dist/web when running from source via tsx', () => {
    expect(defaultWebRoot('/app/src/server')).toBe('/app/dist/web')
  })
})
