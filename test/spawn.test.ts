/** INV-7: the one command shape, and the validation in front of it. */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkSpawnRequest,
  normalizeDir,
  sessionName,
  SpawnError,
  SpawnOptionError,
  validateDir,
} from '../src/server/spawn.ts'

const HOME = '/Users/tester'

describe('normalizeDir', () => {
  it('expands a leading ~', () => {
    expect(normalizeDir('~', HOME)).toBe(HOME)
    expect(normalizeDir('~/Projects/x', HOME)).toBe(`${HOME}/Projects/x`)
  })

  it('keeps an absolute path', () => {
    expect(normalizeDir('/opt/src', HOME)).toBe('/opt/src')
  })

  it('collapses traversal rather than passing it through', () => {
    expect(normalizeDir('/opt/src/../other', HOME)).toBe('/opt/other')
  })

  it('refuses a relative path, which would resolve against the server cwd', () => {
    expect(() => normalizeDir('Projects/x', HOME)).toThrow(SpawnError)
  })

  it('refuses an empty directory', () => {
    expect(() => normalizeDir('   ', HOME)).toThrow(/required/)
  })
})

describe('validateDir', () => {
  it('accepts a real directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-spawn-'))
    expect(await validateDir(dir)).toBe(dir)
  })

  it('refuses a path that does not exist', async () => {
    await expect(validateDir('/definitely/not/here')).rejects.toThrow(/no such directory/)
  })

  it('refuses a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-spawn-'))
    const file = join(dir, 'notes.txt')
    await writeFile(file, 'x')
    await expect(validateDir(file)).rejects.toThrow(/not a directory/)
  })
})

describe('sessionName', () => {
  // tmux reads ':' and '.' as target syntax, so a user-supplied name must never
  // reach it intact.
  it('strips everything tmux could read as target syntax', () => {
    expect(sessionName(1000, 'a:b.c')).toBe('claude-1000-abc')
    expect(sessionName(1000, '../../etc')).toBe('claude-1000-etc')
    expect(sessionName(1000, '$(whoami)')).toBe('claude-1000-whoami')
  })

  it('falls back to a bare timestamped name', () => {
    expect(sessionName(1000)).toBe('claude-1000')
    expect(sessionName(1000, '!!!')).toBe('claude-1000')
  })

  it('bounds the length', () => {
    expect(sessionName(1000, 'x'.repeat(80))).toBe(`claude-1000-${'x'.repeat(24)}`)
  })
})

describe('checkSpawnRequest', () => {
  /*
   * The dialog offers a model and a permission mode, and the server used to
   * forward neither -- you picked "plan" and "opus" and got a default agent
   * with no error. These are the checks that stand between that form and argv,
   * and mock mode runs them too so its failures are the real ones (INV-7).
   */
  it('accepts the aliases the dialog offers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-spawn-'))
    for (const model of ['opus', 'sonnet', 'haiku', 'fable', 'opusplan']) {
      expect(await checkSpawnRequest({ cwd: dir, model })).toBe(dir)
    }
    for (const permissionMode of ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto', 'dontAsk']) {
      expect(await checkSpawnRequest({ cwd: dir, permissionMode })).toBe(dir)
    }
  })

  it('refuses anything off the allow-list rather than making it a flag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-spawn-'))
    await expect(checkSpawnRequest({ cwd: dir, model: '--dangerously' })).rejects.toThrow(
      SpawnOptionError,
    )
    await expect(checkSpawnRequest({ cwd: dir, permissionMode: 'yolo' })).rejects.toThrow(
      SpawnOptionError,
    )
  })

  // The directory is the first thing checked, so a bad path is reported as a
  // bad path rather than as whatever the next check happens to dislike.
  it('reports a missing directory before it looks at the options', async () => {
    await expect(
      checkSpawnRequest({ cwd: '/definitely/not/here', model: 'nonsense' }),
    ).rejects.toThrow(/no such directory/)
  })
})
