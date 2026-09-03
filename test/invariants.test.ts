/**
 * The invariant contract has to stay wired to the code it claims to describe.
 *
 * `INVARIANTS.md` earns its place by being an *index* rather than an essay:
 * every property is greppable from a test name, on both sides of the wire. That
 * promise is made in the file's own preamble and nothing was checking it, so it
 * rotted the way an unchecked claim always does. Measured when this test was
 * written: INV-10 had no test carrying its number anywhere in the repo while
 * describing its coverage in detail, INV-13 cited `test/delegate-effort.test.ts`
 * which the Rust port had deleted, and INV-7's headline clause — slash commands
 * are only ever typed at Claude Code — was pinned by a test named `inv8_*`, so
 * `cargo test inv7` did not run it.
 *
 * None of that is catchable by reading. All of it is catchable by a regex, which
 * is the argument for spending forty lines here.
 *
 * This rides in `npm test` rather than being a new gate, because `npm test` is
 * already the third entry in `.claude/gates.json` and a check nobody runs is the
 * thing being fixed. `test/version.test.ts` is the same shape for the same
 * reason.
 *
 * **What this cannot check is whether the prose is still true.** A rule can
 * confirm INV-8 is pinned by tests; it cannot notice that INV-8 still said "no
 * mode named anywhere in the interface" after a mode was deliberately added to
 * the interface. That half stays a human obligation, and belongs to the
 * commit-guard audit rather than here.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CONTRACT = readFileSync('INVARIANTS.md', 'utf8')

/** The numbers the contract defines, in the order it defines them. */
const declared = (): number[] =>
  [...CONTRACT.matchAll(/^## INV-(\d+)\b/gm)].map((m) => Number(m[1]))

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    return e.isDirectory() ? filesUnder(path) : [path]
  })
}

/**
 * Every number a test carries, from either spelling.
 *
 * Rust identifiers cannot hold a hyphen, so the server spells it `inv3_`; the
 * browser and the e2e specs keep `INV-3` inside the test string. The contract's
 * preamble promises both are searchable by the same digits, so both are read
 * here — a rule that knew only one spelling would let half the repo drift.
 */
function pinnedNumbers(): Map<number, string[]> {
  const found = new Map<number, string[]>()
  const add = (n: number, where: string): void => {
    const seen = found.get(n) ?? []
    if (!seen.includes(where)) seen.push(where)
    found.set(n, seen)
  }
  for (const path of [...filesUnder('rust/src'), ...filesUnder('test'), ...filesUnder('e2e')]) {
    if (!/\.(rs|ts|tsx)$/.test(path)) continue
    if (path.endsWith('test/invariants.test.ts')) continue // this file names them all
    const body = readFileSync(path, 'utf8')
    for (const m of body.matchAll(/\binv(\d+)_/g)) add(Number(m[1]), path)
    for (const m of body.matchAll(/\bINV-(\d+)\b/g)) add(Number(m[1]), path)
  }
  return found
}

/**
 * INV-10 is known-unpinned, and it is listed here rather than quietly excluded.
 *
 * It governs `scripts/statusline-bridge.mjs`, which runs inside every live
 * Claude Code session's render loop — the one piece of this project's code that
 * executes inside somebody else's program, and so the worst one to leave
 * unverified. Its tests lived in `test/limits.test.ts` and left with the Rust
 * port; the bridge is still `.mjs` and nothing picked them back up.
 *
 * Deleting the entry is the fix. Keeping the list non-empty is deliberate: an
 * exemption that has to be written down is one somebody argues with, where a
 * silently skipped check is one nobody ever sees again.
 */
const KNOWN_UNPINNED = new Set([10])

describe('the invariant contract stays wired to the code', () => {
  it('numbers its invariants contiguously from 1', () => {
    const nums = declared()
    expect(nums.length).toBeGreaterThan(0)
    expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1))
  })

  /*
   * The promise the file opens with. An invariant no test carries is a claim
   * with nothing behind it, which is the exact failure the whole document
   * exists to prevent — committed by the document rather than by the app.
   */
  it('pins every invariant to at least one test carrying its number', () => {
    const pinned = pinnedNumbers()
    const unpinned = declared().filter((n) => !pinned.has(n) && !KNOWN_UNPINNED.has(n))
    expect(unpinned, `INV-${unpinned.join(', INV-')} has no test carrying its number`).toEqual([])
  })

  /* The exemption list is itself a claim, so it decays too: an entry that has
     since been pinned should be deleted rather than left as false debt. */
  it('keeps no stale exemptions', () => {
    const pinned = pinnedNumbers()
    const fixed = [...KNOWN_UNPINNED].filter((n) => pinned.has(n))
    expect(fixed, `INV-${fixed.join(', INV-')} is pinned now — drop it from KNOWN_UNPINNED`).toEqual(
      [],
    )
  })

  /* The other direction: a test naming INV-17 against a contract that stops at
     16 means either the heading was lost or the number was invented. */
  it('declares every invariant the tests reference', () => {
    const known = new Set(declared())
    const orphans = [...pinnedNumbers().entries()]
      .filter(([n]) => !known.has(n))
      .map(([n, where]) => `INV-${n} (${where[0]})`)
    expect(orphans, `referenced but not declared: ${orphans.join(', ')}`).toEqual([])
  })

  /*
   * Each section ends with the tests that prove it, and those citations are how
   * a reader gets from a property to its evidence. A path that no longer
   * resolves sends them nowhere — and is the first thing a port breaks, since
   * moving a test to another language leaves the prose behind.
   */
  it('cites only test files that exist', () => {
    const cited = [
      ...CONTRACT.matchAll(/`((?:test|e2e)\/[A-Za-z0-9_./-]+\.(?:ts|tsx))`/g),
    ].flatMap((m) => (m[1] === undefined ? [] : [m[1]]))
    expect(cited.length).toBeGreaterThan(0)
    const missing = [...new Set(cited)].filter((p) => !existsSync(p) || !statSync(p).isFile())
    expect(missing, `cited but absent: ${missing.join(', ')}`).toEqual([])
  })

  /*
   * The same for the Rust side. Only concrete identifiers are checked: the file
   * also writes `routes::tests` for a group and `subagents::inv13_*` for a
   * family, and neither names one function to look for.
   */
  it('cites only Rust tests that exist', () => {
    const cited = [...CONTRACT.matchAll(/`([a-z_]+)::(inv\d+_[a-z0-9_]+)`/g)]
    expect(cited.length).toBeGreaterThan(0)
    const missing = cited
      .filter(([, module, fn]) => {
        const path = `rust/src/${module}.rs`
        return !existsSync(path) || !readFileSync(path, 'utf8').includes(`fn ${fn}`)
      })
      .map(([, module, fn]) => `${module}::${fn}`)
    expect(missing, `cited but absent: ${missing.join(', ')}`).toEqual([])
  })
})
