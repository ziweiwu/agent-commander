/**
 * The macOS launcher bundle.
 *
 * Three cases, chosen because each covers something nothing else here can see.
 * `oxlint` is JS/TS only and `tsc` never looks at a shell script or a plist, so
 * without this file the launcher and the bundle layout ship unchecked.
 *
 * What is deliberately *not* here: `plutil -lint` on the plist, and running the
 * bundled CLI. Both need macOS, and the second needs a built bundle, so as
 * cases they would skip on Linux CI — which is the failure mode the comment in
 * `safety.test.ts` already records, a test that passes silently everywhere it
 * mattered. Both live in `scripts/build-mac-app.py` instead, where they run on
 * exactly the machine that cares, at exactly the moment a bad bundle would
 * otherwise be promoted.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultWebRoot } from '../src/server/cli.ts'

const LAUNCHER = 'scripts/mac-app/launcher.sh'

/** The layout the build script says it will write, without it writing anything. */
const plan = (): { paths: string[]; typeField: string; executable: string } =>
  JSON.parse(
    execFileSync('python3', ['scripts/build-mac-app.py', '--print-layout'], {
      encoding: 'utf8',
      timeout: 30_000,
    }),
  )

describe('the launcher script', () => {
  /*
   * The whole point of this one. A syntax error here is invisible until a Dock
   * icon bounces once and stops — no dialog, no log anyone would think to look
   * for — and there is no other gate in this repo that reads the file at all.
   */
  it('parses', () => {
    const source = readFileSync(LAUNCHER, 'utf8')
    // From the shebang, not hardcoded: macOS /bin/sh is bash in POSIX mode and
    // is lenient about bashisms under -n, so checking a bash script with `sh -n`
    // would prove less than it appears to.
    const shell = source.split('\n')[0]?.endsWith('bash') === true ? 'bash' : 'sh'
    expect(() => execFileSync(shell, ['-n', LAUNCHER], { stdio: 'pipe' })).not.toThrow()
  })

  /*
   * The script rewrites PATH before it uses it, so anything it calls by bare
   * name could be resolved out of whatever it just wrote. `tmux`, `claude` and
   * `node` are looked up that way on purpose — that is what the repair is for —
   * and every other tool must be absolute.
   */
  it('calls system tools by absolute path', () => {
    const code = readFileSync(LAUNCHER, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    /*
     * Only in command position — after a line start, a pipe, a semicolon or a
     * `$(`. The dialog strings are full of English that uses these words
     * ("then open Agent Commander again"), and matching those would make the
     * test a nuisance rather than a guard.
     */
    const bare =
      /(?:^|[;&|(]|\$\()[ \t]*(sed|head|tail|cut|sort|cat|stat|mktemp|curl|date|osascript|open|dirname|dscl)[ \t]/gm
    expect([...code.matchAll(bare)].map((match) => match[1])).toEqual([])
  })
  /*
   * The launcher stops a server only after `ours_to_replace` has confirmed the
   * pid file names a live process whose command line is inside this bundle.
   * Without that, a reinstall would kill whatever happened to be on 4317 —
   * a copy someone started from a clone, mid-work. The guard is one function,
   * so what is checked here is that it stays the only route to a signal.
   */
  it('signals a process only through the ownership guard', () => {
    const code = readFileSync(LAUNCHER, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))

    /*
     * Only signals aimed at the *server*. The launcher also SIGTERMs the
     * subshell it spawns to harvest a PATH, which is its own child and needs no
     * guard — so this is deliberately keyed to the pid read from the pid file.
     */
    const terminates = code.filter((line) => /kill -TERM "\$pid"/.test(line))
    expect(terminates).toHaveLength(1)

    // And the one caller of the function holding it checks ownership first.
    const calls = code.filter(
      (line) => /\bstop_ours\b/.test(line) && !line.trim().startsWith('stop_ours()'),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/stop_ours/)
    expect(code.some((line) => /stale_running && ours_to_replace/.test(line))).toBe(true)

    // Nothing may escalate. The server cleans up a tmux control client and a
    // temp directory on SIGTERM, and both leak under a KILL.
    expect(code.some((line) => /kill -(9|KILL)/.test(line))).toBe(false)
  })
})

describe('the bundle layout', () => {
  const APP_ROOT = '/X/Agent Commander.app'

  /*
   * Checked against the function the server actually calls, not against a copy
   * of its rule — a copy would keep agreeing with itself after cli.ts changed.
   */
  it('puts dist/web where defaultWebRoot looks for it', () => {
    const server = join(APP_ROOT, 'Contents/Resources/app/dist/server')
    expect(defaultWebRoot(server)).toBe(join(APP_ROOT, 'Contents/Resources/app/dist/web'))
    expect(plan().paths).toContain('Contents/Resources/app/dist/web')
  })

  // cli.ts resolves '../../scripts/statusline-bridge.mjs' from dist/server, so
  // the file has to sit one directory deeper than feels natural.
  it('puts the statusline bridge two levels above dist/server', () => {
    expect(plan().paths).toContain('Contents/Resources/app/scripts/statusline-bridge.mjs')
  })

  // Nine files in dist/server import '../shared/*.js' at runtime. Copying only
  // server and web gives a bundle that dies with ERR_MODULE_NOT_FOUND.
  it('ships dist/shared beside dist/server', () => {
    expect(plan().paths).toContain('Contents/Resources/app/dist/shared')
  })

  /*
   * The one that fails silently and completely. From inside the bundle Node
   * finds no package.json anywhere up to /, so it reads the ESM output as
   * CommonJS and dies on the first `import` before printing a character — the
   * do-nothing binary of 0.1.0, wearing a Dock icon.
   */
  it('declares the package root as ESM', () => {
    const layout = plan()
    expect(layout.paths).toContain('Contents/Resources/app/package.json')
    expect(layout.typeField).toBe('module')
  })

  it('names the executable the plist points at', () => {
    const plist = readFileSync('scripts/mac-app/Info.plist', 'utf8')
    const named = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
    expect(plan().executable).toBe(`Contents/MacOS/${named ?? ''}`)
  })
})

/*
 * The icon generator grew a macOS path — an inset superellipse, supersampled —
 * and the committed PWA icons are drawn by the same code. Every added parameter
 * defaults to the web behaviour, so they should be untouched; this is what
 * holds that to more than an intention. Same reasoning as `scheme.test.ts`,
 * which re-runs gen-themes.py against the committed tokens.css.
 */
describe('the committed web icons', () => {
  it.each([192, 512])('icon-%i.png is still what gen-icons.py draws', (side) => {
    const drawn = execFileSync('python3', ['scripts/gen-icons.py', '--stdout', String(side)], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    expect(drawn.equals(readFileSync(`src/web/public/assets/icon-${side}.png`))).toBe(true)
  })
})
