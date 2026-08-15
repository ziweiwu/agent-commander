/**
 * Nine sessions called `ziweiwu-35`, `ziweiwu-9c`, `projects-ef` are nine
 * identical labels. Every session carries better material than that.
 */
import { describe, expect, it } from 'vitest'
import { describeAgent, displayName, isDerivedName, isRenamed } from '../src/web/lib/naming.ts'
import type { Agent } from '../src/shared/types.ts'

const agent = (over: Partial<Agent> & { name: string }): Agent => ({
  sessionId: 's',
  pid: 1,
  cwd: '/Users/me',
  folder: 'me',
  status: 'idle',
  kind: 'interactive',
  startedAt: 0,
  ...over,
})

describe('isDerivedName', () => {
  // The session file states this outright; the app must not second-guess it.
  it('trusts the flag the session reported', () => {
    expect(isDerivedName({ name: 'anything-at-all', derivedName: true })).toBe(true)
    expect(isDerivedName({ name: 'ziweiwu-35', derivedName: false })).toBe(false)
  })

  it('falls back to the shape only when the flag is absent', () => {
    for (const name of ['ziweiwu-35', 'ziweiwu-9c', 'projects-ef', 'terminal-system-monitor-50']) {
      expect(isDerivedName({ name })).toBe(true)
    }
    for (const name of ['kb-operational-hardening', 'blog-redesign', 'smoke']) {
      expect(isDerivedName({ name })).toBe(false)
    }
  })
})

describe('describeAgent', () => {
  it('keeps a given name above everything else', () => {
    const named = agent({ name: 'blog-redesign', derivedName: false, aiTitle: 'Add a dark mode toggle' })
    expect(describeAgent(named)).toEqual({ label: 'blog-redesign', source: 'given' })
    expect(isRenamed(named)).toBe(false)
  })

  it('prefers the title the agent generated for itself', () => {
    const a = agent({
      name: 'ziweiwu-35',
      derivedName: true,
      aiTitle: 'Fix CPU view process names',
      lastPrompt: 'something else',
    })
    expect(describeAgent(a)).toEqual({ label: 'Fix CPU view process names', source: 'title' })
    expect(isRenamed(a)).toBe(true)
  })

  it('falls back to the last thing it was asked', () => {
    const a = agent({ name: 'ziweiwu-9c', derivedName: true, lastPrompt: 'add a dark mode toggle to the header' })
    expect(describeAgent(a)).toMatchObject({ source: 'prompt' })
    expect(displayName(a)).toBe('add a dark mode toggle to the header')
  })

  it('uses only the first line of a multi-line prompt', () => {
    const a = agent({ name: 'ziweiwu-9c', derivedName: true, lastPrompt: '\n\nfirst line here\nsecond line' })
    expect(displayName(a)).toBe('first line here')
  })

  // The directory was tried as a fallback and dropped: these names are derived
  // *from* the folder, so it repeated itself, and the card shows the path anyway.
  it('keeps the session name rather than repeating the directory', () => {
    const a = agent({ name: 'projects-ef', derivedName: true, cwd: '/Users/me/Projects/lego-deals' })
    expect(describeAgent(a)).toEqual({ label: 'projects-ef', source: 'given' })
    expect(isRenamed(a)).toBe(false)
  })

  it('keeps the session name when there is genuinely nothing better', () => {
    const a = agent({ name: 'ziweiwu-35', derivedName: true, cwd: '/Users/me' })
    expect(describeAgent(a)).toEqual({ label: 'ziweiwu-35', source: 'given' })
  })

  it('clips a long title rather than letting it run', () => {
    const a = agent({ name: 'ziweiwu-35', derivedName: true, aiTitle: 'x'.repeat(200) })
    const label = displayName(a)
    expect(label.length).toBeLessThanOrEqual(72)
    expect(label.endsWith('…')).toBe(true)
  })

  it('collapses whitespace so a wrapped prompt reads as one line', () => {
    const a = agent({ name: 'ziweiwu-35', derivedName: true, aiTitle: '  lots   of\t spacing  ' })
    expect(displayName(a)).toBe('lots of spacing')
  })
})
