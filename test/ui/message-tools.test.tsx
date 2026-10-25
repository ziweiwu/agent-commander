/**
 * What a reply's tool calls show, and what the run hides.
 *
 * The chat's whole job on this surface is saying what the agent did, and a
 * long run is where there is most of it to say. The collapse used to take all
 * of it: `VISIBLE_TOOLS` reads "how many tool calls show before the run
 * collapses", and the code showed *none* of them once a run was long enough
 * to collapse — five calls rendered in full and six rendered as the words
 * "6 actions". These pin the constant's own promise.
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { Message } from '../../src/web/components/Message.tsx'
import type { ChatMessage } from '../../src/web/lib/chat.ts'
import { renderApp, resetStore } from './helpers.tsx'

/** The same number `Message.tsx` shows before it collapses the remainder. */
const VISIBLE = 4

const withTools = (count: number): ChatMessage => ({
  id: 'm1',
  role: 'agent',
  at: 1_786_000_000_000,
  text: 'On it.',
  grouped: false,
  tools: Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    tool: 'Read',
    text: `src/file-${i}.ts`,
    subagent: false,
  })),
})

const rows = () => screen.queryAllByTestId('tool-call')

beforeEach(resetStore)

describe('a reply’s tool calls', () => {
  it('shows a short run in full, with nothing to expand', () => {
    renderApp(<Message message={withTools(VISIBLE)} />)
    expect(rows()).toHaveLength(VISIBLE)
    expect(screen.queryByTestId('tools-toggle')).toBeNull()
  })

  /*
   * One hidden row is not worth a control: the press costs the reader more
   * than the line it saves.
   */
  it('does not collapse a run that would hide a single call', () => {
    renderApp(<Message message={withTools(VISIBLE + 1)} />)
    expect(rows()).toHaveLength(VISIBLE + 1)
    expect(screen.queryByTestId('tools-toggle')).toBeNull()
  })

  it('keeps the first calls on screen and collapses only the rest', () => {
    const total = VISIBLE + 5
    renderApp(<Message message={withTools(total)} />)
    expect(rows()).toHaveLength(VISIBLE)
    const toggle = screen.getByTestId('tools-toggle')
    // The count is what is hidden, not the size of the run: the run is on
    // screen above it.
    expect(toggle.textContent).toContain(String(total - VISIBLE))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(rows()).toHaveLength(total)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggle)
    expect(rows()).toHaveLength(VISIBLE)
  })
})

/**
 * The run as a ruled list (U7): one rule down the left of the whole run, and
 * each call a row of a grid — name, argument, and a third column kept for the
 * call's outcome. It used to be a 2px rule per row, so "› 4 more" on a phone
 * was a 44px stub of rule with nothing in it, and the name was drawn in the
 * working hue as if every past call were still running.
 */
const CSS_COMMENT = new RegExp('/\\*[\\s\\S]*?\\*/', 'g')
const SHEET = readFileSync('src/web/components/Message.module.css', 'utf8').replace(CSS_COMMENT, '')

/** The declarations of the first top-level rule written exactly as `selector`. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(SHEET)
  expect(match, `no rule for ${selector}`).not.toBeNull()
  return Object.fromEntries(
    (match?.[1] ?? '')
      .split(';')
      .map((line) => line.split(':').map((part) => part.trim()))
      .filter((pair) => pair.length >= 2 && pair[0])
      .map(([property, ...value]) => [property, value.join(':')]),
  )
}

describe('the run is one ruled list', () => {
  it('draws one rule down the run instead of one per row', () => {
    expect(rule('.tools')['border-left']).toBe('2px solid var(--line)')
    expect(rule('.tool').border).toBe('0')
    expect(rule('.toggle')['border-left']).toBeUndefined()
  })

  it('lays each call on a three-column grid, the third kept for its outcome', () => {
    const tool = rule('.tool')
    expect(tool.display).toBe('grid')
    const tracks = tool['grid-template-columns']?.match(/minmax\([^)]*\)|max-content|auto|\S+/g)
    expect(tracks).toEqual(['minmax(5ch, max-content)', 'minmax(0, 1fr)', 'auto'])
  })

  it('names the tool in the text colour, and a subagent in its accent', () => {
    expect(rule('.toolName').color).toBe('var(--text)')
    expect(rule('.toolName')['font-weight']).toBe('var(--weight-strong)')
    expect(rule('.subagent .toolName').color).toBe('var(--accent)')
  })

  it('puts the name in the first column and the argument in the second', () => {
    renderApp(<Message message={withTools(2)} />)
    for (const row of rows()) {
      const cells = Array.from(row.children)
      expect(cells).toHaveLength(2)
      expect(cells[0]?.textContent).toBe('Read')
      expect(cells[1]?.textContent).toMatch(/^src\/file-\d\.ts$/)
    }
  })
})

describe('a message says what language it is in', () => {
  const said = (text: string): ChatMessage => ({ ...withTools(0), text })

  it('marks Chinese prose zh-CN, so it gets the taller Chinese line', () => {
    renderApp(<Message message={said('好的，我先看一下现在的代码结构。')} />)
    expect(screen.getByTestId('message-text').getAttribute('lang')).toBe('zh-CN')
  })

  it('marks English prose en, even under a Chinese interface', () => {
    renderApp(<Message message={said('Getting oriented in the codebase.')} />)
    expect(screen.getByTestId('message-text').getAttribute('lang')).toBe('en')
  })
})
