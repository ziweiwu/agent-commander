/**
 * The composer's text box has an accessible name of its own, in both
 * languages, rather than leaning on a placeholder that disappears as soon as
 * anything is typed. The terminal's compose box already has one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { Chat } from '../../src/web/components/Chat.tsx'
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
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
}))

const kbVault = () => agent({ sessionId: 'kb', name: 'kb-vault', paneId: '%1' })

beforeEach(resetStore)

describe('the composer text box is named for its agent', () => {
  it('is named "Message to <name>" and keeps its placeholder', () => {
    renderApp(<Chat agent={kbVault()} />)
    const box = screen.getByRole('textbox', { name: 'Message to kb-vault' })
    expect(box.getAttribute('data-testid')).toBe('composer-input')
    expect(box.getAttribute('placeholder')).toBe('Message kb-vault')
  })

  it('is named in Chinese for a Chinese reader', () => {
    useStore.setState({ lang: 'zh-CN' })
    renderApp(<Chat agent={kbVault()} />)
    expect(screen.getByRole('textbox', { name: '发给 kb-vault 的消息' })).toBeTruthy()
  })
})
