import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseTmuxRef, readSessionFiles, sortAgents, toAgent } from '../src/server/registry.ts'
import type { Agent } from '../src/shared/types.ts'

describe('parseTmuxRef', () => {
  it('splits a real tmux reference into session and pane', () => {
    expect(parseTmuxRef('claude-1786666491:@65.%77')).toEqual({
      session: 'claude-1786666491',
      pane: '%77',
    })
  })

  it('returns nothing for undefined or shapeless input', () => {
    expect(parseTmuxRef(undefined)).toEqual({})
    expect(parseTmuxRef('nonsense')).toEqual({})
  })

  it('drops a pane id that is not in %N form', () => {
    expect(parseTmuxRef('sess:@1.pane')).toEqual({ session: 'sess' })
  })
})

describe('toAgent', () => {
  const base = {
    pid: 4421,
    sessionId: 'abc',
    cwd: '/Users/me/Projects/thing',
    startedAt: 1,
    status: 'busy',
    name: 'thing-50',
  }

  it('maps a full session record', () => {
    const agent = toAgent({ ...base, tmux: 'claude-1:@2.%77', version: '2.1.232' })
    expect(agent).toMatchObject({
      sessionId: 'abc',
      folder: 'thing',
      status: 'busy',
      paneId: '%77',
      tmuxSession: 'claude-1',
      version: '2.1.232',
    })
  })

  // INV-5: no tmux means no attach, but the agent must still be listed.
  it('INV-5 lists an agent without tmux and explains why attach is blocked', () => {
    const agent = toAgent(base)
    expect(agent?.paneId).toBeUndefined()
    expect(agent?.attachBlockedReason).toMatch(/not running inside tmux/)
  })

  it('INV-5 explains an unparseable tmux reference separately', () => {
    const agent = toAgent({ ...base, tmux: 'garbage' })
    expect(agent?.attachBlockedReason).toMatch(/could not be parsed/)
  })

  it('rejects records missing the fields everything else depends on', () => {
    expect(toAgent({ pid: 1, cwd: '/x' })).toBeNull()
    expect(toAgent({ sessionId: 'a', cwd: '/x' })).toBeNull()
    expect(toAgent({ sessionId: 'a', pid: 1 })).toBeNull()
  })

  it('marks an unrecognised status as unknown rather than trusting it', () => {
    expect(toAgent({ ...base, status: 'exploded' })?.status).toBe('unknown')
  })
})

describe('sortAgents', () => {
  it('puts blocked agents first, then busy, then idle', () => {
    const make = (name: string, status: Agent['status']): Agent => ({
      sessionId: name,
      pid: 1,
      name,
      cwd: '/x',
      folder: 'x',
      status,
      agentKind: 'claude',
      kind: 'interactive',
      startedAt: 0,
    })
    const order = sortAgents([
      make('c', 'idle'),
      make('a', 'busy'),
      make('b', 'waiting'),
      make('d', 'unknown'),
    ]).map((a) => a.name)
    expect(order).toEqual(['b', 'a', 'c', 'd'])
  })
})

describe('readSessionFiles', () => {
  it('INV-5 survives malformed and non-JSON files in the directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-reg-'))
    await writeFile(join(dir, 'bad.json'), '{not json')
    await writeFile(join(dir, 'notes.txt'), 'ignored')
    await writeFile(
      join(dir, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: 'live',
        cwd: '/Users/me/here',
        status: 'idle',
        tmux: 'claude-1:@0.%1',
      }),
    )
    const agents = await readSessionFiles(dir)
    expect(agents.map((a) => a.sessionId)).toEqual(['live'])
  })

  it('drops records whose process is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-reg-'))
    // PID 2^22 is above the macOS/Linux maximum, so it can never be running.
    await writeFile(
      join(dir, 'dead.json'),
      JSON.stringify({ pid: 4194303, sessionId: 'ghost', cwd: '/x', status: 'idle' }),
    )
    expect(await readSessionFiles(dir)).toEqual([])
  })

  it('returns empty when the directory does not exist', async () => {
    expect(await readSessionFiles('/nonexistent/agent-commander')).toEqual([])
  })
})
