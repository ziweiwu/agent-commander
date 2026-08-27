# Invariants

Properties that must hold for agent-commander to be safe to leave running.
Each is greppable from a test name: `npm test -- -t INV-3`.

## INV-1 — Never disturb the real terminal

No tmux client this app creates may affect the size of a pane. It reads with
`capture-pane` and `display-message`, writes with `send-keys` and
`paste-buffer`, and never runs `new-session`.

**Why this matters here:** this machine runs tmux with `window-size latest` and
`aggressive-resize on`. A browser client attaching at a different size would
resize the user's live panes mid-work — reflowing a TUI that a working agent is
drawing into. That is why the Attach view is built on frame capture rather than
a pty.

**Amended:** this invariant used to say "must never create a tmux client",
which was a proxy for the property above rather than the property itself. The
proxy had a real cost. Every `tmux <command>` starts a fresh client process,
and reaching tmux is almost the entire cost of a tmux command — measured
against a server running 109 panes, `display-message -p ok` took p50 72.8ms
where a bare `fork`+`exec` took 3.0ms. The Attach view spent p50 141ms on the
two round trips a frame needed, against a 140ms frame budget, so it could never
keep its own schedule; and on a machine at its process cap (2840 processes
against a `kern.maxprocperuid` of 2666, which 109 panes and 33 Claude sessions
will reach) `spawn tmux` returns EAGAIN outright.

So one long-lived client is now attached, in `src/server/tmux-client.ts`. It is
a **control-mode** client, and that — not any flag — is what makes it safe.

**The `ignore-size` flag is not the guarantee, and claiming it was is an error
this file previously contained.** Measured on a fresh server with
`window-size latest`, a regular client attaching at 80x24 to a 200x50 window
shrinks it to 80x21 with `-f ignore-size`, with `-r`, with
`-f read-only,ignore-size`, and with no flags at all — all four identically.
The flag describes how a client affects the size of *other clients*; it does
not stop the window following the client that is attached.

What actually holds is narrower and much stronger. A control-mode client has no
size to impose: tmux reports its `client_height` as empty, and it only acquires
one by asking, with `refresh-client -C`. This app never sends that. So its
client cannot participate in window sizing at all — **by construction, not by
configuration.** `ignore-size` is kept as defence in depth and is no longer
load-bearing.

The practical consequence is worth stating, because it closes a door: this is
*not* a licence to attach a normal client "carefully". `tmux attach -r`,
despite being documented as an alias for `-f read-only,ignore-size`, resizes
the pane. Anything that gives a browser a real pty onto an existing pane —
ttyd, gotty, wetty, `attach -r` behind any wrapper — will reflow a working
agent's window. That is why the Attach view is a capture and not a terminal.

Everything else about the design is unchanged. The client asks questions and
sends keys; it never becomes the terminal. Text a user typed never reaches
tmux's argument lexer — a paste is staged through a 0600 file so there is no
quoting rule to get wrong. And nothing depends on the client existing: every
call falls back to spawning a one-shot tmux when it is not up, which is what
runs for the first second of every session.

The Attach view is sized *from* the pane's reported geometry. Browser resizes
change a CSS transform only; cols and rows never travel back to tmux. That holds
on a phone too: rather than reflowing the agent's pane to a narrow screen, the
view keeps the captured geometry, refuses to scale text below ~9.5px, and pans.
`computeScale` never returns a scale above 1 — the pane is a faithful capture,
not a canvas to stretch.

- `test/safety.test.ts` — asserts `pane.ts` contains no attach/new-session
  call, that every attach in `tmux-client.ts` is `-C` (control mode), and that
  neither it nor `pane.ts` ever sends `refresh-client -C`, which is the only
  way a control client could acquire a size
- `npm run verify:inv1` — snapshots every tmux client and pane size, runs a
  real attach session with the control client live, asserts the snapshot is
  byte-identical afterwards, and refuses any client of ours that is not
  control-mode or has acquired a height — checked against tmux's own report,
  not against our source

## INV-2 — No input without intent

Nothing reaches a live agent except from an explicit user action in the UI. No
retries, no auto-send, no replay of buffered input on reconnect.

Pane ids are validated against `/^%\d+$/` before they reach argv, and control
keys are checked against `ALLOWED_KEYS` server-side — the client's allowlist is
a convenience, not the boundary.

The chat's optimistic echo is display-only. A pending message is drawn
immediately so sending feels instant, but it is sent exactly once; `reconcile()`
only ever *removes* the local copy once the transcript confirms it, and never
re-submits. A message that is never confirmed is marked *not delivered* rather
than being retried into a live agent — marking is the only response, because
re-sending is the user's decision, not the app's.

Exactly once is not enough on its own: it also has to be *that* text, to *that*
agent, in the order it was typed. `paste` is two tmux calls with an await
between them — load a buffer, then paste that buffer into a pane — and nothing
serialises the socket messages driving them. One shared buffer name meant two
overlapping pastes interleaved as load(A) → load(B) → paste(into A), and A's
agent received B's text. Two tabs on two agents is the ordinary way to use
this, and the Attach view sends one paste per keystroke, so the overlap was the
common case. Every paste now loads a buffer of its own, and writes to one pane
are queued behind each other so an Enter cannot overtake the text it submits.

Reaching tmux two different ways must not mean delivering twice. Commands go
through a long-lived control client when one is up and through a freshly
spawned tmux when it is not, and a write that fails *after* it reached tmux has
an unknown outcome — a `load-buffer ; paste-buffer ; send-keys` sequence that
errors at the last step has already put the text in the pane. Quietly trying
the other path would type the user's instruction into a live agent a second
time. So a write picks its path before a single byte is sent and never changes
its mind; a failure after that is reported. Reads change nothing and are free
to retry. The one exception is `EAGAIN`, which is safe to retry for the same
reason it has to be: the process never started, so nothing was written.

The text itself never reaches tmux's argument lexer. A paste is staged in a
0600 file and tmux is told to read that, so there is no quoting rule to get
wrong — no stray quote can end an argument early and turn the rest of someone's
prompt into tmux commands.

Sending less often is not sending less. The Attach view coalesces keystrokes:
exactly one paste is allowed in flight, and characters typed while it is
outstanding accumulate into the next one, so a burst of typing arrives as
however many writes tmux can actually absorb. That is flow control, not
batching on a timer — the chunk size is set by how fast tmux is draining, which
is the only thing that knows. It sends nothing that was not typed, sends
nothing twice, and reorders nothing: a key or a submitted message flushes the
buffer ahead of itself, so an Enter can never overtake the line it submits. The
acknowledgement that gates it means "the write is over", not "the write
worked" — a failed paste that never acked would wedge typing for good — and a
dropped socket discards the buffer rather than replaying it, because replaying
input into a live agent is this invariant's one prohibition.

A local echo is matched to its confirmation by *count*, not by text alone. The
quick prompts are "Continue" and "Go ahead", so matching on text reconciled the
second one against the first an hour earlier: the echo vanished the moment it
was drawn and took its delivery timer with it, which meant a message that never
arrived was never marked undelivered either. Marking is the only honest
response to a message that may not have landed, and it only works if the app
can tell this copy from the last one.

"Exactly once" cannot rest on React state. `draft` is read from a closure and
`setDraft('')` does not land until React flushes, so three Enter keydowns
delivered in one batch — key repeat, a double click on Send, input queued behind
a busy main thread — each read the same uncleared draft and each sent it. The
authority is a ref, cleared synchronously, so the second call in the batch finds
it empty. Quick-prompt chips have no draft to clear and a double tap is two
separate tasks, so an identical chip within a second is treated as a mis-tap.

- `test/ui/burst-send.test.tsx` — asserts one send from a burst of three, for
  Enter, for the Send button, and for a double-tapped chip
- `test/pane-writes.test.ts` — two overlapping pastes never swap payloads,
  writes to one pane keep their order, a load and its paste travel as one tmux
  invocation, and a spawn refused for want of a process slot is retried rather
  than dropping the character it carried
- `test/ui/attach-typing.test.tsx` — one write in flight, a burst coalesced
  without loss or reordering, Enter flushed behind its text, and a dropped
  socket that discards rather than replays
- `test/pane-control-path.test.ts` — a write that fails after reaching tmux is
  never retried down the other path, a read that fails is, and the user's text
  never appears on a tmux command line
- `test/chat.test.ts` — a repeated message stays visible until the transcript
  records *another* copy of it

## INV-3 — Localhost by default, and localhost is not the whole story

Binds `127.0.0.1`. `--host` is accepted for Tailscale use but is refused without
`--token`, because this app can type into live agents and answer their
permission prompts. `--token auto` generates one.

Binding loopback keeps the network out. It does nothing about the one program
guaranteed to be running on this machine: the browser. WebSockets are exempt
from CORS entirely, and a `POST` with a `text/plain` body is a CORS "simple
request" that is sent with no preflight — so any page on any origin could open
`ws://127.0.0.1:4317/ws`, read every agent's directory and prompts, and paste a
command plus Enter into a live session. That is arbitrary code execution by way
of a visited web page, and "we only bind loopback" is no defence against it.

So a tokenless server answers only same-origin requests addressed to *this
machine*. Two headers, because they answer different questions:

- `Origin` names the page. Browsers always send it on a WebSocket handshake and
  on any cross-origin request, and never let a page forge it. Absent means a
  non-browser client, which is not what this guards.
- `Host` names what was asked for. Checking it too is what stops DNS rebinding,
  where `evil.example` is re-pointed at 127.0.0.1 and the origin then matches
  the host perfectly — both say `evil.example`, and only the fact that neither
  is a loopback name gives it away.

"This machine" is two names, not one. Loopback is the obvious one. The other
is this host's own Tailscale `DNSName`, when Tailscale is up: `tailscale serve`
terminates TLS and proxies to the loopback port, forwarding the name the caller
asked for, so a request that never left the tailnet arrives wearing a name that
is not loopback. Refusing it made a tokenless server unreachable from the phone
— the flow this project exists to serve — and `--token` was the only way back
in.

Trusting it is narrower than the tailnet: it is one exact name, read from the
Tailscale CLI at startup rather than from anything a caller sends, so a request
matches only by being addressed to *this* host on a network the user
administers. Another machine on the same tailnet does not match. Nothing the
gate was written to stop gets through it either — a visited page carries its
own `Origin`, which is neither loopback nor this name, and a rebound host is
refused for exactly that reason.

A configured token replaces that gate rather than adding to it: a token is
proof of intent that neither a cross-origin page nor a rebound name can
produce, since it lives in the URL of the real origin. It is what `--host`
requires, where the app is bound to a network address directly rather than
reached as itself through a proxy.

**What the gate protects is larger than it looks.** The socket carries every
agent's conversation verbatim — prompts, tool calls, file paths, whatever was
pasted into a session — and accepts input to any of them. A token is therefore
not "access to a dashboard": it is read of everything every agent on this
machine has said, plus the ability to type into them. It arrives in a URL, so
it lands in browser history, screenshots and anything that logs a link. That is
why it lives in `sessionStorage` rather than `localStorage`, why it is scoped to
the tab that was handed it, and why rotating it is just opening a new link.

**Two things carry the token that are easy to miss, and both were once wrong.**

A token arrives on one URL: the one the user opened. Anything the browser then
fetches on its own has to be accounted for, or the gate refuses the app rather
than an attacker.

- *The bundle.* `index.html`'s `<script>` and `<link>` are ordinary subresource
  requests with no token and no `Authorization` header. Gating them 401s the
  app's own JavaScript and the page hangs on its loading shell, so `GET` and
  `HEAD` under `/assets/` are exempt from the token — and from nothing else. It
  costs the gate nothing: those files are the compiled front end, published
  verbatim on npm, and no agent's directory, prompts or output passes through
  them. A tokenless server has no token gate to bypass, so its same-origin
  check still applies to them in full.
- *The address bar.* The router replaces the whole location, query string
  included, so `navigate('/agent/x')` drops the token from the URL. Nothing the
  page remembers can repair that: the *document* request for `/agent/x` is
  refused before a line of JavaScript runs, so the reload, the bookmark and the
  link sent to a phone all dead-end. Every in-app navigation re-attaches it.

- `test/origin.test.ts` — a cross-origin WebSocket and a cross-origin form POST
  are refused, a rebound `Host` is refused down a raw socket, every honest
  spelling of loopback still serves, this host's own tailnet name serves while
  another machine's does not, and the bundle is exempt from the token while the
  document, the fleet and the socket are not
- `test/ui/token.test.tsx` — the token survives into the requests the page makes
  and into the URL the router leaves in the address bar

## INV-4 — Bounded polling cost

Properties, not a timetable. The specific intervals live in `ARCHITECTURE.md`,
where they can drift without making this file wrong.

- **Never open a tail that cannot resolve.** `findTranscript` stats every
  directory under `~/.claude/projects` looking for a file an agent whose CLI
  keeps no transcript will never have. It misses, caches nothing, and left
  unguarded would do it again for every such agent every five seconds forever —
  the most expensive loop in the app, spent on a certainty.
- **Fleet status is one tmux query for the whole machine**, never one per agent,
  and never from pane content. `window_activity` is a clock tmux already keeps,
  so busy-versus-idle costs nothing and needs no sampling: the verdict is a
  function of one timestamp, and a missed tick changes latency, not fidelity.
  (`session_activity` looks like the same thing and is not — client events such
  as attaching bump it, so it reports output that never happened.)
- **Nothing polls what nobody is watching.** A pane is read only while some tab
  has it focused *and* attached, and the fleet-wide transcript enrichment — one
  tail per agent, the most expensive loop here — runs only while at least one
  tab is connected at all.

  Which means the server has to know when a tab has gone, and a tab that has
  gone does not always say so. A closed one sends a close frame; a phone asleep
  on the far side of Tailscale, which is the flow INV-3 exists to permit, sends
  nothing, and its half-open connection can outlive the browser by hours. So
  every socket is pinged, and one that has missed two rounds is dropped —
  otherwise this rule holds only for the failures that announce themselves.
- **One read per pane, not one per tab.** Two tabs on the same agent cost what
  one costs. `PaneHub` shares the read; each viewer still computes its own
  delta, because two tabs that attached at different moments have drawn
  different things.
- **A poll cannot overlap itself or outrun its own cost.** Every loop re-arms
  after the work completes rather than on a fixed interval, and never schedules
  the next read sooner than the last one took.
- **A pane that is not changing is polled less.** Anything this app writes to a
  pane returns it to full speed at once, so the backoff never sits between a
  keystroke and its echo.
- **Frames that changed no row and moved no cursor are not sent.**
- **Transcript reads are incremental by byte offset; the file is never
  re-read.** A day-old transcript is already several MB. The offset is a byte
  count, so a read can stop mid-character — the tailer holds those bytes back
  through a `StringDecoder` rather than decoding each chunk alone, which turned
  any non-ASCII conversation into U+FFFD.
- **The expensive authority is not on the fast path.** `claude agents --json`
  costs ~680ms, so it reconciles on a slow tick while the session list refreshes
  from local file reads.
- **The quota cache is `stat`-ed before it is read**, and `fs.watch` sits on top
  as a low-latency path rather than as the guarantee: on macOS it silently drops
  writes landing within a few ms of the watch being registered, which is
  precisely the "server starts, live session writes" case.

This invariant used to enumerate intervals, and they went stale: it was written
when a frame cost two tmux round trips at p50 141ms, against a 140ms budget it
could not meet. Through the control client a read is roughly 20ms. The numbers
were the reason for the rules, not the rules.

- `test/pane-hub.test.ts` — one poll shared between tabs, measured as a
  comparison rather than asserted; a loop that cannot overlap itself; the idle
  backoff and the wake that cancels it
- `test/poll.test.ts` — INV-4's cadence rule itself: no overlap, never sooner
  than the last pass took, survives a throwing pass, and cannot be started twice
  into two chains
- `test/heartbeat.test.ts` — a socket that answers is kept, one that has gone
  silent is dropped within two rounds, and the drop stops that viewer's
  transcript tail rather than merely closing the socket
- `test/enrich.test.ts` — the enricher idles while no browser is connected, runs
  a pass the moment one arrives, and paces itself by the work rather than by a
  wall clock
- `test/registry-presence.test.ts` — an unconfirmed session is asked about at
  once rather than at the next 30s reconcile, and a ghost is asked about once
  rather than once per scan

## INV-5 — Degrade, don't error

A missing or malformed `~/.claude/sessions/<pid>.json`, an absent `tmux` field, a
dead pane, or an unreadable transcript downgrades one agent's capabilities and
renders a reason. It never removes other agents or takes down the fleet view.

The session file is an internal Claude Code format. If it changes shape, agents
must still list from `claude agents --json` — they simply lose the Attach tab.

The same applies to the quota cache: missing, half-written or malformed, it
hides two meters and touches nothing else. A failed read leaves the last good
reading in place rather than blanking, because the bridge's rename means a
transient ENOENT is normal and flickering meters would be the only visible
result of handling it "correctly". "No reading" and "a stale reading" stay
distinct all the way to the UI — hiding a non-subscriber's meter and hiding a
meter nobody has refreshed in an hour are different claims.

A transcript that moves is found again. The path is resolved once and cached,
and holding on to a stale one meant every later read failed the same way and
that agent's timeline was dead for the life of the process. A read that cannot
stat its file drops the path so the next one looks again — and does not claim
to be a fresh backfill while doing so, because `first` tells the browser to
replace the conversation it is showing.

A failure to read a pane and a pane that has ended are not the same thing. One
failed read used to stop the terminal outright, which meant a transient `spawn
tmux EAGAIN` — ordinary on a machine at its process cap — looked exactly like
an agent that had exited, and the only way back was to close the terminal and
re-open it. Reads now have to fail five times in a row before the view gives
up. A pane that is genuinely gone is still reported immediately, because that
is answered from the pane's own `dead` flag rather than inferred from failure.

The terminal and the conversation degrade separately. They read different
things — one polls tmux, the other tails a file — but both timers used to hang
off one call, so a pane that exited froze the chat for that tab as well.

- `test/limits.test.ts` — truncated and junk documents parse to `null`; a
  deleted file keeps the last good value
- `test/transcript-tail.test.ts` — a character split across two reads, a line
  split across two reads, a transcript that moves, and one that is replaced
- `test/frame-errors.test.ts` — a dead pane ends the frames and not the
  conversation, and a run of failed reads is tolerated before either stops
- `test/pending.test.ts` — a tmux that could not be reached keeps a just-started
  agent visible, where only a positive "no such session" removes it: the same
  distinction as above, at the one moment an agent most needs to be reachable
- `test/pane-hub.test.ts` — one poll shared between tabs, a loop that cannot
  overlap itself, the idle backoff and the wake that cancels it, and a failed
  read that does not end the loop
- `test/tmux-control.test.ts` — the control-mode framing, including captured
  pane content that looks like a protocol terminator

## INV-6 — Guard destructive keys

`Ctrl-C`, `Ctrl-D`, and `Escape` (interrupt) require a confirmation step before
being sent. Sending them to a busy agent discards in-flight work.

They are on `ALLOWED_KEYS` deliberately: interrupting a stuck agent is half the
point of the Attach view. What separates them is that the client must say the
user was asked, and the server refuses them otherwise.

**This used to be a browser-only obligation, which made it the one claim in this
file that was not true.** `DESTRUCTIVE_KEYS` was read in `Terminal.tsx` and
nowhere else; the server checked `ALLOWED_KEYS`, which *contains* all three, and
forwarded them to a live agent for anything that could open a WebSocket. INV-2
says in as many words that the client's allowlist is a convenience and not the
boundary, and this was the place that contradicted it. An invariant that is
enforced only by the code most easily replaced is worse than no invariant: it is
relied on while not being true.

The `confirmed` flag on the `key` message is not proof that a human answered —
nothing on this wire can be, and a caller that sets it is making the same claim
the UI does. What it buys is that sending one is deliberate rather than
incidental, and that the rule lives where every other rule about reaching a live
agent lives.

- `test/destructive-keys.test.ts` — each destructive key is refused and not
  forwarded without confirmation, is forwarded with it, and every other allowed
  key still needs none; a client that omits the flag, sends `false`, or sends a
  truthy non-`true` value gets the same refusal

## INV-7 — One command shape

**Claude Code's slash commands are only ever typed at Claude Code.** `/model`,
`/goal`, `/exit` and the Shift+Tab mode cycle are how every control action
works, and against another agent CLI they do not degrade — they type a sentence
of this app's own devising into somebody's live prompt. `assertSlashCommandable`
refuses them server-side for any kind whose spec says `slashCommands: false`,
and the browser hides the controls; the server is the boundary, because a UI is
not one (INV-6). Closing is the exception, and only because tmux can do it
without the agent's cooperation: those sessions are closed by killing the tmux
session rather than by asking.

Starting an agent is the only place this app creates a process. It runs exactly
one command:

```
tmux new-session -d -s <generated> -c <validated dir> claude [-n <name>] \
  [--model <alias>] [--permission-mode <mode>]
```

Every value is a separate argv entry — never a shell string — and the session
name is generated from a timestamp, so nothing user-supplied reaches tmux's
argument parser, where a `:` or `.` would be read as target syntax. The
directory is resolved and confirmed to exist and to be a directory before
anything is spawned; a missing path is refused with an error rather than
guessed at. Model and permission mode are checked against the fixed allow-lists
in `src/server/options.ts`, so an unrecognised value is refused rather than
becoming a flag.

Mock mode runs the same validation and then does not spawn, so the failure a
user sees in `--mock` is the failure they would get for real.

The model and the mode are part of the request, not decoration on it: the
dialog offered both and the route forwarded neither, so choosing "plan" and
"opus" produced a default agent and nothing to say so. Both are now checked by
`checkSpawnRequest`, which is the same function mock mode runs — that is what
makes "the failure you see in `--mock` is the failure you would get for real"
true rather than aspirational.

- `test/spawn.test.ts` — path expansion, absolute-path requirement, refusal of
  files and missing directories, session-name sanitising, and the model and
  mode allow-lists
- `test/new-agent.test.ts` — what the dialog chose is what reaches the spawn,
  and an unrecognised alias is a 400 rather than a 500
- `test/ui/NewAgentDialog.test.tsx` — a rejected directory surfaces the server's
  reason and leaves the dialog open

## INV-8 — Control actions are guarded and verified

Closing an agent, changing its model, and setting or clearing its goal all work
by typing into that agent's own prompt. Text landing mid-tool-call interleaves
with work in flight — it arrives in whatever the agent is drawing and submits
something nobody wrote — so every action that *types* refuses an agent whose
status is `busy`. Idle and waiting are allowed: a waiting agent is precisely
the one you may want to redirect.

**Two exceptions, for different reasons.**

*Model* is permitted at any point because refusing it was inconsistent with the
app's own composer. `setModel` pastes `/model <alias>` through the very same
primitive the message box uses, and the paste path has never had a busy guard —
sending "use opus instead" as a chat message to a working agent is a designed
feature, and is exactly what the composer's Queue mode is. Forbidding the
select while permitting the message was one door open and one shut onto the
same prompt. What it costs is immediacy: the CLI reads input that arrives
mid-turn when the turn ends, so the caller is told the change was `queued` and
the interface says so rather than implying it has landed.

**Mode is the other exception, because it does not type.** It is switched by sending
`BTab`, a control key Claude Code handles as a toggle wherever it is, exactly
as it would from the keyboard of the terminal this app stands in for. Refusing
it while busy made this app stricter than the thing it mirrors, and stricter in
the one case that matters: deciding "this next step should run in plan mode"
happens *while* the agent is running. So mode changes are permitted at any
point in the flow, from the detail panel, from the chat strip, and from
Shift+Tab in the composer — the same chord the CLI itself uses.

What keeps that safe is the verification in `setMode`: it re-reads the mode the
session reports rather than assuming a press landed.

**That verification must stop when it stops seeing.** If the reading does not
change after a press, this loop is blind, and a blind loop here is not a failed
switch — it is five more Shift+Tabs into a live session, leaving it in a mode
nobody asked for and reporting an error for it. Two real causes and neither is
helped by pressing again: a session that reports no permission mode at all
(they exist), and a busy agent that has not yet written the record where this
app can read it. So it presses once more and stops, and reports the outcome as
*unknown* rather than as failed — the switch may well have landed somewhere
unobservable, and saying it failed asserts something nobody checked (INV-11).

**Neither switch is observable when it is made.** Both are read back out of the
transcript, which a busy session writes at the end of its turn, so a control
bound to the reported value repaints the old one on the next fleet broadcast and
reads as a click that did nothing. The interface holds what the user chose until
the agent reports it back. `assertAttachable` is the guard it uses — agent exists,
pane reachable — and `assertControllable` remains the guard for everything
that types.

- **Close** asks first, in the UI, naming the agent. It sends `/exit`, which is
  Claude Code's own shutdown path, and only kills the tmux session if the pane
  is still alive after a grace period.
- **Model** is set with the CLI's `/model <alias>`, the alias checked against the
  allow-list before anything is typed.
- **Mode** is switched by sending `BTab` and re-reading the mode the session
  reports, repeating until it matches. It is verified rather than counted,
  because the Shift+Tab cycle omits `bypassPermissions` and `auto` when they are
  unavailable — a fixed number of presses would land somewhere else. It gives up
  after a bounded number of steps and reports where it actually ended up.

- **Goal** sends `/goal <condition>`, and `/goal clear` to end one. Setting a
  goal writes a `goal_status` record into the transcript immediately, so the
  set is verified by reading that record back — by *newness*, not by matching
  the text, since Claude Code canonicalises the condition it stores. A goal
  that never appears there is reported as not set rather than assumed.

  The condition is checked before it is typed: one line, no control
  characters, no leading `/`. The newline is the one that matters — this text
  is pasted into a prompt and submitted, so an embedded newline would submit
  early and send the remainder as a second, unreviewed instruction. A leading
  `/` would run some other slash command instead of setting a goal.

  Clearing is the one action here that cannot be verified: Claude Code writes
  nothing when a goal is cleared. The server drops its own copy instead, and if
  the clear never landed the next evaluation writes a fresh record and the goal
  reappears — which is the right way round for a claim this app cannot check.

Setting a goal is also subject to INV-2's "exactly once": it is an instruction
to a live session, and `pending` is React state that does not land until React
flushes, so the composer's goal field guards the send with a ref the same way
the message box does.

`test/control.test.ts` covers each guard, the allow-lists, a shortened cycle,
the give-up path, and the goal's validation and verification.
`test/ui/ChatControls.test.tsx` covers the composer's switches, including the
burst case.

## INV-9 — The folder browser cannot leave its root

Every browsed path is resolved with `realpath` *before* it is checked, then
confirmed to sit inside the root (the home directory by default, or
`--browse-root`). Resolution comes first so a symlink is judged by where it
points, not by what it is called. Containment uses a path-segment check, not a
string prefix, so `/abc` is not treated as inside `/a`.

Listing is metadata only — names and directory-ness. It never reads a file.

`test/browse.test.ts` covers traversal, an escaping symlink, and the
prefix-collision case.

## INV-10 — The statusline bridge cannot break a Claude Code session

With the quota feature this app stops being a pure observer and starts running
code inside another program's render loop: `scripts/statusline-bridge.mjs` is
executed by Claude Code on every footer render of every live session. That is
the same category of risk INV-1 exists for, and gets the same treatment.

It never throws, never exits non-zero, and never writes a diagnostic — a bug in
it must be invisible rather than disruptive, because the alternative is a stack
trace in the footer of the user's working session.

It writes only when `rate_limits` is present. A session that has not yet made an
API call, and any non-subscriber, therefore cannot clobber a good reading with
an empty one. It writes via `rename(2)`, so a reader can never see a partial
document however many sessions write at once.

Nothing it does reaches an agent. It has no way to send input, which is why it
is outside INV-2 rather than an exception to it.

It also has to actually run. Deciding "was I invoked directly?" by comparing
`import.meta.url` against `file://${process.argv[1]}` is the same mistake that
shipped a do-nothing binary in 0.1.0 through 0.1.3: a file URL is
percent-encoded, so a checkout under `~/My Projects` never matches its own
argv, `main` never runs, and the meters simply never appear. The comparison is
made on resolved paths, and even asking the question is wrapped in a catch.

- `test/limits.test.ts` — asserts the entrypoint is wrapped in a catch, that an
  absent `rate_limits` leaves an existing cache intact, that the bridge and
  `src/server/limits.ts` name the same file, and that a copy of the bridge run
  from a path containing a space still writes the cache

## INV-11 — The dashboard never asserts more than it knows

Every figure on screen is either something the app currently knows, or is
marked as something it used to know. Nothing is presented as a reading when it
is a memory, and nothing is labelled as a total when it is a sample.

**And nothing is presented as reported when it was inferred.** Claude Code
writes its own status down — `waiting`, and why. An agent found through tmux
reports nothing, so its status is worked out here from whether its pane has
produced output lately. That is a far weaker claim wearing the same word, so it
is marked `statusInferred` on the wire and reads `idle · quiet` on the card,
never a bare `idle` beside a Claude one.

**An inferred status may never be `waiting`.** An agent blocked on a permission
prompt and an agent that has finished both sit there emitting nothing; no
timestamp separates them. Guessing would put a fabricated "needs you" next to
the real ones, and the whole product rests on that alert being worth walking
across the room for. `tmux-agents.ts` can return `busy`, `idle` or `unknown`
and has no branch that returns `waiting`; `test/tmux-agents.test.ts` pins it
across every age of pane from one second to a day.

The same reasoning removes a feature rather than adding one: the Prune button
reads "no activity, no tokens, no title" as a session opened and forgotten, but
every one of those comes from a transcript, so for an agent whose CLI keeps none
they are absent by construction. That is absence of evidence, and `isUnused`
refuses it for the same reason it already refuses `unknown`.

**Why this is its own rule:** the principle already existed here, applied to
exactly one thing. INV-5 says of the quota meters that *"'no reading' and 'a
stale reading' stay distinct all the way to the UI — hiding a non-subscriber's
meter and hiding a meter nobody has refreshed in an hour are different
claims."* That is right, and it was true of the meters and of nothing else.

With the socket down, every fleet card went on saying `busy`, `waiting · dialog
open`, an activity line and a ticking relative timestamp — each a claim about
*now* — while the only thing that changed was a chip in the header. This app
exists to answer "which agent needs me", so the cost of that is not cosmetic: it
is walking over to unblock an agent that finished twenty minutes ago, or not
walking over because a card that stopped updating says `busy`.

The last known state is still the most useful thing on the screen, so it is
muted and captioned rather than hidden — a disconnected dashboard is precisely
when someone squints at the last thing it knew.

The same rule caught a second claim. `tokens` counts `output_tokens` only
(`transcript.ts:244`), accumulated from a transcript tail capped at 256 KB
(`transcript.ts:17`) — and it was displayed as spend and sorted as "most/least
spent". For a long-running session that is not the agent's cost, and it is the
number you would sort by to find what is burning quota. It is now labelled as
what it is.

- `test/ui/stale-fleet.test.tsx` — nothing is said while the socket is open; a
  caption naming how long ago the state arrived once it is not; the cards are
  marked without being hidden; the caption is announced rather than only drawn;
  and an empty fleet, which asserts nothing, gets no caveat

## INV-12 — Input to a live agent is bounded

No client can queue unbounded work into a running agent. Writes are charged
against a per-connection budget, and a WebSocket frame that could not be a
legitimate message is refused before it is parsed.

**Why this is not covered by INV-2:** that invariant governs whether input is
*intentional* — nothing reaches an agent except from a user action, exactly
once, in order. It says nothing about *volume*. Measured before this existed:
5,000 `key` messages sent down one socket in 1.5 seconds were every one
accepted, with no error and no backpressure, and against a real fleet each is a
`send-keys` queued behind the last on that pane's write queue. A held-down arrow
key, a loop in a client, or anything that got past INV-3's gate could bury a
working agent in keystrokes — and INV-2 would have been satisfied throughout,
because every one of those keystrokes was "intentional".

The budget is sized for a person and not for a program: sustained 30/s is far
above human typing, and a burst of 120 absorbs key-repeat without complaint. A
refusal is reported once per burst rather than per message, because answering a
flood with a flood is not an improvement. The bucket refills, so a user who let
go of the key can type again immediately.

`maxPayload` is set on the WebSocket server for the same reason at a different
layer: `MAX_PASTE` already refuses oversized text, but only after `ws` had
buffered the frame and `JSON.parse` had built the whole string — and `ws` allows
100 MB by default. The two limits are deliberately far apart so they cannot
disagree about the same paste: one is about memory, the other about intent.

`focus` and `attach` are not charged. They cost this server work but never reach
an agent, and a tab switching views quickly is not what this guards.

- `test/input-budget.test.ts` — a 5,000-message flood no longer arrives in full
  and is reported once rather than 5,000 times; a briskly typed sentence is
  never refused; the budget refills after a burst; and an oversized frame is
  refused before it is parsed
