/**
 * C4: what the words on a card mean, where a thumb can reach it.
 *
 * The vocabulary of trust (`quiet`, `ended`, `inferred`, `delegated`, the
 * `session` quota) and the reasons a control is disabled lived only in
 * `title`, which no touch screen and no keyboard can open. Help now has a
 * "Reading a card" section built from the same strings, a disabled Close says
 * why beside itself, and a bell that cannot work says why in Settings.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Help } from '../../src/web/components/Help.tsx'
import { AgentControls } from '../../src/web/components/AgentControls.tsx'
import { SettingsMenu } from '../../src/web/components/SettingsMenu.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { LANGUAGES, translate, type Key } from '../../src/web/lib/i18n.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  loadEnv: vi.fn(),
  closeAgent: vi.fn(),
  setAgentModel: vi.fn(),
}))

const I18N = readFileSync('src/web/lib/i18n.ts', 'utf8')
const EN_BLOCK = I18N.slice(0, I18N.indexOf('const ZH'))
const DELEGATE_TITLES = [...EN_BLOCK.matchAll(/^ {2}(delegate\w*Title):/gm)].map((m) => m[1] as Key)
const CARD_TITLES: Key[] = ['statusInferredTitle', 'cardNewTitle', 'sincePromptTitle', ...DELEGATE_TITLES]

const GLOSSES: Key[] = ['glossSession', 'glossDelegated']

const flat = (text: string) => text.replace(/\s+/g, ' ').trim()

beforeEach(resetStore)
afterEach(() => vi.unstubAllGlobals())

describe('C4 Help explains the words on a card', () => {
  it('finds the delegate titles it is checking', () => {
    expect(DELEGATE_TITLES.length).toBeGreaterThanOrEqual(5)
  })

  it.each(LANGUAGES)("says every card word's meaning in %s", (lang) => {
    useStore.setState({ lang })
    renderApp(<Help onClose={() => {}} />)
    const section = screen.getByTestId('help-reading-card')
    expect(section.textContent).toContain(translate(lang, 'helpSectionReading'))
    const text = flat(section.textContent ?? '')
    const missing = [...CARD_TITLES, ...GLOSSES].filter((key) => !text.includes(flat(translate(lang, key))))
    expect(missing).toEqual([])
  })

  it('is headed Reading a card, and 读懂卡片 in Chinese', () => {
    expect(translate('en', 'helpSectionReading')).toBe('Reading a card')
    expect(translate('zh-CN', 'helpSectionReading')).toBe('读懂卡片')
  })
})

describe('C4 a disabled control says why where it can be read', () => {
  it('says beside a disabled Close that it waits for idle', () => {
    renderApp(<AgentControls agent={agent({ sessionId: 'a', status: 'busy', paneId: '%1' })} />)
    const close = screen.getByTestId('close-agent')
    expect((close as HTMLButtonElement).disabled).toBe(true)
    const line = screen.getByTestId('close-reason')
    expect(line.textContent).toBe('Only while the agent is idle — interrupt it first.')
    expect(close.getAttribute('aria-describedby')).toBe(line.id)
  })

  it('says nothing beside a Close that works', () => {
    renderApp(<AgentControls agent={agent({ sessionId: 'a', status: 'idle', paneId: '%1' })} />)
    expect(screen.queryByTestId('close-reason')).toBeNull()
  })

  it('says in Settings why a browser tab cannot notify', async () => {
    vi.stubGlobal('Notification', undefined)
    const user = userEvent.setup()
    renderApp(<SettingsMenu />)
    await user.click(screen.getByTestId('settings-button'))
    expect(screen.getByTestId('notify-reason').textContent).toContain('Add the page to your Home Screen')
  })
})
