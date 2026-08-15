/** INV-9: the folder browser cannot leave its root. */
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'
import { BrowseError, isInside, labelFor, listDirs, resolveInsideRoot } from '../src/server/browse.ts'

let root = ''

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ac-browse-')))
  await mkdir(join(root, 'Projects', 'app'), { recursive: true })
  await mkdir(join(root, '.hidden'))
  await writeFile(join(root, 'notes.txt'), 'x')
  // A symlink pointing outside the root: the case a prefix check would miss.
  await symlink('/', join(root, 'escape-hatch'))
})

describe('isInside', () => {
  it('accepts the root and its descendants', () => {
    expect(isInside('/a', '/a')).toBe(true)
    expect(isInside('/a', '/a/b')).toBe(true)
  })

  // The bug a naive startsWith() check would have: /abc is not inside /a.
  it('rejects a sibling that merely shares a prefix', () => {
    expect(isInside('/a', '/abc')).toBe(false)
  })

  it('rejects anything above the root', () => {
    expect(isInside('/a/b', '/a')).toBe(false)
  })
})

describe('resolveInsideRoot', () => {
  it('defaults to the root', async () => {
    expect(await resolveInsideRoot(undefined, root)).toBe(root)
  })

  it('resolves a directory inside the root', async () => {
    expect(await resolveInsideRoot(join(root, 'Projects'), root)).toBe(join(root, 'Projects'))
  })

  it('refuses a path outside the root', async () => {
    await expect(resolveInsideRoot('/etc', root)).rejects.toThrow(/outside/)
  })

  it('refuses traversal out of the root', async () => {
    await expect(resolveInsideRoot(join(root, '..'), root)).rejects.toThrow(/outside/)
  })

  // Resolution happens before the check, so a link is judged by where it points.
  it('refuses a symlink that escapes the root', async () => {
    await expect(resolveInsideRoot(join(root, 'escape-hatch'), root)).rejects.toThrow(/outside/)
  })

  it('refuses a path that does not exist', async () => {
    await expect(resolveInsideRoot(join(root, 'nope'), root)).rejects.toThrow(BrowseError)
  })
})

describe('listDirs', () => {
  it('lists only directories, not files', async () => {
    const listing = await listDirs(undefined, { root })
    const names = listing.entries.map((e) => e.name)
    expect(names).toContain('Projects')
    expect(names).not.toContain('notes.txt')
  })

  it('hides dotfolders unless asked', async () => {
    expect((await listDirs(undefined, { root })).entries.map((e) => e.name)).not.toContain('.hidden')
    const withHidden = await listDirs(undefined, { root, includeHidden: true })
    expect(withHidden.entries.map((e) => e.name)).toContain('.hidden')
  })

  it('has no parent at the root, and one below it', async () => {
    expect((await listDirs(undefined, { root })).parent).toBeNull()
    expect((await listDirs(join(root, 'Projects'), { root })).parent).toBe(root)
  })

  it('refuses to list outside the root', async () => {
    await expect(listDirs('/etc', { root })).rejects.toThrow(/outside/)
  })

  it('sorts entries by name', async () => {
    const names = (await listDirs(undefined, { root, includeHidden: true })).entries.map((e) => e.name)
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names)
  })
})

describe('labelFor', () => {
  it('shows the root as ~ and descendants relative to it', () => {
    expect(labelFor('/home/me', '/home/me')).toBe('~')
    expect(labelFor('/home/me/Projects', '/home/me')).toBe('~/Projects')
  })
})
