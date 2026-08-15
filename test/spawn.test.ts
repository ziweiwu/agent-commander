/** INV-7: the one command shape, and the validation in front of it. */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeDir, sessionName, SpawnError, validateDir } from '../src/server/spawn.ts'

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
