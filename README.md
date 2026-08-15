# agent-commander

See every Claude Code agent on your machine at a glance — status, folder, git
branch, what it's doing right now — and drop into any one of them from the
browser.

Built for the case where you have a dozen `claude` sessions running across
different projects and one of them has been sitting on a permission dialog for
twenty minutes without you noticing.

```
npx @ziweiwu/agent-commander        # run it

npm install                         # or from a clone
npm start          # builds the web bundle, then serves on http://127.0.0.1:4317
```

## What it shows

Agents are grouped **Needs you → Working → Idle**, so anything blocked on you is
the first thing on screen. Each card carries the agent's name, status (with the
reason it's blocked, e.g. `waiting · dialog open`), the folder it's scoped to
(`~` when it isn't in a project), its git branch, time since last activity,
output tokens, and a live one-line summary of what it's doing — `Edit:
src/app.ts`, `Task → Rerun the exhaustive sweep`.

An agent that has handed work to a subagent reads `busy · delegated`, and its
last-activity clock follows the subagent's transcript rather than its own. Its
own transcript stops growing the moment it delegates, so without both of those a
perfectly healthy run looks like an agent that quietly died — which is the one
thing this dashboard exists to catch.

Filter with the search box (name, folder, branch, activity or status) or by
clicking a status chip in the header. When an agent starts waiting on you, the
browser tab title becomes `(1) agent-commander`.

Open an agent and you get two tabs:

- **Chat** — the session as a conversation. Your prompts and the agent's replies
  are attributed and grouped like a chat app, with the tool calls each reply
  produced folded underneath it (long runs collapse behind a `6 actions`
  summary). Messages you send appear immediately as *sending…* and settle once
  the agent's transcript confirms them; one the agent never echoes back is
  marked *not delivered* rather than spinning forever, and is never resent
  for you. A typing indicator shows while it is working. `Enter` sends, `Shift+Enter` adds a newline. Above the box is a
  row of the replies you end up typing over and over — *continue*, *yes, go
  ahead*, *run the tests*, *what's blocking you?*, *summarise where you
  are*. Picking one sends it as it reads, and leaves anything you had
  half-typed in the box alone. The prompts follow the language the conversation
  is already in rather than the one the interface is set to, so an agent being
  worked with in Chinese gets 继续 even while you read the app in English.
- **Attach** — the actual terminal, live. Full keyboard passthrough, so you can
  answer a permission dialog, hit Esc to interrupt, or arrow through a menu.

A blocked agent opens straight onto **Attach** — the only tab that can answer
its dialog — with a banner naming what it's waiting for.

### On a phone

The layout is built for actually using this from Tailscale on a phone, not just
surviving there. The agent list is a single column; opening an agent slides a
full-height sheet over it with a `‹ Agents` button back. The conversation fills
the screen with the message box pinned to the bottom, above the home indicator.
Inputs are 16px so iOS does not zoom the page when you tap them, tap targets are
44px, and safe-area insets keep content clear of the notch in both orientations.

The terminal is the hard case: a 150-column pane shrunk to a 390px screen would
render at about 4.6px. Instead it never scales below ~9.5px and pans sideways,
with a **Fit width** button when you want the whole pane at a glance. The quick
keys (`Enter`, arrows, `Tab`, `Esc`, `Ctrl-C`) sit under it, since a phone
keyboard has none of them.

### Keyboard

| Key | Does |
|---|---|
| `/` | focus the filter box |
| `↑` `↓` (or `k` `j`) | move through the agent list |
| `Enter` | open the focused agent |
| `Esc` | close the agent (or clear the filter box) |
| `Enter` / `Shift`+`Enter` | in the message box: send / newline |
| `Shift`+`Esc` | close the agent from inside the terminal, where plain `Esc` belongs to the agent |

## Claude usage

The topbar carries two meters: how much of your Claude.ai **5-hour session**
window and **7-day weekly** window you have used, and — on hover — when each
one resets. It is the one number on this page that decides whether any of the
agents below can keep working.

Getting it needs a one-time change **outside this repo**, because the data is
not where you would expect. Nothing in `~/.claude` records your quota: the
transcripts carry per-request token counts and no rate-limit data at all. Claude
Code hands the numbers to its `statusLine` command and nowhere else. So
`scripts/statusline-bridge.mjs` is a status line whose real job is to write those
two numbers down where this server can watch them.

```
npx @ziweiwu/agent-commander --install-statusline
```

That adds the following to `~/.claude/settings.json`, backing up whatever was
there first, and refuses rather than overwrite a `statusLine` you already have:

```json
"statusLine": {
  "type": "command",
  "command": "node /path/to/agent-commander/scripts/statusline-bridge.mjs"
}
```

New Claude Code sessions pick it up immediately; existing ones need a restart.
The numbers appear once a session has had one API response.

Two things worth knowing:

- **It puts a line in your Claude Code footer**, in every session:
  `⮕ 5h 61%  ·  7d 34%`. That is the bridge doing its visible half.
- **The reset countdown sits next to each meter**, not behind a tooltip — a
  tooltip needs hover, and hover does not exist on the phone widths where these
  chips get a row of their own.
- **The meters only refresh while a Claude Code session is rendering.** On a
  quiet machine the reading ages; past 20 minutes the meters dim and the label
  says when the number was last true rather than implying it is current. If you
  are not on a Claude.ai subscription plan there is no reading at all and the
  meters are hidden entirely.

The bridge is Node rather than Python, which is the usual default for scripts
here. Not for speed — Python actually starts faster — but because it and
`src/server/limits.ts` have to agree on one path and one JSON shape forever, and
a cross-language pair is where that agreement rots.

There is an unofficial `GET /api/oauth/usage` endpoint that returns richer data,
including a per-model weekly breakdown. It is not used, and should not be: it
needs the OAuth token out of the `Claude Code-credentials` Keychain item, which
means storing and refreshing a credential that grants full API access to your
account. That is a much larger security surface than this app has anywhere else,
in an app that refuses to bind a non-loopback address without a token. The
statusLine route gets the two numbers actually rendered, from a documented
extension point, holding no credential at all.

## Themes, language and full screen

The settings menu carries theme (System / Light / Dark) and language (English /
简体中文). Both persist. "System" writes no `data-theme` attribute at all, so the
`prefers-color-scheme` media query decides and keeps deciding while the app is
open; an explicit choice overrides it. The Attach tab has a **Full screen**
button — useful on a phone, where the terminal is the cramped part — and `Esc`
leaves it.

## Sorting and finding

Sort the list by recent activity, token spend, how long a session has been
running, or name. Sorting happens *inside* the Needs you / Working / Idle
groups, never across them, so no sort key can bury an agent that is blocked on
you. Each card shows its full working directory, which is what tells apart the
several sessions everyone ends up running in `~`.

Sort ascending or descending with the toggle beside the picker. It is labelled
with what the order means — "most"/"least", "newest"/"oldest" — because nobody
thinks in "ascending tokens". A session with no value for the chosen key sorts
last in *both* directions: unknown is not a claim that it is the cheapest.

The status filter you pick — need you / working / idle — survives a reload,
kept in `sessionStorage`. Not `localStorage`, where theme and language live: a
filter is a statement about the task in front of you, not about you. Persisting
it across tabs and days would mean a tab opened next week to check the whole
fleet quietly showing only the blocked agents, for a reason you set days ago.
The search box deliberately does not persist — a one-off lookup coming back on
a reload with no visible cause is just confusing.

Sessions Claude Code names for itself look like `ziweiwu-35`, which
distinguishes nothing when several are running. Where a session was
auto-named — the session file says so with `nameSource: "derived"`, so the app
never has to guess — the card leads with the best thing available instead: the
title the agent generated for its own conversation, or failing that the first
line of the last thing it was asked. The session name stays as secondary text.
A derived session with neither keeps its own name; the directory is right there
on the card, and these names are derived *from* the directory anyway.

## Controlling a running agent

The detail panel carries **Mode**, **Model** and **Close**. All three type into
the agent's own prompt, so they are enabled only while it is idle or waiting —
greyed with a tooltip while it is busy, so a keystroke never interleaves with a
tool call in flight. On a phone they collapse behind a `⋯` button, because the
row cost 111px of a 568px screen.

Mode switching sends Shift+Tab and re-reads the mode until it matches, rather
than counting presses: the cycle omits `bypassPermissions` and `auto` when they
are unavailable. Closing sends `/exit` first and only forces a session that
ignores it.

### From the chat itself

Directly above the message box, sharing the line with the quick replies, sit
the two switches you reach for while reading a conversation rather than before
opening it: **Mode**, and a **Goal** toggle. Deciding that the next instruction
should run in plan mode happens while typing that instruction. They share that
line rather than taking one of their own because a row of their own cost 44px
of a 568px phone — enough to push the conversation itself under the layout
audit's floor. Opening the goal field gives it the whole strip, so its Set and
Cancel are never scrolled off the end.

Being part of the conversation view means they are there in full screen too,
unlike the panel's control row — and full screen is where a phone actually
reads a conversation. The one place they are not is a landscape phone, where
the strip hides itself exactly as the quick replies already do: there are 380px
of height there and the conversation needs them.

**Goal** drives Claude Code's own `/goal`, which is a stop condition: the
session keeps working, checking itself against the condition each time it would
otherwise stop, until a separate evaluator agrees it is met. Toggling it on
asks for the condition and sends `/goal <condition>`; toggling it off sends
`/goal clear`. While one is running the chip names it, and says whether the
last check went by without meeting it — the normal case, and the one that means
"still going" rather than "stuck". An achieved goal reads as *achieved* and the
toggle goes back to off, because a met goal is finished, not running.

The state is read, not assumed. `/goal` leaves a `goal_status` record in the
transcript every time it is set and every time it is evaluated, which is the
only place this is observable from outside the session — it is in neither the
session file nor the statusLine payload. Setting a goal is confirmed against
that record appearing, so a paste that went into a dialog instead of the prompt
is reported rather than shown as a goal that is quietly not set. Clearing is
the exception and cannot be confirmed: Claude Code writes nothing when a goal
is cleared. See INV-8.

## Starting an agent

**New agent** in the fleet column asks for a directory — typed, picked from a
folder browser, or chosen from the directories already in use — plus an optional
name, model and permission mode, and starts `claude` there in a fresh detached
tmux session. It appears in the list within a
couple of seconds, because the new process registers itself the same way every
other session does. Directories from running agents are offered as shortcuts.
The server validates the directory before spawning — see INV-7.

## How it works

| Source | Used for |
|---|---|
| `~/.claude/sessions/<pid>.json` | Session list, status, cwd, and the tmux pane id. Read every 2s. |
| `claude agents --json` | Authoritative presence check. Costs ~680ms, so it runs every 30s to reconcile. |
| `~/.claude/projects/*/<sessionId>.jsonl` | The timeline, tailed incrementally by byte offset. |
| `tmux capture-pane` / `send-keys` | The Attach tab, and delivering your input. |
| `~/.claude/agent-commander/rate-limits.json` | Your 5-hour and 7-day subscription quota. The only file this app **writes** — see [Claude usage](#claude-usage). |

The Attach tab is built on frame capture rather than a pty. tmux here runs with
`window-size latest`, so a browser client attaching at a different size would
resize your real panes mid-work. Capturing frames means the browser is a pure
observer that can never move your terminal. See [INVARIANTS.md](INVARIANTS.md).

## Options

```
-p, --port <n>      port to listen on (default 4317)
    --host <addr>   bind address (default 127.0.0.1)
    --token <s>     require this token; "auto" generates one
    --mock          serve fixture agents, touching nothing real
    --install-statusline
                    add the quota bridge to ~/.claude/settings.json and exit
```

`--host` is refused without `--token`. This app can type into live agents and
approve their permission prompts, so it will not expose itself to the network
unauthenticated. For access from your phone, run it behind Tailscale:

```
npm run serve -- --host 0.0.0.0 --token auto
```

## Development

React 19 + Vite for the browser bundle, a dependency-free Node server, and
Vitest in two projects — node for logic and server, jsdom for components.
Node >= 20.

```
npm run mock       # fixture agents — safe to iterate against
npm test           # 377 tests: pure logic, server, and React components
npm run typecheck
npm run lint
npm run verify:inv1   # asserts attaching never resizes a real pane (server must be running)
```

### Review agents

Two subagents do the verification. `ux-bar-raiser` ships with the repo in
`.claude/agents/`; `qa-bar-raiser` lives in `~/.claude/agents/`:

- **`ux-bar-raiser`** holds the UX and UI bar. It runs the four gates below,
  reads the screenshots, and returns a scored six-dimension review with
  criterion-referenced findings. It reviews only — it never edits code.
- **`qa-bar-raiser`** tries to break the app by using it carelessly, and reports
  reproducible defects with the seed that caused them.

Both are told to say "nothing found" plainly rather than pad a list. Point them
at a `--mock` server and never at port 4317, which drives real agents;
`qa-sweep.sh` refuses that port outright.

They earn their keep. Between them they found the document-width overflow, an
xterm use-after-dispose crash on every full-screen toggle, a clipped composer,
an unreadable header on a phone, an ascending-sort bug that ranked unknown
values as the smallest, and a markdown parser that turned `__init__.py` into
`_init_.py`.

### Audit gates

```
python3 scripts/audit-contrast.py        # WCAG 1.4.3 / 1.4.11 across both themes
PORT=4400 node scripts/audit-a11y.mjs    # WCAG 2.2 AA, desktop + phone, light + dark
PORT=4400 node scripts/audit-ux.mjs      # task flows, keyboard, responsive, features
PORT=4400 node scripts/audit-mobile.mjs  # real device profiles, portrait + landscape
```

All four take `PORT`, or `BASE` for a full URL when the server is not on
localhost. The two that take screenshots write them to `SHOTS`, defaulting to
`/tmp/agent-commander-audit`.

Each exits non-zero on a finding, so they gate a change. `audit-contrast.py`
parses `src/web/styles/tokens.css` and measures every pair the interface uses —
it is what caught `--faint` sitting at 3.80:1 against a panel, and control
borders at 1.25:1 while being the only thing defining a card's edge.

### Randomised QA

`scripts/qa-fuzz.mjs` explores the app semi-randomly — clicking, typing and
pressing keys — looking for crashes, console errors, stuck overlays and layout
breakage. It is deterministic per `--seed`, so anything it finds comes with a
reproduction rather than a story.

```
node scripts/qa-fuzz.mjs --seed 23 --steps 150 --profile phone
./scripts/qa-sweep.sh          # 12 runs across all six device profiles
```

It only ever runs against a `--mock` server, and `qa-sweep.sh` refuses port
4317 outright, because the fuzzer types into whatever it finds and that port
drives real agents. The `qa-bar-raiser` subagent runs the sweep and triages the
results.

This is how the empty-state overflow was found: a 300-character search term was
echoed verbatim into "No agent matches …", forcing the document to 2175px.

`--mock` serves a deliberately awkward fleet: nine agents, five of them sharing
the home directory with auto-generated names, one name too long for its card and
two that have never been prompted. `--mock-transitions` additionally flips the
blocked agent on a timer, so live status changes can be reviewed without waiting
for a real one.
