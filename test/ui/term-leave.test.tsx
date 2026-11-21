/**
 * WCAG 2.1.2: a keyboard trap is allowed only when the way out is said.
 *
 * Inside the terminal Tab and Esc go to the agent, and Shift+Esc is the one
 * way out. Help said so and nothing at the terminal did. The key bar now
 * carries the sentence, and xterm's input names it as its description, so a
 * screen reader hears it on arriving in the terminal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { Terminal } from '../../src/web/components/Terminal.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendText: vi.fn(),
  runText: vi.fn(),
  sendKey: vi.fn(),
  sendConfirmedKey: vi.fn(),
  sendShiftTab: vi.fn(),
  setAttached: vi.fn(),
  requestHistory: vi.fn(),
}))

beforeEach(resetStore)

const described = async (): Promise<string> => {
  renderApp(<Terminal agent={agent({ sessionId: 'a', paneId: '%1' })} onExit={() => {}} />)
  const input = await waitFor(() => {
    const box = document.querySelector<HTMLTextAreaElement>('[data-testid="terminal"] textarea.xterm-helper-textarea')
    expect(box).not.toBeNull()
    return box as HTMLTextAreaElement
  })
  const ids = (input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
}

describe('the terminal says how to leave it', () => {
  it('describes its input with the Shift+Esc way out', async () => {
    expect(await described()).toContain('Shift+Esc leaves the terminal')
  })

  it('says it in Chinese', async () => {
    useStore.setState({ lang: 'zh-CN' })
    expect(await described()).toContain('按 Shift+Esc 离开终端')
  })
})
