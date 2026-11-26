import { describe, expect, it } from 'vitest'
import { screenText } from '../src/web/lib/term.ts'

describe('screenText', () => {
  it('drops trailing blank rows and trailing spaces', () => {
    expect(screenText(['Reading src/a.ts   ', '', '  ', ''])).toBe('Reading src/a.ts')
  })

  it('removes runs of box-drawing characters and keeps the words beside them', () => {
    const rows = ['╭─ mock pane %1 ───────╮', '│ Reading src/a.ts │', '╰──────────────╯']
    expect(screenText(rows)).toBe('mock pane %1\nReading src/a.ts')
  })

  it('keeps blank rows between text and the indent of a line', () => {
    expect(screenText(['one', '', '  two'])).toBe('one\n\n  two')
  })

  it('is empty for an empty screen', () => {
    expect(screenText(['', ' '])).toBe('')
  })
})
