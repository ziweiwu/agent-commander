import { expect, type Page } from '@playwright/test'

/**
 * Fixture ids from `src/server/mock.ts`, named by what they are *for* here.
 *
 * Picking a fixture by index — "the second card" — is how a test comes to
 * depend on the sort order it is not testing. The mock fleet is deliberately
 * varied: a blocked one, several busy, one with no tmux at all, one with a goal
 * already running. Each of these names the property the spec needs.
 */
export const AGENT = {
  /** Idle and attachable: the one to type at and to control. */
  idle: 'mock-idle-kb',
  /** A second idle one, for tests that must not disturb the first. */
  idleAlt: 'mock-idle-ce',
  /** Blocked on a prompt — the case the whole dashboard exists to surface. */
  waiting: 'mock-waiting',
  /** Busy, so INV-8 refuses to control it. */
  busy: 'mock-busy',
  /** Not running in tmux: attach is impossible and must say why (INV-5). */
  noTmux: 'mock-no-tmux',
  /**
   * Reserved for `/clear`, and reserved because clearing is destructive to the
   * fixture itself: it rotates the session id, exactly as a real one does, so
   * the agent this test clears stops existing under the name it had. Every spec
   * shares one mock server, so pointing this at a fixture another test uses
   * deletes that test's agent out from under it.
   */
  clearable: 'mock-idle-db',
  /** Delegated, and every delegate has gone quiet with it (INV-15). */
  quietFamily: 'mock-quiet-family',
  /** Delegated, with a delegate still moving — the same shape, opposite answer. */
  movingFamily: 'mock-busy-2',
  /** A CLI that writes no subagent records, so its tree is `unknown`. */
  noSidecars: 'tmux:kiro-1787832510',
} as const

export const card = (page: Page, sessionId: string) =>
  page.locator(`[data-testid="agent-card"][data-session-id="${sessionId}"]`)

/**
 * The card *and* what hangs below it.
 *
 * The delegates disclosure is a sibling of the card rather than a child: the
 * card is itself a button, and a button inside a button is not one.
 */
export const entry = (page: Page, sessionId: string) =>
  page.locator(`[data-testid="agent-entry"][data-session-id="${sessionId}"]`)

/** Open the fleet and wait for the socket to have delivered it. */
export async function openFleet(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'open')
  await expect(page.getByTestId('agent-card').first()).toBeVisible()
}

/** Open one agent's detail view and wait for its conversation to arrive. */
export async function openAgent(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/agent/${sessionId}`)
  await expect(page.getByTestId('agent-detail')).toBeVisible()
  await expect(page.getByTestId('message').first()).toBeVisible()
}

/**
 * Text unique to this run.
 *
 * The mock's echo log lives for the life of the server and every spec shares
 * one server, so a fixed string would be matched by a copy an earlier test
 * sent. Counting copies is exactly what INV-2's "exactly once" tests do, and
 * they have to be counting their own.
 */
let unique = 0
export const stamp = (what: string): string => `${what} ${Date.now()}-${(unique += 1)}`

/**
 * Wait until the conversation has stopped arriving.
 *
 * A freshly opened tab gets the fixture timeline first and then, one tail tick
 * later, everything the mock has been sent since the server started — which,
 * across three browser projects sharing one server, is every message every
 * earlier spec sent. A baseline taken before that lands counts the backlog as
 * if this test had produced it.
 *
 * Stability rather than a fixed sleep: what is being waited for is a queue
 * draining, and how long that takes is not something to guess at.
 */
export async function settled(page: Page): Promise<void> {
  let last = -1
  await expect
    .poll(
      async () => {
        const now = await page.getByTestId('message').count()
        const stable = now === last
        last = now
        return stable
      },
      { timeout: 20_000, intervals: [1_200] },
    )
    .toBe(true)
}

/** Every message bubble whose text is exactly this. */
export const said = (page: Page, text: string) =>
  page.getByTestId('message').filter({ hasText: text })
