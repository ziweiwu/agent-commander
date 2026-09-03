/**
 * The bell, and the nudge that points at it.
 *
 * The preference used to be a row inside the settings menu, behind an icon
 * that reads everywhere else as a theme toggle, and nothing on screen said the
 * setting existed. Help never mentioned it. For the app whose whole promise is
 * "an agent needs you", the switch that makes that true should not depend on
 * curiosity (INV-14).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NotifyButton, NotifyNudge } from '../../src/web/components/NotifyButton.tsx'
import { SettingsMenu } from '../../src/web/components/SettingsMenu.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { renderApp, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(),
  loadEnv: vi.fn(),
}))

// The dismissal is remembered through storage, which the test document does
// not reliably have; what is asserted is that it was written down.
const saveNudgeDismissed = vi.hoisted(() => vi.fn())
vi.mock('../../src/web/lib/prefs.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/web/lib/prefs.ts')>()),
  saveNudgeDismissed,
}))

class FakeNotification {
  static permission = 'default'
  static requestPermission = vi.fn(async () => FakeNotification.permission)
}

beforeEach(() => {
  resetStore()
  saveNudgeDismissed.mockClear()
  FakeNotification.permission = 'default'
  FakeNotification.requestPermission.mockClear()
  vi.stubGlobal('Notification', FakeNotification)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the bell', () => {
  it('is its own control, off by default, and says what a press does', () => {
    renderApp(<NotifyButton />)
    const bell = screen.getByTestId('notify-toggle')
    expect(bell.getAttribute('aria-pressed')).toBe('false')
    expect(bell.dataset.state).toBe('off')
    expect(bell.getAttribute('aria-label')).toMatch(/turn on/i)
  })

  it('carries the browser permission prompt on the press that turns it on', async () => {
    const user = userEvent.setup()
    FakeNotification.permission = 'granted'
    renderApp(<NotifyButton />)
    await user.click(screen.getByTestId('notify-toggle'))
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce()
    expect(useStore.getState().notify).toBe(true)
    expect(screen.getByTestId('notify-toggle').dataset.state).toBe('on')
  })

  it('stays off, and says why, when the browser refuses', async () => {
    const user = userEvent.setup()
    FakeNotification.permission = 'denied'
    renderApp(<NotifyButton />)
    await user.click(screen.getByTestId('notify-toggle'))
    expect(useStore.getState().notify).toBe(false)
    expect(screen.getByTestId('notify-toggle').getAttribute('title')).toMatch(/blocked/i)
  })

  it('is disabled, with a reason, where the browser has no notifications at all', () => {
    vi.stubGlobal('Notification', undefined)
    renderApp(<NotifyButton />)
    const bell = screen.getByTestId('notify-toggle') as HTMLButtonElement
    expect(bell.disabled).toBe(true)
    expect(bell.dataset.state).toBe('unsupported')
    expect(bell.getAttribute('title')).toMatch(/cannot show/i)
  })

  it('is no longer buried in the settings menu', async () => {
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)
    await user.click(screen.getByTestId('settings-button'))
    expect(screen.getByTestId('settings-menu').querySelector('[data-testid="notify-toggle"]')).toBeNull()
  })
})

describe('the nudge', () => {
  it('is absent until a watched block raised it', () => {
    renderApp(<NotifyNudge />)
    expect(screen.queryByTestId('notify-nudge')).toBeNull()
  })

  it('turns notifications on from the banner, and goes away', async () => {
    const user = userEvent.setup()
    FakeNotification.permission = 'granted'
    useStore.setState({ notifyNudge: true })
    renderApp(<NotifyNudge />)
    await user.click(screen.getByTestId('notify-nudge-on'))
    expect(useStore.getState().notify).toBe(true)
    expect(screen.queryByTestId('notify-nudge')).toBeNull()
  })

  it('remembers a refusal, so it never asks this browser again', async () => {
    const user = userEvent.setup()
    useStore.setState({ notifyNudge: true })
    renderApp(<NotifyNudge />)
    await user.click(screen.getByTestId('notify-nudge-dismiss'))
    expect(screen.queryByTestId('notify-nudge')).toBeNull()
    expect(saveNudgeDismissed).toHaveBeenCalledOnce()
    expect(useStore.getState().notify).toBe(false)
  })
})
