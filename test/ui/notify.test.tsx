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
import { freshlyBlocked, notifyBlocked, resetBlockedTracking } from '../../src/web/lib/notify.ts'
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
