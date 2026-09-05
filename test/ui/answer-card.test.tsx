/**
 * Answering a blocked agent from the conversation.
 *
 * The card exists because the alternative was the Attach tab — a faithful
 * capture of somebody else's terminal, which is a fine thing to read and a poor
 * thing to answer a multiple choice on from a phone.
 *
 * What makes it safe to answer here is that nothing is guessed. The options are
 * read out of the agent's own transcript, which Claude Code flushes *before*
 * the dialog is answered. Where the transcript does not state them — a plan
 * approval, a tool permission — the card offers the choices Claude Code draws
 * for that dialog, flagged as drawn and shown above a live capture of the pane
 * that can contradict them (INV-16). A mislabelled button here answers a live
 * agent's question wrongly, which is exactly what INV-11 exists to prevent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Chat } from '../../src/web/components/Chat.tsx'
import { AnswerCard } from '../../src/web/components/AnswerCard.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'
import { useStore } from '../../src/web/store/store.ts'
import type { PendingPrompt } from '../../src/shared/types.ts'

// The live capture is xterm behind a lazy import; here it only has to be
// present or absent. `test/ui/pane-peek.test.tsx` proves what it does.
vi.mock('../../src/web/components/LazyTerminal.tsx', () => ({
  LazyPanePeek: () => <div data-testid="pane-peek" />,
  LazyTerminal: () => null,
}))

const sendKey = vi.hoisted(() => vi.fn())
const sendConfirmedKey = vi.hoisted(() => vi.fn())
// Answers `true` like a socket that took the frame; the CLOSING-gap test below
// routes one call through the real transport instead.
const answerPrompt = vi.hoisted(() =>
  vi.fn((_session: string, _prompt: string, _choice: number): boolean => true),
)

vi.mock('../../src/web/store/transport.ts', () => ({
  sendKey,
  sendConfirmedKey,
  answerPrompt,
  sendMessage: vi.fn(),
  sendText: vi.fn(),
  flushText: vi.fn(),
  interruptAndSend: vi.fn(),
  loadEnv: vi.fn(),
  startAgent: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
  setAgentGoal: vi.fn(),
  sendShiftTab: vi.fn(),
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
}))

const QUESTION: PendingPrompt = {
  tool: 'AskUserQuestion',
  question: 'Which migration should run first?',
  options: [
    { label: 'Backfill the index', description: 'Slower, but safe.' },
    { label: 'Swap the table', description: 'Faster, with a gap.' },
  ],
  // The server derives this from the prompt's own content and refuses an
  // answer that no longer matches; the card only has to echo it back.
  id: 'prompt-fingerprint',
}

const blocked = () => agent({ sessionId: 'a', status: 'waiting', paneId: '%1' })

/* What the server sends for the two dialogs whose choices the transcript never
   states: Claude Code's own numbering, flagged as drawn (INV-16). */
const DRAWN = [
  { label: 'Yes', description: 'Allow this once' },
  { label: "Yes, and don't ask again", description: 'As the terminal says' },
  { label: 'No, and tell Claude what to do differently', description: 'Refuse' },
]
const PLAN: PendingPrompt = {
  tool: 'ExitPlanMode',
  detail: '## Steps\n1. Do the thing',
  options: DRAWN,
  optionsDrawn: true,
  id: 'plan-fingerprint',
}
const PERMISSION: PendingPrompt = {
  tool: 'Bash',
  detail: 'Clear the build tree',
  options: DRAWN,
  optionsDrawn: true,
  id: 'permission-fingerprint',
}

beforeEach(() => {
  resetStore()
  sendKey.mockClear()
  sendConfirmedKey.mockClear()
  answerPrompt.mockReset().mockImplementation(() => true)
})

describe('INV-16 the verified answer outranks the escape hatch', () => {
  /*
   * `Enter` commits whatever the real pane has highlighted, which is not
   * necessarily the option the user just read. Drawn beside the labelled
   * buttons at equal weight, it invited exactly that slip.
   */
  it('demotes the raw keys below a labelled answer, and says what they are for', () => {
    renderApp(<AnswerCard agent={blocked()} prompt={QUESTION} />)
    const keys = screen.getByRole('group', { name: /answer keys/i })
    expect(keys.dataset.secondary).toBe('true')
    const note = screen.getByTestId('answer-keys-fallback')
    expect(note.textContent).toMatch(/terminal keys/i)
    // Demoted, not removed: the keys are still there for a picker whose
    // rendering disagrees with the transcript.
    expect(screen.getByTestId('answer-key-Enter')).toBeTruthy()
    // The rule and the note come before the keys, so the reading order is
    // "answer, then the fallback", which is the order of trust.
    expect(note.compareDocumentPosition(keys) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the keys primary when the transcript named nothing', () => {
    const permission: PendingPrompt = { tool: 'Bash', detail: 'rm -rf dist', id: 'p' }
    renderApp(<AnswerCard agent={blocked()} prompt={permission} />)
    expect(screen.getByRole('group', { name: /answer keys/i }).dataset.secondary).toBeUndefined()
    expect(screen.queryByTestId('answer-keys-fallback')).toBeNull()
  })

  it('keeps the keys primary for a multi-select, which a digit cannot finish', () => {
    renderApp(<AnswerCard agent={blocked()} prompt={{ ...QUESTION, multiSelect: true }} />)
    expect(screen.getByRole('group', { name: /answer keys/i }).dataset.secondary).toBeUndefined()
  })
})

describe('INV-16 the card names only what the transcript named', () => {
  it('labels a button with each option the transcript stated', () => {
    renderApp(<AnswerCard agent={blocked()} prompt={QUESTION} />)
    const options = screen.getAllByTestId('answer-option')
    expect(options).toHaveLength(2)
    expect(options[0]?.textContent).toContain('Backfill the index')
    expect(options[1]?.textContent).toContain('Swap the table')
  })

  /*
   * The choice is absolute, and it is a choice rather than a keystroke. A
   * relative move has to assume where the highlight started; a bare digit
   * assumes the pane is still showing the same question. Sending the index
   * alongside the prompt's id lets the server refuse both mistakes — it
   * composes the keystroke itself, and only if the question still matches.
   */
  it('answers with the option index, bound to the prompt it was shown for', async () => {
    const user = userEvent.setup()
    renderApp(<AnswerCard agent={blocked()} prompt={QUESTION} />)
    await user.click(screen.getAllByTestId('answer-option')[1] as HTMLElement)
    expect(answerPrompt).toHaveBeenCalledWith('a', 'prompt-fingerprint', 1)
    expect(sendKey).not.toHaveBeenCalled()
  })

  /*
   * INV-2, and the sharpest edge in this card: a second press is not a
   * duplicate. `AskUserQuestion` asks its questions one at a time, so the
   * second digit would answer the *next* one — a question the user has not
   * read yet.
   */
  it('sends one answer from a double click, because the second would answer the next question', async () => {
    const user = userEvent.setup()
    renderApp(<AnswerCard agent={blocked()} prompt={QUESTION} />)
    const first = screen.getAllByTestId('answer-option')[0] as HTMLElement
    await user.click(first)
    await user.click(first)
    expect(answerPrompt).toHaveBeenCalledTimes(1)
  })

  /*
   * The CLI composes a plan's approval choices at the terminal, so the labels
   * offered are the drawn ones — and the card says so, in words and with a
   * dashed edge, next to the live pane they can be checked against.
   */
  it('labels a plan with the drawn choices, says they are drawn, and shows the pane', () => {
    renderApp(<AnswerCard agent={blocked()} prompt={PLAN} />)
    const options = screen.getAllByTestId('answer-option')
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Yes'),
      expect.stringContaining("don't ask again"),
      expect.stringContaining('No, and tell Claude'),
    ])
    expect(screen.getByTestId('answer-drawn').textContent).toMatch(/how Claude Code draws/)
    expect(screen.getByTestId('answer-options').getAttribute('data-drawn')).toBe('true')
    expect(options[0]?.getAttribute('aria-describedby')).toBe('answer-drawn-note')
    expect(screen.getByTestId('answer-peek')).toBeTruthy()
    expect(screen.getByTestId('pane-peek')).toBeTruthy()
    // What *is* known is still shown: the plan being approved.
    expect(screen.getByTestId('answer-detail').textContent).toContain('Do the thing')
  })

  it('labels a permission request the same way, and still says what it is about', () => {
    renderApp(<AnswerCard agent={blocked()} prompt={PERMISSION} />)
    expect(screen.getAllByTestId('answer-option')).toHaveLength(3)
    expect(screen.getByTestId('answer-drawn')).toBeTruthy()
    expect(screen.getByTestId('answer-detail').textContent).toContain('Clear the build tree')
  })

  it('answers a drawn choice with its index, bound to the prompt, like a stated one', async () => {
    const user = userEvent.setup()
    renderApp(<AnswerCard agent={blocked()} prompt={PERMISSION} />)
    await user.click(screen.getAllByTestId('answer-option')[2] as HTMLElement)
    expect(answerPrompt).toHaveBeenCalledWith('a', 'permission-fingerprint', 2)
  })

  /* A question the transcript stated in full needs no second opinion: no
     caveat, no dashed edge, no pane. */
  it('does not caveat or show the pane for options the transcript stated', () => {
    renderApp(<AnswerCard agent={blocked()} prompt={QUESTION} />)
    expect(screen.queryByTestId('answer-drawn')).toBeNull()
    expect(screen.getByTestId('answer-options').getAttribute('data-drawn')).toBeNull()
    expect(screen.queryByTestId('answer-peek')).toBeNull()
  })

  it('shows the pane wherever only keys are offered, so the highlight can be seen', () => {
    renderApp(<AnswerCard agent={blocked()} prompt={{ ...QUESTION, multiSelect: true }} />)
    expect(screen.getByTestId('answer-peek')).toBeTruthy()
  })

  it('shows no pane for an agent with no pane', () => {
    renderApp(
      <AnswerCard
        agent={agent({ sessionId: 'a', status: 'waiting', paneId: undefined })}
        prompt={PERMISSION}
      />,
    )
    expect(screen.queryByTestId('answer-peek')).toBeNull()
  })

  /*
   * With the socket down nothing is sent, and the card used to disable itself
   * and announce "Answer sent" anyway — then stay dead through the reconnect.
   * INV-11: it must not claim an answer it did not send.
   */
  it('refuses to answer while the socket is down, and claims nothing', async () => {
    const user = userEvent.setup()
    useStore.setState({ conn: 'connecting' })
    renderApp(<AnswerCard agent={blocked()} prompt={QUESTION} />)
    const first = screen.getAllByTestId('answer-option')[0] as HTMLButtonElement
    expect(first.disabled).toBe(true)
    expect((screen.getByTestId('answer-key-Enter') as HTMLButtonElement).disabled).toBe(true)
    await user.click(first)
    expect(answerPrompt).not.toHaveBeenCalled()
    expect(useStore.getState().toast).toBeNull()
    // Back online, the same question is answerable: nothing was spent.
    act(() => useStore.setState({ conn: 'open' }))
    expect((screen.getAllByTestId('answer-option')[0] as HTMLButtonElement).disabled).toBe(false)
  })

  /*
   * The gap `conn` cannot see. A socket that has begun closing drops the frame
   * before its `close` listener sets `conn`, so the button is enabled, the
   * click writes nothing, and the card used to latch, say "Answer sent" and
   * stay dead for this question through the reconnect. `send()` now reports
   * whether the frame was written, and the card believes that rather than the
   * store (INV-11). The call goes through the real transport, against a socket
   * stubbed CLOSING, so both halves of the contract are on trial.
   */
  it('claims nothing and spends nothing when the socket is closing under an open conn', async () => {
    const user = userEvent.setup()
    const real = await vi.importActual<typeof import('../../src/web/store/transport.ts')>(
      '../../src/web/store/transport.ts',
    )
    const written: string[] = []
    class ClosingSocket {
      static readonly OPEN = 1
      readyState = 1
      readonly listeners = new Map<string, Array<(e: unknown) => void>>()
      send(raw: string): void {
        written.push(raw)
      }
      addEventListener(type: string, fn: (e: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
      }
      fire(type: string): void {
        for (const fn of this.listeners.get(type) ?? []) fn({})
      }
      close(): void {}
    }
    const sockets: ClosingSocket[] = []
    const originalSocket = globalThis.WebSocket
    vi.stubGlobal(
      'WebSocket',
      // A `vi.fn(() => …)` cannot be `new`-ed; a class can.
      class extends ClosingSocket {
        constructor() {
          super()
          sockets.push(this)
        }
      },
    )
    try {
      real.connect()
      const socket = sockets[0] as ClosingSocket
      socket.fire('open')
      expect(useStore.getState().conn).toBe('open')
      // CLOSING: the browser has stopped writing and `close` has not fired yet.
      socket.readyState = 2
      answerPrompt.mockImplementationOnce(real.answerPrompt)

      renderApp(<AnswerCard agent={blocked()} prompt={QUESTION} />)
      const first = screen.getAllByTestId('answer-option')[0] as HTMLButtonElement
      expect(first.disabled).toBe(false)
      await user.click(first)

      expect(written).toEqual([])
      expect(answerPrompt).toHaveReturnedWith(false)
      expect(useStore.getState().toast).not.toMatch(/Answer sent/)
      expect(useStore.getState().toast).toMatch(/not sent/i)
      // Nothing was spent: the same question is still answerable, and the next
      // press goes through.
      expect(first.disabled).toBe(false)
      await user.click(first)
      expect(answerPrompt).toHaveBeenCalledTimes(2)
      expect(first.disabled).toBe(true)
      expect(useStore.getState().toast).toMatch(/Answer sent/)
    } finally {
      // Only this stub: the setup's own globals (matchMedia) must stay.
      vi.stubGlobal('WebSocket', originalSocket)
    }
  })

  /*
   * Every dialog whose choices the transcript does not state now arrives with
   * drawn options, so the only way to reach this branch is an `AskUserQuestion`
   * whose options could not be parsed. The copy has to describe that, not a
   * terminal that draws choices nobody wrote down.
   */
  it('says the choices could not be read when a question arrives with none', () => {
    renderApp(
      <AnswerCard
        agent={blocked()}
        prompt={{ tool: 'AskUserQuestion', question: 'Which?', options: [], id: 'q' }}
      />,
    )
    const note = screen.getByTestId('answer-no-options')
    expect(note.textContent).toMatch(/could not be read from the transcript/)
    expect(note.textContent).not.toMatch(/drawn by the terminal/)
    expect(screen.queryByTestId('answer-drawn')).toBeNull()
    expect(screen.queryByTestId('answer-option')).toBeNull()
    expect(screen.getByTestId('answer-question').textContent).toBe('Which?')
  })

  /* One digit cannot finish a multi-select, so offering one would be a button
     that looks like an answer and is not. */
  it('offers keys rather than digits when the picker takes several answers', () => {
    renderApp(<AnswerCard agent={blocked()} prompt={{ ...QUESTION, multiSelect: true }} />)
    expect(screen.queryByTestId('answer-option')).toBeNull()
    expect(screen.getByTestId('answer-key-Space')).toBeTruthy()
  })

  it('says how many questions still follow, so one answer is not read as the end', () => {
    renderApp(<AnswerCard agent={blocked()} prompt={{ ...QUESTION, moreQuestions: 2 }} />)
    expect(screen.getByTestId('answer-more').textContent).toContain('2')
  })

  // INV-6: Escape destroys work in flight, so it asks first — wherever it is.
  it('confirms before sending Escape, and sends nothing when refused', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderApp(<AnswerCard agent={blocked()} prompt={QUESTION} />)
    await user.click(screen.getByTestId('answer-key-Escape'))
    expect(sendConfirmedKey).not.toHaveBeenCalled()
    vi.mocked(window.confirm).mockRestore()
  })

  it('cannot answer an agent with no pane', () => {
    renderApp(
      <AnswerCard
        agent={agent({ sessionId: 'a', status: 'waiting', paneId: undefined })}
        prompt={QUESTION}
      />,
    )
    expect((screen.getAllByTestId('answer-option')[0] as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('INV-16 the card appears only when both halves agree', () => {
  const show = (status: 'waiting' | 'busy' | 'idle', prompt: PendingPrompt | null) => {
    useStore.setState({ prompt })
    renderApp(<Chat agent={agent({ sessionId: 'a', status, paneId: '%1' })} />)
  }

  it('offers the answer when the agent is waiting and the transcript says on what', () => {
    show('waiting', QUESTION)
    expect(screen.getByTestId('answer-card')).toBeTruthy()
  })

  /*
   * A tool that is merely *running* leaves an open call that looks exactly like
   * one waiting to be allowed. Without the status this would offer to answer a
   * question nobody is asking.
   */
  it('offers nothing while the agent is working, however open the call looks', () => {
    show('busy', QUESTION)
    expect(screen.queryByTestId('answer-card')).toBeNull()
  })

  it('offers nothing when the transcript cannot say what is being asked', () => {
    show('waiting', null)
    expect(screen.queryByTestId('answer-card')).toBeNull()
  })
})

/*
 * The answer buttons are what a keyboard user opened a blocked agent for, and
 * they sit before the composer — where Shift+Tab is the mode chord, not a step
 * back. Landing in the composer left them reachable only by tabbing forward
 * through every control in the app.
 */
describe('focus on a blocked agent', () => {
  const open = (status: 'waiting' | 'busy', prompt: PendingPrompt | null) => {
    useStore.setState({ prompt })
    renderApp(<Chat agent={agent({ sessionId: 'a', status, paneId: '%1' })} />)
  }

  it('lands on the first answer option, not the composer', () => {
    open('waiting', QUESTION)
    expect(document.activeElement).toBe(screen.getAllByTestId('answer-option')[0])
  })

  it('lands in the composer when there is nothing to answer', () => {
    open('busy', null)
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })

  it('does not take focus from a sentence in progress when a question arrives', async () => {
    const user = userEvent.setup()
    open('waiting', null)
    await user.type(screen.getByRole('textbox'), 'half a thought')
    act(() => useStore.setState({ prompt: QUESTION }))
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })

  it('tells assistive tech that Shift+Tab in the composer is the mode chord', () => {
    open('busy', null)
    const box = screen.getByRole('textbox')
    const hint = document.getElementById(box.getAttribute('aria-describedby') ?? '')
    expect(hint?.textContent).toContain('Shift+Tab')
  })
})

describe('a refused answer releases the card (INV-11)', () => {
  it('re-enables the options when the server refuses this agent’s answer, and not another’s', async () => {
    const user = userEvent.setup()
    answerPrompt.mockReturnValue(true)
    renderApp(<AnswerCard agent={blocked()} prompt={PERMISSION} />)
    const first = () => screen.getAllByTestId('answer-option')[0] as HTMLButtonElement
    await user.click(first())
    expect(first().disabled).toBe(true)

    // Somebody else's refusal is not this card's business.
    act(() => useStore.getState().markAnswerRefused('someone-else'))
    expect(first().disabled).toBe(true)

    // Ours: the pane was not drawing that row, nothing was typed, and the
    // question is still the one on screen.
    act(() => useStore.getState().markAnswerRefused('a'))
    expect(first().disabled).toBe(false)
    await user.click(first())
    expect(answerPrompt).toHaveBeenCalledTimes(2)
  })
})
