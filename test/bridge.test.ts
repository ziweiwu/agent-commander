/**
 * INV-10: the statusLine bridge writes only what it was given, and only when
 * it was given something.
 *
 * The bridge runs inside the render loop of every live Claude Code session, so
 * these are pure-function tests of what it decides to write — the process
 * boundary (never throw, never exit non-zero, never print a diagnostic) is the
 * `main().catch(() => {})` in the file itself, which a unit test cannot reach.
 */
import { describe, expect, it } from 'vitest'
import { persistSession, sessionUsage, snapshot } from '../scripts/statusline-bridge.mjs'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FRAME = {
  session_id: 'abc-123',
  context_window: { used_percentage: 42.5, context_window_size: 200_000 },
  cost: { total_cost_usd: 1.25 },
  rate_limits: { five_hour: { used_percentage: 23, resets_at: 1_700_000_000 } },
}

describe('INV-10 the bridge writes only what the frame carries', () => {
  it('reads the per-session figures under the session id', () => {
    const usage = sessionUsage(JSON.stringify(FRAME), 5)
    expect(usage).toEqual({
      sessionId: 'abc-123',
      at: 5,
      contextPct: 42.5,
      contextSize: 200_000,
      costUsd: 1.25,
    })
  })

  it('writes nothing for a frame with neither a context reading nor a cost', () => {
    const bare = { session_id: 'abc', context_window: { used_percentage: null }, cost: {} }
    expect(sessionUsage(JSON.stringify(bare), 5)).toBeNull()
    expect(sessionUsage(JSON.stringify({ cost: { total_cost_usd: 1 } }), 5)).toBeNull()
  })

  it('refuses a session id that is not a file name (INV-9)', () => {
    for (const id of ['../token', 'a/b', '', '.hidden']) {
      expect(sessionUsage(JSON.stringify({ ...FRAME, session_id: id }), 5)).toBeNull()
    }
  })

  it('clamps a percentage out of range and drops a negative cost', () => {
    const odd = {
      session_id: 's',
      context_window: { used_percentage: 103 },
      cost: { total_cost_usd: -1 },
    }
    expect(sessionUsage(JSON.stringify(odd), 5)).toEqual({ sessionId: 's', at: 5, contextPct: 100 })
  })

  it('leaves the quota reading exactly as it was', () => {
    expect(snapshot(JSON.stringify(FRAME), 5)).toEqual({
      at: 5,
      fiveHour: { pct: 23, resetsAt: 1_700_000_000_000 },
    })
  })

  it('lands the file under the session id, whole, via a rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-'))
    const usage = sessionUsage(JSON.stringify(FRAME), 7)
    if (!usage) throw new Error('unreachable')
    persistSession(usage, dir)
    expect(readdirSync(dir)).toEqual(['abc-123.json'])
    expect(JSON.parse(readFileSync(join(dir, 'abc-123.json'), 'utf8'))).toEqual(usage)
  })
})
