import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store/store.ts'
import { longestWaiting } from '../lib/hop.ts'
import { shortName } from '../lib/naming.ts'
import { uptimeParts } from '../lib/format.ts'
import { formatUptime } from '../lib/i18n.ts'
import { useLang, useTranslate } from '../hooks/useTranslate.ts'
import { useHop } from '../hooks/useHop.ts'
import { Button } from './ui/Button.tsx'
import styles from './HandOff.module.css'

/** Whether to offer the hand-off on this agent, and the call that arms it. */
export interface HandOffState {
  shown: boolean
  arm: () => void
}

/**
 * Remember that this page has just answered a single question on this agent.
 *
 * Held here rather than inside the answer card because the card goes the
 * moment the agent stops waiting — which, for an answer that worked, is the
 * next registry scan — and "who is next" is the question on the reader's mind
 * for longer than that. It is let go when a *new* question arrives (the next
 * decision is that one), when the server refuses the answer (nothing was
 * answered), or when another agent is opened.
 */
export function useHandOff(sessionId: string, promptId: string | undefined): HandOffState {
  const [answered, setAnswered] = useState<{ sessionId: string; promptId?: string } | null>(null)
  const refused = useStore((s) => s.answerRefused)
  useEffect(() => {
    if (refused?.sessionId === sessionId) setAnswered(null)
  }, [refused, sessionId])
  useEffect(() => {
    setAnswered((held) => (held && promptId !== undefined && promptId !== held.promptId ? null : held))
  }, [promptId])
  const arm = useCallback(() => setAnswered({ sessionId, promptId }), [sessionId, promptId])
  return { shown: answered?.sessionId === sessionId, arm }
}

/**
 * "Next: ‹name› · waiting 14m ⌥H", under a question this page has just answered.
 *
 * The agent it names is the one ⌥H would open — the one that has needed you
 * longest — so the key printed on it is the key that does the same thing.
 *
 * **It is a button and nothing more.** It never navigates on its own: an answer
 * is a decision about this agent, and being carried off to another one the
 * moment it is sent would take away the look at what the agent does with it.
 * Absent when no other agent needs you.
 */
export function HandOff({ from }: { from: string }) {
  const t = useTranslate()
  const lang = useLang()
  const hop = useHop()
  const agents = useStore((s) => s.agents)
  const exited = useStore((s) => s.exited)
  const next = longestWaiting(agents, from, exited)
  if (!next) return null
  const name = shortName(next)
  const age = formatUptime(lang, uptimeParts(next.lastActivityAt))
  return (
    <Button
      className={styles.next}
      data-testid="answer-next"
      aria-keyshortcuts="Alt+H"
      onClick={() => hop(next.sessionId, 'chat')}
    >
      <span className={styles.text}>
        {age ? t('answerNext', { name, age }) : t('answerNextNoAge', { name })}
      </span>
      <kbd className={styles.key} aria-hidden="true">
        ⌥H
      </kbd>
    </Button>
  )
}
