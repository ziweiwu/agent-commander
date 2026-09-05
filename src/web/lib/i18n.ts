/**
 * Localisation.
 *
 * The English dictionary is the source of truth: every other language is typed
 * against its keys, so a missing or misspelt translation is a compile error
 * rather than a blank label discovered by a user.
 */
import type { DayMark, Relative, Uptime } from './format.ts'

export const LANGUAGES = ['en', 'zh-CN'] as const
export type Lang = (typeof LANGUAGES)[number]

export const LANGUAGE_NAMES: Record<Lang, string> = {
  en: 'English',
  'zh-CN': '简体中文',
}

const EN = {
  appName: 'agent-commander',
  /* topbar + filters */
  filterAll: 'agents',
  filterWaiting: 'need you',
  filterBusy: 'working',
  filterIdle: 'idle',
  connLive: 'live',
  connConnecting: 'connecting…',
  connReconnecting: 'reconnecting…',
  searchPlaceholder: 'Filter agents…',
  searchLabel: 'Filter agents by name, folder, branch or activity',
  /* groups */
  groupWaiting: 'Needs you',
  groupBusy: 'Working',
  groupIdle: 'Idle',
  /* status */
  /* account quota, bridged from Claude Code's statusLine */
  usageFiveHour: 'session',
  usageSevenDay: 'week',
  /* Narrow screens, where the full word does not fit but no label at all
     would leave two bare percentages with nothing to tell them apart. */
  usageFiveHourShort: '5h',
  usageSevenDayShort: '7d',
  usageMeter: '{label} quota: {n}% used, {reset}',
  usageResetsIn: 'resets in {t}',
  usageResetting: 'resetting',
  usageStale: 'last read {t}',
  usageStaleMeter: '{label} quota: {n}% used when last read {t}',
  statusWaiting: 'waiting',
  statusBusy: 'busy',
  statusIdle: 'idle',
  /* Past tense on purpose: the agent is not doing the delegating, it already
     did it and is now waiting. "delegating…" would imply it is the busy one. */
  statusDelegated: 'delegated',
  statusUnknown: 'unknown',
  waitingDialog: 'dialog open',
  waitingPermission: 'a permission prompt',
  waitingInput: 'input needed',
  waitingSandbox: 'a sandbox request',
  waitingGoal: 'a goal proposal',
  waitingWorker: 'a worker request',
  waitingStarting: 'starting up',
  /* cards */
  notAttachable: 'not attachable',
  noPromptsYet: 'No prompts yet — waiting for its first instruction.',
  statusFromPane: 'quiet',
  /* delegates — INV-13 and INV-15 in the words themselves */
  delegatesNone: 'delegated nothing',
  delegatesUnknown: 'delegates: cannot tell',
  delegatesUnknownTitle:
    'This CLI writes no record of its subagents, so whether it delegated is not something this app is able to read. That is different from having delegated nothing.',
  delegatesOne: '1 delegate',
  delegatesMany: '{n} delegates',
  delegateActive: 'active',
  delegateQuiet: 'quiet',
  delegateDone: 'done',
  delegateGuess: 'inferred',
  delegateCalls: '{n} calls',
  delegateCallsOver: '{n} calls over {t}',
  delegateEffortTitle:
    'What it did, measured from its transcript — not what came of it. Tool calls, and the span between its first and last record.',
  delegateGuessTitle:
    'A guess: its transcript grew recently and its parent is busy. Nothing reported this.',
  delegateQuietTitle:
    'It stopped writing. An agent that finished and one that died both do that, so this is not "done".',
  delegateDoneTitle: 'Evidence of an ending: a recorded result, or you stopped it.',
  delegateStopped: 'you stopped it',
  delegateOrphan: 'parent not found',
  delegateOrphanTitle:
    'Its parent record is missing, so it was raised to the top rather than dropped — which would have taken this delegate and everything under it off the screen.',
  detailsShow: 'Details',
  detailsHide: 'Hide details',
  cardAnswer: 'Answer →',
  tokensLabel: 'Output tokens',
  tokensSeen: '{n} seen in this transcript — not the session total',
  sessionNameLabel: 'Session',
  pathLabel: 'Folder',
  delegatesMoving: '{n} still moving, so this is not a stall',
  delegatesShowRest: 'Show {n} more, not moving',
  delegatesHideRest: 'Hide the {n} not moving',
  stallQuestion: 'Nothing here has moved for {t} — still working?',
  stallQuestionTitle:
    'This agent is quiet because it delegated, and every delegate is quiet too. Quiet is not "finished" — nothing recorded an ending. Worth a look.',
  trailLabel: 'Wrote for {worked}, silent for {silent}',
  helpSectionKinds: 'Other agent CLIs',
  helpKindsIntro:
    'Kiro CLI sessions appear alongside Claude Code ones, found through tmux and ' +
    'marked with a badge. They can be attached to like any other agent, but they ' +
    'keep no transcript this app can read, so they have no conversation, no token ' +
    'count and no Chat tab.',
  helpKindsStatus:
    'Their status is marked \u201Cquiet\u201D and drawn with a dashed outline, because ' +
    'it is worked out from whether their terminal has produced output lately rather ' +
    'than reported by the agent. For the same reason they never show ' +
    '\u201Cwaiting\u201D: an agent stopped at a prompt and one that has finished look ' +
    'identical from outside.',
  statusInferredTitle:
    "Worked out from whether this agent's terminal has produced output lately. It " +
    'does not report its own status the way Claude Code does, so it can never show ' +
    '\u201Cwaiting\u201D \u2014 an agent stopped at a prompt and one that has ' +
    'finished look the same from outside.',
  noTranscript: 'This agent keeps no transcript this app can read.',
  /* what a busy agent is running — INV-11: read from the process table */
  runningProcess: 'running {cmd} · {t}',
  runningLabel: 'Running',
  runningFold: '{cmd} for {t} — read from the process table, not reported by the agent',
  runningFromProcessTable:
    'Read from the process table: the newest process under this agent, not something the agent reported.',
  fleetLoading: 'Connecting… the fleet appears once the first update arrives.',
  quickMenu: 'Replies',
  emptyFleetTitle: 'No Claude Code sessions found',
  emptyFleetBody: 'Run this in any folder to start one, or start one from here:',
  emptyFleetOr: 'or',
  emptyFleetHelp: 'Reaching this from a phone?',
  emptyFleetHelpLink: 'Help explains the Tailscale setup.',
  emptyFilterTitle: 'Nothing matches that filter',
  emptyFilterQuery: 'No agent matches “{query}”.',
  emptyFilterStatus: 'No agent has that status right now.',
  agentGone: 'That agent is no longer running.',
  /* detail */
  tabChat: 'Chat',
  tabAttach: 'Attach',
  back: '‹ Agents',
  backLabel: 'Agents',
  close: 'close',
  blockedTitle: 'Waiting on you — {reason}.',
  blockedReasonFallback: 'input required',
  blockedBodyAttachable: ' Answer it in the terminal below; this agent is stopped until you do.',
  blockedBodyAnswerable: ' Answer it below; this agent is stopped until you do.',
  blockedBodyNotAttachable: ' This session is not attachable, so it must be answered in its own terminal.',
  focusTerminal: 'Focus terminal',
  openTerminal: 'Open terminal',
  answerTitle: 'Answer without leaving the conversation',
  answerOption: 'Answer {label}',
  answerSending: 'sending…',
  answerSent: 'Answer sent. {name} is picking it up.',
  answerNotSent: 'Not sent: the connection to {name} dropped. Nothing was queued — answer again once it is back.',
  answerMore: 'Answering this one does not finish the set: {count} still follow.',
  answerMultiSelect:
    'This one takes more than one answer, so it is chosen in the terminal — the keys below move and toggle.',
  answerNoOptions:
    'The agent asked a question, but its choices could not be read from the transcript, so they cannot be labelled here. The keys below move and confirm.',
  answerKeysLabel: 'Answer keys',
  answerKeysFallback: 'Or use the terminal keys if this does not match what the terminal shows.',
  answerDrawn:
    'These labels are how Claude Code draws this dialog, not something the agent wrote down. The number is what is sent — check it against the terminal below.',
  answerPeek: 'The agent’s terminal, live',
  peekLabel: 'The bottom of the agent’s terminal, as it is now. Read-only.',
  answerPlan: 'The plan under review',
  answerAbout: 'What it is asking about',
  uptimePrefix: 'up',
  /* chat */
  you: 'You',
  agent: 'Agent',
  sending: 'sending…',
  queued: 'queued',
  queuedHint:
    'Waiting its turn at the prompt. The agent writes a message down when it ' +
    'gets to it, so this stays queued until the current task finishes.',
  notDelivered: 'not delivered',
  notDeliveredHint: "The agent has not echoed this back. It was not resent — check the Attach tab before sending it again.",
  working: 'working…',
  chatLoading: 'Loading the conversation…',
  chatEmpty: 'Nothing said yet. Send this agent a message below and it will appear here.',
  messagePlaceholder: 'Message {name}',
  /* quick prompts — the label IS the text sent, so what you see is what the
     agent receives, in whichever language the interface is set to */
  quickPromptsLabel: 'Common replies',
  quickPromptSend: 'Send \u201c{text}\u201d',
  quickContinue: 'continue',
  quickGoAhead: 'yes, go ahead',
  quickRunTests: 'run the tests',
  quickBlocked: "what's blocking you?",
  quickSummarise: 'summarise where you are',
  messageDisabled: 'This agent is not attachable, so messages cannot be delivered.',
  send: 'Send',
  hintEnterSend: 'send',
  hintShiftEnter: 'newline',
  jumpToLatest: '↓ Jump to latest',
  actionsCount: '{n} actions',
  today: 'Today',
  yesterday: 'Yesterday',
  /* terminal */
  fitWidth: 'Fit width',
  readable: 'Readable',
  expand: 'Full screen',
  collapse: 'Exit full screen',
  termHint: 'Tap the terminal to type · shift+esc to go back',
  /* earlier output — the pane's scrollback, on request */
  earlierOutput: 'Earlier output',
  hideHistory: 'Hide earlier output',
  earlier: 'Earlier',
  noEarlierOutput: 'No earlier output',
  historyDepthReached: 'As far back as this reads',
  historyCaption: '{n} lines above the screen',
  historyLabel: 'Earlier output from this terminal, read from its scrollback',
  termLoading: 'Loading the terminal…',
  termNotAttachable: 'This agent cannot be attached to.',
  paneExited: 'pane has exited',
  confirmInterrupt: 'Really interrupt this agent?',
  confirmInterruptMode:
    'Interrupt mode: sending while this agent is working will stop it mid-task ' +
    'first, discarding whatever it had in flight. It stays on for this agent ' +
    'until you switch it back. Continue?',
  sendModeLabel: 'What Send does while the agent is working',
  moreOptions: 'Send options, goal and common replies',
  sendModeQueue: 'Queue',
  sendModeInterrupt: 'Interrupt',
  sendModeQueueTitle: 'Let the agent finish; your message waits at its prompt.',
  sendModeInterruptTitle: 'Stop the agent first, then send. Asked once, then armed.',
  interrupt: 'Interrupt',
  interruptAndSend: 'Interrupt & send',
  interruptTitle: 'Stop what this agent is doing now',
  interruptIdle: 'Nothing to interrupt — this agent is not working',
  /* The one control action INV-8 cannot verify. Nothing records an Escape, so
     claiming it landed would be exactly the assertion INV-11 forbids — this
     says what was done and what remains unknown. */
  interruptSent: 'Escape was sent. Nothing records it, so this cannot be confirmed — check the Attach tab.',
  modelQueued: '{model} is queued — it applies when the current task finishes',
  /* The Shift+Tab button. It claims the key, not a mode: Claude Code writes
     its permission mode down only at the end of a turn, so a session at its
     prompt reports nothing back and there is no landing place to name. The
     agent's own terminal shows the mode immediately. */
  shiftTabSent: 'Shift+Tab sent — the agent’s terminal shows which mode it moved to',
  modeUnreported: 'not reported yet',
  shiftTabAction: 'Send Shift+Tab, the chord that cycles this agent’s permission mode',
  /* "last recorded" rather than "current", and the distinction is the one the
     control was rewritten over: Claude Code writes the mode down at the end of
     a turn, so this can trail a press until the session takes one. */
  shiftTabActionWithMode:
    'Send Shift+Tab, the chord that cycles this agent’s permission mode — last recorded: {mode}',
  hintShiftTab: 'permission mode',
  confirmKey: 'Really send {key} to this agent?',
  /* settings */
  settings: 'Settings',
  /* alerts — OS notifications for an agent that starts waiting (INV-14) */
  notifyOn: 'Notifications on — turn off',
  notifyOff: 'Notify when an agent needs you — turn on',
  notifyNudge: 'An agent just needed you. Get notified next time?',
  notifyNudgeOn: 'Turn on',
  notifyNudgeDismiss: 'Not now',
  notifyUnsupported: 'This browser cannot show notifications.',
  notifyDenied: 'Notifications are blocked for this site in the browser settings.',
  notifyBody: 'Waiting on you — {reason}.',
  notifyBodyPlain: 'Waiting on you.',
  theme: 'Theme',
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',
  /* Colour schemes. The names are the palette's character, not the palette it
     was inspired by: "Nordic" rather than "Nord", because the hues are
     borrowed and the lightness is re-derived to be legible — calling it Nord
     would claim to be something it deliberately is not. */
  colourScheme: 'Colours',
  schemeGraphite: 'Graphite',
  schemeNordic: 'Nordic',
  schemeSolar: 'Solar',
  schemeEmber: 'Ember',
  schemeMauve: 'Mauve',
  schemeOne: 'One',
  schemeDracula: 'Dracula',
  schemeMonokai: 'Monokai',
  language: 'Language',
  /* help */
  help: 'Help',
  helpTitle: 'Help',
  helpVersion: 'server {version}',
  helpIntro:
    'agent-commander shows every Claude Code session running on this machine and lets you talk to any of them.',
  helpSectionBasics: 'The basics',
  helpBasicsGroups:
    'Agents are grouped Needs you → Working → Idle, so anything blocked on you is at the top.',
  helpBasicsChat:
    'Chat shows the session as a conversation, with each reply’s tool calls folded underneath it.',
  helpBasicsAttach:
    'Attach is the real terminal, captured rather than shared. Chat can answer a question the agent wrote down; Attach is for everything else.',
  helpBasicsNotify:
    'The bell in the header turns on a notification when an agent starts needing you. It fires only for a block this page saw happen, and never while the tab is visible — the list at the top is the notification then.',
  helpSectionKeys: 'Keyboard',
  keySlash: 'focus the filter box',
  keyArrows: 'move through the agent list',
  keyEnter: 'open the focused agent',
  keyEsc: 'close the agent, or clear the filter box',
  keyShiftEsc: 'leave the terminal (plain Esc belongs to the agent)',
  keyEnterSend: 'in the message box: send / newline',
  helpSectionPhone: 'Reaching this from your iPhone',
  helpPhoneIntro:
    'This server listens on localhost only. Tailscale puts it on your phone without exposing it to the internet.',
  helpPhoneStep1: 'Install Tailscale on your iPhone from the App Store and sign in to the same account.',
  helpPhoneStep2: 'On this Mac, start the server with a token and share the port:',
  helpPhoneStep3: 'Then open this address in Safari on your phone:',
  helpPhoneStep3Note:
    'Add the token to the end of it — `--print-url` prints the whole link ready to paste. A token is required: Tailscale Serve forwards this machine\u2019s own name to every peer on your tailnet, so the name alone cannot tell your phone from anything else on it. You only paste the link once; the server swaps it for a cookie and drops it from the address bar.',
  helpPhoneStep4: 'To stop sharing later, run:',
  helpPhoneAlt: 'Alternative, without Tailscale Serve — bind the tailnet address directly:',
  helpPhoneAltNote:
    'This stores a token in ~/.claude/agent-commander/token and reuses it on every start, so the link you save keeps working. Do not use --host 0.0.0.0, which would also expose the app on whatever Wi-Fi you are on.',
  helpPhoneWarning:
    'Never use `tailscale funnel` here: it publishes to the public internet, and anyone who reached it could drive your agents.',
  helpTailscaleDetected: 'Detected on this machine',
  helpReveal: 'reveal',
  helpHide: 'hide',
  helpMaskedNote:
    'Your machine and tailnet names are hidden so this page is safe to screenshot or share. Copy still copies the real address.',
  helpTailscaleMissing:
    'Tailscale was not detected on this machine, so the address below is an example.',
  helpAddToHome: 'In Safari, tap Share → Add to Home Screen to get an app icon.',
  /* sorting */
  sortBy: 'Sort',
  sortRecent: 'Recent activity',
  sortTokens: 'Output tokens',
  staleFleet: 'Not connected — showing the last state received {when}.',
  staleFleetNoTime: 'Not connected — showing the last state received.',
  sortDuration: 'Running longest',
  sortName: 'Name',
  sortFirst: 'first',
  senseNewest: 'newest',
  senseOldest: 'oldest',
  senseMost: 'most',
  senseLeast: 'least',
  senseLongest: 'longest',
  senseShortest: 'shortest',
  senseZA: 'Z→A',
  senseAZ: 'A→Z',
  /* control */
  agentSettings: 'Agent settings',
  modeLabel: 'Mode',
  modelLabel: 'Model',
  modeDefault: 'Manual',
  modeAcceptEdits: 'Accept edits',
  modePlan: 'Plan',
  modeBypassPermissions: 'Bypass',
  modeAuto: 'Auto',
  modeDontAsk: "Don't ask",
  modelDefault: 'Default',
  controlBusy: 'Only while the agent is idle',
  controlFailed: 'That did not take effect: {error}',
  closeAgent: 'Close agent',
  closeKeep: 'Keep it running',
  /* goal — Claude Code's own /goal, driven from the composer */
  goalLabel: 'Goal',
  goalPlaceholder: 'Keep working until…',
  goalConditionLabel: 'Goal condition',
  goalApply: 'Set',
  goalCancel: 'Cancel',
  goalSetting: 'Setting…',
  goalSetAction: 'Set a goal the agent keeps working towards',
  goalClearAction: 'Clear the goal: {condition}',
  goalActiveTitle: 'Working towards: {condition}',
  goalChecked: 'checked, not met yet',
  goalAchieved: 'achieved',
  closeConfirm: 'Close {name}? It will be asked to exit, and forced if it does not.',
  closing: 'Closing…',
  closedGracefully: '{name} exited.',
  closedForced: '{name} did not respond to /exit and was stopped.',
  /* clear + compact — Claude Code's own /clear and /compact */
  clearContext: 'Clear',
  clearKeep: 'Keep the conversation',
  clearing: 'Clearing…',
  clearContextTitle: 'Discard this conversation and start the agent fresh',
  /* The confirm has to say the second half. Clearing does not just reset the
     agent — it starts a new session, and the conversation on this screen is
     the old one, which nothing can get back. */
  clearConfirm:
    'Clear {name}? The agent starts a fresh session and this conversation is discarded. There is no undo.',
  cleared: '{name} was cleared and is now a fresh session.',
  clearUnverified:
    '/clear was sent, but {name} has not started a new session yet — it may not have taken effect.',
  compactContext: 'Compact',
  compacting: 'Compacting…',
  compactContextTitle: 'Ask the agent to summarise and shorten its own context',
  /* Asked for, not done: a compaction runs for minutes, so claiming it had
     finished would be the interface asserting more than it knows. */
  compactRequested: 'Compaction requested. {name} will summarise its context; this takes a while.',
  compacted: 'compacted · {before} → {after}',
  compactedAuto: 'compacted automatically · {before} → {after}',
  /* folder browser */
  browse: 'Browse…',
  browseTitle: 'Choose a directory',
  browseUp: 'Up',
  browseHidden: 'Show hidden',
  browseEmpty: 'No subfolders here.',
  browseChoose: 'Use this folder',
  browseFailed: 'Could not read that folder: {error}',
  defaultDir: 'Default directory',
  defaultDirSet: 'Set current as default',
  /* fullscreen */
  fullscreenTitle: 'Full screen',
  /* pruning unused sessions */
  prune: 'Prune {count} unused',
  pruneTitle: 'Close sessions that were opened and never prompted',
  pruneConfirm: 'Close {count} unused {sessionWord}?\n\n{names}\n\nEach is idle and has never been prompted. This runs /exit in it.',
  pruneSessionOne: 'session',
  pruneSessionMany: 'sessions',
  pruneWorking: 'Closing…',
  pruneDone: 'Closed {count} unused session(s).',
  pruneSome: 'Closed {done} of {count}. {failed} refused: {error}',
  pruneNone: 'Nothing was closed: {error}',
  /* new agent */
  newAgent: 'New agent',
  newAgentTitle: 'Start a new agent',
  newAgentDir: 'Directory',
  newAgentDirHint: 'Where the agent will run. Must be an existing directory.',
  newAgentName: 'Name (optional)',
  newAgentNameHint: 'Shown in the list. Defaults to the folder name.',
  newAgentStart: 'Start agent',
  newAgentCancel: 'Cancel',
  newAgentStarting: 'Starting…',
  newAgentRecent: 'Recent directories',
  newAgentFailed: 'Could not start the agent: {error}',
  newAgentNoTmux: 'A new agent needs tmux, which is not available on this machine.',
} as const

export type Key = keyof typeof EN

const ZH: Record<Key, string> = {
  appName: 'agent-commander',
  filterAll: '个代理',
  filterWaiting: '待处理',
  filterBusy: '运行中',
  filterIdle: '空闲',
  connLive: '已连接',
  connConnecting: '连接中…',
  connReconnecting: '重新连接中…',
  searchPlaceholder: '筛选代理…',
  searchLabel: '按名称、目录、分支或活动筛选代理',
  groupWaiting: '需要你处理',
  groupBusy: '运行中',
  groupIdle: '空闲',
  /* account quota, bridged from Claude Code's statusLine */
  usageFiveHour: '会话',
  usageSevenDay: '本周',
  usageFiveHourShort: '5时',
  usageSevenDayShort: '7天',
  usageMeter: '{label}额度：已用 {n}%，{reset}',
  usageResetsIn: '{t} 后重置',
  usageResetting: '正在重置',
  usageStale: '读数于 {t}',
  usageStaleMeter: '{label}额度：最近读数已用 {n}%，读于 {t}',
  statusWaiting: '等待中',
  statusBusy: '运行中',
  statusIdle: '空闲',
  statusDelegated: '已委派子代理',
  statusUnknown: '未知',
  waitingDialog: '有对话框待确认',
  waitingPermission: '有权限确认待处理',
  waitingInput: '需要输入',
  waitingSandbox: '有沙箱请求待处理',
  waitingGoal: '有目标提议待确认',
  waitingWorker: '有工作请求待处理',
  waitingStarting: '正在启动',
  notAttachable: '无法接入',
  noPromptsYet: '还没有任何指令 —— 正在等待第一条消息。',
  statusFromPane: '窗格静默',
  delegatesNone: '未委派任何子代理',
  delegatesUnknown: '子代理：无法判断',
  delegatesUnknownTitle:
    '此 CLI 不写入子代理记录，因此本应用无从得知它是否委派过。这与「未委派任何子代理」是两回事。',
  delegatesOne: '1 个子代理',
  delegatesMany: '{n} 个子代理',
  delegateActive: '活跃',
  delegateQuiet: '静默',
  delegateDone: '已结束',
  delegateGuess: '推测',
  delegateCalls: '{n} 次工具调用',
  delegateCallsOver: '{t} 内 {n} 次工具调用',
  delegateEffortTitle: '这是从它的记录中量出来的「做了多少」，不是「结果如何」：工具调用次数，以及首末两条记录之间的跨度。',
  delegateGuessTitle: '这是推测：它的记录最近有增长，且其父代理正在运行。没有任何一方如此报告。',
  delegateQuietTitle: '它停止了写入。已完成和已死亡的代理都会如此，所以这不等于「已结束」。',
  delegateDoneTitle: '有结束的证据：记录中有结果，或由你停止。',
  delegateStopped: '由你停止',
  delegateOrphan: '未找到父节点',
  delegateOrphanTitle:
    '它的父节点记录缺失，因此被提升到顶层而不是丢弃——丢弃会让这个子代理及其下所有节点从屏幕上消失。',
  detailsShow: '详情',
  detailsHide: '收起详情',
  cardAnswer: '回答 →',
  tokensLabel: '输出 token',
  tokensSeen: '此对话记录中看到 {n}——非本次会话总量',
  sessionNameLabel: '会话',
  pathLabel: '目录',
  delegatesMoving: '仍有 {n} 个在推进，因此不是停滞',
  delegatesShowRest: '显示另外 {n} 个（未在推进）',
  delegatesHideRest: '隐藏 {n} 个未在推进的',
  stallQuestion: '已有 {t} 没有任何动静——还在运行吗？',
  stallQuestionTitle:
    '此代理因为委派而静默，且每个子代理也都静默。静默不等于「已完成」——没有任何记录表明它结束了。值得看一眼。',
  trailLabel: '写入 {worked}，静默 {silent}',
  helpSectionKinds: '其他助手 CLI',
  helpKindsIntro:
    'Kiro CLI 会话会与 Claude Code 会话一同显示，通过 tmux 发现并带有标记。它们可以像其他助手一样接入终端，但没有本应用能读取的对话记录，因此没有对话、没有 token 统计，也没有“对话”标签页。',
  helpKindsStatus:
    '它们的状态标记为“窗格静默”并以虚线勾勒，因为这是根据终端近期是否有输出推断的，而非助手自报。同理，它们永远不会显示“等待中”——停在提示符前和已经完成，从外部看是一样的。',
  statusInferredTitle:
    '根据该助手终端近期是否有输出推断得出。它不像 Claude Code 那样自报状态，因此永远不会显示“等待中”——停在提示符前和已经完成，从外部看是一样的。',
  noTranscript: '此助手没有本应用能读取的对话记录。',
  runningProcess: '正在运行 {cmd} · {t}',
  runningLabel: '正在运行',
  runningFold: '{cmd}，已运行 {t} —— 读自进程表，而非助手自报',
  runningFromProcessTable: '读自进程表：该助手之下最新的进程，而非助手自报。',
  fleetLoading: '连接中……收到第一次更新后即会显示机队。',
  quickMenu: '快捷回复',
  emptyFleetTitle: '没有找到 Claude Code 会话',
  emptyFleetBody: '在任意目录运行下面的命令启动一个，或直接从这里新建：',
  emptyFleetOr: '或',
  emptyFleetHelp: '想从手机访问？',
  emptyFleetHelpLink: '帮助页说明了 Tailscale 的设置方法。',
  emptyFilterTitle: '没有符合条件的代理',
  emptyFilterQuery: '没有代理匹配“{query}”。',
  emptyFilterStatus: '目前没有该状态的代理。',
  agentGone: '该代理已经结束运行。',
  tabChat: '对话',
  tabAttach: '终端',
  back: '‹ 代理列表',
  backLabel: '代理列表',
  close: '关闭',
  blockedTitle: '正在等待你 —— {reason}。',
  blockedReasonFallback: '需要输入',
  blockedBodyAttachable: ' 请在下方终端中确认；在此之前该代理会一直停住。',
  blockedBodyAnswerable: ' 请在下方确认；在此之前该代理会一直停住。',
  blockedBodyNotAttachable: ' 该会话无法接入，需要在它自己的终端里确认。',
  focusTerminal: '聚焦终端',
  openTerminal: '打开终端',
  answerTitle: '无需离开对话即可回复',
  answerOption: '选择{label}',
  answerSending: '发送中…',
  answerSent: '已发送回复，{name} 正在处理。',
  answerNotSent: '未发送：与 {name} 的连接已断开。系统不会排队重发——恢复连接后请再回答一次。',
  answerMore: '回答这一个还不算结束，后面还有 {count} 个问题。',
  answerMultiSelect: '这个问题可多选，需要在终端中选择——下方按键用于移动和切换。',
  answerNoOptions: '该 agent 提出了一个问题，但无法从记录中读出它的选项，因此无法在此列出。下方按键用于移动和确认。',
  answerKeysLabel: '回复按键',
  answerKeysFallback: '如果与终端显示的不一致，可改用终端按键。',
  answerDrawn:
    '这些选项文字是 Claude Code 在终端中绘制的样式，并非 agent 写入记录的内容。实际发送的是数字——请对照下方终端确认。',
  answerPeek: '该 agent 的终端（实时）',
  peekLabel: '该 agent 终端的底部，当前实时画面。只读。',
  answerPlan: '待审阅的计划',
  answerAbout: '它正在询问的内容',
  uptimePrefix: '已运行',
  you: '你',
  agent: '代理',
  sending: '发送中…',
  queued: '排队中',
  queuedHint: '正在等待代理处理。代理只有轮到这条消息时才会记录它，因此在当前任务结束前会一直排队。',
  notDelivered: '未送达',
  notDeliveredHint: '代理没有回显这条消息。系统不会自动重发——请先在「终端」标签页确认，再决定是否重新发送。',
  working: '处理中…',
  chatLoading: '正在加载对话…',
  chatEmpty: '还没有任何对话。在下方给它发一条消息，就会显示在这里。',
  messagePlaceholder: '发消息给 {name}',
  quickPromptsLabel: '常用回复',
  quickPromptSend: '发送\u201c{text}\u201d',
  quickContinue: '继续',
  quickGoAhead: '可以，继续吧',
  quickRunTests: '运行测试',
  quickBlocked: '你卡在哪里了？',
  quickSummarise: '总结一下当前进度',
  messageDisabled: '该代理无法接入，消息无法送达。',
  send: '发送',
  hintEnterSend: '发送',
  hintShiftEnter: '换行',
  jumpToLatest: '↓ 跳到最新',
  actionsCount: '{n} 个操作',
  today: '今天',
  yesterday: '昨天',
  fitWidth: '适应宽度',
  readable: '清晰模式',
  expand: '全屏',
  collapse: '退出全屏',
  termHint: '点击终端即可输入 · shift+esc 返回',
  earlierOutput: '更早的输出',
  hideHistory: '隐藏更早的输出',
  earlier: '更早',
  noEarlierOutput: '没有更早的输出',
  historyDepthReached: '只能回读到这里',
  historyCaption: '屏幕之上的 {n} 行',
  historyLabel: '该终端更早的输出，读自其回滚缓冲区',
  termLoading: '正在加载终端…',
  termNotAttachable: '该代理无法接入终端。',
  paneExited: '终端窗格已退出',
  confirmInterrupt: '确定要中断这个代理吗？',
  confirmInterruptMode:
    '中断模式：在该助手工作时发送消息，会先打断它并丢弃正在进行的工作。' +
    '此设置对该助手持续生效，直到你切换回来。是否继续？',
  sendModeLabel: '助手工作时，发送键的行为',
  moreOptions: '发送选项、目标与常用回复',
  sendModeQueue: '排队',
  sendModeInterrupt: '中断',
  sendModeQueueTitle: '让助手做完，你的消息在提示符处等待。',
  sendModeInterruptTitle: '先打断助手，再发送。只确认一次，之后即生效。',
  interrupt: '中断',
  interruptAndSend: '中断并发送',
  interruptTitle: '立即停止该助手正在做的事',
  interruptIdle: '无需中断 —— 该助手当前没有在工作',
  interruptSent: '已发送 Escape。该操作没有任何记录，因此无法确认是否生效 —— 请在「终端」标签页查看。',
  modelQueued: '{model} 已排队 —— 当前任务结束后生效',
  shiftTabSent: '已发送 Shift+Tab —— 该助手的终端会显示切换到了哪个模式',
  modeUnreported: '尚未报告',
  shiftTabAction: '发送 Shift+Tab，即循环切换该助手权限模式的快捷键',
  shiftTabActionWithMode: '发送 Shift+Tab，即循环切换该助手权限模式的快捷键 —— 最近记录的模式：{mode}',
  hintShiftTab: '切换权限模式',
  confirmKey: '确定要向这个代理发送 {key} 吗？',
  settings: '设置',
  notifyOn: '通知已开启——点击关闭',
  notifyOff: '有代理需要你时通知我——点击开启',
  notifyNudge: '刚才有代理需要你。下次要收到通知吗？',
  notifyNudgeOn: '开启',
  notifyNudgeDismiss: '暂不',
  notifyUnsupported: '此浏览器不支持通知。',
  notifyDenied: '通知已在浏览器的网站设置中被禁止。',
  notifyBody: '正在等你 — {reason}。',
  notifyBodyPlain: '正在等你。',
  theme: '主题',
  themeSystem: '跟随系统',
  themeLight: '浅色',
  themeDark: '深色',
  colourScheme: '配色',
  schemeGraphite: '石墨',
  schemeNordic: '极地',
  schemeSolar: '日晒',
  schemeEmber: '余烬',
  schemeMauve: '藕荷',
  schemeOne: 'One',
  schemeDracula: 'Dracula',
  schemeMonokai: 'Monokai',
  language: '语言',
  help: '帮助',
  helpTitle: '帮助',
  helpVersion: '服务端 {version}',
  helpIntro: 'agent-commander 会列出本机所有正在运行的 Claude Code 会话，并且可以直接和它们对话。',
  helpSectionBasics: '基本用法',
  helpBasicsGroups: '代理按「需要你处理 → 运行中 → 空闲」分组，需要你处理的排在最上面。',
  helpBasicsChat: '「对话」把会话显示成聊天记录，每条回复所执行的工具调用会折叠在下面。',
  helpBasicsAttach: '「终端」是真实终端的画面截取，而非共享。代理写下的问题可以在「对话」里回答；其余情况用「终端」。',
  helpBasicsNotify:
    '页眉的铃铛会在有代理开始需要你时发出通知。只对本页面亲眼看到的阻塞触发，且标签页可见时绝不触发——那时顶部的列表本身就是通知。',
  helpSectionKeys: '键盘快捷键',
  keySlash: '聚焦筛选框',
  keyArrows: '在代理列表中上下移动',
  keyEnter: '打开选中的代理',
  keyEsc: '关闭当前代理，或清空筛选框',
  keyShiftEsc: '离开终端（单独按 Esc 会传给代理）',
  keyEnterSend: '在输入框中：发送 / 换行',
  helpSectionPhone: '在 iPhone 上访问',
  helpPhoneIntro: '本服务只监听 localhost。通过 Tailscale 可以在手机上访问，而不会暴露到公网。',
  helpPhoneStep1: '在 iPhone 上从 App Store 安装 Tailscale，并登录同一个账号。',
  helpPhoneStep2: '在这台 Mac 上带令牌启动服务，并共享端口：',
  helpPhoneStep3: '然后在手机的 Safari 中打开：',
  helpPhoneStep3Note:
    '需要在末尾加上令牌，`--print-url` 会打印可直接粘贴的完整链接。令牌是必需的：Tailscale Serve 会把本机自己的名字转发给 tailnet 上的每一台设备，只凭名字无法把你的手机和其它设备区分开。链接只需粘贴一次，服务会把它换成 Cookie 并从地址栏中移除。',
  helpPhoneStep4: '之后想停止共享，运行：',
  helpPhoneAlt: '另一种方式，不用 Tailscale Serve —— 直接绑定 tailnet 地址：',
  helpPhoneAltNote:
    '令牌会保存在 ~/.claude/agent-commander/token 并在每次启动时复用，所以你保存的链接不会失效。不要使用 --host 0.0.0.0，那样在你连接的任何 Wi-Fi 上都能访问到它。',
  helpPhoneWarning: '千万不要使用 `tailscale funnel`：它会发布到公网，任何能访问的人都能操控你的代理。',
  helpTailscaleDetected: '已在本机检测到',
  helpReveal: '显示',
  helpHide: '隐藏',
  helpMaskedNote: '已隐藏本机名称与 tailnet 名称，方便截图或分享。点击“复制”仍会复制真实地址。',
  helpTailscaleMissing: '本机未检测到 Tailscale，下面的地址仅作示例。',
  helpAddToHome: '在 Safari 中点「分享 → 添加到主屏幕」，就能得到一个应用图标。',
  sortBy: '排序',
  sortRecent: '最近活动',
  sortTokens: '输出 token',
  staleFleet: '未连接 — 显示 {when} 收到的最后状态。',
  staleFleetNoTime: '未连接 — 显示最后收到的状态。',
  sortDuration: '运行最久',
  sortName: '名称',
  sortFirst: '优先',
  senseNewest: '最新',
  senseOldest: '最早',
  senseMost: '最多',
  senseLeast: '最少',
  senseLongest: '最久',
  senseShortest: '最短',
  senseZA: 'Z→A',
  senseAZ: 'A→Z',
  agentSettings: '代理设置',
  modeLabel: '模式',
  modelLabel: '模型',
  modeDefault: '手动',
  modeAcceptEdits: '自动接受修改',
  modePlan: '计划',
  modeBypassPermissions: '跳过确认',
  modeAuto: '自动',
  modeDontAsk: '不询问',
  modelDefault: '默认',
  controlBusy: '仅在代理空闲时可用',
  controlFailed: '未能生效：{error}',
  closeAgent: '关闭代理',
  closeKeep: '让它继续运行',
  goalLabel: '目标',
  goalPlaceholder: '持续工作直到……',
  goalConditionLabel: '目标条件',
  goalApply: '设定',
  goalCancel: '取消',
  goalSetting: '设定中……',
  goalSetAction: '设定一个代理会持续追求的目标',
  goalClearAction: '清除目标：{condition}',
  goalActiveTitle: '正在追求：{condition}',
  goalChecked: '已检查，尚未达成',
  goalAchieved: '已达成',
  closeConfirm: '要关闭 {name} 吗？会先请它退出，若无响应则强制结束。',
  closing: '正在关闭…',
  closedGracefully: '{name} 已退出。',
  closedForced: '{name} 未响应 /exit，已被强制结束。',
  clearContext: '清空',
  clearKeep: '保留这段对话',
  clearing: '正在清空…',
  clearContextTitle: '丢弃当前对话，让该代理重新开始',
  clearConfirm: '要清空 {name} 吗？代理会开启新会话，当前对话将被丢弃，且无法恢复。',
  cleared: '{name} 已清空，现在是一个新会话。',
  clearUnverified: '已发送 /clear，但 {name} 尚未开启新会话，可能没有生效。',
  compactContext: '压缩',
  compacting: '正在压缩…',
  compactContextTitle: '请该代理总结并压缩自己的上下文',
  compactRequested: '已请求压缩。{name} 会总结自己的上下文，这需要一些时间。',
  compacted: '已压缩 · {before} → {after}',
  compactedAuto: '已自动压缩 · {before} → {after}',
  browse: '浏览…',
  browseTitle: '选择目录',
  browseUp: '上一级',
  browseHidden: '显示隐藏文件夹',
  browseEmpty: '这里没有子文件夹。',
  browseChoose: '使用此文件夹',
  browseFailed: '无法读取该文件夹：{error}',
  defaultDir: '默认目录',
  defaultDirSet: '将当前设为默认',
  fullscreenTitle: '全屏',
  prune: '清理 {count} 个闲置会话',
  pruneTitle: '关闭那些打开后从未使用过的会话',
  pruneSessionOne: '会话',
  pruneSessionMany: '会话',
  pruneConfirm: '要关闭 {count} 个闲置会话吗？\n\n{names}\n\n它们都处于空闲状态且从未收到过指令，将对其执行 /exit。',
  pruneWorking: '正在关闭…',
  pruneDone: '已关闭 {count} 个闲置会话。',
  pruneSome: '已关闭 {count} 个中的 {done} 个，{failed} 个未能关闭：{error}',
  pruneNone: '没有关闭任何会话：{error}',
  newAgent: '新建代理',
  newAgentTitle: '启动一个新代理',
  newAgentDir: '目录',
  newAgentDirHint: '代理运行的位置，必须是已存在的目录。',
  newAgentName: '名称（可选）',
  newAgentNameHint: '显示在列表中，默认使用文件夹名。',
  newAgentStart: '启动代理',
  newAgentCancel: '取消',
  newAgentStarting: '启动中…',
  newAgentRecent: '最近使用的目录',
  newAgentFailed: '无法启动代理：{error}',
  newAgentNoTmux: '新建代理需要 tmux，但本机没有可用的 tmux。',
}

const DICTS: Record<Lang, Record<Key, string>> = { en: EN, 'zh-CN': ZH }

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}

/**
 * Longest value interpolated into a message.
 *
 * Substituted values are user input or server text and can be arbitrarily long;
 * a 300-character search term echoed back is unreadable even when it wraps.
 */
const MAX_VAR = 80

function clamp(value: string | number): string {
  const text = String(value)
  return text.length > MAX_VAR ? `${text.slice(0, MAX_VAR - 1)}…` : text
}

/** Translate, substituting `{placeholders}`. */
export function translate(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  const raw = DICTS[lang][key] ?? EN[key]
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(vars, name) ? clamp(vars[name] as string | number) : whole,
  )
}

/* ---- time, where word order differs between languages ---- */

export function formatRelative(lang: Lang, rel: Relative | null): string {
  if (!rel) return ''
  if (lang === 'zh-CN') {
    switch (rel.unit) {
      case 'now':
        return '刚刚'
      case 'sec':
        return `${rel.n} 秒前`
      case 'min':
        return `${rel.n} 分钟前`
      case 'hour':
        return `${rel.n} 小时前`
      case 'day':
        return `${rel.n} 天前`
    }
  }
  switch (rel.unit) {
    case 'now':
      return 'just now'
    case 'sec':
      return `${rel.n}s ago`
    case 'min':
      return `${rel.n}m ago`
    case 'hour':
      return `${rel.n}h ago`
    case 'day':
      return `${rel.n}d ago`
  }
}

export function formatUptime(lang: Lang, up: Uptime | null): string {
  if (!up) return ''
  if (lang === 'zh-CN') {
    if (up.unit === 'day') return `${up.a} 天 ${up.b} 小时`
    if (up.unit === 'hour') return `${up.a} 小时 ${up.b} 分`
    return `${up.a} 分钟`
  }
  if (up.unit === 'day') return `${up.a}d ${up.b}h`
  if (up.unit === 'hour') return `${up.a}h ${String(up.b).padStart(2, '0')}m`
  return `${up.a}m`
}

export function formatDay(lang: Lang, mark: DayMark): string {
  if (mark.kind === 'today') return translate(lang, 'today')
  if (mark.kind === 'yesterday') return translate(lang, 'yesterday')
  return new Date(mark.at).toLocaleDateString(lang === 'zh-CN' ? 'zh-CN' : undefined, {
    month: 'short',
    day: 'numeric',
  })
}

/** Best initial guess from the browser, before the user has chosen. */
export function detectLang(): Lang {
  const nav = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]
  for (const tag of nav) {
    if (typeof tag === 'string' && tag.toLowerCase().startsWith('zh')) return 'zh-CN'
  }
  return 'en'
}
