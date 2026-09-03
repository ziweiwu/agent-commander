# Architecture

What the pieces are, which way data moves, and where the joins are weak.

`INVARIANTS.md` holds the properties that must not break and the tests that
prove them; `README.md` describes what the app does for the person using it.
This file is for the person changing it. Where an invariant explains a design,
this points at it rather than restating it.

## The two constraints everything else follows from

**INV-1: no tmux client this app creates may affect the size of a pane.** That
single rule is why the Attach view is a *capture* rather than a pty. A pty means
a client, a client has a size, and under `window-size latest` with
`aggressive-resize on` a browser-shaped client reflows the pane a working agent
is drawing into. So the terminal is polled with `capture-pane`, diffed, and
replayed into xterm.js, and the browser's own width only ever sets a CSS
transform. One long-lived control client now exists (`rust/src/tmux_client.rs`)
because reaching tmux costs more than anything tmux does — it carries
`ignore-size`, which is the whole of the amendment.

**INV-2: nothing reaches a live agent except from an explicit user action.** No
retries, no auto-send, no replay on reconnect. This is why the client has four
separate duplicate-suppression mechanisms rather than one, why a paste is staged
through a file instead of a command line, and why every control action is
*verified by reading the transcript back* rather than assumed to have worked.

Everything below is downstream of those two.

## The module graph

```
                    cli.ts  ← composition root; nothing imports it
                      │
   ┌──────────────────┼───────────────────────────────┐
   │                  │                               │
 registry.ts       routes.ts ────────────┐          limits.ts
   │ pending.ts      │ browse.ts         │            │
   │                 │ control.ts ──┐    │            │
 enrich.ts           │ spawn.ts ─┐  │  pane-hub.ts    │
   │                 │ frames.ts │  │    │            │
 transcript.ts       │ subagents.ts │  └── pane.ts ── tmux-client.ts
   │                 │        options.ts        │
   └─────────────────┴──────────── sources.ts ── shared/types.ts

        poll.ts ← registry.ts, enrich.ts, limits.ts, routes.ts
```

`rust/src/poll.rs` is the odd one out in that picture: a leaf with four
callers and no dependencies of its own. It holds INV-4's cadence rule — re-arm
after the work, never sooner than the last pass took — which was previously
written once properly and three times as `setInterval` plus a busy flag.

`rust/src/subagents.rs` is a leaf beside `transcript.rs` and reads a different
thing from the same directory: the sidecars Claude Code writes for every
delegate. It parses no transcripts at all (INV-13), which is what keeps
`/api/tree` cheap enough to poll.

`rust/src/main.rs` is the composition root: it parses argv, chooses real or
mock providers, and constructs everything. It imports fourteen modules and is
imported by none. `rust/src/routes.rs` is the second hub — the HTTP and
WebSocket surface. Everything else is a leaf. The graph is acyclic and shallow.

`rust/src/sources.rs` is the seam that makes that possible: four interfaces —
`AgentSource` (`:5`), `PaneApi` (`:16`), `TailApi` (`:32`), `LimitsApi` (`:37`) —
and nothing else. Real implementations are `Registry`, the `pane.rs` module
namespace, `TranscriptTail` and `RateLimitWatcher`; fakes are the four classes in
`mock.rs`. That seam is why `--mock` is a genuine review gate rather than a demo:
the mock fleet runs the same server, the same routes, and the same
`checkSpawnRequest` (`spawn.ts:73`) that the real one does, so a validation
failure seen in mock mode is the failure you would get for real.

`src/shared/types.ts` is the only module the browser imports for anything that
has to mean the same thing on both sides: the wire types, `ALLOWED_KEYS` and
`DESTRUCTIVE_KEYS`, and the option lists — `MODEL_ALIASES`, `MODE_CYCLE` and
`SPAWN_MODES`. It re-exports `src/shared/wire.ts`, which is generated from
`rust/src/types.rs` by `npm run gen:types`, so the server validates against the
same lists the browser offers by construction rather than by discipline — the
only arrangement in which a model cannot be offered-and-rejected or
accepted-and-invisible. A stale `wire.ts` fails
`types::tests::the_checked_in_wire_contract_is_current`.

## The five planes

The app looks like one dashboard but is five independent pipelines that happen to
render into the same object. They fail independently on purpose.

### Discovery — who exists

```
~/.claude/sessions/<pid>.json ──2s + fs.watch──► toAgent()      registry.ts:67
claude agents --json          ──30s────────────► presence filter
PendingStore (tmux list-panes)─────────────────► synthetic agents
                                                      ▼
                                         Registry.#agents ──┐
                                                            ├─► CompositeSource
tmux list-panes -a            ──3s────────────► TmuxProvider ┘   tmux-source.ts
```

Two providers behind one `AgentSource`. `Registry` finds Claude sessions from
the files Claude Code writes about itself; `TmuxProvider` finds every other CLI
by asking tmux what is running, because they write nothing this app can use —
Kiro's own `~/.kiro/sessions/cli/<uuid>.json` records neither the pane it runs
in nor whether it is blocked, so it can be neither attached to nor sorted from.
Claude is listed first and wins any clash over a tmux session, since what an
agent reports about itself always beats what this app can infer from a pane.

The tmux side is one `list-panes -a` for the whole machine — O(1) in agents, and
it reads no pane content. A row is an agent only if its command is not a shell:
tmux-resurrect restores sessions by name long after the process inside them
died, so a machine accumulates `gemini-<epoch>` sessions holding nothing but an
idle `zsh`, and listing those would be worse than listing nothing. Their status
is inferred from `window_activity` and marked as inferred all the way to the
pill (INV-11), and can never be `waiting`.

Two sources with different jobs. The session files are authoritative for
everything, including the tmux pane id the CLI does not expose, and are cheap
enough to re-read every `TICK_MS = 2_000` (`registry.ts:24`) with `fs.watch` on
top. `claude agents --json` costs ~680ms and is asked only every
`RECONCILE_MS = 30_000` (`registry.ts:23`), for one question: is this pid still
really a session? A pid can be reused; the CLI is the authority on what is live.

`PendingStore` covers a gap that has no other cover: a freshly spawned `claude`
writes no session file until it has started up, and in an unfamiliar directory it
stops on a workspace-trust prompt *first*. Without a synthetic entry the agent is
invisible in the fleet and the prompt blocking it can only be answered from the
terminal this app exists to avoid.

Status is not derived for a Claude agent. `toStatus` (`registry.ts:41`) is a
four-value whitelist over what Claude Code itself wrote — `busy`, `idle`, `waiting`,
otherwise `unknown`. See "Where it is fragile", item 14.

### Transcript — what they are doing

```
~/.claude/projects/**/<sid>.jsonl ──5s, one tail per agent──► 11 card fields
                                  ──1s, focused tab only────► TimelineEvent[]
<sid>/subagents/*.jsonl (mtime)  ─────────────────────────► delegating + clock
<sid>/subagents/*.meta.json      ──3s, forest view only───► AgentTree
```

`transcript.rs` turns JSONL into events plus a `Partial<Agent>` patch. Two
independent tails run over the same file: `FleetEnricher` every
`TICK_MS = 5000` (`enrich.ts:14`) so cards for agents you are *not* looking at
still move, and one per focused tab every `TIMELINE_MS = 1000` (`routes.ts:43`)
for the conversation. They hold separate byte offsets; this is deliberate, and
`mock.rs` documents the bug that appears when a single drain-on-read queue is
shared between them.

The most important derivation in the app is delegation (`transcript.ts:363`). An
agent that hands work to a subagent stops writing its own transcript at that
moment, so on the evidence a card otherwise has, a healthy delegated run and a
dead one are identical. The subagent's transcript mtime is the thing still
moving, so it overrides `lastActivityAt`. The directory is `stat`ed before it is
read, because most agents never delegate and the common case should cost one
syscall.

`subagents.rs` reads the *other* files in that directory, and they turn the same
count into a shape. Beside every `agent-<id>.jsonl` sits an `agent-<id>.meta.json`
naming the delegate's type, its brief and its parent — so the whole tree is read
rather than derived, with no transcript parsing at all (INV-13). Sidecars are
cached by path forever: they are written once when a delegate is spawned and
never touched again.

### Quota — whether anyone can keep working

```
Claude Code statusLine ──► statusline-bridge.mjs ──tmp + rename──►
   ~/.claude/agent-commander/rate-limits.json ──2s stat + fs.watch──► WS
```

The 5-hour and 7-day windows exist nowhere on disk. Transcripts carry per-request
token counts and no rate-limit data at all; Claude Code hands the numbers to its
`statusLine` command and nowhere else. `scripts/statusline-bridge.mjs` is a status
line whose real job is to write them down (INV-10).

`POLL_MS = 2000` (`limits.ts:37`) is the correctness guarantee and
`DEBOUNCE_MS = 200` (`limits.ts:21`) on `fs.watch` is only the latency path on
top: on macOS, `fs.watch` silently drops writes landing within a few ms of
registration — about one run in three, which is exactly the shape of "the server
starts and a live session writes immediately". The watch is on the *directory*,
because the bridge writes-then-renames and a file-bound watch goes deaf after the
first swap.

### Pane — the terminal

```
sample()  one tmux round trip: display-message ; capture-pane -e     pane.ts:299
   │
PaneHub   one loop per pane, shared by every tab; 25ms / 140ms / →1s
   │
buildFrame  per-viewer line diff → {lines} or {changed[]}            frames.ts:11
   │
PaneTerm.apply  ESC[row;1H ESC[0m ESC[2K <text> into xterm.js        term.ts
```

Polling is scoped by INV-4: a pane is read only while some tab has it focused
*and* attached, and it is read once no matter how many tabs are watching. The
loop re-arms after a read completes rather than on a fixed interval, and never
schedules the next read sooner than the last one took.

There are three cadences, not two, and the third is the one that makes typing
feel immediate. The steady 140ms is chosen for a pane redrawing on its own; a
pane that stops changing decays to 1s; and for up to a second after this app
writes to a pane, the loop runs at 25ms because it is waiting for a specific
character the user just typed. Without that third rate the write landed in ~4ms
and the frame carrying its echo arrived at ~146ms — the whole gap was one full
`BASE_MS` after a read that was a fraction too early to see the redraw. The
window is cleared the moment a change is seen, so it costs one burst, not a
faster steady state.

The diff is per-viewer even though the read is shared (`routes.ts:428`): two tabs
that attached at different moments have drawn different things, and a delta
against rows a tab never drew is a delta against nothing.

Geometry travels one way only. `computeScale` never returns more than 1 in the
panel, refuses to shrink text below ~9.5px, and pans instead — the browser's
width is a CSS transform and never a `resize`.

### Control — typing on the user's behalf

```
POST /api/agents/:id/{close,clear,compact,mode,model,goal}
   └─ assertControllable()   refuses busy, or no pane            control.ts:19
   └─ paste "/model opus" etc. into the agent's own prompt
   └─ re-read something the CLI wrote, until the change shows up
```

Three of those carry no request body at all — `mode`, `clear` and `compact` take
no value — which is why `readJson` reads an empty body as *no value* rather than
parsing it. It did not, and `JSON.parse('')` throws: pressing the mode button
reported "that did not take effect: Unexpected end of JSON input" about a
control the server had never called.

Every mutation works by typing into the prompt, which is why `busy` is refused: a
keystroke landing mid-tool-call interleaves with work in flight. Nothing free-text
ever reaches a live prompt — models are allow-listed (`options.ts:9`), modes are
allow-listed (`options.ts:17`), and a goal condition is rejected for control
characters, a newline, or a leading `/`.

Every action that *types* is verified against whatever the CLI actually writes
down — which is a different file for almost every one.

`sendShiftTab` is the one that verifies nothing, and that is the finding rather
than a gap. It presses `BTab` **once** and reports that it was sent. Two earlier
shapes chased a mode — one named it over up to six presses, one pressed once and
waited to be told where it landed — and both reported failure at a press that had
worked: Claude Code writes its `permission-mode` record at the end of a turn, so
a session at its prompt answers nothing and a session that has not taken a turn
has no transcript to answer from. The key itself is sound (`send-keys BTab`
emits `\033[Z`); only the observation was ever missing. See INV-8.

`setGoal` polls the transcript for a set-sentinel. `clearContext` watches
`~/.claude/sessions/<pid>.json` for the session id to **turn over**, because
`/clear` replaces the session rather than editing it — the old transcript just
stops growing, which is also what a clear that never arrived looks like.
`compactContext` verifies nothing on purpose: the one real sample took
`durationMs: 157676`, so it returns immediately and the `compact_boundary`
record is picked up later by the transcript tail that is already reading the
file. `clearGoal` (`control.rs`) is the one action that cannot be verified at
all — clearing writes nothing — so the server drops its own copy and lets the
next evaluation restore the goal if the clear never landed. That is the right
way round for a claim this app cannot check.

## What is pushed, what is polled

Pushed: two `fs.watch` registrations, `AgentSource.onChange` and
`LimitsApi.onChange` → WebSocket broadcasts, the four client messages, and
`hub.wake(paneId)` after every write.

| What | Interval | Constant |
|---|---|---|
| Session-file scan | 2s | `registry.ts:24` |
| `claude agents --json` reconcile | 30s | `registry.ts:23` |
| Fleet-wide transcript enrichment | 5s | `enrich.ts:14` |
| Focused-agent transcript tail | 1s | `routes.ts:43` |
| Quota file `stat` | 2s | `limits.ts:37` |
| Pane capture (focused + attached only) | 140ms → 1s | `pane-hub.ts:40`, `:42` |
| …while an echo is expected, after a write | 25ms for ≤1s | `pane-hub.ts:76`, `:58` |
| Mode-switch settling | 120ms for ≤2.5s | `control.ts:172`, `:173` |
| `/clear` session-id turnover | 250ms for ≤6s | `control.ts:255`, `:256` |
| `/exit` grace before kill | 500ms × 6s | `control.ts:230` |
| Pending-agent expiry | 5m | `pending.ts:16` |
| WebSocket heartbeat | 30s, drop after 2 missed | `routes.rs` |
| Environment probe | once at startup | `env.rs` |
| Delegation tree, while the forest view is open | 3s | `useFleetTrees.ts` |

Three of those are conditional rather than constant. The pane capture runs only
while some tab has that agent focused *and* attached; the delegation tree is
fetched only while the forest view is mounted, which is why it is plain HTTP
rather than a fifth socket message — an effect that stops on unmount satisfies
INV-4's first rule without a subscription lifecycle on the wire; and the
fleet-wide enrichment runs only while at least one tab is connected at all — `routes.rs` reports the
viewer count through `ServeOptions.onViewers` and `main.rs` idles
`FleetEnricher` on it. Both are INV-4's first rule, which is about who is
watching rather than how often.

The heartbeat is what makes "who is watching" answerable. A closed tab says so;
a phone that went to sleep on the far side of Tailscale says nothing at all, and
without a ping the server would go on polling for it until the OS noticed the
dead connection — which can be hours.

Every loop re-arms after its work rather than on a wall clock, through `Poller`
(`poll.rs`); `PaneLoop` has its own copy of the same rule with the extra cadences
the terminal needs. A re-entrancy guard on a `setInterval` is the shape this
replaced: it stops the overlap but turns an overrun into ticks dropped at a rate
nobody chose and nothing reports.

## The wire, and one tab's state machine

Deliberately small, and it has stayed that way: the delegation graph is the most
recent addition to the app and it is a `GET`, not a seventh server message. The
data is neither hot nor pushed, and only the forest wants it.

One WebSocket per browser tab. Four messages up — `focus`, `attach`, `paste`,
`key` (`types.ts:189`) — and six down — `fleet`, `limits`, `timeline`, `frame`,
`paste-ack`, `error` (`types.ts:203`). There is no schema validation beyond the
discriminated union and a `JSON.parse` in a try/catch; a malformed frame must not
kill the connection.

A tab's legal states are (focused, detached) and (focused, attached). `attach`
no-ops unless it names the currently focused session, so it can never outlive its
focus, and the frame callback re-checks both flags on every event because a shared
hub read can arrive after the tab moved on.

The degradation model is two methods on `Viewer`: `clearTimers()` stops
everything, `clearFrameTimer()` (`routes.ts:191`) stops the pane and only the
pane. The terminal reads tmux and the conversation reads a file on disk; a dead
pane used to take the transcript down with it, which left the chat frozen with
nothing saying why. A dead pane is reported immediately from tmux's own flag; a
*failed read* is tolerated up to `FRAME_FAIL_LIMIT = 5` (`routes.ts:57`),
because a transient `spawn tmux EAGAIN` is ordinary on a machine at its process
cap and used to end the terminal for good.

`paste-ack` is flow control and nothing else. It is sent in a `finally`, whether
the write succeeded or not: an unacknowledged failure would wedge typing forever,
and re-sending on failure is precisely what INV-2 forbids.

## The client

Zustand holds the state; `src/web/store/transport.ts` owns the socket and writes
into the store from outside React. That split exists because frames arrive about
seven times a second, and that cadence should not be expressed as a React effect.
The URL is the selection state — `/agent/:id` and `/agent/:id/term` — so the
phone's back gesture closes an agent instead of leaving the app.

The fleet has **two renderings and one route**. `FleetRoute` picks between
`ForestView` and `FleetList` on a stored preference (`prefs.ts`, `VIEWS`); the
view is deliberately *not* a URL — it is how you like to read, not what you are
looking at, and putting it in the address bar would mean a link sent to a phone
carried the sender's preference with it. `ForestRoute` polls
`/api/tree` on a mount-scoped loop (`useFleetTrees`), so the rendering owns no
endpoint, no wire message and no new polling rule (INV-4).
`src/web/lib/forest.ts` holds the layout as pure functions — the log axis, the
fold, and the accessible description that carries a mark's state and age,
because position is the one channel a screen reader cannot receive.

The client's real architecture is its duplicate suppression, all of it INV-2:

- `draftRef` in `Chat.tsx` — three Enter keydowns in one React batch each read the
  same uncleared `draft` and each sent it. Three identical messages went to a live
  agent.
- `sendingRef` in `ChatControls.tsx` — the same lesson applied to a control.
- a 1s guard on quick prompts — a double-tap is ~100ms apart, which no
  same-batch check catches.
- the pending-message timer — an unconfirmed message is marked *not delivered*
  after 12s rather than resent. The 12s is counted only across time the agent
  was **not** working: a message queued behind a live turn cannot be confirmed
  until that turn ends, so counting through one marked every correctly queued
  message as undelivered. It reads *queued* until the agent stops.
- `sendingRef` in `ShiftTabButton.tsx` and in `useContextActions.ts` — the same
  lesson again, and for clear it is the one with the highest stakes: a second
  press would discard the fresh session the first one had just created. The hook
  is shared by the detail panel and the composer strip, so that guard exists
  once rather than once per surface.
- `sendingRef` in `AnswerCard.tsx` — the sharpest case, because a second press
  is not a duplicate at all: `AskUserQuestion` asks its questions one at a time,
  so it would answer the *next* question rather than repeat this answer.
- paste-ack flow control (`transport.ts:90`) — exactly one paste in flight,
  everything typed meanwhile coalesced into the next. Not a debounce: a guessed
  window is wrong at both ends, whereas the ack makes the chunk size a function of
  how fast tmux is actually draining. `flushText()` (`transport.ts:121`) runs
  before every other write so an Enter cannot overtake the line it submits.

Two pieces of state in the store exist for the same underlying reason — the
browser knows something the fleet broadcast has not caught up with yet, and
binding straight to the broadcast makes a control look like it did nothing.
`heldMode` holds the permission mode a user just moved to; it lives in the store
rather than in the component because *two* mode buttons are on screen at once
and holding it locally left them disagreeing two inches apart. `expectSession`
holds a session id `/clear` has just created: the registry has not scanned for
it, and the route's "the agent ended while it was open" rule cannot otherwise
tell that apart from an agent that really has gone. Both expire — `expectSession`
on a timer, because an expectation this app cannot keep must not leave the panel
blank forever.

`reconcile()` (`chat.ts:143`) settles the optimistic echo by counting: a message
is confirmed when its text has appeared once *more* than it had when it was sent.
Matching on text alone reconciled a second "Continue" against one from an hour
earlier — and cancelled the delivery timer with it, so a message that never
arrived was never marked either.

### Colour: two attributes, and why the palettes are generated

Two axes on `<html>`, deliberately not one. `data-scheme` picks the palette
family and `data-theme` picks light or dark within it. They are separate because
the second has three states and only two of them can be an attribute: absent
means "follow the system", which is why every scheme repeats its light block
inside a `prefers-color-scheme` query rather than there being one global one.
`data-scheme` absent means the default, `graphite`, which is written as the bare
`:root` — so a document carrying no attributes at all is still a complete theme
rather than an unstyled one. `applyScheme` and `applyTheme` (`prefs.ts`) *remove*
the attribute rather than set a sentinel, for exactly that reason, and both
choices persist in `localStorage`, as the fleet filter now does too. Folding the two into one
list would mean ten menu entries and no way to say "this one, but follow the
system".

Five schemes in two modes is ten palettes, each owing a measured ratio on ~26
foreground/background pairs — `--dim` against three different surfaces,
`--line-strong` at 3:1 against the same three because it is the only thing
drawing a control's edge, `--text` against the mock banner's tinted wash. That
is 260-odd numbers, and picking hex by eye and checking afterwards is how
`--faint` shipped at 3.80:1 and control borders at 1.25:1. So the colours are
computed instead: `scripts/gen-themes.py` takes a set of hues and a character
and solves each token's lightness in OKLCH against the contrast its role
requires, and `python3 scripts/gen-themes.py --write` rewrites
`src/web/styles/tokens.css` whole. The stylesheet is output, not source, and
`test/scheme.test.ts` regenerates it and compares byte for byte so a hand-edit
fails rather than being silently reverted by the next `--write`.

Two properties the contrast audit cannot see are checked by the generator's own
`--report`, and both came out of looking at the rendered result rather than at
the numbers. Status colours have to differ **from each other**: `--waiting` and
`--danger` each cleared 4.5:1 against every surface while sitting 0.073 apart in
OKLab, which on screen is an amber pill and a red one that both read "warm" —
the entire job of a status colour failing with no failing pair anywhere. And the
schemes have to differ from each other: Graphite and Nordic first arrived 0.006
apart, the same colour twice under two names. Near white there is very little
chroma to be had before a colour leaves sRGB, so that second check is measured
across the surfaces rather than the page alone — a scheme has to be
distinguishable somewhere, not everywhere.

The generator is not the authority on legibility; `scripts/audit-contrast.py`
is. It re-measures every pair of every palette from the CSS with its own
independent implementation of the WCAG formula, and it *finds* the palettes by
parsing the stylesheet rather than holding a list of scheme names — a list there
would be a second place to remember, and a scheme added to the generator and
forgotten here would ship unaudited, which is the one outcome that script exists
to prevent. What the generator holds is the reasoning: why neither end is ever
pure black or pure white, why chroma drops on dark surfaces, why the two modes'
surface ramps are mirrored, and why body text stops around 11:1 rather than
maximising. Read that docstring before changing a constant. Nordic, Solar, Ember
and Mauve borrow hue relationships and character from Nord, Solarized, Gruvbox
and Catppuccin and are not those palettes: the lightness is re-derived here
because each of the originals has a documented contrast problem, which the
generator names one by one.

## Where it is fragile

Ordered by how quietly each one fails. A list like this is only worth keeping if
it is trimmed when things are fixed — see "Fixed since this list was written"
below, which is where the entries that used to be here went.

**1. The delegation tree reads an undocumented internal format, and it is the
second place this app does that.** `agent-<id>.meta.json` is not a published
contract any more than `~/.claude/sessions/<pid>.json` is (INV-5), and the
forest's delegate lanes are the only thing in the app that depends on it. A change of shape degrades to
"no tree" for that agent, which is the right direction — but it degrades
*silently*, and an empty tree looks identical to an agent that has not
delegated. The sidecars are also cached by path for the life of the process on
the grounds that they are written once and never rewritten; if that ever stops
being true, a delegate's type and brief go stale with nothing to say so.

**2. `Registry.enrich()` (`registry.ts:183`) is a blind shallow merge with two
callers writing different field sets.** The fleet enricher filters through
`CARD_FIELDS` (`enrich.ts:17`); the focused viewer passes its whole patch
(`routes.ts:410`). `undefined` overwrites, which is load-bearing for goal-clear
(`routes.ts:633`) and a trap for any future patch producer that nullifies a field
it does not know about.

**3. `changed()` (`registry.ts:320`) does not watch enrichment fields.** It
compares size, `status`, `name`, `cwd`, `waitingFor` and `paneId` — so `activity`,
`goal` and `model` reach the browser only because the enricher explicitly calls
`notify()`. A future writer that forgets lags the UI indefinitely, with nothing
raising an error.

**4. `tokens` is not the session's spend.** It is output tokens only
(`transcript.ts:244`), accumulated per tail, from a backfill capped at
`BACKFILL_BYTES = 256 * 1024` (`transcript.ts:17`). The card presents it as the
agent's cost and it is a sort key.

**5. `BASE_MS = 140` (`pane-hub.ts:40`) is calibrated to a cost that no longer
exists.** It was chosen when a frame needed two round trips at p50 141ms; through
the control client a `sample()` is roughly 20ms, so the loop idles most of every
interval at its steady rate. The keystroke case is no longer the victim of this —
`HOT_INTERVAL_MS = 25` (`pane-hub.ts:76`) runs the loop fast while an echo is
outstanding — but the steady cadence has never been re-derived from what a read
now costs.

**6a. The origin gate's extra names are earned by a token, not by Tailscale.**
`same_origin_request` measures both `Origin` and `Host` against loopback plus
whatever `origin_names` gathered (`routes.rs`): the address `--host` bound, and
this host's own Tailscale `DNSName` from the CLI probe at startup. That list is
empty without a token, so a tokenless server answers to loopback and nothing
else.

This used to accept the Tailscale name unconditionally, and the reasoning —
recorded here and in `INVARIANTS.md` — was that the name meant "this machine".
It does not. `tailscale serve` forwards the name the caller *dialled*, which is
ours, so every tailnet peer's request arrives wearing it, and nothing in the
gate reads the peer address. The name meant "anyone on the tailnet". The unit
test that seemed to prove otherwise checked that *another machine's* name is not
a self-name, which no peer ever sends.

**6. The token no longer replaces the origin gate.** `permitted` is now
`same_origin_request(headers, &self.origin_names)` with no `token.is_some()`
short-circuit. The old form made the token both the credential *and* the
exemption from rebinding protection. That was survivable only while the token
lived in a query string an attacking page could not read — it does not survive
a credential the browser attaches on its own, which is the direction this is
heading. The two gates answer different questions: the name says the request
reached the right server, the token says who sent it.

No longer true, and worth recording because it was the motive for the rest:
the token used to travel in the query string on every request and every
navigation, and `announce` printed it in full at startup. Scrollback, shell
history, `Referer` and `~/Library/Logs/agent-commander/server.log` all held it.
`cookie_exchange` now trades it for an `HttpOnly` cookie on the first document
request and redirects the query away, `announce` masks to four characters
unless asked with `--print-url`, and the token itself lives in a 0600 file
rather than in argv. What remains deliberate: `--token <literal>` is still
visible to `ps`, because an explicit override is one the operator chose.

The same "it lives in the URL" property is also what the token cannot do, and
`isPublicAsset` (`routes.ts:365`) is the concession: a URL the user opened says
nothing about the `<script>` that URL then pulls in, so `GET`/`HEAD` under
`/assets/` skip the token gate or the app 401s its own bundle. The prefix is the
whole boundary, which is why nothing under it may ever serve agent state, and
why a miss there 404s instead of falling through to the shell.

**7. A known reconcile gap is documented and unfixed** (`chat.ts:139`): a message
sent in the second before backfill arrives was baselined against an empty history.
Re-baselining on backfill was tried and reverted, because it cannot tell "this
backfill contains an older copy" from "this backfill contains mine" — and being
wrong that way sends a delivered message to a live agent twice. It is a real
limitation, not an oversight, and it currently lives only in a source comment.

**8. Status is trusted wholesale from Claude Code's session file.** `toStatus`
(`registry.ts:41`) is a whitelist over a field this app does not write, with
`unknown` as the only fallback. Knowing which agents are blocked is the entire
purpose of the dashboard, and that judgement has no independent corroboration —
notably, the two liveness signals the app *does* compute, `delegating` and
`attachBlockedReason`, are deliberately separate fields rather than statuses. This
is a reasonable dependency, but it is the largest one in the system and should be
named as such.

**9. Comment density is inverted relative to risk.** The tmux layer runs 30–36%
comments (`pane.rs` 173/478, `pane_hub.rs` 136/311, `tmux_client.rs` 128/375) and
is also the layer with source-level assertions and a live-server verifier.
`registry.rs` runs 11% (28/259), is consumed by every other plane, and has nothing
watching it. The reasoning was recorded where it was hard-won rather than where it
is load-bearing.

**10. `isMissingTarget()` (`pane.rs`) reads tmux's prose.** Telling "this session
does not exist" from "this question could not be put" is what stops a pending
agent being forgotten on a machine at its process cap, and tmux only says which
one it means in English. The wording has been stable for many years and the
default is the safe direction — anything unrecognised counts as "could not ask",
which keeps an agent visible until its expiry rather than making a live one
disappear — but it is a string match against another program's messages.

## Fixed since this list was written

Kept as a short record, because several of these were load-bearing enough that
their absence would otherwise read as an oversight.

- **The heartbeat.** A half-open socket — a phone asleep on the far side of
  Tailscale — left a `Viewer` tailing a transcript once a second and, if the
  terminal was open, holding a share of a pane poller, for a browser that was not
  there. `HEARTBEAT_MS` (`routes.rs`) pings every socket and drops one that has
  missed two rounds. `test/heartbeat.test.ts`.
- **`Poller` (`poll.rs`).** INV-4's "re-arms after the work completes rather than
  on a fixed interval" was implemented properly in `registry.rs` and as
  `setInterval` plus a busy flag in three other places, which converts an overrun
  into silently dropped ticks. All four now share one implementation.
  `test/poll.test.ts`.
- **Nothing polls what nobody is watching.** The fleet enricher — one transcript
  tail per agent, every five seconds — ran with no browser connected at all.
  `routes.rs` reports the viewer count and `main.rs` idles the enricher on it.
- **An agent that has just started is visible now, not in thirty seconds.** A
  session id the presence check had not confirmed was skipped until the next
  30s reconcile. `registry.rs` asks the CLI immediately, and `#asked` is what
  stops a ghost turning that into a 2s loop. `test/registry-presence.test.ts`.
- **A tmux that could not answer is not a session that has gone.** `pending.rs`
  spawned its own `tmux` and read any error as "the window closed", including
  the `EAGAIN` that `pane.rs` retries four times. It now goes through `pane.rs`
  and drops an entry only on a positive answer. `test/pending.test.ts`.
- **A pane that has exited now says so.** `routes.rs` sent the dead-pane error
  as prose alone, with no `kind`, and `transport.ts` branches on the kind — so
  the browser never marked the session exited, and the notice, the caption and
  the disabled key bar were reachable from unit tests and from nowhere else.
  The mock fleet's `mock-gone` fixture, added to put that surface on screen, is
  what found it. `routes::a_dead_pane_ends_the_terminal_and_not_the_conversation`
  asserts the kind; `e2e/blocked-shapes.spec.ts` drives it.
- **The five `as never` casts** on the control path are gone: `control.rs` takes
  `Agent | undefined` and `assertControllable` asserts `Controllable`, which
  carries the pane id in the type.
- **The model and mode lists live once**, in `shared/types.ts`, where
  `ALLOWED_KEYS` already lived. `test/safety.test.ts` fails a re-added copy.
- **`mapKey()` has a test** — `test/ui/key-map.test.tsx` — asserting it can never
  produce a name outside `ALLOWED_KEYS`, and can still produce every key it
  claims to.
- **INV-10 is greppable** from a test name, as `INVARIANTS.md` promises of every
  invariant.
- **`qa-fuzz.mjs` imports `playwright`** rather than an absolute path into an
  unrelated project on one laptop.
- **The gates run on every push and pull request**, not only on a release tag —
  `.github/workflows/ci.yml`, which also runs the end-to-end suite.
- **INV-6 is enforced by the server**, not only by the browser. That was fixed
  before this document was written and the entry saying otherwise was stale.

## How it is checked

Five gates, each answering a question the others cannot.

| Gate | What it can see | Where it runs |
|---|---|---|
| `npm test` | the server's modules (`cargo test`), and the browser's in jsdom (vitest) | CI, Node 20 and 22 |
| `npm run e2e` | the joins: a real browser against a real `--mock` server | CI, Chromium |
| `npm run audit` | contrast across all ten palettes, WCAG 2.2 AA at five device profiles, task flows, device layouts | local |
| `npm run qa` | randomised exploration, deterministic per seed | local |
| `npm run verify:inv1` | INV-1 against a live tmux server | local |

The split between the first two is the interesting one, and the port sharpened
it. `cargo test` covers the server's modules and vitest covers the browser's;
neither can see the other side at all, and what *neither* can see is a message
crossing the socket,
being written by the server, coming back through a transcript tail and settling
the optimistic copy the browser drew — five modules and two processes, each
individually tested, and every duplicate this app has ever sent lived between
them. `e2e/` drives that in Chromium at three shapes: desktop, tablet and phone.

Tablet is not a third size for completeness. The layout's breakpoint is 900px,
and an iPad is 834px one way up and 1194px the other — the only device that
crosses it in normal use, by being turned over mid-conversation. What has to
survive that is which agent is open, which tab it is on, and what is half-typed,
all of which live outside the layout on purpose.

The palettes are checked twice, by two of those gates. `npm test`
regenerates `tokens.css` from `scripts/gen-themes.py` and fails if the file on
disk differs, which is what keeps the generator's reasoning attached to the
values actually shipped; `npm run audit` measures every pair of all ten palettes
and is what decides whether a scheme is legible.

The last three stay local, and stay a habit rather than a gate. The audits judge
appearance, and font rendering differs enough between macOS and a runner that a
finding there would fail CI for a reason that has nothing to do with the change;
`verify:inv1` drives a real attach against a live Claude Code agent on a live
tmux server, which does not exist on a runner at all.

## The port to Rust

The server is Rust. It was ~6,600 lines of TypeScript until it wasn't, and the
TypeScript is preserved intact on **`old-node-backend-branch`**.

The five planes, the module boundaries and every invariant survived the move —
each `src/server/*.ts` has a same-named `rust/src/*.rs` — with three
rearrangements worth knowing:

- `cli.ts` split into `main.rs` (entry point, `--install-statusline`) and
  `options.rs` (argument parsing, the 4317 refusal, INV-3's bind refusal).
- `tmux-client.ts` gained `tmux_source.rs` and `tmux_agents.rs` beside it,
  matching the TypeScript's own later split.
- `agent-kinds.ts` is now in both languages: `rust/src/agent_kinds.rs` for the
  server and `src/shared/agent-kinds.ts` for the browser. **Nothing checks that
  pair still agrees except the golden fixtures below.** The wire contract used
  to be in the same position — `rust/src/types.rs` mirrored
  `src/shared/types.ts` by hand — and is not any more: `src/shared/wire.ts` is
  generated from the Rust (`npm run gen:types`) and a unit test fails when the
  checked-in copy is stale. `agent-kinds` is the remaining hand-held pair, and
  it is the price of the browser staying TypeScript.

### How the port was held to the old behaviour

Not by reading. Three things, in increasing order of how much they prove:

1. **Golden fixtures.** `rust/tests/golden/{agents,tree,env,dirs}.json` are real
   responses captured from the Node server running `--mock`, and `mock.rs`
   asserts the Rust bytes still equal them. A drift in any wire field fails a
   unit test instead of a browser.
2. **A live differential.** Both servers run `--mock` on different ports and
   every route is diffed. `/api/agents` and `/api/dirs` came back byte-identical;
   `/api/env` differs only in the port number it was told to report.
3. **The 233 end-to-end tests, unchanged.** They drive HTTP and a WebSocket and
   never imported a server module, so they arbitrate the port without knowing it
   happened. They are the reason the port can be believed.

### What the port cost and bought

Bought: ~15-27x less memory and roughly 6x faster start, measured on a spike
before any of this was written. **Not** bought: throughput. This server's time
goes to tmux subprocesses, not to its own language — JS was 0.07ms per pane poll
against a 140ms budget, where one `capture-pane` is 5.70ms spawned or 0.23ms
through the control client. At p95 the two backends are the same speed, and
anyone expecting the rewrite to have made the app feel faster should read INV-4
instead: what makes it feel fast is not polling what nobody is watching.

Cost: the two-language seam above; a distribution problem, now solved but not
for free (`bin` points at `scripts/launch.mjs`, which resolves a prebuilt
binary out of `dist/bin/<platform>-<arch>` — so the release is a four-target
build matrix rather than one job, and every future release carries that
matrix); and the loss of 412 TypeScript server tests, replaced by 501 Rust
ones.

The distribution shape was chosen against the alternative the ecosystem
usually reaches for. esbuild, Biome and swc publish one npm package per
platform and pull them in as `optionalDependencies`, which is right when a tool
is a transitive dependency installed thousands of times and every megabyte
multiplies. This one is a global CLI installed deliberately, so it ships all
four binaries in a single package: ~4 MB packed instead of ~1 MB, in exchange
for one package to own, one trusted-publisher configuration, and no window in
which a half-published matrix resolves to an install with no server. README
§"Releasing" carries the pipeline; AGENTS.md §"Shipping it to npm" carries what
must not be changed by accident.
`rust/README.md` on that branch says the rest.

Nothing on this line references it: not `package.json`, not the CI workflows,
not this document beyond these four paragraphs.
