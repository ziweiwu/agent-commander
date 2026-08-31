/**
 * The WebSocket, and the only thing that talks to the server.
 *
 * This lives outside React on purpose. Frames arrive about seven times a
 * second while the terminal is open, and reconnect uses exponential backoff —
 * neither belongs in a component effect. React reads the results from the
 * Zustand store.
 */
import type {
  Agent,
  AgentTree,
  ClientMessage,
  ControlResponse,
  DirListing,
  FleetTree,
  NewAgentResponse,
  ServerEnv,
  ServerMessage,
} from '../../shared/types.ts'
import { withToken } from '../lib/token.ts'
import { notifyBlocked } from '../lib/notify.ts'
import { useStore } from './store.ts'

let socket: WebSocket | null = null
let retry = 500
let announced = new Set<string>()

export function send(msg: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
}

/** Tell the server which agent this tab is looking at. */
export function focusAgent(sessionId: string | null): void {
  const state = useStore.getState()
  if (state.selected === sessionId) return
  // Whatever is half-typed belongs to the agent being left.
  flushText()
  if (state.selected && state.tab === 'attach') {
    send({ type: 'attach', sessionId: state.selected, on: false })
  }
  useStore.setState({ selected: sessionId })
  state.resetConversation()
  send({ type: 'focus', sessionId })
}

export function setAttached(on: boolean): void {
  const { selected } = useStore.getState()
  if (!selected) return
  flushText()
  useStore.setState({ tab: on ? 'attach' : 'chat' })
  if (!on) useStore.setState({ frame: null })
  send({ type: 'attach', sessionId: selected, on })
}

/**
 * Keystrokes typed in the Attach view, waiting for the pipe to be free.
 *
 * The Attach view sent one `paste` per character, and a paste is a tmux write
 * that measured p50 229ms on a busy machine. Typing at any ordinary speed
 * produces a character every ~120ms, so the writes queued and the gap between
 * pressing a key and seeing it grew for as long as the sentence lasted -- a
 * 40-character line took about 11 seconds of tmux work to deliver.
 *
 * The fix is flow control rather than a fixed timer. A guessed debounce window
 * is wrong at both ends: too short and it coalesces nothing on a slow machine,
 * too long and it adds latency on a fast one. Instead exactly one paste is
 * allowed to be in flight, and everything typed meanwhile accumulates into the
 * next one -- so the chunk size is set by how fast tmux is actually draining,
 * which is the only thing that knows. On an idle machine that is one character
 * per paste and feels immediate; on a loaded one it is a whole word, and the
 * whole word still lands sooner than its first character used to.
 *
 * INV-2 is untouched: nothing here is ever sent twice, nothing is synthesised,
 * and the ack only gates text the user has already typed.
 */
interface Outbox {
  sessionId: string
  text: string
}

let outbox: Outbox | null = null
let inFlight: number | null = null
let seq = 0
let stallTimer: number | undefined

/**
 * How long an unacknowledged paste blocks the next one.
 *
 * A dropped socket message or a server that never answers must not leave the
 * user unable to type. This releases the gate; it never re-sends what was not
 * acknowledged, which would be INV-2's exact prohibition.
 */
const ACK_TIMEOUT_MS = 2_000

function transmit(entry: Outbox): void {
  seq += 1
  inFlight = seq
  window.clearTimeout(stallTimer)
  stallTimer = window.setTimeout(() => {
    inFlight = null
    pump()
  }, ACK_TIMEOUT_MS)
  send({ type: 'paste', sessionId: entry.sessionId, text: entry.text, submit: false, seq })
}

/** Send what is waiting, if the pipe is free. */
function pump(): void {
  if (inFlight !== null || !outbox) return
  const entry = outbox
  outbox = null
  transmit(entry)
}

/**
 * Push out anything buffered, in order, right now.
 *
 * Called before every other kind of write. A key or a submitted message that
 * overtook the characters typed before it would reorder the user's input --
 * Enter arriving ahead of the line it submits is the case that matters. The
 * server queues writes per pane, so once both are on the wire their order is
 * guaranteed; what has to happen here is only that they get on the wire in the
 * order they were typed.
 */
export function flushText(): void {
  const entry = outbox
  outbox = null
  if (entry && entry.text.length > 0) {
    send({ type: 'paste', sessionId: entry.sessionId, text: entry.text, submit: false })
  }
}

function acknowledge(ackSeq: number): void {
  if (inFlight !== ackSeq) return
  inFlight = null
  window.clearTimeout(stallTimer)
  pump()
}

export function sendMessage(text: string): void {
  const { selected, addPending } = useStore.getState()
  if (!selected || text.trim().length === 0) return
  flushText()
  addPending(text)
  send({ type: 'paste', sessionId: selected, text, submit: true })
}

/**
 * Stop the agent, then say the next thing.
 *
 * Two writes, deliberately in this order and deliberately not merged into one:
 * the server queues writes per pane (`pane.ts` `enqueue`), so an `Escape` put on
 * the wire before the paste is delivered before it. Merging them into a single
 * "interrupt and send" message on the server would be a second command shape
 * for the one path that types into a live session, which INV-7 exists to
 * prevent.
 *
 * The caller is claiming a human chose to interrupt — see `sendConfirmedKey`.
 * Here that claim is made once, when the send mode is switched, rather than on
 * every message: a dialog in front of every send is one people learn to dismiss
 * without reading, which leaves the guard weaker than a single deliberate
 * choice that relabels the button it arms.
 */
export function interruptAndSend(text: string): void {
  const { selected } = useStore.getState()
  if (!selected || text.trim().length === 0) return
  sendConfirmedKey('Escape')
  sendMessage(text)
}

/** Send a control key that cannot destroy work. */
export function sendKey(key: string): void {
  const { selected } = useStore.getState()
  if (!selected) return
  flushText()
  send({ type: 'key', sessionId: selected, key })
}

/**
 * Send a key that can destroy work, saying the user was asked.
 *
 * Two functions rather than one with a flag, because they are two different
 * acts: the server refuses `C-c`, `C-d` and `Escape` without the flag (INV-6),
 * so calling this one is a claim that a human answered a dialog. A caller
 * should have to say that on purpose, not by passing `true`.
 */
export function sendConfirmedKey(key: string): void {
  const { selected } = useStore.getState()
  if (!selected) return
  flushText()
  send({ type: 'key', sessionId: selected, key, confirmed: true })
}

export function sendText(text: string): void {
  const { selected } = useStore.getState()
  if (!selected) return
  // Characters buffered while another agent was open were typed for that
  // agent, and must not be delivered to this one.
  if (outbox && outbox.sessionId !== selected) flushText()
  outbox = { sessionId: selected, text: (outbox?.text ?? '') + text }
  pump()
}

export async function loadEnv(): Promise<void> {
  try {
    const env = (await (await fetch(withToken('/api/env'))).json()) as ServerEnv
    useStore.setState({ env })
  } catch {
    // The help page falls back to generic instructions.
  }
}

export async function startAgent(
  cwd: string,
  options: { name?: string; model?: string; permissionMode?: string } = {},
): Promise<NewAgentResponse> {
  try {
    const res = await fetch(withToken('/api/agents'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd, ...options }),
    })
    return (await res.json()) as NewAgentResponse
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * A control action against a named agent.
 *
 * Split out from `control` because pruning acts on sessions the user is *not*
 * looking at, and every wrapper here used to read the selection instead of
 * taking a subject. The server has always accepted any id on this route; it
 * was only the client that could address one agent.
 */
async function controlAgent(
  sessionId: string,
  action: string,
  value?: string,
): Promise<ControlResponse> {
  try {
    const res = await fetch(withToken(`/api/agents/${encodeURIComponent(sessionId)}/${action}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify({ value }) }),
    })
    return (await res.json()) as ControlResponse
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** The same, aimed at whichever agent is open. */
async function control(action: string, value?: string): Promise<ControlResponse> {
  const { selected } = useStore.getState()
  if (!selected) return { ok: false, error: 'no agent selected' }
  return controlAgent(selected, action, value)
}

/**
 * Advance the permission mode by one Shift+Tab.
 *
 * Takes no argument on purpose. Asking for a *named* mode is what made this
 * control unreliable — see `cycleMode` in `src/server/control.ts`.
 */
export function sendShiftTab(): Promise<ControlResponse> {
  return control('mode')
}

export const setAgentModel = (model: string): Promise<ControlResponse> => control('model', model)
export const closeAgent = (): Promise<ControlResponse> => control('close')

/**
 * Discard the agent's conversation with Claude Code's `/clear`.
 *
 * On success `detail` is the id the session is running *now*. `/clear` does not
 * edit a session, it replaces one, so the caller has to follow the agent to its
 * new id — every URL and socket focus naming the old one is already dead.
 */
export const clearAgentContext = (): Promise<ControlResponse> => control('clear')

/**
 * Ask the agent to compact its own context.
 *
 * Returns as soon as the request is submitted. Compaction takes minutes, so
 * nothing here waits for it; the result shows up in the conversation on its own.
 */
export const compactAgentContext = (): Promise<ControlResponse> => control('compact')

/**
 * Close one named agent. Used by pruning, which closes sessions one at a time
 * and in order, so a machine at its process cap is not asked for several tmux
 * clients at once and a failure stops at the session it happened to.
 */
export const closeAgentById = (sessionId: string): Promise<ControlResponse> =>
  controlAgent(sessionId, 'close')
/** An empty condition is the toggle going off; the server reads it as a clear. */
export const setAgentGoal = (condition: string): Promise<ControlResponse> =>
  control('goal', condition)

/** Directory listing for the folder picker; the server confines it to a root. */
export async function browseDirs(path?: string, hidden = false): Promise<DirListing> {
  const url = withToken('/api/dirs')
  if (path) url.searchParams.set('path', path)
  if (hidden) url.searchParams.set('hidden', '1')
  const res = await fetch(url)
  const body = (await res.json()) as DirListing & { error?: string }
  if (body.error) throw new Error(body.error)
  return body
}

/**
 * The result of one poll: either a new graph, or word that it has not moved.
 *
 * `changed: false` is not an error and not an empty graph — it means the
 * caller's existing trees are still current and must be **kept by identity**,
 * which is what stops the whole view re-rendering (see `fetchTree`).
 */
export type TreeResult =
  | { changed: false }
  | { changed: true; trees: AgentTree[]; etag: string | null }

/** The graph has not moved since the caller's `ETag`; the body is empty. */
const HTTP_NOT_MODIFIED = 304

/**
 * The fleet's delegation graph.
 *
 * Fetched rather than pushed, and only while the forest is mounted — INV-4's
 * first rule is that nothing polls what nobody is watching, and a hook that
 * stops calling on unmount (`useFleetTrees`) satisfies it without adding a
 * subscription to the socket.
 *
 * **Conditional, because the graph is nearly always the same graph.** Measured
 * against 53 real sessions the payload is 54.6 KB and byte-identical from one
 * three-second poll to the next: 64 MB an hour, re-sent to a phone over
 * Tailscale. The `ETag` the server sends comes back as `If-None-Match` and the
 * answer is usually a 304 carrying nothing.
 *
 * `cache: 'no-store'` keeps the browser's own HTTP cache out of it. The
 * revalidation here is explicit and the 304 has to reach this function rather
 * than being turned back into a 200 from a store we are not managing.
 */
export async function fetchTree(etag: string | null, signal?: AbortSignal): Promise<TreeResult> {
  const res = await fetch(withToken('/api/tree'), {
    cache: 'no-store',
    ...(etag === null ? {} : { headers: { 'if-none-match': etag } }),
    ...(signal ? { signal } : {}),
  })
  if (res.status === HTTP_NOT_MODIFIED) return { changed: false }
  if (!res.ok) throw new Error(String(res.status))
  const body = (await res.json()) as FleetTree
  return { changed: true, trees: body.trees, etag: res.headers.get('etag') }
}

function handle(msg: ServerMessage): void {
  const state = useStore.getState()
  switch (msg.type) {
    case 'fleet': {
      useStore.setState({ agents: msg.agents, mock: msg.mock, fleetAt: Date.now() })
      announceBlocked(msg.agents)
      notifyBlocked(msg.agents, { enabled: state.notify, lang: state.lang })
      return
    }
    case 'limits': {
      useStore.setState({ limits: msg.limits })
      return
    }
    case 'timeline': {
      if (msg.sessionId !== state.selected) return
      useStore.setState({ events: msg.reset ? msg.events : [...state.events, ...msg.events] })
      useStore.getState().rebuildChat()
      return
    }
    case 'frame': {
      if (msg.frame.sessionId === state.selected && state.tab === 'attach') {
        useStore.setState({ frame: msg.frame })
      }
      return
    }
    case 'paste-ack': {
      acknowledge(msg.seq)
      return
    }
    case 'error':
      /*
       * A dead pane is a state, not a passing notice. The toast says it once
       * and is gone in five seconds; the terminal has to keep showing that
       * nothing typed there can arrive, so the fact is recorded rather than
       * only announced.
       */
      if (msg.kind === 'pane-exited' && msg.sessionId) state.markExited(msg.sessionId)
      state.showToast(msg.message)
  }
}

/** Surface newly blocked agents in the tab title, for a backgrounded window. */
function announceBlocked(agents: Agent[]): void {
  const blocked = agents.filter((a) => a.status === 'waiting')
  const fresh = blocked.filter((a) => !announced.has(a.sessionId))
  announced = new Set(blocked.map((a) => a.sessionId))
  document.title = blocked.length ? `(${blocked.length}) agent-commander` : 'agent-commander'
  if (fresh.length === 0) return
  const region = document.getElementById('live-region')
  if (region) region.textContent = `${fresh.length}: ${fresh.map((a) => a.name).join(', ')}`
}

export function connect(): void {
  const url = withToken('/ws')
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

  const ws = new WebSocket(url)
  socket = ws

  ws.addEventListener('open', () => {
    retry = 500
    useStore.setState({ conn: 'open' })
    const { selected, tab } = useStore.getState()
    if (selected) {
      send({ type: 'focus', sessionId: selected })
      if (tab === 'attach') send({ type: 'attach', sessionId: selected, on: true })
    }
  })

  ws.addEventListener('message', (event) => {
    try {
      handle(JSON.parse(String(event.data)) as ServerMessage)
    } catch {
      // A malformed frame must not kill the connection.
    }
  })

  ws.addEventListener('close', () => {
    socket = null
    // The ack for anything outstanding is never coming. Release the gate so
    // typing works again on reconnect; the unsent buffer is dropped rather
    // than replayed, because replaying input into a live agent is INV-2's one
    // prohibition.
    inFlight = null
    outbox = null
    window.clearTimeout(stallTimer)
    useStore.setState({ conn: 'closed' })
    window.setTimeout(connect, retry)
    retry = Math.min(retry * 2, 10_000)
  })

  ws.addEventListener('error', () => ws.close())
}
