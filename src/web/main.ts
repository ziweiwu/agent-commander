import './style.css'
import type { Agent, ClientMessage, ServerMessage, TimelineEvent } from '../shared/types.ts'
import { renderFilters, renderFleet, visibleAgents, type FleetState, type StatusFilter } from './fleet.ts'
import { DetailView, type Tab } from './agent.ts'
import { buildMessages, pendingMessage, reconcile, type ChatMessage } from './chat.ts'

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing #${id}`)
  return node as T
}

const fleetHost = $('fleet')
const detailHost = $('detail')
const filtersHost = $('filters')
const connHost = $('conn')
const toastHost = $('toast')
const liveRegion = $('live-region')
const searchInput = $<HTMLInputElement>('search')
const layout = document.querySelector<HTMLElement>('.layout')

const token = new URLSearchParams(location.search).get('token')
const NARROW = (): boolean => window.matchMedia('(max-width: 900px)').matches

let agents: Agent[] = []
let selected: string | null = null
let tab: Tab = 'timeline'
let socket: WebSocket | null = null
let retry = 500
let toastTimer: number | undefined
let announced = new Set<string>()
let events: TimelineEvent[] = []
let pending: ChatMessage[] = []
let pendingSeq = 0

const state: FleetState = { query: '', filter: 'all' }

const send = (msg: ClientMessage): void => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
}

function toast(message: string): void {
  toastHost.textContent = message
  toastHost.hidden = false
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toastHost.hidden = true
  }, 5000)
}

const detail = new DetailView(detailHost, {
  onClose: () => select(null),
  onTab: (next) => setTab(next),
  onSend: (text) => {
    if (!selected) return
    // Echo locally first so sending feels immediate; the transcript confirms it
    // a moment later and reconcile() drops this copy.
    pending.push(pendingMessage(text, Date.now(), pendingSeq++))
    paintChat()
    send({ type: 'paste', sessionId: selected, text, submit: true })
  },
  onKey: (key) => {
    if (selected) send({ type: 'key', sessionId: selected, key })
  },
  onText: (text) => {
    if (selected) send({ type: 'paste', sessionId: selected, text, submit: false })
  },
  confirm: (message) => window.confirm(message),
})

/** Rebuild the conversation from confirmed events plus un-echoed local sends. */
function paintChat(): void {
  if (tab !== 'timeline') return
  const agent = agents.find((a) => a.sessionId === selected)
  if (!agent) return
  const messages = reconcile(buildMessages(events), pending)
  pending = pending.filter((p) => messages.some((m) => m.id === p.id))
  detail.renderMessages(messages, agent.status === 'busy')
}

function setTab(next: Tab): void {
  if (!selected || next === tab) return
  if (tab === 'attach') send({ type: 'attach', sessionId: selected, on: false })
  tab = next
  paint()
  if (tab === 'attach') send({ type: 'attach', sessionId: selected, on: true })
}

/**
 * A blocked agent is opened to answer its dialog, which only the terminal can
 * do — so land there rather than making the user find the tab themselves.
 */
function initialTab(agent: Agent): Tab {
  return agent.status === 'waiting' && agent.paneId ? 'attach' : 'timeline'
}

function select(sessionId: string | null): void {
  if (selected === sessionId) return
  if (selected && tab === 'attach') send({ type: 'attach', sessionId: selected, on: false })
  selected = sessionId
  events = []
  pending = []
  const agent = agents.find((a) => a.sessionId === sessionId)
  tab = agent ? initialTab(agent) : 'timeline'
  send({ type: 'focus', sessionId })
  if (!sessionId) {
    detail.clear()
    document.body.classList.remove('detail-open')
  } else {
    document.body.classList.toggle('detail-open', NARROW())
  }
  paint()
  if (sessionId && tab === 'attach') send({ type: 'attach', sessionId, on: true })
  if (sessionId && NARROW()) window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  // Not on narrow screens: focusing a textarea there pops the on-screen keyboard
  // over the conversation the user just asked to see.
  if (sessionId && tab === 'timeline' && !NARROW()) detail.focusComposer()
}

function paint(): void {
  // The fleet re-renders on every server broadcast; without this the user's
  // keyboard position would be thrown away every few seconds.
  const activeCard = document.activeElement?.closest<HTMLElement>('.card')
  const focusedId = activeCard?.dataset.sessionId

  renderFilters(filtersHost, agents, state, (next) => {
    state.filter = next
    paint()
  })
  renderFleet(fleetHost, agents, state, selected, select)

  if (focusedId) {
    fleetHost.querySelector<HTMLElement>(`.card[data-session-id="${CSS.escape(focusedId)}"]`)?.focus()
  }

  const current = agents.find((a) => a.sessionId === selected)
  if (current) {
    const rebuilt = detail.render(current, tab)
    if (rebuilt || tab === 'timeline') paintChat()
  } else if (selected) {
    selected = null
    detail.clear()
    document.body.classList.remove('detail-open')
    toast('That agent is no longer running.')
  }
  layout?.classList.toggle('solo', selected === null)
}

/** Announce newly blocked agents for screen readers and for a background tab. */
function announceBlocked(next: Agent[]): void {
  const blocked = next.filter((a) => a.status === 'waiting')
  const fresh = blocked.filter((a) => !announced.has(a.sessionId))
  announced = new Set(blocked.map((a) => a.sessionId))
  if (fresh.length === 0) return
  const names = fresh.map((a) => a.name).join(', ')
  liveRegion.textContent = `${fresh.length} agent needs you: ${names}`
  document.title = blocked.length ? `(${blocked.length}) agent-commander` : 'agent-commander'
}

/* ---- keyboard ---- */

function cards(): HTMLElement[] {
  return [...fleetHost.querySelectorAll<HTMLElement>('.card')]
}

function moveFocus(delta: number): void {
  const list = cards()
  if (list.length === 0) return
  const active = document.activeElement?.closest<HTMLElement>('.card')
  const index = active ? list.indexOf(active) : -1
  const next = list[Math.max(0, Math.min(list.length - 1, index + delta))] ?? list[0]
  next?.focus()
}

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target?.closest('.term-wrap') !== null

  if (e.key === '/' && !typing) {
    e.preventDefault()
    searchInput.focus()
    searchInput.select()
    return
  }

  // Plain Escape inside the terminal belongs to the agent (it interrupts it),
  // so Shift+Escape is the always-available way back to the list.
  if (e.key === 'Escape' && e.shiftKey && selected) {
    e.preventDefault()
    select(null)
    return
  }

  if (e.key === 'Escape') {
    if (target === searchInput && searchInput.value) {
      searchInput.value = ''
      state.query = ''
      paint()
      return
    }
    // Inside the terminal, Escape belongs to the agent, not to this app.
    if (target?.closest('.term-wrap')) return
    if (selected) {
      e.preventDefault()
      select(null)
    }
    return
  }

  if (typing && target !== searchInput) return

  if (e.key === 'ArrowDown' || (e.key === 'j' && !typing)) {
    e.preventDefault()
    moveFocus(1)
  } else if (e.key === 'ArrowUp' || (e.key === 'k' && !typing)) {
    e.preventDefault()
    moveFocus(-1)
  }
})

searchInput.addEventListener('input', () => {
  state.query = searchInput.value
  paint()
})

window.addEventListener('resize', () => {
  document.body.classList.toggle('detail-open', selected !== null && NARROW())
})

/* ---- transport ---- */

function connect(): void {
  const url = new URL(location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
  url.search = token ? `?token=${encodeURIComponent(token)}` : ''

  const ws = new WebSocket(url)
  socket = ws

  ws.addEventListener('open', () => {
    retry = 500
    connHost.textContent = 'live'
    connHost.dataset.state = 'open'
    if (selected) {
      send({ type: 'focus', sessionId: selected })
      if (tab === 'attach') send({ type: 'attach', sessionId: selected, on: true })
    }
  })

  ws.addEventListener('message', (event) => {
    let msg: ServerMessage
    try {
      msg = JSON.parse(String(event.data)) as ServerMessage
    } catch {
      return
    }
    handle(msg)
  })

  ws.addEventListener('close', () => {
    connHost.textContent = 'reconnecting…'
    connHost.dataset.state = 'closed'
    socket = null
    window.setTimeout(connect, retry)
    retry = Math.min(retry * 2, 10_000)
  })

  ws.addEventListener('error', () => ws.close())
}

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case 'fleet':
      agents = msg.agents
      if (msg.mock) showMockBanner()
      announceBlocked(agents)
      paint()
      return
    case 'timeline':
      if (msg.sessionId !== selected) return
      if (msg.reset) events = msg.events
      else events.push(...msg.events)
      paintChat()
      return
    case 'frame':
      if (msg.frame.sessionId === selected && tab === 'attach') detail.applyFrame(msg.frame)
      return
    case 'error':
      toast(msg.message)
  }
}

let mockShown = false
function showMockBanner(): void {
  if (mockShown) return
  mockShown = true
  const banner = document.createElement('div')
  banner.className = 'mock-banner'
  banner.textContent = 'mock mode — these agents are fixtures, nothing real is being touched'
  document.body.prepend(banner)
}

export { visibleAgents, type StatusFilter }

connect()
