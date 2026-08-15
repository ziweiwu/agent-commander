import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsMenu } from '../../src/web/components/SettingsMenu.tsx'
import { FleetList } from '../../src/web/components/FleetList.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(),
  sendKey: vi.fn(),
  sendText: vi.fn(),
  loadEnv: vi.fn(),
  startAgent: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
}))

beforeEach(resetStore)

describe('SettingsMenu', () => {
  it('opens on click and closes again', async () => {
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)
    expect(screen.queryByTestId('settings-menu')).toBeNull()

    await user.click(screen.getByTestId('settings-button'))
    expect(screen.getByTestId('settings-menu')).toBeDefined()

    await user.click(screen.getByTestId('settings-button'))
    expect(screen.queryByTestId('settings-menu')).toBeNull()
  })

  it('applies an explicit theme to the document', async () => {
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)

    await user.click(screen.getByTestId('settings-button'))
    await user.click(screen.getByTestId('theme-dark'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    await user.click(screen.getByTestId('settings-button'))
    await user.click(screen.getByTestId('theme-light'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  // Leaving it open hides the change behind the menu that made it.
  it('closes once a choice is made', async () => {
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)
    await user.click(screen.getByTestId('settings-button'))
    await user.click(screen.getByTestId('theme-dark'))
    expect(screen.queryByTestId('settings-menu')).toBeNull()
  })

  // "System" must leave no attribute, so the media query decides.
  it('removes the attribute for the system theme', async () => {
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)
    await user.click(screen.getByTestId('settings-button'))

    await user.click(screen.getByTestId('theme-dark'))
    await user.click(screen.getByTestId('settings-button'))
    await user.click(screen.getByTestId('theme-system'))
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('marks the active theme and language', async () => {
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)
    await user.click(screen.getByTestId('settings-button'))
    await user.click(screen.getByTestId('theme-dark'))
    await user.click(screen.getByTestId('settings-button'))
    expect(screen.getByTestId('theme-dark').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('theme-light').getAttribute('aria-checked')).toBe('false')
  })
})

describe('language switching', () => {
  it('re-renders the interface in Simplified Chinese', async () => {
    const user = userEvent.setup()
    useStore.setState({ agents: [agent({ sessionId: 'a', status: 'waiting' })] })

    renderApp(
      <>
        <SettingsMenu />
        <FleetList tiled selected={null} onSelect={() => {}} />
      </>,
    )

    expect(screen.getByTestId('group-title').textContent).toBe('Needs you')

    await user.click(screen.getByTestId('settings-button'))
    await user.click(screen.getByTestId('lang-zh-CN'))

    expect(screen.getByTestId('group-title').textContent).toBe('需要你处理')
    expect(screen.getByTestId('new-agent-button').textContent).toContain('新建代理')
    expect(document.documentElement.lang).toBe('zh-CN')
  })
})
