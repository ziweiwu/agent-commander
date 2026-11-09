/**
 * Reading the conversation from the keyboard, and arrows that stay arrows
 * (FR-UI-13).
 *
 * The conversation was no Tab stop and PageUp from the message box did nothing,
 * so a keyboard-only reader could not reach an earlier message. And the global
 * handler that walks the fleet's cards on ArrowUp/ArrowDown ran from anywhere
 * that was not a text field: a select lost its arrows, and ArrowUp on any
 * button in the agent's panel threw focus onto a card. The walk now runs only
 * from the list itself, the page body and the filter box.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { App, FleetRoute } from '../../src/web/components/App.tsx'
import { Chat } from '../../src/web/components/Chat.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, resetStore } from './helpers.tsx'
import { setViewport } from './setup.ts'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(),
  sendKey: vi.fn(),
  sendConfirmedKey: vi.fn(),
  sendText: vi.fn(),
  flushText: vi.fn(),
  interruptAndSend: vi.fn(),
  loadEnv: vi.fn(),
  startAgent: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
  answerPrompt: vi.fn(),
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
  setAgentModel: vi.fn(),
  setAgentGoal: vi.fn(),
  setGoal: vi.fn(),
  clearGoal: vi.fn(),
  sendShiftTab: vi.fn(),
  closeAgentById: vi.fn(),
  closeAgent: vi.fn(),
  fetchTree: vi.fn(),
}))

const DESKTOP = () => false
const VIEW_HEIGHT = 500
const READ_FROM = 2000
const PAGE_STEP = VIEW_HEIGHT * 0.9

function shell(startPath: string) {
  return render(
    <MemoryRouter initialEntries={[startPath]}>
      <Routes>
        <Route path="/*" element={<App />}>
          <Route index element={<FleetRoute />} />
          <Route path="agent/:sessionId" element={<FleetRoute />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

function openChat() {
  cleanup()
  resetStore()
  render(
    <MemoryRouter>
      <Chat agent={agent({ sessionId: 'a', status: 'idle', paneId: '%1' })} />
    </MemoryRouter>,
  )
  const scroll = screen.getByTestId('chat-scroll')
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: VIEW_HEIGHT })
  scroll.scrollTop = READ_FROM
  return { scroll, box: screen.getByTestId('composer-input') as HTMLTextAreaElement }
}

beforeEach(() => {
  resetStore()
  setViewport(DESKTOP)
  useStore.setState({
    agents: [
      agent({ sessionId: 'a', name: 'alpha', status: 'idle', paneId: '%1' }),
      agent({ sessionId: 'b', name: 'beta', status: 'idle', paneId: '%2' }),
    ],
  })
})

describe('arrows keep their native meaning outside the agent list (FR-UI-13)', () => {
  it('leaves ArrowDown on the sort select to the select, and focus stays on it', () => {
    shell('/')
    const select = screen.getByTestId('sort-select')
    select.focus()

    const passed = fireEvent.keyDown(select, { key: 'ArrowDown' })

    expect(passed).toBe(true)
    expect(document.activeElement).toBe(select)
  })

  it('leaves ArrowUp on a button outside the list where it is', () => {
    shell('/')
    const button = screen.getByTestId('new-agent-button')
    button.focus()

    fireEvent.keyDown(button, { key: 'ArrowUp' })
    fireEvent.keyDown(button, { key: 'j' })

    expect(document.activeElement).toBe(button)
  })

  it('still walks the cards from the page body, and from card to card', () => {
    shell('/')
    ;(document.activeElement as HTMLElement | null)?.blur()

    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    const first = document.activeElement
    expect(first?.getAttribute('data-testid')).toBe('agent-card')

    fireEvent.keyDown(first as HTMLElement, { key: 'j' })
    expect(document.activeElement?.getAttribute('data-testid')).toBe('agent-card')
    expect(document.activeElement).not.toBe(first)
  })
})

describe('the conversation can be read from the keyboard (FR-UI-13)', () => {
  it('is one named Tab stop', () => {
    const { scroll } = openChat()
    expect(scroll.tabIndex).toBe(0)
    expect(scroll.getAttribute('role')).toBe('region')
    expect(scroll.getAttribute('aria-label')).toBe('Conversation')
  })

  it('is named in Chinese too', () => {
    cleanup()
    resetStore()
    useStore.setState({ lang: 'zh-CN' })
    render(
      <MemoryRouter>
        <Chat agent={agent({ sessionId: 'a', status: 'idle', paneId: '%1' })} />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('chat-scroll').getAttribute('aria-label')).toBe('对话')
  })

  it('scrolls back a page on PageUp from the message box', () => {
    const { scroll, box } = openChat()
    box.focus()

    const passed = fireEvent.keyDown(box, { key: 'PageUp' })

    expect(passed).toBe(false)
    expect(scroll.scrollTop).toBe(READ_FROM - PAGE_STEP)
    expect(document.activeElement).toBe(box)
  })

  it('scrolls on a page on PageDown from the message box', () => {
    const { scroll, box } = openChat()

    fireEvent.keyDown(box, { key: 'PageDown' })

    expect(scroll.scrollTop).toBe(READ_FROM + PAGE_STEP)
  })

  it('leaves PageUp to a draft tall enough to scroll inside itself', () => {
    const { scroll, box } = openChat()
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 300 })
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 120 })

    const passed = fireEvent.keyDown(box, { key: 'PageUp' })

    expect(passed).toBe(true)
    expect(scroll.scrollTop).toBe(READ_FROM)
  })
})
