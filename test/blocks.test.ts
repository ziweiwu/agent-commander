/**
 * Tables in a conversation, and what is deliberately not one.
 *
 * Tables are the only block-level structure the chat parses. Everything else
 * an agent writes — lists, headings, fenced code — already reads correctly as
 * text in a `pre-wrap` block, because its markers are punctuation a person
 * would type anyway. A table is the one shape where that is false: the pipes
 * are scaffolding for a grid, and without the grid they are noise laid over
 * the data they were meant to organise.
 *
 * Which makes the false positive the expensive direction. Turning a sentence
 * that happens to contain a pipe into a one-cell grid is worse than leaving it
 * as the sentence it was, so most of what follows is about refusing.
 */
import { describe, expect, it } from 'vitest'
import { parseBlocks, type TableBlock } from '../src/web/lib/chat.ts'

const table = (text: string): TableBlock | undefined =>
  parseBlocks(text).find((b): b is TableBlock => b.kind === 'table')

describe('a markdown table becomes a grid', () => {
  it('reads the header, the body and nothing else', () => {
    const t = table('| Port | What runs there |\n| --- | --- |\n| 4317 | Production |\n| 4400 | Dev |')
    expect(t?.head).toEqual(['Port', 'What runs there'])
    expect(t?.rows).toEqual([
      ['4317', 'Production'],
      ['4400', 'Dev'],
    ])
  })

  it('takes the alignment the delimiter row declares', () => {
    const t = table('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |')
    expect(t?.align).toEqual(['left', 'center', 'right'])
  })

  /* GitHub's dialect makes the outer pipes optional, and agents write both. */
  it('does not require the outer pipes', () => {
    const t = table('a | b\n--- | ---\n1 | 2')
    expect(t?.head).toEqual(['a', 'b'])
    expect(t?.rows).toEqual([['1', '2']])
  })

  /*
   * A table of shell commands is a table full of pipes. An escaped one is a
   * literal character in a cell, not a column boundary — get this wrong and
   * the row silently gains a column and the grid goes ragged.
   */
  it('keeps an escaped pipe inside its cell', () => {
    const t = table('| cmd | does |\n| --- | --- |\n| `ps \\| grep x` | finds it |')
    expect(t?.rows[0]?.[0]).toBe('`ps | grep x`')
    expect(t?.rows[0]).toHaveLength(2)
  })

  /*
   * A ragged grid is a rendering bug rather than a claim about the data, so
   * rows are squared off against the header either way.
   */
  it('squares off a short row and a long one', () => {
    const t = table('| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |')
    expect(t?.rows).toEqual([
      ['1', ''],
      ['1', '2'],
    ])
  })

  it('keeps the prose on either side of it as prose', () => {
    const blocks = parseBlocks('before\n\n| a |\n| --- |\n| 1 |\n\nafter')
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'table', 'p'])
    expect(blocks[0]).toMatchObject({ text: 'before' })
    expect(blocks[2]).toMatchObject({ text: 'after' })
  })
})

describe('what is not a table stays prose', () => {
  it('leaves a sentence that merely contains a pipe alone', () => {
    const text = 'Run ps | grep node to find it.'
    expect(parseBlocks(text)).toEqual([{ kind: 'p', text }])
  })

  /* A header with nothing under it is a sentence, however many pipes it has. */
  it('refuses a header row with no delimiter beneath it', () => {
    const text = '| a | b |\n| 1 | 2 |'
    expect(table(text)).toBeUndefined()
  })

  /*
   * The case that made the column check necessary: a line of prose with one
   * pipe, above a horizontal rule, is an ordinary thing to write and parsed as
   * a two-column table with a rule for a body.
   */
  it('refuses a delimiter that does not match the header’s column count', () => {
    expect(table('a | b\n---\n1 | 2')).toBeUndefined()
    expect(table('| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |')).toBeUndefined()
  })

  it('refuses a delimiter row with anything but dashes and colons in it', () => {
    expect(table('| a | b |\n| --- | no |\n| 1 | 2 |')).toBeUndefined()
  })

  it('returns the whole message as one paragraph when there is no table', () => {
    expect(parseBlocks('just words')).toEqual([{ kind: 'p', text: 'just words' }])
  })

  /*
   * An empty message must not become an empty paragraph that draws a gap: the
   * composer's own echo arrives before the transcript confirms it, and a blank
   * block would flicker a space into the conversation at exactly that moment.
   */
  it('makes nothing out of nothing', () => {
    expect(parseBlocks('')).toEqual([{ kind: 'p', text: '' }])
  })
})
