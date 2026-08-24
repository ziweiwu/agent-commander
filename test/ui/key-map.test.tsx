/**
 * INV-2: the key names the Attach view can produce must be names the server
 * will forward.
 *
 * `mapKey` is the fourth hand-maintained key list in this codebase — after
 * `ALLOWED_KEYS`, `DESTRUCTIVE_KEYS` and the server's check — and it was the
 * only one with no test at all. Both directions of drift are silent: mapping a
 * key that is not on the allow-list gets it refused with an error the user has
 * no way to act on, and adding a key server-side does nothing until this
 * function knows how to produce it.
 *
 * The subset assertion is the invariant. The table below it is what makes a
 * *removal* fail too — a subset check alone is satisfied by a `mapKey` that
 * has stopped mapping anything.
 */
import { describe, expect, it } from 'vitest'
import { mapKey } from '../../src/web/lib/term.ts'
import { ALLOWED_KEYS, DESTRUCTIVE_KEYS } from '../../src/shared/types.ts'

const press = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', init)

/** Every key this function is meant to be able to produce. */
const EXPECTED: Array<[KeyboardEventInit, string]> = [
  [{ key: 'Enter' }, 'Enter'],
  [{ key: 'Escape' }, 'Escape'],
  [{ key: 'Tab' }, 'Tab'],
  [{ key: 'Backspace' }, 'BSpace'],
  [{ key: 'ArrowUp' }, 'Up'],
  [{ key: 'ArrowDown' }, 'Down'],
  [{ key: 'ArrowLeft' }, 'Left'],
  [{ key: 'ArrowRight' }, 'Right'],
  [{ key: 'Home' }, 'Home'],
  [{ key: 'End' }, 'End'],
  [{ key: 'PageUp' }, 'PageUp'],
  [{ key: 'PageDown' }, 'PageDown'],
  [{ key: 'c', ctrlKey: true }, 'C-c'],
  [{ key: 'd', ctrlKey: true }, 'C-d'],
  [{ key: 'o', ctrlKey: true }, 'C-o'],
  [{ key: 'r', ctrlKey: true }, 'C-r'],
  [{ key: 'u', ctrlKey: true }, 'C-u'],
]

describe('INV-2 mapKey can only produce keys the server forwards', () => {
  it('maps every key it claims to', () => {
    for (const [init, expected] of EXPECTED) {
      expect(mapKey(press(init)), JSON.stringify(init)).toBe(expected)
    }
  })

  it('never produces a name outside ALLOWED_KEYS', () => {
    const allowed = new Set<string>(ALLOWED_KEYS)
    // A broad sweep rather than only the table above: anything a keyboard can
    // plausibly emit, including the modifier combinations that used to be the
    // easy way to smuggle a name past a hand-checked list.
    const keys = [
      ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
      ...'`-=[]\\;\'",./<>?:{}|~!@#$%^&*()_+'.split(''),
      'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Space', ' ',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Home', 'End', 'PageUp', 'PageDown',
      'F1', 'F5', 'F12', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified',
      'é', '中', '😀',
    ]
    const mods = [
      {},
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { shiftKey: true },
      { ctrlKey: true, altKey: true },
      { ctrlKey: true, metaKey: true },
      { ctrlKey: true, shiftKey: true },
    ]
    for (const key of keys) {
      for (const mod of mods) {
        const mapped = mapKey(press({ key, ...mod }))
        if (mapped === null) continue
        expect(allowed.has(mapped), `${JSON.stringify({ key, ...mod })} -> ${mapped}`).toBe(true)
      }
    }
  })

  it('does not turn a Ctrl chord into a control key when Alt or Meta is held', () => {
    // Those are the browser's own shortcuts and the OS's; treating them as a
    // C-c would interrupt a working agent because someone reached for a menu.
    expect(mapKey(press({ key: 'c', ctrlKey: true, altKey: true }))).toBeNull()
    expect(mapKey(press({ key: 'c', ctrlKey: true, metaKey: true }))).toBeNull()
  })

  it('can still produce every destructive key, since interrupting is the point', () => {
    // INV-6 guards these with a confirmation; it does not remove them. A
    // `mapKey` that could no longer produce C-c would make a stuck agent
    // unreachable from the browser, which is half of why Attach exists.
    const produced = new Set(EXPECTED.map(([, name]) => name))
    for (const key of DESTRUCTIVE_KEYS) expect(produced.has(key)).toBe(true)
  })
})
