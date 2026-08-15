/**
 * Directory listing for the new-agent folder picker.
 *
 * INV-9: browsing cannot leave the root. Every requested path is resolved with
 * `realpath` and confirmed to sit inside it, so a symlink pointing at `/` does
 * not become a filesystem tour. This app is reachable over Tailscale, so an
 * endpoint that enumerates directories deserves a hard boundary rather than a
 * string-prefix check on an unresolved path.
 *
 * Listing is metadata only: names and directory-ness. It never reads a file.
 */
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

export class BrowseError extends Error {}

export interface DirEntry {
  name: string
  path: string
  hidden: boolean
}

export interface Listing {
  /** The resolved directory being listed. */
  path: string
  /** Parent, or null when already at the root. */
  parent: string | null
  root: string
  entries: DirEntry[]
}

/** True when `candidate` is the root itself or sits underneath it. */
export function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Resolve a requested path and refuse anything outside the root.
 *
 * Resolution happens before the check, so `~/link-to-slash` is judged by where
 * it points rather than by what it is called.
 */
export async function resolveInsideRoot(requested: string | undefined, root: string): Promise<string> {
  const realRoot = await realpath(root)
  const target = requested && requested.trim() ? resolve(requested.trim()) : realRoot

  let real: string
  try {
    real = await realpath(target)
  } catch {
    throw new BrowseError(`no such directory: ${target}`)
  }

  if (!isInside(realRoot, real)) {
    throw new BrowseError('that directory is outside the browsable root')
  }
  return real
}

/** List the subdirectories of a path, contained to the root. */
export async function listDirs(
  requested: string | undefined,
  options: { root?: string; includeHidden?: boolean } = {},
): Promise<Listing> {
  const root = await realpath(options.root ?? homedir())
  const path = await resolveInsideRoot(requested, root)

  const info = await stat(path)
  if (!info.isDirectory()) throw new BrowseError(`not a directory: ${path}`)

  let names: string[]
  try {
    names = await readdir(path)
  } catch {
    throw new BrowseError(`cannot read directory: ${path}`)
  }

  const entries: DirEntry[] = []
  for (const name of names) {
    const hidden = name.startsWith('.')
    if (hidden && !options.includeHidden) continue
    try {
      // withFileTypes would be cheaper, but a symlinked project directory is
      // common and should still be offered; stat follows it.
      const child = join(path, name)
      if ((await stat(child)).isDirectory()) entries.push({ name, path: child, hidden })
    } catch {
      // Unreadable or a broken symlink; not worth failing the whole listing.
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name))

  const parentPath = resolve(path, '..')
  const parent = path === root || !isInside(root, parentPath) ? null : parentPath

  return { path, parent, root, entries }
}

/** Display label for a path, relative to the root. */
export function labelFor(path: string, root: string): string {
  if (path === root) return '~'
  return isInside(root, path) ? `~/${path.slice(root.length + 1)}` : basename(path)
}
