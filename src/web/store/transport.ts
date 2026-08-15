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
  ClientMessage,
  ControlResponse,
  DirListing,
  NewAgentResponse,
  ServerEnv,
  ServerMessage,
} from '../../shared/types.ts'
import { useStore } from './store.ts'

const token = new URLSearchParams(location.search).get('token')

let socket: WebSocket | null = null
let retry = 500
let announced = new Set<string>()

function withToken(path: string): URL {
  const url = new URL(path, location.href)
  if (token) url.searchParams.set('token', token)
  return url
}

export function send(msg: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
}

/** Tell the server which agent this tab is looking at. */
export function focusAgent(sessionId: string | null): void {
  const state = useStore.getState()
  if (state.selected === sessionId) return
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
  useStore.setState({ tab: on ? 'attach' : 'chat' })
  if (!on) useStore.setState({ frame: null })
  send({ type: 'attach', sessionId: selected, on })
}

export function sendMessage(text: string): void {
  const { selected, addPending } = useStore.getState()
  if (!selected || text.trim().length === 0) return
  addPending(text)
  send({ type: 'paste', sessionId: selected, text, submit: true })
}

export function sendKey(key: string): void {
  const { selected } = useStore.getState()
  if (selected) send({ type: 'key', sessionId: selected, key })
}

export function sendText(text: string): void {
  const { selected } = useStore.getState()
  if (selected) send({ type: 'paste', sessionId: selected, text, submit: false })
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

async function control(action: string, value?: string): Promise<ControlResponse> {
  const { selected } = useStore.getState()
  if (!selected) return { ok: false, error: 'no agent selected' }
  try {
    const res = await fetch(withToken(`/api/agents/${encodeURIComponent(selected)}/${action}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify({ value }) }),
    })
    return (await res.json()) as ControlResponse
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export const setAgentMode = (mode: string): Promise<ControlResponse> => control('mode', mode)
export const setAgentModel = (model: string): Promise<ControlResponse> => control('model', model)
export const closeAgent = (): Promise<ControlResponse> => control('close')
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

function handle(msg: ServerMessage): void {
  const state = useStore.getState()
  switch (msg.type) {
    case 'fleet': {
      useStore.setState({ agents: msg.agents, mock: msg.mock })
      announceBlocked(msg.agents)
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
    case 'error':
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
    useStore.setState({ conn: 'closed' })
    window.setTimeout(connect, retry)
    retry = Math.min(retry * 2, 10_000)
  })

  ws.addEventListener('error', () => ws.close())
}
