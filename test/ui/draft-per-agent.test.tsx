/**
 * F1: a half-typed message stays with the agent it was written for.
 *
 * The composer's draft was `useState` inside `<Chat>`, and nothing keyed
 * `<Chat>` by agent. So it failed three ways, one per mount path:
 *
 *  - switching agents kept the component, and A's half-written reply sat in
 *    B's box, one Enter away from going to the wrong agent;
 *  - ‹ Agents on a phone unmounts the sheet, and the text went with it;
 *  - ⤢ mounts a second `<Chat>` inside `FullscreenView`, which started empty.
 *
 * The draft is held in the store per agent now, in memory only (INV-3), and
 * only a send that went lets it go. `draftRef` is still the synchronous guard
 * `burst-send.test.tsx` holds (INV-2). The Attach tab's paste line had the same
 * shape and gets the same treatment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentDetail } from '../../src/web/components/AgentDetail.tsx'
import { Chat } from '../../src/web/components/Chat.tsx'
import { Terminal } from '../../src/web/components/Terminal.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

const sendMessage = vi.hoisted(() => vi.fn())
vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage,
  interruptAndSend: vi.fn(),
  sendKey: vi.fn(),
  sendConfirmedKey: vi.fn(),
  sendText: vi.fn(),
  runText: vi.fn(),
  flushText: vi.fn(),
  loadEnv: vi.fn(),
  startAgent: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
  requestHistory: vi.fn(),
  answerPrompt: vi.fn(),
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
  setAgentModel: vi.fn(),
  setAgentGoal: vi.fn(),
  sendShiftTab: vi.fn(),
  closeAgent: vi.fn(),
  uploadPicture: vi.fn(),
}))

const A = agent({ sessionId: 'a', status: 'idle', paneId: '%1' })
const B = agent({ sessionId: 'b', status: 'idle', paneId: '%2' })

const box = () => screen.getByTestId('composer-input') as HTMLTextAreaElement
const pasteLine = () => screen.getByTestId('term-compose-input') as HTMLTextAreaElement

/** The panel the way the app mounts it: one `<Chat>`, not keyed by agent. */
const detail = (shown = A) => (
  <AgentDetail agent={shown} tab="chat" sheet={false} onTab={() => {}} onClose={() => {}} />
)

beforeEach(() => {
  resetStore()
  useStore.setState({ agents: [A, B], selected: 'a' })
  sendMessage.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('F1 a draft belongs to the agent it was typed for', () => {
  it('keeps A’s draft out of B’s box, and gives each back on the way back', async () => {
    const user = userEvent.setup()
    const { rerender } = renderApp(detail(A))
    await user.type(box(), 'half a reply to a')

    rerender(detail(B))
    expect(box().value).toBe('')
    await user.type(box(), 'something for b')

    rerender(detail(A))
    expect(box().value).toBe('half a reply to a')
    rerender(detail(B))
    expect(box().value).toBe('something for b')
  })

  it('survives the panel closing and opening again, as ‹ Agents does on a phone', async () => {
    const user = userEvent.setup()
    const { unmount } = renderApp(detail(A))
    await user.type(box(), 'still thinking about this')
    unmount()

    renderApp(detail(A))
    expect(box().value).toBe('still thinking about this')
  })

  it('survives ⤢ full screen and back, which mounts a second Chat', async () => {
    const user = userEvent.setup()
    renderApp(detail(A))
    await user.type(box(), 'a long reply, read in full screen')

    await user.click(screen.getByTestId('fullscreen-toggle'))
    expect(screen.getByTestId('fullscreen-view')).toBeTruthy()
    expect(box().value).toBe('a long reply, read in full screen')

    await user.click(screen.getByTestId('fullscreen-exit'))
    expect(screen.queryByTestId('fullscreen-view')).toBeNull()
    expect(box().value).toBe('a long reply, read in full screen')
  })

  it('clears only the draft a send took, and leaves every other agent’s alone', async () => {
    const user = userEvent.setup()
    const { rerender } = renderApp(detail(A))
    await user.type(box(), 'for a')
    rerender(detail(B))
    await user.type(box(), 'for b')
    rerender(detail(A))

    await user.click(box())
    await user.keyboard('{Enter}')
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith('for a')
    expect(box().value).toBe('')

    rerender(detail(B))
    expect(box().value).toBe('for b')
    rerender(detail(A))
    expect(box().value).toBe('')
  })

  it('keeps a draft whose send could not go, across a switch and back', async () => {
    const user = userEvent.setup()
    useStore.setState({ conn: 'closed' })
    const { rerender } = renderApp(detail(A))
    await user.type(box(), 'send me later')
    await user.keyboard('{Enter}')
    expect(sendMessage).not.toHaveBeenCalled()

    rerender(detail(B))
    rerender(detail(A))
    expect(box().value).toBe('send me later')
  })

  it('puts the box back to the height its draft had grown to', async () => {
    const user = userEvent.setup()
    const LINE_PX = 20
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
      this: HTMLTextAreaElement,
    ) {
      return this.value.split('\n').length * LINE_PX
    })
    const { rerender } = renderApp(detail(A))
    await user.type(box(), 'one{Shift>}{Enter}{/Shift}two{Shift>}{Enter}{/Shift}three')
    expect(box().style.height).toBe(`${3 * LINE_PX}px`)

    rerender(detail(B))
    expect(box().style.height).toBe('')
    rerender(detail(A))
    expect(box().style.height).toBe(`${3 * LINE_PX}px`)
  })

  it('holds the draft in memory only, never in browser storage (INV-3)', async () => {
    const user = userEvent.setup()
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    renderApp(<Chat agent={A} />)
    await user.type(box(), 'private words to an agent')

    const leaked = writes.mock.calls.filter(([, value]) => String(value).includes('private words'))
    expect(leaked).toEqual([])
  })
})

describe('F1 drafts of agents that have gone', () => {
  it('lets go of a draft once its session has left the fleet', () => {
    const { keepDraft } = useStore.getState()
    useStore.setState({ selected: null })
    keepDraft('chat', 'a', { text: 'for a', height: null })
    keepDraft('paste', 'a', { text: 'ls', height: null })
    keepDraft('chat', 'b', { text: 'for b', height: null })

    act(() => useStore.getState().pruneDrafts(['b']))

    const { drafts } = useStore.getState()
    expect(Object.keys(drafts.chat)).toEqual(['b'])
    expect(Object.keys(drafts.paste)).toEqual([])
  })

  /**
   * After a `/clear` the old id leaves the fleet for a scan or two while the
   * route follows the agent to its new one, and the panel stays up on it in
   * between. Whatever is being typed there in that gap is still the reader's.
   */
  it('keeps the draft of the agent on screen even while the fleet does not list it', () => {
    useStore.getState().keepDraft('chat', 'a', { text: 'mid-sentence', height: null })
    act(() => useStore.getState().pruneDrafts([]))
    expect(useStore.getState().drafts.chat.a?.text).toBe('mid-sentence')
  })
})

describe('F1 the Attach tab’s paste line is per agent too', () => {
  const terminal = (shown: typeof A) => <Terminal agent={shown} onExit={() => {}} />

  it('keeps A’s line out of B’s, and gives it back', async () => {
    const user = userEvent.setup()
    const { rerender } = renderApp(terminal(A))
    await user.type(pasteLine(), 'git status')

    rerender(terminal(B))
    expect(pasteLine().value).toBe('')

    rerender(terminal(A))
    expect(pasteLine().value).toBe('git status')
  })
})
