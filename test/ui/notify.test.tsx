/**
 * INV-14: a notification is a transition, not a state.
 *
 * The tab title may say "(2 blocked)" forever; an OS notification reaches out
 * of the tab, so it fires only for an agent this page *watched become*
 * waiting. The cases that matter: the backlog on the first frame stays
 * silent, a standing block never re-fires, and turning the preference on
 * later starts from "now" rather than dumping everything already blocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  freshlyBlocked,
  notifyBlocked,
  resetBlockedTracking,
  shouldNudge,
} from '../../src/web/lib/notify.ts'
import { agent } from './helpers.tsx'
import type { Agent } from '../../src/shared/types.ts'

const waiting = (id: string): Agent =>
  agent({ sessionId: id, status: 'waiting', waitingFor: 'dialog open' })
const idle = (id: string): Agent => agent({ sessionId: id, status: 'idle' })

/** A Notification double the module's feature checks accept. */
class FakeNotification {
  static permission = 'granted'
  static instances: Array<{ title: string; body?: string }> = []
  onclick: (() => void) | null = null
  constructor(title: string, options?: { body?: string }) {
    FakeNotification.instances.push({ title, body: options?.body })
  }
}

const hideTab = (): void => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
}

beforeEach(() => {
  resetBlockedTracking()
  FakeNotification.instances = []
  FakeNotification.permission = 'granted'
  vi.stubGlobal('Notification', FakeNotification)
  hideTab()
})

afterEach(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

describe('INV-14 what counts as newly blocked', () => {
  it('treats everything in the first frame as backlog, not news', () => {
    expect(freshlyBlocked([waiting('a'), waiting('b')])).toEqual([])
  })

  it('reports an agent seen to become waiting', () => {
    freshlyBlocked([idle('a')])
    const fresh = freshlyBlocked([waiting('a')])
    expect(fresh.map((a) => a.sessionId)).toEqual(['a'])
  })

  it('does not repeat while the same agent stays blocked', () => {
    freshlyBlocked([idle('a')])
    freshlyBlocked([waiting('a')])
    expect(freshlyBlocked([waiting('a')])).toEqual([])
  })

  it('is news again after the agent unblocked in between', () => {
    freshlyBlocked([idle('a')])
    freshlyBlocked([waiting('a')])
    freshlyBlocked([idle('a')])
    expect(freshlyBlocked([waiting('a')]).map((a) => a.sessionId)).toEqual(['a'])
  })
})

/*
 * The one unsolicited prompt in the app, held to the same rule as the
 * notification it points at: a witnessed transition, never the backlog.
 */
describe('INV-14 the nudge to turn notifications on', () => {
  const off = { enabled: false, dismissed: false, supported: true }

  it('is silent on the first frame, however many agents are blocked', () => {
    const fresh = notifyBlocked([waiting('a'), waiting('b')], { enabled: false, lang: 'en' })
    expect(shouldNudge(fresh, off)).toBe(false)
  })

  it('asks once for a block this page watched happen while off', () => {
    notifyBlocked([idle('a')], { enabled: false, lang: 'en' })
    const fresh = notifyBlocked([waiting('a')], { enabled: false, lang: 'en' })
    expect(shouldNudge(fresh, off)).toBe(true)
    // And not again on the next frame: the block is standing, not news.
    const again = notifyBlocked([waiting('a')], { enabled: false, lang: 'en' })
    expect(shouldNudge(again, off)).toBe(false)
  })

  it('never asks once it has been waved away', () => {
    expect(shouldNudge([waiting('a')], { ...off, dismissed: true })).toBe(false)
  })

  it('never asks when the preference is already on', () => {
    expect(shouldNudge([waiting('a')], { ...off, enabled: true })).toBe(false)
  })

  it('never asks a browser that could not say yes', () => {
    expect(shouldNudge([waiting('a')], { ...off, supported: false })).toBe(false)
  })
})

describe('INV-14 what reaches the OS', () => {
  it('notifies for a watched transition while the tab is hidden', () => {
    notifyBlocked([idle('a')], { enabled: true, lang: 'en' })
    notifyBlocked([waiting('a')], { enabled: true, lang: 'en' })

    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.body).toMatch(/dialog open/)
  })

  it('stays silent while the tab is visible — the screen is the notification', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    notifyBlocked([idle('a')], { enabled: true, lang: 'en' })
    notifyBlocked([waiting('a')], { enabled: true, lang: 'en' })

    expect(FakeNotification.instances).toHaveLength(0)
  })

  it('tracks while disabled, so enabling later does not dump the backlog', () => {
    notifyBlocked([idle('a')], { enabled: false, lang: 'en' })
    notifyBlocked([waiting('a')], { enabled: false, lang: 'en' })
    // The block predates the preference; turning it on must not replay it.
    notifyBlocked([waiting('a')], { enabled: true, lang: 'en' })

    expect(FakeNotification.instances).toHaveLength(0)
  })

  it('respects a permission revoked after the preference was stored', () => {
    FakeNotification.permission = 'denied'
    notifyBlocked([idle('a')], { enabled: true, lang: 'en' })
    notifyBlocked([waiting('a')], { enabled: true, lang: 'en' })

    expect(FakeNotification.instances).toHaveLength(0)
  })
})
