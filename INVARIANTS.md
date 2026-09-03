# Invariants

Properties that must hold for agent-commander to be safe to leave running.

Each is greppable from a test name, on both sides of the wire:

```sh
cargo test --manifest-path rust/Cargo.toml inv3   # the server (Rust)
npm run test:web -- -t INV-3                      # the browser app (vitest)
```

Rust test names spell the number in lower case and without the hyphen
(`inv3_refuses_a_non_loopback_bind_without_a_token`), because that is what an
identifier can hold; the browser's keep the `INV-3` spelling in the test string.
Both are searched by the same digits.

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

So one long-lived client is now attached, in `rust/src/tmux_client.rs`. It is
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
Enlarging — up to 26px text in the panel and 32px full screen — re-renders
xterm at a bigger font, and shrinking is a transform; neither sends a size to
tmux. The pane is a faithful capture at any size, never a reflowed one.

- `tmux_client::inv1_never_passes_a_size_to_tmux` — asserts the source contains no attach/new-session
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

**An answer is bound to the question it was given for.** Answering used to be a
`key` message carrying a bare digit, which means "whatever the pane is showing
when tmux receives it". `AnswerCard` guarded against a double press with a ref,
but that guard lived in one tab and was keyed on the prompt's *content*, so two
identical consecutive questions looked like one — and nothing at all stopped a
stale tab, a duplicated frame, or any other socket peer. `AskUserQuestion` asks
its questions one at a time, so the second digit answers a question the user has
not read.

So `PendingPrompt` now carries an `id`: `fingerprint`, a hash over the session
id and every field a reader reads before deciding — tool, question, detail,
option labels, and `more_questions`, which is what makes question two of a set
differ from question one. It is derived rather than issued, so it needs nothing
stored and survives the server restarting under a browser that stayed open. The
client echoes it on a new `answer` message with an option *index*; `on_answer`
opens a tail of its own, re-reads the transcript, and refuses if the id no
longer matches. The keystroke is composed on the server, so nothing the browser
sends becomes an argv entry.

Answering is also its own **grant** (`respond`), separable from `drive`. It is
the highest-privilege verb in the app — it releases a command the agent already
chose to run — and it is simultaneously the one thing you open this on a phone
to do, which is why it must be grantable without also granting arbitrary
keystrokes.

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
- `pane::tests` (the write-path group) — two overlapping pastes never swap payloads,
  writes to one pane keep their order, a load and its paste travel as one tmux
  invocation, and a spawn refused for want of a process slot is retried rather
  than dropping the character it carried
- `test/ui/attach-typing.test.tsx` — one write in flight, a burst coalesced
  without loss or reordering, Enter flushed behind its text, and a dropped
  socket that discards rather than replays
- `pane::tests` (the control-path group) — a write that fails after reaching tmux is
  never retried down the other path, a read that fails is, and the user's text
  never appears on a tmux command line. The path is a value as well as a rule:
  `pane::Prepared` carries the route chosen before a byte is sent and
  `Panes::send` consumes it, leaving a `pane::Failed` that can tidy up down
  the route it took and hand back the error, and cannot send. "Retry down the
  other path" is therefore not something the code after a failure can write
- `pane_props::inv2_every_interleaving_delivers_each_text_once_to_its_pane_in_order`
  — the same four clauses as a stateful property rather than a list of
  examples: generated sequences of pastes and keys, two at a time, down either
  path, with tmux refusing before a write or failing after one, against a
  reference model of what each pane should have received and a tmux in
  miniature whose one buffer table is reachable both ways. Reverting the
  per-paste buffer name makes it fail on exactly the historical shape — two
  overlapping pastes on two panes — shrunk to that in under a second. A
  failure is written to `rust/proptest-regressions/`, which is the regression
  test.
- `types::tests` (`inv2_a_prompt_id_changes_with_every_field_a_reader_reads`,
  `inv2_field_boundaries_cannot_be_shifted_to_forge_a_match`) — the id moves
  with the question, the agent, and the position in a multi-question set
- `routes::tests` (`inv2_an_answer_naming_the_current_prompt_reaches_the_agent`,
  `inv2_an_answer_to_a_question_that_has_moved_on_is_refused`,
  `inv2_an_option_the_transcript_never_named_is_refused`) — a correct id
  answers, a stale one is refused with nothing reaching the pane, and an index
  past what was offered is not a keystroke to invent
- `test/ui/answer-card.test.tsx` — the card sends the option index and the
  prompt id, and never a raw key
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

A tokenless server answers to loopback and to nothing else. Names beyond it —
the address `--host` bound, and this host's own Tailscale `DNSName` — are
gathered by `origin_names` only when a token is configured, and the reason is
worth stating precisely, because it was got wrong once.

`tailscale serve` terminates TLS and proxies to the loopback port, forwarding
the name the caller *dialled*. That name is this host's. So a request from the
phone and a request from any other peer on the tailnet arrive identical: both
say `box.tail1234.ts.net`, and nothing in the gate looks at the peer address.
Accepting that name tokenless did not mean "this machine" — it meant the whole
tailnet, and it was published in this file as if it meant the former.

The unit test that appeared to prove otherwise asserted that *another machine's*
name is not a self-name. True, and irrelevant: a peer never announces its own
name in `Host`, only the one it asked for.

So the two gates ask two questions and neither substitutes for the other. The
name says the request reached the server it was addressed to; the **token** says
who sent it. `--host` already requires a token
(`refuse_an_open_bind_without_a_token`); `tailscale serve` needs no `--host` at
all, which is how the tokenless case arose, and is why the name is worthless
without one.

The origin gate is therefore never skipped, not even for a correct token. That
mattered less while the token lived in a URL an attacking page could not read.
It matters now: a credential the browser attaches by itself travels on a
cross-origin request and proves nothing about intent.

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
  them. The same-origin check applies to them in full either way, because it
  applies to everything.
- *The address bar, which the token no longer touches.* It arrives once, as
  `?token=…` on the URL the user opened; `cookie_exchange` trades it for an
  `HttpOnly; SameSite=Strict` cookie and redirects to the same path without it.
  The reload, the bookmark and the link sent to a phone are then served by the
  cookie, so the router dropping the query string on `navigate('/agent/x')` is
  correct rather than a bug to work around.

  This replaced a client that remembered the token in `sessionStorage` and
  re-attached it to every request and every navigation. That worked, and the
  cost was that the secret lived in the address bar permanently — and therefore
  in history, in `document.referrer`, and in the access log of whatever proxy
  was in front. The cookie also reaches the one place a header cannot: a
  `WebSocket` handshake carries no `Authorization`, which is why the query
  parameter existed at all.

  Only a browser navigation is exchanged (`Accept: text/html`), so `?token=` and
  `Authorization: Bearer` still work unchanged for curl and for tests.

- `routes::tests` (the origin group, incl. `inv3_a_rebound_host_is_refused_even_when_origin_matches_it`) — a cross-origin WebSocket and a cross-origin form POST
  are refused, a rebound `Host` is refused down a raw socket, every honest
  spelling of loopback still serves, a tokenless server answers to no name but
  loopback (`inv3_a_tokenless_server_answers_to_no_name_but_loopback`) while a
  token widens the set to the bound host and this host's own tailnet name
  without ever replacing the gate (`a_token_does_not_replace_the_origin_gate`),
  and the bundle is exempt from the token while the document, the fleet and the
  socket are not
- `test/ui/token.test.tsx` — the page puts no token on any request and none in
  the address bar, even when it was loaded from a URL carrying one

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

**Nothing polls what nobody is watching — and nothing re-sends what the watcher
already has.** The first half was always here; the second was the gap, and
`/api/tree` fell straight into it. The delegation graph is polled every three
seconds while the fleet list is mounted, and measured against 53 real sessions the
body is 54.6 KB that is *byte-identical* from one poll to the next — 0 of 55,916
bytes differing, 64 MB an hour re-sent to a phone over Tailscale, which is the
connection this app exists to be used from.

The pane path never had this problem because it was written against the same
rule stated in frame terms: `buildFrame` sends only the rows that changed and
`isNoop` drops a frame carrying no visual change at all. So the graph is
conditional. The server hashes the body it would send and answers a matching
`If-None-Match` with a bare 304; the browser sends the tag back and, on a 304,
**keeps its existing trees by identity**.

That last clause is load-bearing and is the half that was actually broken in the
browser. In the standalone tree view this app used to have, `setTrees(body.trees)`
handed every `tree` prop a new object identity every three seconds even when the
JSON was identical, so a `memo` could never hit and all 260 nodes re-rendered for
data nobody had changed. It matters more now than it did then: the graph feeds
every fleet card, and each card's `memo` is what keeps a broadcast from
re-rendering the whole list. `useFleetTrees` holds the tag in a ref and a 304 comes
back as `{ changed: false }`, which carries no trees for `setTrees` to be handed
— the churn is impossible by construction rather than merely fixed.

The read itself still happens on every poll — a `readdir` and a few cached
sidecars, ~3ms for the whole fleet. It is not worth caching state that Claude
Code owns and this app only observes; what is worth saving is the transfer and
the render behind it.

This invariant used to enumerate intervals, and they went stale: it was written
when a frame cost two tmux round trips at p50 141ms, against a 140ms budget it
could not meet. Through the control client a read is roughly 20ms. The numbers
were the reason for the rules, not the rules.

- `pane_hub::inv4_*` — one poll shared between tabs, measured as a
  comparison rather than asserted; a loop that cannot overlap itself; the idle
  backoff and the wake that cancels it
- `poll::inv4_*` — INV-4's cadence rule itself: no overlap, never sooner
  than the last pass took, survives a throwing pass, and cannot be started twice
  into two chains
- `routes::tests` (the heartbeat group) — a socket that answers is kept, one that has gone
  silent is dropped within two rounds, and the drop stops that viewer's
  transcript tail rather than merely closing the socket
- `enrich::inv4_stops_tailing_while_no_browser_is_connected` — the enricher idles while no browser is connected, runs
  a pass the moment one arrives, and paces itself by the work rather than by a
  wall clock
- `registry::inv4_asks_once_for_a_ghost_not_once_per_scan` — an unconfirmed session is asked about at
  once rather than at the next 30s reconcile, and a ghost is asked about once
  rather than once per scan
- `routes::the_tree_is_not_resent_when_it_has_not_changed` — the graph is served with an `ETag`, a matching
  `If-None-Match` gets a bare 304, a real change gets a new tag and a body, and
  a stale or unknown tag is answered in full rather than with a 304
- `test/ui/fleet-trees.test.tsx` — the first poll carries no tag and the next
  carries the one just served; an unchanged answer does not blank a card's
  delegates; a changed one advances the tag; and unmounting the list stops the
  poll

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

- `limits::tests` — truncated and junk documents parse to `None`; a
  deleted file keeps the last good value
- `transcript::tests` (the tail group) — a character split across two reads, a line
  split across two reads, a transcript that moves, and one that is replaced
- `routes::tests` (the frame-error group) — a dead pane ends the frames and not the
  conversation, and a run of failed reads is tolerated before either stops
- `pending::inv5_a_tmux_that_could_not_be_reached_keeps_the_entry` — a tmux that could not be reached keeps a just-started
  agent visible, where only a positive "no such session" removes it: the same
  distinction as above, at the one moment an agent most needs to be reachable
- `pane_hub::inv4_*` — one poll shared between tabs, a loop that cannot
  overlap itself, the idle backoff and the wake that cancels it, and a failed
  read that does not end the loop
- `tmux_client::tests` — the control-mode framing, including captured
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

**The rule is a type, not a check each caller remembers.** `PaneApi::key` takes
a `control::SendableKey`, and there are two ways to make one. `check_key` is
where a key the *client* named is held to the allow-list and to the
confirmation rule; it returns the type only when both pass. `server_composed`
is for a key the *server* decided to send — the mode chord, the digit that
answers a prompt — and takes a `&'static str`, which nothing that arrived on
the wire can be, so a client's key cannot be smuggled through it. Before this,
`on_key` checked and then passed a bare `&str` on, and a second caller that
forgot the check would have compiled.

- `control::inv6_every_destructive_key_needs_confirmation` — each destructive key is refused and not
  forwarded without confirmation, is forwarded with it, and every other allowed
  key still needs none; a client that omits the flag, sends `false`, or sends a
  truthy non-`true` value gets the same refusal
- `sources::PaneApi::key` — the signature is the rest of the proof: no
  implementation can be handed a key that did not come from `check_key` or
  from a literal in the server

## INV-7 — One command shape

**Claude Code's slash commands are only ever typed at Claude Code.** `/model`,
`/goal`, `/clear`, `/compact`, `/exit` and the Shift+Tab mode cycle are how
every control action works, and against another agent CLI they do not degrade —
they type a sentence of this app's own devising into somebody's live prompt. `assertSlashCommandable`
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
in `rust/src/types.rs` (and re-exported by `options.rs`), so an unrecognised value is refused rather than
becoming a flag.

Mock mode runs the same validation and then does not spawn, so the failure a
user sees in `--mock` is the failure they would get for real.

The model and the mode are part of the request, not decoration on it: the
dialog offered both and the route forwarded neither, so choosing "plan" and
"opus" produced a default agent and nothing to say so. Both are now checked by
`checkSpawnRequest`, which is the same function mock mode runs — that is what
makes "the failure you see in `--mock` is the failure you would get for real"
true rather than aspirational.

- `control::inv8_*` — every command, `/clear` and `/compact` included, is
  refused for a kind whose spec says `slashCommands: false`, and nothing is
  typed on the way to the refusal
- `spawn::inv7_*` — path expansion, absolute-path requirement, refusal of
  files and missing directories, session-name sanitising, and the model and
  mode allow-lists
- `routes::tests` (the new-agent group) — what the dialog chose is what reaches the spawn,
  and an unrecognised alias is a 400 rather than a 500
- `test/ui/NewAgentDialog.test.tsx` — a rejected directory surfaces the server's
  reason and leaves the dialog open

## INV-8 — Control actions are guarded and verified

Closing an agent, clearing or compacting its context, changing its model, and
setting or clearing its goal all work by typing into that agent's own prompt. Text landing mid-tool-call interleaves
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

**Shift+Tab is the other exception, because it does not type.** It sends
`BTab`, a control key Claude Code handles as a toggle wherever it is, exactly
as it would from the keyboard of the terminal this app stands in for. Refusing
it while busy made this app stricter than the thing it mirrors, and stricter in
the one case that matters: deciding "this next step should run in plan mode"
happens *while* the agent is running. So it is permitted at any point in the
flow, from the detail panel, from the chat strip, and from Shift+Tab in the
composer — the same chord the CLI itself uses.

**One press, and nothing claimed about where it lands. Every previous shape of
this control claimed one, and every one of them was reported as broken.** It
was first a `<select>`: the user named a mode, and the server pressed `BTab`
and re-read up to six times until the session reported it. It then became a
cycle button that pressed exactly once and waited to be told which mode it had
reached — narrower, and still wrong in the same place.

The second version was not wrong about the key. Measured against a live
session, three `BTab` presses walk it `auto` → `plan` exactly as the keyboard
would, and `tmux send-keys BTab` emits `\033[Z`, which is precisely what a
terminal sends for Shift+Tab. **What no version could do is observe it.** Claude
Code writes its `permission-mode` record at the *end of a turn*, so a session
sitting at its prompt — the one usually being switched — writes nothing in
response to the press, and a session that has not yet taken a turn has no
transcript file to write it to.

So each press bought a 2.5-second settle window with the control disabled, then
reported `unverified`, then left the old mode's name on the button. Three
signals that nothing had happened, about something that had. A control that
works but reports that it did not is indistinguishable from a broken one.

**Sending the key is now the whole action.** `sendShiftTab` presses `BTab` and
reports that it was sent. There is no target to miss, no window to wait out,
and no mode named anywhere in the interface — the agent's own terminal shows
the mode immediately, which is where a user reads it in any case. This is INV-11
applied to the one control that never had a way to check itself: the key either
reached the pane or the call failed loudly at tmux, and there is no third
outcome for an observation to discover.

**Two of these controls are on screen at once** — the composer strip and the
detail panel's control row — which is why the button is one shared component
rather than two. When it still displayed a mode, that display had to be held in
the store: pressing one left the other reading the old mode two inches away
until the enricher caught up, and an app that contradicts itself within one
glance is worse than one that is briefly behind. Binding to nothing removed
that whole class of problem along with the hold.

**Four controls now sit in both places, and what is shared differs by control.**
Mode, Goal, Clear and Compact all appear in the composer strip as well as in the
detail panel's row, because that row is above the tabs, collapses behind `⋯`
below 900px, and does not exist at all in full screen — the surface where a
conversation gets long enough to want clearing. Shift+Tab is one shared
*component*; Clear and Compact are one shared *hook*
(`web/hooks/useContextActions.ts`), because their reasoning is a sequence rather
than a widget: a `sendingRef` so a double click cannot discard the session the
first click just created, a refusal to navigate on an `unverified` result, and
`setExpectSession` **before** `navigate` so the route's "the agent ended while it
was open" rule does not fire on an id the registry has not scanned yet. Two
copies of that sequence would be two chances to get the order wrong, and only
one of them would be under test.

One gap is accepted rather than fixed: under `@media (max-height: 420px)` the
whole strip is hidden, so a landscape phone in full screen still cannot reach
them. Exempting them costs ~44px of the 66px left for the conversation, which
`Chat.module.css` records as measured and rejected.

**Model, which does still report, remains observable only late.** It is read
back out of the transcript, which a busy session writes at the end of its turn,
so a control bound to the reported value repaints the old one on the next fleet
broadcast and reads as a click that did nothing. The interface holds what the
user chose until the agent reports it back. `assertAttachable` is the guard
Shift+Tab uses — agent exists, pane reachable — and `assertControllable`
remains the guard for everything that types.

- **Close** asks first, in the UI, naming the agent. It sends `/exit`, which is
  Claude Code's own shutdown path, and only kills the tmux session if the pane
  is still alive after a grace period.
- **Model** is set with the CLI's `/model <alias>`, the alias checked against the
  allow-list before anything is typed.
- **Shift+Tab** sends one `BTab` and reports that it was sent. It never presses
  twice, never aims at a named mode, and never claims one; see above for why
  each of those was the same bug wearing a different shape.

- **Clear** asks first, in the UI, naming the agent, because there is no undo.
  It sends `/clear`, and it is **verified by watching the session id turn over**
  rather than by reading the transcript. `/clear` does not edit a conversation,
  it replaces one: Claude Code opens a fresh transcript under a new session id
  and rewrites `~/.claude/sessions/<pid>.json` to point at it. The old file
  simply stops growing, which is also exactly what a `/clear` that never
  arrived looks like — the id is the only thing that separates them, and Claude
  Code writes it rather than this app inferring it.

  The new id is the answer and not decoration on it. Every URL, socket focus and
  route naming the old one is dead the moment the clear lands, so the browser
  follows the agent to its new id; without that, `focusAgent` points at nothing,
  the route bails to the fleet, and the agent reappears further down the page as
  a stranger. From the user's side, the panel closed itself.

- **Compact** sends `/compact` and is deliberately **not verified**, because the
  number forbids it: a compaction writes a `compact_boundary` record when it
  finishes, and the one real sample reports `durationMs: 157676` — over two and
  a half minutes. Holding a request open for that is a hung button, not a
  verification strategy. So it returns as soon as the text is submitted, the
  interface says the compaction was *asked for* rather than that it happened
  (INV-11), and the result arrives on its own: the transcript tail turns the
  boundary record into a timeline event through the loop already reading that
  file, carrying `preTokens → postTokens` and whether the trigger was `manual`
  or `auto`.

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

`control::tests` covers each guard, the allow-lists, the single press and the
fact that it types nothing, the clear's rotation and its unobserved case, the
compaction that does not wait, and the goal's validation and verification.
`routes::inv8_mode_and_clear_and_compact_carry_no_body` covers the same actions over HTTP — mode, clear
and compact carry no body at all, and `JSON.parse('')` throws, which surfaced as
"that did not take effect" about a control the server had never called.
`test/ui/ChatControls.test.tsx` and `test/ui/AgentControls.test.tsx` cover the
browser's half: the burst case, the button naming no mode whatever the agent
last reported, the confirm before a clear, and following the session id
afterwards.

## INV-9 — The folder browser cannot leave its root

Every browsed path is resolved with `realpath` *before* it is checked, then
confirmed to sit inside the root (the home directory by default, or
`--browse-root`). Resolution comes first so a symlink is judged by where it
points, not by what it is called. Containment uses a path-segment check, not a
string prefix, so `/abc` is not treated as inside `/a`.

The check runs once. `browse::resolve_inside_root` is the only function that
can produce a `WithinRoot`, and everything downstream — the listing, the `..`
destination, the `~/…` label — takes a `WithinRoot` rather than a `Path`. So a
path that never went through the check is not a value those functions can be
handed: the compiler refuses it, not a test. Two runtime branches went with the
change. The parent of a contained path used to be checked for containment
again, and a label used to have a form for a path outside the root; neither
state can now be written down, so neither is asserted.

Listing is metadata only — names and directory-ness. It never reads a file.

`browse::inv9_*` covers traversal, an escaping symlink, and the
prefix-collision case at the constructor, and
`inv9_a_parent_is_within_the_same_root_or_absent` shows the one place the type
does the work: no containment check runs, because there is nothing left for it
to refuse.

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

- `limits::tests` — asserts the entrypoint is wrapped in a catch, that an
  absent `rate_limits` leaves an existing cache intact, that the bridge and
  `rust/src/limits.rs` name the same file, and that a copy of the bridge run
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
and has no branch that returns `waiting`; `tmux_agents::inv11_an_inferred_status_is_never_waiting` pins it
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

### Two more places the same rule bit

**A composer with the socket down used to accept the message.** `send()` returns
without doing anything when the socket is not open — correct, because queuing is
the one thing INV-2 forbids — but the composer cleared the box, marked the
message `sending…`, and twelve seconds later called it `not delivered`. The
fleet's two renderings both caption a disconnected view; this was the one
surface where a user *acts*, and it said nothing. It now refuses at the
composer, keeps every character of the draft, and says so in a live region
rather than only by greying a button.

- `test/ui/chat-offline.test.tsx` — the draft survives, nothing is sent, nothing
  is replayed on reconnect, and the explanation is reachable by keyboard

**A card's activity trail is measured or it is absent.** The two lengths a card
draws — writing, then silent — come from `startedAt` and `lastActivityAt`, and
the second field means two different things depending on where it came from: a
transcript write, or a pane that produced output. The trail draws the first as
"it was working until here", which is a claim the second cannot support, since a
pane goes quiet when a TUI stops repainting rather than only when the agent
stops. So an agent whose CLI writes no transcript gets no trail at all rather
than a weaker claim wearing the same shape — and neither does one with no last
write, where a full-width silence would assert that nothing has happened since
it started. A delegate cannot even be passed to it: `SubagentNode` carries no
start time, so the tree draws a mark with nothing leading up to it.

- `test/trail.test.ts` — the split; nothing drawn without a start or a last
  write; a write reported outside the session's life clamped rather than
  overflowing the row
- `test/ui/fleet-delegates.test.tsx` — no trail for an agent whose CLI writes no
  transcript, even when it reports a last activity

**A dead pane was a five-second toast.** With no pty to report an exit (INV-1),
the only signal was a notice that expired while the terminal went on showing its
last frame as though it were live. The exit is now carried on the wire as
`kind: 'pane-exited'` and recorded in the store, so the terminal reads a fact
rather than matching the server's English prose — a coupling that would have
broken silently the day anyone reworded the string, in an app that ships a
second language.

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

- `control::inv12_a_flood_does_not_all_reach_the_agent` — a 5,000-message flood no longer arrives in full
  and is reported once rather than 5,000 times; a briskly typed sentence is
  never refused; the budget refills after a burst; and an oversized frame is
  refused before it is parsed

## INV-13 — A delegation tree claims only what the sidecars say

The fleet card draws an agent's delegates, and everything under them. Their
structure is **read, not derived**: Claude Code writes one small sidecar beside
every subagent transcript.

```
~/.claude/projects/<slug>/<sessionId>/subagents/
  agent-<agentId>.jsonl        the delegate's own transcript
  agent-<agentId>.meta.json    {agentType, description, toolUseId,
                                parentAgentId, spawnDepth}
```

Measured against 350 of them on this machine: every transcript has a sidecar
and every sidecar a transcript, `spawnDepth: 1` never carries `parentAgentId`
and depth 2 and 3 always do. So a whole tree costs one `readdir` plus a few
hundred bytes each, with no transcript parsing at all — which is what makes it
cheap enough to poll under INV-4. Sidecars are cached by path for the life of
the process because they are written once and never touched again; only the
transcript is re-`stat`ed. The directory is flat, so a grandchild sits beside
its parent and the tree is rebuilt from `parentAgentId`, never from the path.

**An unresolvable parent is raised to the top, never dropped.** A sidecar that
is missing or half-written takes its entire subtree with it if children are only
ever attached to a parent that exists. Silently losing a branch of somebody's
work is a worse failure than showing it at the wrong depth (INV-5), so the node
is re-parented and marked, and the view says what happened rather than quietly
lying about the shape of the work.

**Three states, and the third is the point.** This is INV-11 applied to a
delegate rather than to an agent, and the ordering is evidence, then a marked
guess, then an admission:

- `done` is claimed **only on evidence**, and today there is exactly one piece
  of it: the sidecar says `stoppedByUser`. Something recorded the ending because
  a person caused it.

  **This is narrower than it sounds, and the word oversells it.** A delegate
  that finished its work normally is *not* `done` — it is `quiet`, forever,
  along with one that died. `done` in practice means "you stopped it". This
  file previously also claimed the state could be reached from a result for the
  delegate's `toolUseId` in the parent's transcript; that was never implemented
  — `toolUseId` is named in the sidecar but read nowhere in `src/` — and saying
  so was the same overclaiming this invariant exists to prevent, committed by
  the document rather than by the app.
- `active` is a guess: the transcript grew recently *and* the parent is busy. It
  is marked `stateInferred` and renders as `active · inferred` with a dashed
  edge — the same device a fleet card already uses for a status this app worked
  out rather than read. On its own a recent write says nothing, because a
  delegate that finished half a second ago also wrote half a second ago.
- `quiet` is everything else — which, per the above, is nearly everything. **A
  quiet node is never drawn as done.** An agent that finished and an agent that
  died both stop writing; no timestamp separates them.

  Because `quiet` carries so much, it must not be the only thing on the row.
  It answers "is it still going" and is silent about what happened, and a tree
  of seven delegates all reading `quiet` tells a reader nothing at all. So each
  node also carries **what it did**, as a measurement rather than a claim: the
  number of tool calls in its transcript and the span between its first and
  last record. That separates a delegate that worked for thirteen minutes
  before going quiet from one that died on its first call — a distinction
  `quiet` alone flattens, and the one a reader actually wants.

  It is deliberately not a summary. Three heuristics were tried against seven
  real delegates — the first line of the final message, the first substantive
  line, the last tool call — and each produced something useless on at least
  one of them ("Here is the mock.", a mangled fence, and "Bash" seven times
  over). The brief the parent gave is a better description of the work than
  anything recoverable from the transcript, and the tree already shows it. This is the same absence-of-evidence trap that removed the
  Prune button's reach in INV-11, and it is the failure this invariant exists to
  prevent: telling somebody their work completed when nothing checked.

**An agent with no delegates and an agent this app cannot ask are different
claims.** The sidecars are written by Claude Code, so for a CLI that keeps no
transcript there is nothing to read — and "has not delegated" would be a claim
nobody could make. That tree comes back `unknown` and the view says so.

**Transcript size is captioned as a size, never as a percentage.** There is no
total for it to be a fraction of. INV-11 caught exactly this once already, with
`tokens` displayed as spend and sorted as "most spent". No view draws a size at
all, so the rule is pinned at the server (`subagents::inv13_*` keeps `bytes` as
bytes) and at the tree (`test/ui/fleet-delegates.test.tsx` asserts nothing
size-shaped reaches the screen); any surface that ever draws it again inherits
the caption clause.

Colour is never the only signal: every state mark carries words in its
accessible name, which is what `audit:contrast` and the generated palettes both
assume.

- `subagents::inv13_*` — a three-deep tree assembled from `parentAgentId`;
  an orphan raised rather than dropped; one malformed sidecar costing only its
  own node; the `isFork` and `stoppedByUser` variants; a missing `subagents/`
  directory returning an empty tree rather than throwing; `unknown` rather than
  empty for a CLI with no transcript; and each of the three states, including a
  delegate that is not called active while its parent is idle
**The card that everybody reads is where this has to hold.** The tree used to
be drawn only in the forest, which was a place you had to go; it is now rolled
up onto the fleet card, and a rollup is where distinctions go to die. Four
claims share one line and all four are different sentences: `unread` — the
graph has not arrived, so the line is absent rather than briefly saying
"delegated nothing" on every card at load; `none`; `unknown`; and the counts.
A count of zero renders nothing, which is exactly why `none` and `unknown`
cannot be left to a count.

**`done` may never be reached from an inference, and that is a rule rather
than a description of the server.** `done` is the one state a reader acts on —
it is what makes them stop checking — so `isGuess` ignores `stateInferred` on
it entirely. `quiet` is not marked as a guess either: it is the honest answer,
and marking it would imply a better one exists.

- `subagents::inv13_counts_tool_calls_rather_than_turns` and the effort group
  beside it (`subagents::inv13_measures_the_span_between_first_and_last_record`)
  — tool calls counted rather than turns; the
  span read off the records and not off the file's mtime; nothing reported at
  all for a transcript that could not be parsed, distinct from a real zero; and
  a transcript that cannot have changed is not re-read
- `test/delegation-claim.test.ts` — the four claims; counts across every depth;
  a raised orphan counted rather than dropped; `done` refused as a guess even
  when the flag says otherwise
- `test/ui/fleet-delegates.test.tsx` — effort renders beside the state rather
  than instead of it, a span too short to name is dropped rather than shown as
  "0m", an unreadable transcript renders no numbers while a real zero still
  does; a quiet delegate is not rendered as done,
  an inferred `active` says so in words, a stopped delegate is named rather
  than called finished, a raised orphan says it was raised, a grandchild is
  drawn, no transcript size reaches the screen, and the disclosure is kept
  outside the card's own button
- `e2e/delegates.spec.ts` — the same clauses against the real server and mock
  sidecars, plus depth-3 nesting and no sideways scroll at any width

## INV-14 — A notification is a transition, not a state

The tab title and the aria-live region describe standing state and may say
"(2 blocked)" for as long as it stays true. An OS notification reaches out of
the tab, so it fires only for an agent this page has **watched become**
waiting:

- **The first fleet frame is backlog, not news.** An agent that has been
  waiting three days notifies nobody on page load — this page never saw it
  become blocked and cannot claim the event happened now. The same rule makes
  turning the preference on start from "now" rather than replaying everything
  already blocked, because the tracker runs on every frame whether or not the
  preference is on.
- **A standing block never re-fires.** An agent that unblocks and blocks again
  is news again; one that simply stays blocked is not. The notification `tag`
  carries the session id, so even a flapping agent replaces its own
  notification rather than stacking copies.
- **The stored preference is only half the gate.** `Notification.permission`
  is read again at fire time, so revoking it in the browser's site settings
  wins immediately over anything stored — and the API is feature-checked, so a
  browser without it (iOS Safari outside an installed web app) gets a disabled
  toggle that says so rather than one that silently does nothing (INV-11).
- **A visible tab never notifies.** The waiting group at the top of the screen
  is already the notification.

Off by default. Enabling it is a click in settings, which is also the moment
the browser's own permission prompt rides — the one gesture a browser accepts
as intent rather than ambience.

- `test/ui/notify.test.tsx` — the first frame is backlog; a watched transition
  notifies; a standing block does not repeat; unblocked-then-blocked is news
  again; tracking continues while disabled so enabling later dumps nothing; a
  visible tab stays silent; a revoked permission wins over the stored
  preference

## INV-15 — A silent family is a question, never a verdict

An agent that delegated stops writing. That is not a failure — it is the point,
and it is why `delegating` exists — but it means its own clock says nothing
about whether anything is happening. The delegates are the thing still moving.

So when a delegating agent is quiet **and every one of its delegates is quiet
too**, nothing in the family has moved and nobody has checked. That is the
shape a status board hides best: the card reads a confident `busy · delegated`
for as long as you leave it there, and every number on it agrees.

**It is surfaced, and it is surfaced as a question.** Every delegate in that
state is `quiet`, and quiet is precisely the state that does not separate
finished from dead (INV-13). The strongest true sentence is "nothing here has
moved for 9m — still working?", and the card says that rather than "stalled".
A verdict would be the INV-11 failure this whole file exists to prevent,
committed one level up: asserting about a family what could only be asserted
about a delegate.

**One delegate called active is enough to keep a family off the list, and the
card says so where the question would otherwise be** — `2 still moving, so this
is not a stall`. That claim is itself only a guess (INV-13 marks `active` as
inferred), and erring towards "still working" is the safe direction: the cost
is a question nobody was asked, where the other direction costs a stall nobody
noticed.

**The question needs a duration or it is not asked.** Without a number it is
an insinuation rather than a question, so an agent with no readable last write
gets nothing.

**Absence of a tree is not a silent tree.** `unread` and `unknown` never
qualify, for the same reason `none` does not: there is nothing to have gone
quiet.

- `test/delegation-claim.test.ts` — a quiet family asks; one inferred-active
  delegate silences it; an agent working itself never qualifies; neither does
  an unread, unknown or empty tree
- `test/ui/fleet-delegates.test.tsx` — the question renders as a question, the
  "not a stall" note takes the same slot when a delegate is moving, and the
  question is withheld when no duration can be named

## INV-16 — An answer names only what the transcript named

The Chat tab offers to answer a question the agent is blocked on. Every option
it labels is **read out of that agent's own transcript**, never inferred from
the screen, and where the transcript does not state the choices the interface
says so instead of composing a list.

**Why this can be read at all.** Claude Code flushes a `tool_use` record before
the dialog it raises is answered. Three independent proofs, all from real
transcripts on this machine: an `AskUserQuestion` whose `tool_result` never
arrives because the session was abandoned with the question on screen; a
`PreToolUse` hook record written *after* the call and before the tool ran; and a
call whose result landed 701 seconds later, which is a person reading. So an
unanswered `AskUserQuestion` is on disk in full — `questions[].options[].label`,
their descriptions, and `multiSelect`.

**Why the three blocked shapes are treated differently.** They are knowable to
different depths, and flattening that would mean inventing the difference:

- `AskUserQuestion` states the question and every option. Buttons are labelled.
- `ExitPlanMode` states the plan but not the three approval choices, which the
  CLI composes at the terminal. The plan is shown; no choice is named.
- A tool permission request states the tool and its input but never the numbered
  list. What it would do is shown; no choice is named.

`waitingFor` cannot stand in for any of this. It is a closed set — `dialog
open`, `permission prompt`, `input needed`, `sandbox request`, `goal proposal`,
`worker request` — and permission prompts, plan approvals and question pickers
all collapse into one of them. It says that a dialog is open, never which.

**A digit, because a digit is absolute.** An answer is delivered as the option's
own number, which selects it wherever the highlight happens to sit. Arrow keys
would have to assume the picker opens at the top, and being wrong about that
does not fail loudly — it answers a different question than the one the user
read. `1`–`9` are on `ALLOWED_KEYS` for this and nothing else; `0` names no
option and a two-digit string is not a key.

**Both halves must agree before anything is offered.** An open call means a tool
is unfinished, which during ordinary work is nearly always true — a tool that is
merely *running* looks exactly like one waiting to be allowed. The registry
knows the session is stopped but not what stopped it. So the card appears only
when the status is `waiting` **and** the transcript names an open call, and a
delegate's question is excluded outright: it is asked of the delegate, and
answering it into this agent's prompt would type into the wrong session.

**One press, and the card closes.** This is INV-2's "exactly once" with a
sharper edge than usual: a second digit is not a duplicate answer, because
`AskUserQuestion` asks its questions one at a time — it would answer the *next*
question, which the user has not read. The guard is a ref, cleared
synchronously, for the reason the composer's is.

- `transcript::prompt_tests` — the options an `AskUserQuestion` states are read
  back exactly; `ExitPlanMode` yields its plan and no choices; a permission
  request yields its subject and no choices; a malformed payload yields nothing
  rather than an empty question; a call is held open until its `tool_result`
  arrives; the newest open call wins; a sidechain's call is ignored
- `control::inv2_allows_single_digits_and_nothing_that_merely_looks_like_one` —
  `1`–`9` pass, `0`, `10`, `1 ` and `1;2` are refused
- `test/ui/answer-card.test.tsx` — a labelled button per stated option, the
  answer sent as its number, one answer from a double click, no invented labels
  for a plan or a permission request, keys instead of digits for a multi-select,
  and the card withheld unless status and transcript agree
- `e2e/control.spec.ts` — INV-16 end to end against the mock fleet's blocked
  fixture, which carries a real `AskUserQuestion` payload
- `mock::inv16_the_plan_and_permission_fixtures_name_no_option` and
  `e2e/blocked-shapes.spec.ts` — the two thinner shapes, a plan and a tool
  permission, show what was written and name no option; the same spec drives
  the fixture whose pane has exited onto the dead-pane notice
