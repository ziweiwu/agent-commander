/** Tests for the guardrails: what may bind, and what may reach a live agent. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultWebRoot, parseArgs } from '../src/server/cli.ts'
import { capture, key, meta, paste, PaneError } from '../src/server/pane.ts'
import { ALLOWED_KEYS, DESTRUCTIVE_KEYS } from '../src/shared/types.ts'

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

  it('every destructive key is itself an allowed key', () => {
    for (const k of DESTRUCTIVE_KEYS) expect(ALLOWED_KEYS).toContain(k)
  })
})

describe('INV-1 source guarantee', () => {
  // The whole capture-based design exists so no tmux client is ever created.
  it('INV-1 never references attach-session or new-session', async () => {
    const source = await readFile(resolve('src/server/pane.ts'), 'utf8')
    const code = source.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/attach-session|new-session|attach\b/)
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
