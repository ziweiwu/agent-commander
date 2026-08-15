import { describe, expect, it } from 'vitest'
import {
  describe as summarize,
  goalFromRecord,
  parseLines,
  summarizeTool,
} from '../src/server/transcript.ts'

const seq = (): (() => string) => {
  let n = 0
  return () => `e${n++}`
}

const line = (obj: unknown): string => JSON.stringify(obj)

const assistant = (blocks: unknown[], extra: Record<string, unknown> = {}): string =>
  line({
    type: 'assistant',
    timestamp: '2026-08-14T00:57:52.725Z',
    gitBranch: 'main',
    message: { content: blocks, usage: { output_tokens: 40 } },
    ...extra,
  })

describe('parseLines', () => {
  it('extracts assistant text and tool calls', () => {
    const { events } = parseLines(
      [
        assistant([{ type: 'text', text: 'Getting oriented.' }]),
        assistant([
          { type: 'tool_use', name: 'Bash', input: { command: 'ls -la', description: 'List root' } },
        ]),
      ],
      seq(),
    )
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ kind: 'assistant', text: 'Getting oriented.' })
    expect(events[1]).toMatchObject({ kind: 'tool', tool: 'Bash', text: 'List root' })
  })

  it('classifies Task as a subagent and counts it', () => {
    const { events, patch } = parseLines(
      [assistant([{ type: 'tool_use', name: 'Task', input: { description: 'Audit tokens' } }])],
      seq(),
    )
    expect(events[0]).toMatchObject({ kind: 'subagent', tool: 'Task' })
    expect(patch.subagents).toBe(1)
  })

  it('omits thinking blocks and tool_result plumbing', () => {
    const { events } = parseLines(
      [
        assistant([{ type: 'thinking', thinking: 'hmm' }]),
        line({ type: 'user', timestamp: '2026-08-14T00:00:00Z', message: { content: [{ type: 'tool_result' }] } }),
      ],
      seq(),
    )
    expect(events).toHaveLength(0)
  })

  it('keeps a real user prompt', () => {
    const { events } = parseLines(
      [line({ type: 'user', timestamp: '2026-08-14T00:00:00Z', message: { content: '  add dark mode  ' } })],
      seq(),
    )
    expect(events[0]).toMatchObject({ kind: 'user', text: 'add dark mode' })
  })

  it('skips meta record types the transcript interleaves', () => {
    const metas = ['attachment', 'mode', 'permission-mode', 'ai-title', 'last-prompt', 'file-history-delta']
    const { events } = parseLines(
      metas.map((type) => line({ type, timestamp: '2026-08-14T00:00:00Z' })),
      seq(),
    )
    expect(events).toHaveLength(0)
  })

  // INV-5: a torn final line is normal when tailing a file being appended to.
  it('INV-5 ignores malformed JSON instead of throwing', () => {
    const { events } = parseLines(
      ['{"type":"assistant","message":{"content":[{"type":"tex', assistant([{ type: 'text', text: 'ok' }])],
      seq(),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.text).toBe('ok')
  })

  it('accumulates tokens and reports git branch', () => {
    const { patch } = parseLines([assistant([{ type: 'text', text: 'a' }]), assistant([{ type: 'text', text: 'b' }])], seq())
    expect(patch.tokens).toBe(80)
    expect(patch.gitBranch).toBe('main')
  })

  it('derives the activity line from the last event', () => {
    const { patch } = parseLines(
      [
        assistant([{ type: 'text', text: 'first' }]),
        assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x.ts' } }]),
      ],
      seq(),
    )
    expect(patch.activity).toBe('Read: /tmp/x.ts')
  })
})

describe('summarizeTool', () => {
  it('prefers a Bash description over the raw command', () => {
    expect(summarizeTool('Bash', { command: 'rm -rf x', description: 'Clean build' })).toBe('Clean build')
  })

  it('falls back to the first line of a command', () => {
    expect(summarizeTool('Bash', { command: 'echo one\necho two' })).toBe('echo one')
  })

  it('uses file_path for file tools and pattern for search tools', () => {
    expect(summarizeTool('Edit', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(summarizeTool('Grep', { pattern: 'TODO' })).toBe('TODO')
  })

  it('returns empty rather than throwing on unknown tools', () => {
    expect(summarizeTool('MysteryTool', undefined)).toBe('')
  })
})

describe('describe', () => {
  it('truncates long activity lines', () => {
    const text = 'x'.repeat(200)
    const out = summarize({ id: 'a', at: 0, kind: 'assistant', text })
    expect(out.length).toBeLessThanOrEqual(80)
    expect(out.endsWith('…')).toBe(true)
  })

  it('prefixes tool events with the tool name', () => {
    expect(summarize({ id: 'a', at: 0, kind: 'tool', tool: 'Bash', text: 'build' })).toBe('Bash: build')
  })
})

describe('git branch', () => {
  it('ignores a HEAD branch, which carries no information', () => {
    const { patch } = parseLines(
      [
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-08-14T00:00:00Z',
          gitBranch: 'HEAD',
          message: { content: [{ type: 'text', text: 'hi' }] },
        }),
      ],
      seq(),
    )
    expect(patch.gitBranch).toBeUndefined()
  })
})

/**
 * `/goal` state is observable from outside the session in exactly one place:
 * the `goal_status` attachments Claude Code writes into the transcript. Three
 * shapes exist and only the newest one is the current state.
 */
describe('goal records', () => {
  const goalLine = (att: Record<string, unknown>, at = '2026-08-15T03:42:57.797Z'): string =>
    line({ type: 'attachment', timestamp: at, attachment: { type: 'goal_status', ...att } })

  it('reads the record written when a goal is set', () => {
    const { patch } = parseLines(
      [goalLine({ met: false, sentinel: true, condition: 'the tests pass' })],
      seq(),
    )
    expect(patch.goal).toMatchObject({ condition: 'the tests pass', met: false, fresh: true })
  })

  it('reads an evaluation that rejected the goal', () => {
    const { patch } = parseLines(
      [goalLine({ met: false, condition: 'the tests pass', reason: 'Two still fail.' })],
      seq(),
    )
    expect(patch.goal).toMatchObject({ met: false, reason: 'Two still fail.' })
    expect(patch.goal?.fresh).toBeUndefined()
  })

  // A met goal is finished, not running: the UI has to be able to tell those
  // apart, because one of them means the session is still working.
  it('reads the verdict that ended the goal', () => {
    const { patch } = parseLines([goalLine({ met: true, condition: 'ship it' })], seq())
    expect(patch.goal).toMatchObject({ met: true, condition: 'ship it' })
  })

  it('keeps the newest record when several are in one batch', () => {
    const { patch } = parseLines(
      [
        goalLine({ met: false, sentinel: true, condition: 'ship it' }, '2026-08-15T01:00:00.000Z'),
        goalLine({ met: true, condition: 'ship it' }, '2026-08-15T02:00:00.000Z'),
      ],
      seq(),
    )
    expect(patch.goal).toMatchObject({ met: true })
  })

  it('leaves the timeline alone — a goal record is not a message', () => {
    const { events } = parseLines([goalLine({ met: true, condition: 'ship it' })], seq())
    expect(events).toHaveLength(0)
  })

  // INV-5: other attachment types share the envelope and must not be read as goals.
  it('ignores other attachments', () => {
    const rec = { type: 'attachment', attachment: { type: 'hook_success', condition: 'x' } }
    expect(goalFromRecord(rec)).toBeNull()
  })

  it('ignores a goal record with no condition', () => {
    expect(goalFromRecord({ type: 'attachment', attachment: { type: 'goal_status', met: true } }))
      .toBeNull()
  })
})
