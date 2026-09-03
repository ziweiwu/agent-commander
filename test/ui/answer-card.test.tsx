/**
 * Answering a blocked agent from the conversation.
 *
 * The card exists because the alternative was the Attach tab — a faithful
 * capture of somebody else's terminal, which is a fine thing to read and a poor
 * thing to answer a multiple choice on from a phone.
 *
 * What makes it safe to answer here is that nothing is guessed. The options are
 * read out of the agent's own transcript, which Claude Code flushes *before*
 * the dialog is answered, and where the transcript does not state them this
 * says so instead of inventing a list (INV-16). A mislabelled button here
 * answers a live agent's question wrongly, which is exactly what INV-11 exists
 * to prevent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Chat } from '../../src/web/components/Chat.tsx'
import { AnswerCard } from '../../src/web/components/AnswerCard.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'
import { useStore } from '../../src/web/store/store.ts'
import type { PendingPrompt } from '../../src/shared/types.ts'

const sendKey = vi.hoisted(() => vi.fn())
const sendConfirmedKey = vi.hoisted(() => vi.fn())
const answerPrompt = vi.hoisted(() => vi.fn())

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

beforeEach(() => {
  resetStore()
  sendKey.mockClear()
  sendConfirmedKey.mockClear()
  answerPrompt.mockClear()
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

  it('names no option for a plan, because the CLI composes those choices', () => {
    renderApp(
      <AnswerCard
        agent={blocked()}
        prompt={{ tool: 'ExitPlanMode', detail: '## Steps\n1. Do the thing' }}
      />,
    )
    expect(screen.queryByTestId('answer-option')).toBeNull()
    expect(screen.getByTestId('answer-no-options')).toBeTruthy()
    // What *is* known is still shown: the plan being approved.
    expect(screen.getByTestId('answer-detail').textContent).toContain('Do the thing')
  })

  it('names no option for a permission request, but says what it is about', () => {
    renderApp(
      <AnswerCard agent={blocked()} prompt={{ tool: 'Bash', detail: 'Clear the build tree' }} />,
    )
    expect(screen.queryByTestId('answer-option')).toBeNull()
    expect(screen.getByTestId('answer-detail').textContent).toContain('Clear the build tree')
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
