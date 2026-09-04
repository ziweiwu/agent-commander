# agent-commander — functional specification

What this app must do, surface by surface, stated as requirements rather than
as code. It is the fourth document in a set that already covers everything
else, so its boundaries matter more than most:

| Document | Answers |
|---|---|
| `README.md`, `docs/HANDBOOK.md` | How do I use it? (one page, then at length) |
| `ARCHITECTURE.md` | How is it built, and where does it break? |
| `INVARIANTS.md` | What must never be false, and what proves it? |
| **`SPEC.md`** | **What is it supposed to do?** |
| `AGENTS.md` | How do I work on it? |
| `TODO.md` | What is queued, and what was rejected? |

**The relationship to `INVARIANTS.md` is containment, not overlap.** INV-1 …
INV-17 are the subset of this document's requirements that are (a) properties
whose violation is a defect rather than a preference, and (b) individually
numbered and greppable from a test name. Where a requirement here restates an
invariant it cites it, and **the invariant is authoritative** — if the two ever
disagree, this file is the one that is wrong. `INVARIANTS.md` is the terse,
gated contract; this file is the fuller, more fluent account of what the app is
for, written for someone who wants the reasons as well as the rules.

**This file has no gate.** `npm test` does not read it, no hook checks it, and
nothing fails when it drifts. That is a real cost and the reason the set did
not already contain it: TODO.md's own "Not doing" section rejects TLA+ partly
for being "a third artifact to keep in sync". Two things hold it down instead:

- Every requirement cites the test that checks it, or is marked **[unverified]**.
  An unverified requirement is a claim about intent, not about the build.
- When behaviour changes, this file changes in the same commit — the same rule
  `AGENTS.md` already states for `INVARIANTS.md`.

Requirements are `MUST` (a violation is a defect), `MUST NOT`, and `SHOULD` (a
deliberate departure needs a reason written down). IDs are stable; retire one
by marking it withdrawn rather than reusing the number.

---

## 1. Scope

### 1.1 What this is

A local web dashboard over every agent CLI session running on one machine —
what each is doing, which is blocked on a human, and a way to answer the
blocked one from a browser, including a phone reached over Tailscale.

**It is an observer of somebody else's work in progress.** Every requirement
below is downstream of that: the sessions on screen are real, they are mid-task,
and this app is never allowed to disturb one. The two constraints that follow
from it are INV-1 (never resize a real pane) and INV-2 (nothing reaches a live
agent except from an explicit user action).

### 1.2 Non-goals

- **Not a terminal multiplexer.** It does not create tmux sessions, windows or
  panes for existing agents, and does not give the browser a pty (INV-1).
- **Not an agent runner.** It never decides what an agent should do next, never
  retries, and never composes a message on the user's behalf. `/goal` is the
  one stop condition it can set, and only because the CLI implements it.
- **Not multi-machine.** One server, one machine, the sessions on it. Remote
  access is Tailscale in front of a loopback bind, not a fleet protocol.
- **Not multi-user.** There are no accounts. A credential is a capability
  (§7), not an identity, and nothing is scoped per person.
- **Not a cost tracker.** `tokens` is output tokens accumulated per tail, not
  a session's spend (INV-11); the quota meters are the only cost-shaped figure
  and they come from a statusLine bridge, not from billing.
- **Not Windows.** The Attach tab is `tmux capture-pane`/`send-keys`. A Windows
  build would install cleanly and command nothing.

### 1.3 Platform envelope

- **FR-ENV-1** — The server MUST run as a single binary with no interpreter and
  no runtime dependencies, on macOS (arm64, x64) and Linux (x64, arm64).
  *`.github/workflows/npm-publish.yml`, four matrix legs.*
- **FR-ENV-2** — The browser app MUST work on the current Chromium and WebKit
  engines at desktop, tablet and phone shapes, in both orientations.
  *`npm run e2e`, five projects.*
- **FR-ENV-3** — The app MUST require a running tmux server for its Attach and
  input paths, and MUST degrade rather than fail where one is absent (§6).

---

## 2. Domain model

The nouns, and where each one's truth lives. Nothing here is invented by this
app; every field is read from something else's record.

| Term | Definition | Source of truth |
|---|---|---|
| **Agent** | One CLI session this app can see. | `~/.claude/sessions/<pid>.json` for Claude; tmux for other kinds |
| **Session id** | The agent's identity, and the key for every operation. | Claude Code |
| **Agent kind** | Which CLI it is, and therefore what may be done to it. | `agent_kinds.rs` |
| **Pane** | The tmux pane the session runs in. Absent means unattachable. | tmux |
| **Status** | `busy` / `waiting` / `idle` / `unknown`. | The CLI, or inferred (§3.2) |
| **`waitingFor`** | Why it is blocked, from a closed set. | Claude Code |
| **Transcript** | The conversation, as JSONL, tailed by byte offset. | `~/.claude/projects/…` |
| **Delegate** | A subagent the session handed work to. | One sidecar per delegate |
| **Pending prompt** | The question an agent is blocked on, with its options where stated. | The transcript's open `tool_use` |
| **Goal** | A `/goal` stop condition and its evaluation history. | `goal_status` transcript records |
| **Grant** | What a credential may do: `read`, `respond`, `drive`, `spawn`. | `--grant` |
| **Frame** | One captured pane image, as changed rows. | `tmux capture-pane` |

### 2.1 Status

- **FR-STATUS-1** — Status MUST be one of `busy`, `waiting`, `idle`, `unknown`,
  and `unknown` MUST be the default for an unset or unrecognised value: an
  absent status is not a claim. *`types.rs::AgentStatus`.*
- **FR-STATUS-2** — `waitingFor` MUST only be present when status is `waiting`,
  and MUST come from the closed set the CLI writes: `dialog open`, `permission
  prompt`, `input needed`, `sandbox request`, `goal proposal`, `worker request`.
  It says *that* a dialog is open, never *which* (INV-16).
- **FR-STATUS-3** — A status this app derived rather than read MUST be marked
  as inferred, and an inferred status MUST NEVER be `waiting`. An agent blocked
  on a permission prompt and one that has finished look identical from outside
  a transcript, and inventing a "needs you" for either spends the credibility of
  the one alert this app exists to raise. **(INV-11)**
  *`tmux_agents::inv11_an_inferred_status_is_never_waiting`.*
- **FR-STATUS-4** — An agent that has delegated and is doing nothing itself MUST
  read as busy-and-delegating, and its last-activity clock MUST follow its
  delegates' transcripts rather than its own — its own stops growing the moment
  it delegates, so without both a healthy run looks like an agent that died.
  **(INV-15)** *`test/ui/delegated-pill.test.tsx`, `test/trail.test.ts`.*

### 2.2 Agent kinds, and the capability matrix

Every capability here is a statement about a *foreign program's* interface, so
the default for an unrecognised kind is deny.

| | Claude Code | Kiro | Unknown kind |
|---|---|---|---|
| Discovered via | its own session file | tmux name or process | — |
| Chat tab | yes | **no** | no |
| Attach tab | yes | yes | yes, with a pane |
| Token counts, delegation | yes | no | no |
| Status | reported | inferred, never `waiting` | inferred |
| Shift+Tab, Model, Compact, Clear, Goal | yes | **no** | no |
| Close | yes (`/exit`, then force) | yes (tmux only) | yes (tmux only) |

- **FR-KIND-1** — Claude Code's slash commands MUST only ever be typed at
  Claude Code. Against another CLI they do not degrade — they type a sentence of
  this app's own devising into somebody's live prompt. The server MUST refuse
  them for any kind whose spec says otherwise; the browser hiding the control is
  a convenience, not the boundary. **(INV-7)**
  *`agent_kinds::capabilities_deny_by_default_for_unknown_kinds`,
  `test/ui/kiro-surfaces.test.tsx`.*
- **FR-KIND-2** — A capability a kind lacks MUST be hidden with its reason
  stated on the card, not rendered empty. An empty Chat tab reads as a bug; "no
  conversation this app can read" reads as a fact. *`test/ui/kiro-surfaces.test.tsx`.*
- **FR-KIND-3** — A tmux session whose pane is sitting at a shell prompt MUST
  NOT be listed as an agent. tmux-resurrect restores session names long after
  the process inside them died, and a husk listed as a live agent is worse than
  no listing. *`agent_kinds::SHELL_COMMANDS`.*

---

## 3. The fleet

### 3.1 The list

- **FR-FLEET-1** — The fleet MUST have exactly one rendering. There were two;
  every property that had to be true of the fleet had to be proved twice, and
  the second view's question turned out to be answerable on the card.
- **FR-FLEET-2** — Agents MUST be grouped **Needs you → Working → Idle**, in
  that order, so anything blocked on a human is the first thing on screen.
  `unknown` groups with Idle. *`test/fleet-ui.test.ts`, `e2e/fleet.spec.ts`.*
- **FR-FLEET-3** — Sorting MUST happen *inside* groups and never across them:
  no sort key may bury an agent that is blocked. *`test/fleet-ui.test.ts`.*
- **FR-FLEET-4** — Sort keys MUST be `recent`, `tokens`, `duration`, `name`,
  each with an ascending and descending direction labelled by what the order
  *means* ("most"/"least", "newest"/"oldest") rather than by "asc"/"desc".
  *`test/ui/SortControl.test.tsx`.*
- **FR-FLEET-5** — An agent with no value for the active sort key MUST sort last
  in **both** directions. Unknown is not a claim that it is the smallest.
  **(INV-11)** *`test/fleet-ui.test.ts`.*
- **FR-FLEET-6** — The search box MUST filter on name, folder, branch, activity
  and status, and MUST narrow the same list the status chips and sort do.
- **FR-FLEET-7** — The active status filter, sort key and sort direction MUST
  persist together in this browser and survive a reload, a new tab and a browser
  restart. Restoring one while resetting another leaves a view nobody picked.
  *`test/prefs-filter.test.ts`.*
- **FR-FLEET-8** — The search query MUST NOT persist: a one-off lookup returning
  after a reload with no visible cause is confusing.
- **FR-FLEET-9** — An active filter MUST be distinguishable by more than a fill
  colour, so arriving at an already-filtered dashboard reads as a filter rather
  than an empty fleet.
- **FR-FLEET-10** — No user-supplied string may set the document's width. A long
  search term echoed into an empty-state message MUST wrap or truncate.
  *Found by `qa-fuzz`; `scripts/audit-mobile.mjs` measures it.*
- **FR-FLEET-11** — Before the first fleet frame has arrived, the list MUST show
  a loading state that names no count and makes no claim, and MUST NOT show the
  confirmed-empty copy. "No sessions found" is a reading the server has to have
  given; over Tailscale on a phone the gap before it does is seconds long.
  `--mock-empty` serves the confirmed-empty screen so it can be looked at.
  **(INV-11)** *`test/ui/stale-fleet.test.tsx`, `e2e/loading.spec.ts`.*

### 3.2 The card

- **FR-CARD-1** — A card has three tiers. Its **face** MUST carry name, status
  (with `waitingFor` where present), a one-line summary of current activity,
  and one line of place: working directory, git branch, time since last
  activity. A **working** card adds what "is it still moving" needs — the
  activity trail, its delegate claims and the stall question — and a
  **waiting** card that can be reached adds the verb that answers it. A
  **fold** below the card, behind one disclosure, MUST carry the rest: the
  output-token count with its caveat, the original session name where the
  title leads, the full path, the delegation tree, and on a card that is not
  working the "delegated nothing" claim. The face MUST NOT carry a fact the
  group's question does not need. *`test/ui/card-diet.test.tsx`.*
- **FR-CARD-2** — Where Claude Code named a session for itself (`nameSource:
  "derived"`), the card MUST lead with the agent's own conversation title, or
  failing that the first line of the last prompt, keeping the session name as
  secondary text. The app MUST NOT guess which names are derived — the session
  file says so. *`test/naming.test.ts`.*
- **FR-CARD-3** — Token counts MUST be presented as what they are: output
  tokens accumulated from a bounded backfill, not a session's spend — and the
  caveat MUST be visible text, not a hover title, because a phone has no hover
  and a screen reader is not told about a `title`. **(INV-11)**
  *`test/ui/card-diet.test.tsx`.*
- **FR-CARD-4** — An agent that has never been prompted MUST say so ("No
  prompts yet") rather than showing zeros. *`test/ui/FleetList.test.tsx`.*
- **FR-CARD-5** — A card MUST NOT present a figure from a dropped connection as
  a current reading. When the fleet is not live, the view MUST say the data is a
  memory and disable the actions that depend on it being current. **(INV-11)**
  *`test/ui/stale-fleet.test.tsx`.*

### 3.3 Delegates

- **FR-DEL-1** — A delegation tree MUST be read from the sidecars Claude Code
  writes beside each subagent transcript, never derived from timing or naming.
  **(INV-13)** *`test/delegation-claim.test.ts`, `test/ui/fleet-trees.test.tsx`.*
- **FR-DEL-2** — Each card MUST summarise what the agent handed out (`4
  delegates · 1 active · 2 quiet · 1 done`) and MUST be able to open the tree
  beneath it, nested as deep as the work goes.
- **FR-DEL-3** — A delegate MUST carry exactly one of three states, and the
  three MUST stay distinct:
  - **done** — something recorded an ending. In practice: a human stopped it.
  - **active · inferred** — its transcript grew recently and the parent is
    working. A guess that says it is one.
  - **quiet** — nothing written for a while, nothing recorded an ending. It may
    have finished; it may have died. The app MUST say neither. **(INV-13)**
- **FR-DEL-4** — Because almost every delegate ends up `quiet`, each row MUST
  also show a *measurement* of what it did (`29 calls over 12m`) counted from
  its own transcript. A delegate whose transcript cannot be read MUST show no
  numbers rather than zeros — a zero is a confident claim that it did nothing.
- **FR-DEL-5** — A delegate whose parent is missing from disk MUST be shown at
  the top level and marked, never dropped along with everything beneath it.
- **FR-DEL-6** — An agent whose CLI keeps no transcript MUST report that the app
  *cannot tell* whether it delegated, which is not the same as having delegated
  nothing. *`test/ui/fleet-delegates.test.tsx`.*
- **FR-DEL-7** — When a delegating agent is quiet **and** every delegate is
  quiet, the card MUST raise it as a **question** ("Nothing here has moved for
  9m — still working?"), never as a verdict; and one delegate still moving MUST
  say the opposite in the same place. **(INV-15)** *`test/trail.test.ts`.*

---

## 4. The agent view

Opening an agent gives two tabs. On a narrow screen it is a full-height sheet
over the list with a back control; on a wide one, a second column.

### 4.1 Chat

- **FR-CHAT-1** — The Chat tab MUST render the session as an attributed
  conversation, with the tool calls a reply produced folded underneath it and
  long runs collapsed behind a count.
- **FR-CHAT-2** — A message the user sends MUST appear immediately as *sending…*
  and settle only when the agent's own transcript confirms it. *`test/ui/delivery.test.tsx`.*
- **FR-CHAT-3** — A message the agent never echoes back MUST be marked **not
  delivered**, and MUST NEVER be resent automatically. **(INV-2)**
  *`test/ui/delivery.test.tsx`.*
- **FR-CHAT-4** — A message sent to a **working** agent MUST read *queued* and
  MUST NOT start its undelivered countdown until the agent stops. Claude Code
  writes a prompt down when it *processes* it, so a message waiting behind a long
  turn is waiting, not late. *`test/ui/delivery.test.tsx`.*
- **FR-CHAT-5** — Duplicate suppression MUST hold across a burst: two sends in
  one frame, a double tap, and a reconnect MUST NOT produce two messages.
  **(INV-2)** *`test/ui/burst-send.test.tsx`.*
- **FR-CHAT-6** — `Enter` MUST send and `Shift+Enter` MUST insert a newline.
  `Shift+Tab` in the box MUST send the chord to the agent (§5.1); the cost — that
  it no longer tabs focus backwards — is accepted, and `Tab` and `Escape` MUST
  still move focus. *`test/ui/escape-levels.test.tsx`.*
- **FR-CHAT-7** — The quick replies MUST be offered from one menu in the strip
  above the box, closed at rest. As a row of chips they overflowed the strip at
  every width the detail panel has — two of five out of sight at 1280px — and a
  shortcut nobody can see is not one. Picking one sends it as it reads, closes
  the menu, and MUST leave anything half-typed in the box alone. Opening it
  MUST move focus into the list, and Escape MUST close the list and nothing
  else (FR-UI-14): the list is portalled, so a guard that only saw keys from
  inside it let Escape reach the app and close the whole agent panel.
  *`test/ui/QuickPrompts.test.tsx`, `test/ui/burst-send.test.tsx`.*
- **FR-CHAT-8** — Quick replies MUST follow the language the *conversation* is
  in, not the language the interface is set to. *`test/promptLang.test.ts`.*
- **FR-CHAT-9** — While the agent is working, the conversation MUST show that it
  is, and MUST offer a way to stop it from here rather than only from Attach.
  *`test/ui/chat-interrupt.test.tsx`.*
- **FR-CHAT-10** — With the connection down, the composer MUST refuse rather
  than accept text it cannot deliver, and MUST say why. **(INV-2)**
  *`test/ui/chat-offline.test.tsx`.*

### 4.2 Answering a blocked agent

This is the app's reason to exist, and the requirement that governs it is
epistemic rather than functional.

- **FR-ANS-1** — Every option label the app offers MUST be read out of that
  agent's own transcript. Where the transcript does not state the choices, the
  app MUST say so and offer navigation keys instead of composing a list. A
  mislabelled button here answers a live agent's question wrongly. **(INV-16)**
  *`transcript::prompt_tests`, `test/ui/answer-card.test.tsx`.*
- **FR-ANS-2** — The three blocked shapes MUST be treated to the depth each is
  knowable: `AskUserQuestion` states question and every option, so buttons are
  labelled; `ExitPlanMode` states the plan but not its approval choices, so the
  plan is shown and no choice named; a tool permission request states the tool
  and its input but not the numbered list, so what it would do is shown and no
  choice named. **(INV-16)**
- **FR-ANS-3** — The card MUST appear only when the status is `waiting` **and**
  the transcript names an open call. A tool merely *running* looks exactly like
  one waiting to be allowed. **(INV-16)**
- **FR-ANS-4** — A delegate's question MUST be excluded outright: it is asked of
  the delegate, and answering it into the parent's prompt types into the wrong
  session. **(INV-16)**
- **FR-ANS-5** — An answer MUST be delivered as the option's own *number*, which
  selects it wherever the highlight sits. Arrow keys would assume the picker
  opened at the top, and being wrong about that does not fail loudly — it
  answers a different question than the one that was read. **(INV-16)**
- **FR-ANS-6** — An answer MUST carry the id of the prompt it was given for, and
  the server MUST re-read the transcript and refuse if the agent has moved on. A
  bare digit means "whatever the pane is showing when tmux receives it".
- **FR-ANS-7** — One press MUST close the card, guarded synchronously. A second
  digit is not a duplicate answer — `AskUserQuestion` asks its questions one at
  a time, so it would answer the *next* one. **(INV-2, INV-16)**
- **FR-ANS-8** — A blocked agent MUST show a banner naming what it is waiting
  for wherever it is opened, and MUST offer a route to the terminal for the
  cases the transcript cannot describe.

### 4.3 Attach

- **FR-ATT-1** — The Attach tab MUST be a polled, diffed capture of the pane —
  never a pty. A pty means a tmux client, a client has a size, and under
  `window-size latest` a browser-shaped client reflows the pane a working agent
  is drawing into. **(INV-1)** *`tmux_client::inv1_never_passes_a_size_to_tmux`,
  `npm run verify:inv1`.*
- **FR-ATT-2** — The browser's width MUST only ever set a CSS transform. `cols`
  and `rows` MUST NEVER travel back to tmux, at any viewport, in any
  orientation, in full screen or out of it. **(INV-1)** *`e2e/tablet.spec.ts`.*
- **FR-ATT-3** — Text MUST NOT be scaled below ~9.5px. Past that floor the view
  MUST keep the captured geometry and pan sideways instead: a 150-column pane on
  a 390px screen would otherwise render at ~4.6px. *`test/term-scale.test.ts`.*
- **FR-ATT-4** — Where the container has room to spare, the capture MUST be
  enlarged to use it, bounded by height as well as width so growing can never
  push the last rows off the bottom. *`test/term-scale.test.ts`.*
- **FR-ATT-5** — The view MUST re-fit when its container changes shape — a
  window drag, a rotation, a sheet opening, the key bar wrapping — without
  waiting for the agent to redraw. A quiet agent sends no geometry change, so
  nothing would otherwise recover it. *`test/ui/term-resize.test.tsx`.*
- **FR-ATT-6** — A **Fit width** control MUST be offered whenever the view is
  not 1:1, in both directions, so a crisp capture is always one action away.
- **FR-ATT-7** — A **Full screen** mode MUST be offered once per layout: from
  the panel header on a desktop and from the tab row on a narrow screen, where
  it sits directly above the pane that needs the room. It was offered a third
  time from the terminal's own key bar, two rows below the tab row's copy, and
  a second answer to a question already answered is noise. `Esc` leaves it.
  *`test/ui/inv17-parity.test.tsx`, `test/ui/one-place.test.tsx`.*
- **FR-ATT-8** — Quick keys (`Enter`, `↑`, `↓`, `Tab`, `Esc`, `Ctrl-C`) MUST sit
  under the terminal, because a phone keyboard has none of them.
- **FR-ATT-9** — `Ctrl-C`, `Ctrl-D` and `Escape` MUST require a confirmation
  step, and the server MUST refuse them unless the client states the user was
  asked. **(INV-6)** *`test/ui/key-map.test.tsx`, `control::tests`.*
- **FR-ATT-10** — `Shift+Esc` MUST leave the terminal, because plain `Esc`
  belongs to the agent — and MUST discard exactly one level, not two.
  *`test/ui/escape-levels.test.tsx`.*
- **FR-ATT-11** — A pane that has ended MUST be reported as ended, above the
  capture and ahead of it in reading order, with input disabled. Nothing else
  changes on screen when a pane dies: a frozen capture is indistinguishable from
  a live one that is quiet. The last frame MUST be kept and MUST NOT be dimmed —
  it usually says why the agent died.
- **FR-ATT-12** — Attaching MUST NOT begin polling until a tab explicitly opens
  the view, and MUST stop when it closes, disconnects or goes to sleep. Nothing
  polls what nobody is watching. **(INV-4)**

---

## 5. Controlling a running agent

Every control here works by typing Claude Code's own commands into that agent's
prompt. That is what makes the guards below non-negotiable rather than tidy.

### 5.1 The controls

| Control | Effect | Allowed while busy |
|---|---|---|
| **Shift+Tab** | cycles the permission mode | yes |
| **Model** | switches model | yes |
| **Compact** | asks the agent to shorten its own context | no |
| **Clear** | discards the conversation, starting a new session | no |
| **Goal** | sets or clears a `/goal` stop condition | no |
| **Close** | `/exit`, then force | no |

- **FR-CTL-1** — Every action that *types* MUST refuse an agent whose status is
  `busy`. Text landing mid-tool-call arrives in whatever the agent is drawing and
  submits something nobody wrote. `idle` and `waiting` MUST be allowed — a
  waiting agent is precisely the one worth redirecting. **(INV-8)**
  *`test/ui/AgentControls.test.tsx`, `control::tests`.*
- **FR-CTL-2** — Shift+Tab and Model are the two exceptions and MUST work
  mid-task: Shift+Tab is a control key the agent handles wherever it is, and
  Model rides the same paste the composer already permits on a working agent.
  Refusing the select while permitting the message would be one door open and one
  shut onto the same prompt.
- **FR-CTL-3** — A control whose success cannot be observed MUST claim only what
  it did. Shift+Tab MUST say it sent the key and nothing more: Claude Code writes
  its permission mode down only at the *end of a turn*, so an agent at its prompt
  reports nothing back, and one that has not taken a turn has no transcript to
  report from. Naming the mode is what made a working control look broken three
  times across two rewrites. **(INV-11)**
- **FR-CTL-4** — A control whose value is read back from the transcript MUST keep
  showing the user's choice until the agent confirms it. Otherwise the next fleet
  broadcast repaints the old value and the action looks like it did nothing.
- **FR-CTL-5** — A change made mid-turn MUST say it is **queued** rather than
  claiming to have landed. *`test/ui/ChatControls.test.tsx`.*
- **FR-CTL-6** — **Compact** MUST NOT be waited on — it runs for minutes. The
  confirmation MUST say the compaction was *requested*, and the conversation MUST
  later show what it shed (`compacted · 887k → 29k`). An automatic compaction MUST
  appear the same way and MUST say it was automatic. **(INV-8)**
- **FR-CTL-7** — **Clear** MUST ask first, because there is no undo; and because
  `/clear` *replaces* the session rather than editing it, the app MUST follow the
  agent to its new id. Anything holding the old id is stale the moment it lands.
  **(INV-8)** *`e2e/control.spec.ts`.*
- **FR-CTL-8** — Clear and Compact MUST share one implementation across every
  place they are offered. What has to be identical is a *sequence*: a guard so a
  double click cannot discard the session the first click just created, a refusal
  to claim anything when no new session appeared, and following the agent to its
  new id in the right order.
- **FR-CTL-9** — **Close** MUST send `/exit` first and force only a session that
  ignores it. For a kind with no slash commands, Close MUST close the tmux
  session instead. **(INV-7)**
- **FR-CTL-10** — **Goal** MUST be confirmed against the `goal_status` record
  `/goal` leaves in the transcript, so a paste that went into a dialog instead of
  the prompt is reported rather than shown as a goal that is quietly not set.
  Clearing MUST be the stated exception: Claude Code writes nothing when a goal is
  cleared, so the app MUST NOT claim confirmation it cannot have. **(INV-8,
  INV-11)**
- **FR-CTL-11** — A running goal MUST name itself, and MUST distinguish "checked
  and not yet met" (the normal case, meaning still going) from *achieved*, which
  ends the goal and returns the toggle to off.

### 5.2 Where the controls live

- **FR-CTL-12** — Shift+Tab, Model, Goal, Compact and Clear MUST live in the
  composer strip beside the message box, and nowhere else. The panel's control
  row sits above the tabs, folds behind `⋯` on a phone and does not exist in
  full screen — which is exactly where a conversation gets long enough to want
  compacting, and where its model is read — so the strip is the one surface
  every layout keeps; the row keeps Close, which ends the session rather than
  steering it. They used to be in both, and at a desktop width both were
  visible: two Clear buttons for one action. Every control on the agent screen
  MUST be drawn once. *`test/ui/one-place.test.tsx`,
  `test/ui/AgentControls.test.tsx`, `e2e/control.spec.ts`.*
- **FR-CTL-13** — On a narrow screen the panel's control row MUST collapse behind
  a single control; it cost 111px of a 568px screen. On a landscape phone the
  composer strip MUST hide itself entirely — there are ~380px of height and the
  conversation needs them. This is a measured, accepted gap, not an oversight.

### 5.3 Send behaviour

- **FR-SEND-1** — What Send does to a working agent MUST be a choice between
  **Queue** (default: the message waits at the prompt) and **Interrupt** (stop
  first, then send).
- **FR-SEND-2** — Choosing Interrupt MUST ask once, after which the Send button
  reads *Interrupt & send*. A dialog in front of every send is one people learn
  to dismiss without reading.
- **FR-SEND-3** — The choice MUST be remembered **per agent**: it is a judgement
  about that session, not a global preference. *`test/ui/ChatControls.test.tsx`.*
- **FR-SEND-4** — A standalone **Interrupt** MUST ask every time, unlike the
  standing preference above, because it is a single destructive act. **(INV-6)**
  *`test/ui/chat-interrupt.test.tsx`.*

---

## 6. Fleet lifecycle

### 6.1 Starting an agent

- **FR-SPAWN-1** — **New agent** MUST ask for a directory — typed, picked from a
  folder browser, or chosen from the directories already in use — plus an
  optional name, model and permission mode, and MUST start the CLI there in a
  fresh *detached* tmux session.
- **FR-SPAWN-2** — The new session MUST appear in the list within a couple of
  seconds through the same discovery path as every other session — never by
  being inserted client-side. *`e2e/fleet.spec.ts`.*
- **FR-SPAWN-3** — The server MUST validate the directory before spawning, and
  MUST check model and permission mode against fixed allow-lists so an
  unrecognised value is refused rather than becoming a flag. **(INV-7)**
  *`MODEL_ALIASES`, `SPAWN_MODES` in the generated wire contract;
  `spawn::tests`.*
- **FR-SPAWN-4** — On a machine that cannot spawn anything, the dialog MUST
  refuse to offer a form rather than presenting one that will fail.
  *`test/ui/NewAgentDialog.test.tsx`.*

### 6.2 The folder browser

- **FR-BROWSE-1** — Every browsed path MUST be resolved with `realpath` *before*
  it is checked, so a symlink is judged by where it points rather than by what it
  is called, then confirmed to sit inside the root — the home directory by
  default, or `--browse-root`. **(INV-9)** *`browse::inv9_*`,
  `npm run verify:kani`.*
- **FR-BROWSE-2** — Containment MUST use a path-segment check, never a string
  prefix: `/abc` is not inside `/a`. **(INV-9)**

### 6.3 Pruning

- **FR-PRUNE-1** — **Prune N unused** MUST appear only when the fleet contains
  sessions matching the narrowest claim the data supports: status `idle`, a pane
  present, and *no* activity line, token spend, last-activity clock, generated
  title or recorded prompt — the same evidence the card prints "No prompts yet"
  from. *`test/prune.test.ts`.*
- **FR-PRUNE-2** — `busy`, `waiting`, delegating and `unknown` agents MUST be
  excluded outright. A status the app could not read is an absence of evidence,
  not permission to close a session. **(INV-11)**
- **FR-PRUNE-3** — Nothing MUST be closed without a confirmation that names the
  sessions first. *`test/ui/prune.test.tsx`.*
- **FR-PRUNE-4** — Sessions MUST be closed one at a time through the same
  `/exit`-then-force path as Close, one refusal MUST NOT stop the rest, and the
  result MUST report what actually closed rather than what was attempted.
  **(INV-11)**
- **FR-PRUNE-5** — The control MUST be unavailable while the fleet view is not
  live: a card from a dropped connection is a memory, not a reading. **(INV-11)**

---

## 7. Access and authority

### 7.1 Binding

- **NFR-SEC-1** — The server MUST bind `127.0.0.1` by default. **(INV-3)**
- **NFR-SEC-2** — `--host` MUST be refused without `--token`. This app can type
  into live agents and answer their permission prompts, so it MUST NOT expose
  itself to a network unauthenticated. **(INV-3)** *`options::inv3_*`.*
- **NFR-SEC-3** — The origin gate and the token gate MUST be independent, and
  the origin gate MUST NEVER be skipped. A token used to exempt a request from
  rebinding protection, which made the token the credential and the exemption at
  once. Binding loopback keeps the network out; it does nothing about the one
  program guaranteed to be running on this machine — the browser, whose
  WebSockets are exempt from CORS entirely. **(INV-3)** *`routes::inv3_*`.*
- **NFR-SEC-4** — A tokenless server MUST answer to loopback alone. Behind
  `tailscale serve` every tailnet peer arrives wearing this machine's own name,
  so the name alone cannot tell one peer from another and buys nothing.
  **(INV-3)**

### 7.2 The credential

- **NFR-SEC-5** — `--token auto` MUST persist its token at mode 0600 rather than
  minting a fresh one each start: rotation on every restart breaks the link saved
  on a phone, which pushes users to a literal token in an alias, where `ps` can
  read it and nothing ever rotates it. Rotation MUST be a deliberate command.
- **NFR-SEC-6** — A token arriving in a URL MUST be exchanged, on a browser
  navigation only, for an `HttpOnly; SameSite=Strict` cookie and redirected to
  the same address without the query string — so it stops living in the address
  bar, in history, in `document.referrer` and in any proxy's access log. A
  WebSocket handshake carries no `Authorization` header, which is why the query
  parameter exists at all. `?token=` and `Authorization: Bearer` MUST keep
  working unchanged for non-browser clients.
- **NFR-SEC-7** — The startup banner MUST mask the token. Under the Mac app
  stdout is a log file, so printing it in full writes the secret to disk on every
  start; `--print-url` is the explicit opt-in.
- **NFR-SEC-8** — A token in the URL cannot reach a subresource: `index.html`'s
  own `<script>` and `<link>` carry neither token nor header. `GET`/`HEAD` under
  the asset prefix MUST skip the token gate, and **nothing under that prefix may
  ever serve agent state.** *`routes::is_public_asset` tests.*

### 7.3 Grants

- **NFR-SEC-9** — A credential's authority MUST be separable into `read`,
  `respond`, `drive` and `spawn`; every grant MUST imply `read`, because being
  able to answer a question you cannot see would be worse to hand out than the
  whole token. The default MUST be all four.

| Grant | Covers |
|---|---|
| `read` | the fleet, transcripts, frames, `/api/env` |
| `respond` | answering the question an agent is blocked on |
| `drive` | pastes, keystrokes, mode, model, compact, clear, close |
| `spawn` | starting new agents, and the folder picker |

- **NFR-SEC-10** — An unknown grant name MUST be an error, not an ignored token.
  A typo that silently granted nothing would look like the app being broken; one
  that silently granted everything would be worse. *`options::tests`.*

### 7.4 Input safety

- **NFR-SEC-11** — Nothing MUST reach a live agent except from an explicit user
  action: no retries, no auto-send, no replay of buffered input on reconnect.
  **(INV-2)**
- **NFR-SEC-12** — Pane ids MUST be validated before reaching argv, and control
  keys MUST be checked against the server's own allow-list. The client's list is
  a convenience; the server is the boundary. **(INV-2)**
- **NFR-SEC-13** — User text MUST NEVER reach tmux's argument lexer. A paste MUST
  be staged through a mode-0600 file so there is no quoting rule to get wrong.
  **(INV-1, INV-2)**
- **NFR-SEC-14** — A write MUST pick its path before a byte is sent and MUST NOT
  change its mind: one shared tmux buffer name once meant two overlapping pastes
  ran `load(A) → load(B) → paste(into A)`, and A's agent received B's text.
  **(INV-2)** *`pane::tests` write-path group, plus a stateful property test.*
- **NFR-SEC-15** — No client may queue unbounded work into a running agent.
  Writes MUST be charged against a per-connection budget, and a frame that could
  not be a legitimate message MUST be refused before it is parsed. **(INV-12)**

---

## 8. Quota meters

- **FR-QUOTA-1** — The topbar MUST show how much of the Claude.ai **5-hour** and
  **7-day** windows have been used, each with when it resets, shown beside the
  meter rather than behind a hover — hover does not exist at the widths where
  these get a row of their own. *`test/ui/UsageChips.test.tsx`.*
- **FR-QUOTA-2** — The numbers MUST come from Claude Code's own `statusLine`
  extension point, written to a file this server watches. Nothing in `~/.claude`
  records quota, and the app MUST NOT hold an OAuth credential to get richer data
  — that is a far larger security surface than an app that refuses to bind a
  non-loopback address without a token has anywhere else.
- **FR-QUOTA-3** — The reading MUST age visibly. Meters only refresh while a
  Claude Code session is rendering, so past ~20 minutes they MUST dim and say
  when the number was last true rather than implying it is current. **(INV-11)**
- **FR-QUOTA-4** — With no reading at all — no subscription plan, or the bridge
  not installed — the meters MUST be hidden entirely rather than shown empty.
- **NFR-QUOTA-5** — The bridge MUST never throw, never exit non-zero and never
  write a diagnostic. It runs inside another program's render loop on every
  footer render of every live session; a bug in it must be invisible rather than
  disruptive. **(INV-10)**
- **FR-QUOTA-6** — Installing the bridge MUST back up the existing settings file
  and MUST refuse rather than overwrite a `statusLine` that is already there.

---

## 9. Attention

- **FR-NOTIFY-1** — The browser tab title MUST carry a count while any agent is
  waiting. Standing state may be described for as long as it stays true.
  **(INV-14)**
- **FR-NOTIFY-2** — An OS notification MUST fire only for an agent this page has
  **watched become** waiting. The first fleet frame is backlog, not news: an
  agent blocked for three days notifies nobody on page load. **(INV-14)**
- **FR-NOTIFY-3** — A standing block MUST NOT re-fire; an agent that unblocks and
  blocks again is news again. A flapping agent MUST replace its own notification
  rather than stack copies. **(INV-14)**
- **FR-NOTIFY-4** — A visible tab MUST NOT notify: the waiting group at the top
  of the screen is already the notification. **(INV-14)**
- **FR-NOTIFY-5** — Notifications MUST be off by default, and enabling them MUST
  be the gesture that carries the browser's own permission prompt. Turning the
  preference on MUST start from "now" rather than replaying everything already
  blocked. The switch MUST be its own control in the header — a bell whose
  shape carries its state — not a row inside the appearance menu, and Help
  MUST say it exists. The app MAY make exactly one unsolicited suggestion to
  turn it on: after this page watched an agent become blocked while the
  preference was off, once per browser, never on load or for the backlog, and
  never where the browser could not say yes. **(INV-14)**
  *`test/ui/notify-button.test.tsx`, `test/ui/notify.test.tsx`.*
- **FR-NOTIFY-6** — Permission MUST be re-read at fire time so revoking it in the
  browser wins immediately over anything stored, and a browser with no
  Notification API MUST get a disabled toggle that says so rather than one that
  silently does nothing. **(INV-11, INV-14)** *`test/ui/notify.test.tsx`.*
- **FR-NOTIFY-7** — Clicking a notification MUST open that agent.

---

## 10. Presentation

### 10.1 Layout

- **FR-UI-1** — The app MUST have three layouts — two-column desktop, tablet
  (which crosses the breakpoint by being turned over), and a single-column phone
  sheet — and MUST survive a rotation mid-conversation without losing which agent
  is open, which tab it is on, what is half-typed, or the terminal's column count.
  The stylesheets MUST cut at exactly two widths, 900px and 560px, and the root
  element carries `data-layout` naming which of the three is on. Eleven
  breakpoints, each measured and each right, were more than a reader could
  hold. *`e2e/tablet.spec.ts`, `test/responsive.test.ts`.*
- **FR-UI-17** — A container that scrolls MUST say so at the edge it scrolls
  past. Overlay scrollbars and phones hide the bar at rest, so the detail pane
  on a landscape phone showed one answer option and no sign of the second. The
  fade is measured, so it lifts when the end is in view.
  *`test/ui/overflow-edge.test.ts`, `e2e/fades.spec.ts`.*
- **FR-UI-20** — The agent view MUST carry a status line under its tabs with
  the session's permission mode, its model, and its delegate claims — the same
  facts the fleet card makes, on the screen where the work is read. The mode
  is what the session last recorded or "not reported yet", never a guess
  **(INV-11)**; the delegates are the sidecars' claims **(INV-13)**; a quiet
  family is asked about **(INV-15)**. The mode button in the composer strip
  MUST read "Mode · <mode>", not the name of its chord. The graph comes from
  the store, filled by one holder at a time: the fleet list, or a stand-in
  while a phone's sheet has the list unmounted **(INV-4)**.
  *`test/ui/AgentDetail.test.tsx`, `test/ui/ChatControls.test.tsx`.*
- **FR-UI-19** — An on-screen keyboard MUST NOT cover the composer, the answer
  card, or the terminal's key bar, on iOS Safari or Android Chrome. Android
  honours `interactive-widget=resizes-content` and shrinks the layout viewport;
  Safari ignores it and shrinks only the visual viewport, so the sheet and the
  full-screen overlay are sized from `window.visualViewport` (`--vvh`), and
  the conversation stays pinned to its last message as its box shrinks. Text a
  phone keyboard delivers without a keystroke — Android's input events, a
  Chinese or Japanese composition, a paste — MUST reach the pane through
  xterm's data stream, and a key the handler already took MUST NOT arrive
  twice. The pane's textarea MUST refuse autocorrect, autocapitalisation and
  completion, because each is a phone rewriting what reaches a live agent.
  *`test/viewport.test.ts`, `test/ui/visual-viewport.test.tsx`,
  `test/ui/term-ime.test.tsx`. Not provable in CI: no test runner drives a
  real software keyboard, so a physical iPhone and Android phone are the last
  gate.*
- **FR-UI-18** — The confirmed-empty fleet MUST show both ways in — the command
  that starts an agent, as copyable text, and the New agent button as a real
  control — and point at the phone setup in Help. On a first run the New agent
  dialog MUST open on the folder browser at home rather than a bare path field.
  *`test/ui/FleetList.test.tsx`, `test/ui/NewAgentDialog.test.tsx`,
  `e2e/empty.spec.ts`.*
- **FR-UI-2** — Text inputs MUST be at least 16px so iOS does not zoom the page,
  tap targets MUST be at least 44px, and safe-area insets MUST keep content clear
  of a notch in both orientations. *`scripts/audit-mobile.mjs`.*
- **FR-UI-3** — The conversation MUST fill a phone screen with the message box
  pinned above the home indicator.
- **FR-UI-4** — The app MUST ship a web manifest so a phone can install it to the
  Home Screen and open it full-screen.
- **FR-UI-5** — Wide content MUST scroll inside its own container. The document
  body MUST NEVER scroll horizontally, at any viewport, for any input.
  *`e2e/responsive.spec.ts`.* **(INV-17)**
- **FR-UI-6** — Every action MUST be available in all three layouts. A layout
  with less room MAY fold one behind a disclosure, which MUST itself be on
  screen and named; it MUST NOT drop one. What a smaller screen gives up is
  labelling, hints and decoration.
  *`test/responsive.test.ts`, `test/ui/inv17-parity.test.tsx`,
  `e2e/responsive.spec.ts`.* **(INV-17)**
- **FR-UI-7** — Every control on screen MUST be hittable and named in every
  layout, not only in the widest: 24x24 at WCAG 2.2 AA, 44x44 where the pointer
  is coarse. *`e2e/responsive.spec.ts`, `scripts/audit-a11y.mjs`.* **(INV-17)**

### 10.2 Theme and colour

- **FR-UI-6** — Theme (System / Light / Dark) and colour scheme (eight palettes)
  MUST be separate axes, giving sixteen palettes: *Nordic, following the system* is a
  thing a user can ask for.
- **FR-UI-7** — "System" MUST write no theme attribute at all, so
  `prefers-color-scheme` keeps deciding while the app is open; an explicit choice
  overrides it. *`e2e/theme.spec.ts`.*
- **FR-UI-8** — Every palette MUST clear WCAG 1.4.3 / 1.4.11 for every pair the
  interface uses; status colours MUST be distinguishable **from each other**, not
  only from the surface behind them; and schemes MUST be distinguishable from
  each other. *`scripts/audit-contrast.py`, `test/scheme.test.ts`.*
- **FR-UI-9** — Palettes MUST be generated, never hand-edited, and the generator's
  output MUST be checked byte-for-byte so a hand edit fails the suite rather than
  surviving until the next regeneration. *`test/scheme.test.ts`.*
- **FR-UI-10** — The scheme menu MUST stay open while a palette is picked, unlike
  the theme and language rows: choosing a palette means trying two or three.
  It MUST still close like every other layer: on Escape, handing focus back to
  the gear, and when focus leaves it, since a menu left open over the page
  while focus sits on a control underneath hides that control from the person
  using it. It closed on a mouse alone for its first five releases.
  *`test/ui/SettingsMenu.test.tsx`.*

### 10.3 Language

- **FR-UI-11** — The interface MUST be available in English and 简体中文, and the
  choice MUST persist in this browser only. *`test/ui/SettingsMenu.test.tsx`.*
- **FR-UI-12** — Preferences MUST NEVER reach the server and MUST NEVER be able
  to reach an agent.

### 10.4 Keyboard

- **FR-UI-13** — The following MUST work:

| Key | Does |
|---|---|
| `/` | focus the filter box |
| `↑` `↓`, `k` `j` | move through the agent list |
| `Enter` | open the focused agent |
| `Esc` | close the agent, or clear the filter box |
| `Enter` / `Shift+Enter` | in the message box: send / newline |
| `Shift+Tab` | in the message box: cycle the agent's permission mode |
| `Shift+Esc` | leave the terminal, where plain `Esc` belongs to the agent |

- **FR-UI-14** — `Esc` MUST discard exactly one level of nesting per press.
  *`test/ui/escape-levels.test.tsx`.*
- **FR-UI-15** — Every modal surface MUST trap focus, restore it on close, and be
  operable by keyboard alone. *`test/ui/modal-a11y.test.tsx`.*
- **FR-UI-16** — The app MUST pass WCAG 2.2 AA on desktop and phone, in both
  themes. *`scripts/audit-a11y.mjs`.*

---

## 11. Honesty and degradation

The rules that outrank convenience everywhere above. They are why several
requirements in this document look like refusals to be helpful.

- **FR-HON-1** — Every figure on screen MUST be either something the app
  currently knows or marked as something it used to know. Nothing may be
  presented as a reading when it is a memory, as a total when it is a sample, or
  as reported when it was inferred. **(INV-11)** *`test/invariants.test.ts`,
  `test/ui/stale-fleet.test.tsx`.*
- **FR-HON-2** — Where evidence is absent, the app MUST say it cannot tell.
  "Cannot tell" and "nothing there" are different claims and MUST NOT be
  collapsed — a zero where a measurement failed is a confident lie.
- **FR-HON-3** — A missing or malformed session file, an absent tmux field, a
  dead pane or an unreadable transcript MUST downgrade *one* agent's capabilities
  and render a reason. It MUST NEVER remove other agents or take down the fleet
  view. **(INV-5)** *`test/invariants.test.ts`.*
- **FR-HON-4** — If the session file's format changes, agents MUST still list
  from the CLI's own authoritative listing — they simply lose the Attach tab.
  **(INV-5)**
- **FR-HON-5** — A capability the app lacks MUST be hidden with a reason, not
  disabled without one, and MUST NOT be offered as an action that cannot happen.
- **FR-HON-6** — A control MUST NOT report failure for something it cannot
  observe. Where the CLI writes nothing down when the thing happens, the control
  MUST say what it *sent*. **(INV-11)**

---

## 12. Operational envelope

### 12.1 Ports

| Port | What runs there |
|---|---|
| 4317 | Production. Real agents. |
| 4400 | Development, and what the audits target. |
| 4500 | The QA sweep. |
| 4599 | The end-to-end suite's own mock server. |

- **NFR-OPS-1** — Fixture mode MUST be refused on the production port. A fixture
  fleet at the address the real one lives at is indistinguishable from the real
  one having vanished, and the composer on that page types into nothing.
- **NFR-OPS-2** — Nothing that types — a fuzzer, an audit, a review agent — may
  be pointed at the production port, and the sweep script MUST refuse it outright.

### 12.2 Sources and cadence

| Source | Used for |
|---|---|
| `~/.claude/sessions/<pid>.json` | session list, status, cwd, pane id |
| the CLI's own `--json` listing | authoritative presence, reconciled periodically |
| `~/.claude/projects/*/<sessionId>.jsonl` | the timeline, tailed by byte offset |
| `…/<sessionId>/subagents/agent-*.meta.json` | the delegation tree |
| `tmux capture-pane` / `send-keys` | the Attach tab, and delivering input |
| `~/.claude/agent-commander/rate-limits.json` | the quota meters |

- **NFR-OPS-3** — Polling cost MUST be bounded by *properties*, not by a
  timetable: never open a tail that cannot resolve; never poll what nobody is
  watching; one poll per pane however many tabs watch it; re-arm after the work
  rather than on a wall clock, so a slow pass cannot pile up; and back off when
  nothing is changing, snapping back on any change. **(INV-4)**
- **NFR-OPS-4** — The only file this app writes under `~/.claude` MUST be its own
  rate-limit cache and token. It MUST NEVER write another program's records.
- **NFR-OPS-5** — Fixture mode MUST run the same server, routes and validation as
  the real one, so a failure seen there is the failure you would get for real.

### 12.3 Fixtures

- **NFR-OPS-6** — The fixture fleet MUST stay deliberately awkward: agents
  sharing a home directory with auto-generated names, a name too long for its
  card, sessions never prompted, a session of a kind with no transcript, every shape
  an agent blocks on (a question with options, a plan, a tool permission), a
  pane that has exited, and
  delegation trees covering a depth-3 chain, a stopped delegate, one node in each
  of the three delegate states, an orphan whose parent is missing, an agent that
  delegated nothing, and a CLI that cannot say either way.

---

## 13. Requirement → invariant map

Only the requirements that carry an invariant number are individually proved.
Everything else is checked by the surface tests cited inline, or is marked
unverified.

| Invariant | Requirements it governs |
|---|---|
| INV-1 — never disturb the real terminal | FR-ATT-1, FR-ATT-2, NFR-SEC-13 |
| INV-2 — no input without intent | FR-CHAT-3, FR-CHAT-5, FR-CHAT-10, FR-ANS-7, NFR-SEC-11 … 14 |
| INV-3 — loopback by default | NFR-SEC-1 … NFR-SEC-4 |
| INV-4 — bounded polling cost | FR-ATT-12, NFR-OPS-3 |
| INV-5 — degrade, don't error | FR-HON-3, FR-HON-4 |
| INV-6 — guard destructive keys | FR-ATT-9, FR-SEND-4 |
| INV-7 — one command shape | FR-KIND-1, FR-CTL-9, FR-SPAWN-3 |
| INV-8 — control actions guarded and verified | FR-CTL-1, FR-CTL-6, FR-CTL-7, FR-CTL-10 |
| INV-9 — the browser cannot leave its root | FR-BROWSE-1, FR-BROWSE-2 |
| INV-10 — the bridge cannot break a session | NFR-QUOTA-5 |
| INV-11 — never assert more than you know | FR-STATUS-3, FR-CARD-3, FR-CARD-5, FR-FLEET-5, FR-PRUNE-2, FR-PRUNE-4, FR-PRUNE-5, FR-QUOTA-3, FR-CTL-3, FR-CTL-10, FR-NOTIFY-6, FR-HON-1, FR-HON-6 |
| INV-12 — input is bounded | NFR-SEC-15 |
| INV-13 — a tree claims only what the sidecars say | FR-DEL-1, FR-DEL-3 |
| INV-14 — a notification is a transition | FR-NOTIFY-1 … FR-NOTIFY-6 |
| INV-15 — a silent family is a question | FR-STATUS-4, FR-DEL-7 |
| INV-16 — an answer names only what the transcript named | FR-ANS-1 … FR-ANS-7 |
| INV-17 — every shape is the whole app | FR-UI-1, FR-UI-2, FR-UI-5, FR-UI-6, FR-UI-7 |

---

## 14. Open questions

Written down rather than resolved, because guessing would put a claim in this
file that nothing checks.

1. **No requirement covers what happens when two browser tabs drive the same
   agent at once.** The duplicate-suppression requirements (FR-CHAT-5,
   FR-ANS-7) are stated per tab. FR-ANS-6's prompt-id binding is the only
   cross-tab guard, and it covers answers alone.
2. **`unknown` is doing two jobs** — "the field was missing" and "the value was
   not recognised". FR-STATUS-1 treats them alike; whether a user should be able
   to tell them apart is unsettled.
3. **Nothing specifies the behaviour of a session whose kind changes** — a pane
   whose foreground process is replaced while the app is watching it.
