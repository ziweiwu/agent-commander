import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
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

/**
 * The scheme is a second axis, not a longer list of themes.
 *
 * Folding "which palette" and "light or dark" into one menu would mean ten
 * entries and no way to say "Ember, but follow the system" — which is the
 * combination most people actually want, since the system preference is
 * already a statement about the room they are sitting in.
 */
describe('colour schemes', () => {
  it('applies a scheme to the document', async () => {
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)

    await user.click(screen.getByTestId('settings-button'))
    await user.click(screen.getByTestId('scheme-ember'))

    expect(document.documentElement.getAttribute('data-scheme')).toBe('ember')
  })

  // The default is the bare `:root` in the CSS, so it must set no attribute —
  // otherwise a document with no attributes at all would not be a theme.
  it('removes the attribute for the default scheme', async () => {
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)

    await user.click(screen.getByTestId('settings-button'))
    await user.click(screen.getByTestId('scheme-nordic'))
    expect(document.documentElement.getAttribute('data-scheme')).toBe('nordic')

    await user.click(screen.getByTestId('scheme-graphite'))
    expect(document.documentElement.hasAttribute('data-scheme')).toBe(false)
  })

  /*
   * Unlike the theme and language choices, which close the menu so the result
   * is visible at once. Picking a palette is a thing people try two or three of
   * before settling, and closing on the first one makes comparing them four
   * clicks apiece.
   */
  it('stays open so schemes can be compared', async () => {
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)

    await user.click(screen.getByTestId('settings-button'))
    await user.click(screen.getByTestId('scheme-solar'))
    expect(screen.getByTestId('settings-menu')).toBeDefined()

    await user.click(screen.getByTestId('scheme-mauve'))
    expect(document.documentElement.getAttribute('data-scheme')).toBe('mauve')
  })

  it('leaves the light/dark choice alone', async () => {
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)

    await user.click(screen.getByTestId('settings-button'))
    await user.click(screen.getByTestId('theme-dark'))
    await user.click(screen.getByTestId('settings-button'))
    await user.click(screen.getByTestId('scheme-ember'))

    // Two axes: choosing a palette must not silently pin the mode, or "Ember,
    // but follow the system" would be unreachable.
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-scheme')).toBe('ember')
  })

  it('marks the active scheme', async () => {
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)

    await user.click(screen.getByTestId('settings-button'))
    await user.click(screen.getByTestId('scheme-nordic'))

    expect(screen.getByTestId('scheme-nordic').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('scheme-graphite').getAttribute('aria-checked')).toBe('false')
  })

  it('offers every scheme the stylesheet defines', async () => {
    const user = userEvent.setup()
    const { SCHEMES } = await import('../../src/web/lib/prefs.ts')
    renderApp(<SettingsMenu />)

    await user.click(screen.getByTestId('settings-button'))
    for (const scheme of SCHEMES) {
      expect(screen.getByTestId(`scheme-${scheme}`)).toBeDefined()
    }
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

/*
 * The one layer in the app that closed on a mouse alone. A keyboard user had
 * no way to dismiss it, and tabbing past its last item left it open over the
 * page while focus sat on a control underneath it.
 */
describe('dismissing the menu without a mouse', () => {
  it('closes on Escape and hands focus back to the gear', async () => {
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)
    await user.click(screen.getByTestId('settings-button'))
    expect(screen.getByTestId('settings-menu')).toBeDefined()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('settings-menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('settings-button'))
  })

  it('closes when focus leaves it', async () => {
    const user = userEvent.setup()
    renderApp(
      <>
        <SettingsMenu />
        <button type="button" data-testid="elsewhere">elsewhere</button>
      </>,
    )
    await user.click(screen.getByTestId('settings-button'))
    // jsdom's focus() carries no relatedTarget, so the event is dispatched
    // as a browser would: focus leaving the menu for a control outside it.
    fireEvent.focusOut(screen.getByTestId('settings-menu'), {
      relatedTarget: screen.getByTestId('elsewhere'),
    })
    expect(screen.queryByTestId('settings-menu')).toBeNull()
  })

  // The way most people close this menu, and the one path that left focus
  // on <body> — the next Tab then started the document over.
  it('returns focus to the gear when a theme is chosen, not to <body>', async () => {
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)
    await user.click(screen.getByTestId('settings-button'))
    await user.click(screen.getByTestId('theme-dark'))
    expect(screen.queryByTestId('settings-menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('settings-button'))
  })

  it('returns focus to the gear when a language is chosen', async () => {
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)
    await user.click(screen.getByTestId('settings-button'))
    await user.click(screen.getByTestId('lang-zh-CN'))
    expect(document.activeElement).toBe(screen.getByTestId('settings-button'))
  })

  it('stays open while focus moves between its own items', async () => {
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)
    await user.click(screen.getByTestId('settings-button'))
    await user.tab()
    await user.tab()
    expect(screen.getByTestId('settings-menu')).toBeDefined()
  })
})
