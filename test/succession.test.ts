/**
 * Following an agent whose session id has turned over.
 *
 * `/clear` keeps the process and the pane and changes only the id, so the pid
 * is the thread. These pin what counts as the same agent and, as importantly,
 * what does not: a kernel reuses pids, so a pid alone in a different pane is a
 * stranger, and a placeholder has no process to follow.
 */
import { describe, expect, it } from 'vitest'
import { successorOf } from '../src/web/lib/succession.ts'
import { agent } from './helpers/agent.ts'

const PID = 4421
const before = agent({ sessionId: 'before', pid: PID, paneId: '%7' })

describe('successorOf', () => {
  it('finds the same process under a new id', () => {
    const after = agent({ sessionId: 'after', pid: PID, paneId: '%7' })
    expect(successorOf(before, [agent({ sessionId: 'x', pid: 1 }), after])).toBe(after)
  })

  it('never names the agent itself', () => {
    expect(successorOf(before, [before])).toBeNull()
  })

  it('does not follow a pid into a different pane', () => {
    const elsewhere = agent({ sessionId: 'after', pid: PID, paneId: '%8' })
    expect(successorOf(before, [elsewhere])).toBeNull()
  })

  it('lets the pid decide when either side has no pane', () => {
    const noPane = agent({ sessionId: 'after', pid: PID, paneId: undefined })
    expect(successorOf(before, [noPane])?.sessionId).toBe('after')
    expect(successorOf({ ...before, paneId: undefined }, [noPane])?.sessionId).toBe('after')
  })

  it('does not follow a different process', () => {
    expect(successorOf(before, [agent({ sessionId: 'after', pid: PID + 1, paneId: '%7' })])).toBeNull()
  })

  it('has nothing to follow from a placeholder', () => {
    const placeholder = { sessionId: 'pending-x', pid: 0, paneId: '%7' }
    expect(successorOf(placeholder, [agent({ sessionId: 'real', pid: 0, paneId: '%7' })])).toBeNull()
  })
})
