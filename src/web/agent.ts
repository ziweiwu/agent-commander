/**
 * Detail view for one agent: a readable Timeline, and an Attach tab holding the
 * live pane.
 */
import { DESTRUCTIVE_KEYS, type Agent, type Frame } from '../shared/types.ts'
import { parseInline, type ChatMessage } from './chat.ts'
import { agentSubtitle } from './fleet.ts'
import { clock, dayLabel, statusLabel } from './format.ts'
import { PaneTerm } from './term.ts'

export type Tab = 'timeline' | 'attach'

export interface DetailHandlers {
  onClose(): void
  onTab(tab: Tab): void
  onSend(text: string): void
  onKey(key: string): void
  onText(text: string): void
  confirm(message: string): boolean
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Owns the DOM for the detail pane and the terminal instance inside it. */
export class DetailView {
  #term: PaneTerm | null = null
  #timelineHost: HTMLElement | null = null
  #scroller: HTMLElement | null = null
  #jumpButton: HTMLElement | null = null
  #input: HTMLTextAreaElement | null = null
  #pinned = true
  #agentId: string | null = null
  #tab: Tab = 'timeline'

  constructor(
    private readonly host: HTMLElement,
    private readonly handlers: DetailHandlers,
  ) {
    window.addEventListener('resize', () => this.#term?.rescale())
  }

  get tab(): Tab {
    return this.#tab
  }

  clear(): void {
    this.#disposeTerm()
    this.#agentId = null
    this.#timelineHost = null
    this.#scroller = null
    this.#jumpButton = null
    this.#input = null
    this.host.hidden = true
    this.host.replaceChildren()
  }

  /**
   * Full re-render. Returns true when the DOM was actually rebuilt, so the
   * caller knows the conversation needs repainting into the fresh nodes.
   */
  render(agent: Agent, tab: Tab): boolean {
    const sameAgent = this.#agentId === agent.sessionId
    if (sameAgent && tab === this.#tab) {
      // Cheap in-place update: a full re-render here would tear down the live
      // terminal every time the fleet broadcasts.
      this.#refreshHead(agent)
      this.#refreshBlocked(agent, tab)
      return false
    }
    this.#disposeTerm()
    if (!sameAgent) this.#pinned = true
    this.#agentId = agent.sessionId
    this.#tab = tab
    this.host.hidden = false
    this.host.replaceChildren(this.#head(agent), this.#tabs(agent, tab))

    const pane = el('div', 'pane')
    if (agent.status === 'waiting') pane.append(this.#blockedBanner(agent, tab))
    if (tab === 'timeline') pane.append(this.#timeline(agent))
    else pane.append(this.#attach(agent))
    this.host.append(pane)
    return true
  }

  /**
   * A blocked agent is the whole reason to look at this app, so say plainly what
   * is wrong and put the action that fixes it one click away.
   */
  #blockedBanner(agent: Agent, tab: Tab): HTMLElement {
    const banner = el('div', 'blocked')
    const text = el('div', 'blocked-text')
    text.append(
      el('strong', undefined, `Waiting on you — ${agent.waitingFor ?? 'input required'}.`),
      document.createTextNode(
        agent.paneId
          ? ' Answer it in the terminal below; this agent is stopped until you do.'
          : ' This session is not attachable, so it must be answered in its own terminal.',
      ),
    )
    banner.append(text)
    if (agent.paneId) {
      const cta = el('button', 'btn cta', tab === 'attach' ? 'Focus terminal' : 'Open terminal')
      cta.type = 'button'
      cta.dataset.action = 'unblock'
      cta.addEventListener('click', () => {
        if (tab === 'attach') this.#term?.focus()
        else this.handlers.onTab('attach')
      })
      banner.append(cta)
    }
    return banner
  }

  /**
   * Keep the blocked banner honest without a full re-render: when an agent you
   * are watching gets unblocked, a stale "Waiting on you" banner would tell you
   * to go and do something that is already done.
   */
  #refreshBlocked(agent: Agent, tab: Tab): void {
    const pane = this.host.querySelector<HTMLElement>('.pane')
    if (!pane) return
    const existing = pane.querySelector<HTMLElement>('.blocked')
    if (agent.status === 'waiting') {
      const fresh = this.#blockedBanner(agent, tab)
      if (existing) existing.replaceWith(fresh)
      else pane.prepend(fresh)
    } else {
      existing?.remove()
    }
  }

  #refreshHead(agent: Agent): void {
    const pill = this.host.querySelector<HTMLElement>('.detail-head .pill')
    if (pill) {
      pill.textContent = statusLabel(agent)
      pill.dataset.status = agent.status
    }
  }

  #head(agent: Agent): HTMLElement {
    const head = el('div', 'detail-head')
    // Only rendered on narrow screens, where the detail covers the fleet list.
    const back = el('button', 'back', '‹ Agents')
    back.type = 'button'
    back.addEventListener('click', () => this.handlers.onClose())
    head.append(back, el('h2', undefined, agent.name))
    const pill = el('span', 'pill', statusLabel(agent))
    pill.dataset.status = agent.status
    head.append(pill, el('span', 'path', agentSubtitle(agent)))
    const close = el('button', 'close', 'close')
    close.type = 'button'
    close.addEventListener('click', () => this.handlers.onClose())
    head.append(close)
    return head
  }

  #tabs(agent: Agent, active: Tab): HTMLElement {
    const bar = el('div', 'tabs')
    const add = (id: Tab, label: string, enabled: boolean): void => {
      const button = el('button', 'tab', label)
      button.type = 'button'
      button.setAttribute('aria-selected', String(id === active))
      button.disabled = !enabled
      button.addEventListener('click', () => this.handlers.onTab(id))
      bar.append(button)
    }
    add('timeline', 'Chat', true)
    add('attach', 'Attach', Boolean(agent.paneId))
    return bar
  }

  /* ---- conversation ---- */

  #timeline(agent: Agent): HTMLElement {
    const box = el('div', 'chat-pane')
    const scroller = el('div', 'chat-scroll')
    const list = el('div', 'chat-list')
    scroller.append(list)
    this.#timelineHost = list
    this.#scroller = scroller

    list.append(el('div', 'notice', 'Loading the conversation…'))

    // Stop pinning to the bottom the moment the user scrolls up to read, and
    // offer an explicit way back rather than yanking them forward.
    scroller.addEventListener('scroll', () => {
      const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      this.#pinned = gap < 60
      this.#jumpButton?.classList.toggle('show', !this.#pinned)
    })

    const jump = el('button', 'jump', '↓ Jump to latest')
    jump.type = 'button'
    jump.addEventListener('click', () => {
      this.#pinned = true
      this.#scrollToEnd()
      jump.classList.remove('show')
    })
    this.#jumpButton = jump

    const region = el('div', 'chat-region')
    region.append(scroller, jump)
    box.append(region, this.#composer(agent))
    return box
  }

  #composer(agent: Agent): HTMLElement {
    const form = el('form', 'composer')
    const input = el('textarea', 'composer-input')
    input.rows = 1
    input.placeholder = agent.paneId
      ? `Message ${agent.name}…`
      : 'This agent is not attachable, so messages cannot be delivered.'
    input.disabled = !agent.paneId
    this.#input = input

    const send = el('button', 'btn send', 'Send')
    send.type = 'submit'
    send.disabled = true

    const grow = (): void => {
      input.style.height = 'auto'
      input.style.height = `${Math.min(input.scrollHeight, 180)}px`
      send.disabled = !agent.paneId || input.value.trim().length === 0
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const text = input.value
      if (text.trim().length === 0 || !agent.paneId) return
      this.handlers.onSend(text)
      input.value = ''
      grow()
      input.focus()
    })

    input.addEventListener('input', grow)
    input.addEventListener('keydown', (e) => {
      // Slack's convention: Enter sends, Shift+Enter starts a new line.
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        form.requestSubmit()
      }
    })

    const hint = el('div', 'composer-hint')
    hint.append(
      el('kbd', undefined, 'Enter'),
      document.createTextNode(' send  ·  '),
      el('kbd', undefined, 'Shift+Enter'),
      document.createTextNode(' newline'),
    )

    const row = el('div', 'composer-row')
    row.append(input, send)
    form.append(row, hint)
    return form
  }

  /** Re-render the conversation from the full message list. */
  renderMessages(messages: ChatMessage[], busy: boolean): void {
    const list = this.#timelineHost
    if (!list) return
    list.replaceChildren()

    if (messages.length === 0) {
      list.append(
        el(
          'div',
          'notice',
          'Nothing said yet. Send this agent a message below and it will appear here.',
        ),
      )
      return
    }

    let lastDay = ''
    for (const message of messages) {
      const day = dayLabel(message.at)
      if (day !== lastDay) {
        lastDay = day
        const sep = el('div', 'day-sep')
        sep.append(el('span', undefined, day))
        list.append(sep)
      }
      list.append(bubble(message))
    }

    if (busy) list.append(workingIndicator())
    if (this.#pinned) this.#scrollToEnd()
  }

  /**
   * Put the cursor in the message box, the way opening a Slack channel does, so
   * an agent you deliberately opened can be replied to without another click.
   */
  focusComposer(): void {
    this.#input?.focus()
  }

  #scrollToEnd(): void {
    const scroller = this.#scroller
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }

  /* ---- attach ---- */

  #attach(agent: Agent): HTMLElement {
    const box = el('div')
    if (!agent.paneId) {
      box.append(
        el('div', 'notice', agent.attachBlockedReason ?? 'This agent cannot be attached to.'),
      )
      return box
    }

    const wrap = el('div', 'term-wrap')
    const scaler = el('div', 'term-scale')
    wrap.append(scaler)

    const term = new PaneTerm(
      (key) => this.#guardedKey(key),
      (text) => this.handlers.onText(text),
      () => this.handlers.onClose(),
    )
    this.#term = term
    box.append(wrap, this.#keybar())
    queueMicrotask(() => {
      term.mount(wrap, scaler)
      term.focus()
    })
    return box
  }

  #keybar(): HTMLElement {
    const bar = el('div', 'keybar')
    const add = (label: string, key: string, danger = false): void => {
      const button = el('button', `btn${danger ? ' danger' : ''}`, label)
      button.type = 'button'
      button.addEventListener('click', () => this.#guardedKey(key))
      bar.append(button)
    }
    add('Enter', 'Enter')
    add('↑', 'Up')
    add('↓', 'Down')
    add('Tab', 'Tab')
    add('Esc', 'Escape', true)
    add('Ctrl-C', 'C-c', true)
    bar.append(
      el('span', 'hint', 'Click the terminal, then type normally · shift+esc to go back'),
    )
    return bar
  }

  /** INV-6: keys that can destroy work require a confirmation first. */
  #guardedKey(key: string): void {
    if (DESTRUCTIVE_KEYS.has(key)) {
      const what = key === 'Escape' ? 'interrupt this agent' : `send ${key} to this agent`
      if (!this.handlers.confirm(`Really ${what}?`)) return
    }
    this.handlers.onKey(key)
  }

  applyFrame(frame: Frame): void {
    this.#term?.apply(frame)
  }

  #disposeTerm(): void {
    this.#term?.dispose()
    this.#term = null
  }
}

/** One chat bubble: the message, then whatever the agent did because of it. */
function bubble(message: ChatMessage): HTMLElement {
  const row = el('div', `msg msg-${message.role}${message.grouped ? ' grouped' : ''}`)
  if (message.pending) row.classList.add('pending')

  if (message.grouped) {
    // Slack's trick: a grouped message keeps its timestamp in the gutter,
    // revealed on hover, so a long run of replies never loses its time anchor.
    row.append(el('time', 'msg-gutter', clock(message.at)))
  } else {
    const head = el('div', 'msg-head')
    head.append(
      el('span', 'msg-who', message.role === 'you' ? 'You' : 'Agent'),
      el('time', 'msg-time', clock(message.at)),
    )
    if (message.pending) head.append(el('span', 'msg-state', 'sending…'))
    row.append(head)
  }

  if (message.text) row.append(richText(message.text))
  if (message.tools.length > 0) row.append(toolStrip(message.tools))
  return row
}

/**
 * Tool calls are what the agent did, not what it said, so they render as a
 * compact secondary strip. Long runs collapse behind a summary line so a
 * hundred-tool turn does not bury the sentence that explains it.
 */
function toolStrip(tools: ChatMessage['tools']): HTMLElement {
  const wrap = el('div', 'tools')
  const VISIBLE = 4
  const hidden = tools.length - VISIBLE

  const render = (list: ChatMessage['tools']): HTMLElement[] =>
    list.map((call) => {
      const item = el('div', `tool${call.subagent ? ' tool-sub' : ''}`)
      item.append(el('span', 'tool-name', call.tool))
      if (call.text) item.append(el('span', 'tool-arg', call.text))
      item.title = call.text ? `${call.tool}: ${call.text}` : call.tool
      return item
    })

  if (hidden > 1) {
    const toggle = el('button', 'tool-toggle', `▸ ${tools.length} actions`)
    toggle.type = 'button'
    const rest = el('div', 'tool-rest')
    rest.append(...render(tools))
    rest.hidden = true
    toggle.addEventListener('click', () => {
      rest.hidden = !rest.hidden
      toggle.textContent = `${rest.hidden ? '▸' : '▾'} ${tools.length} actions`
    })
    wrap.append(toggle, rest)
    return wrap
  }

  wrap.append(...render(tools))
  return wrap
}

function workingIndicator(): HTMLElement {
  const row = el('div', 'msg msg-agent working')
  const dots = el('div', 'dots')
  dots.append(el('i'), el('i'), el('i'))
  const body = el('div', 'working-body')
  body.append(dots, el('span', undefined, 'working…'))
  row.append(body)
  return row
}

/** Render a message body, applying inline markdown as DOM nodes (never HTML). */
function richText(text: string): HTMLElement {
  const box = el('div', 'msg-text')
  for (const span of parseInline(text)) {
    if (span.kind === 'text') {
      box.append(document.createTextNode(span.text))
    } else {
      const tag = span.kind === 'code' ? 'code' : span.kind === 'bold' ? 'strong' : 'em'
      box.append(el(tag, undefined, span.text))
    }
  }
  return box
}
