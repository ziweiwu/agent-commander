# agent-commander

[![npm](https://img.shields.io/npm/v/@ziweiwu/agent-commander?color=cb3837&logo=npm)](https://www.npmjs.com/package/@ziweiwu/agent-commander)
[![Publish](https://github.com/ziweiwu/agent-commander/actions/workflows/npm-publish.yml/badge.svg)](https://github.com/ziweiwu/agent-commander/actions/workflows/npm-publish.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@ziweiwu/agent-commander)](https://nodejs.org)
[![sponsor](https://img.shields.io/github/sponsors/ziweiwu?logo=githubsponsors&color=ea4aaa)](https://github.com/sponsors/ziweiwu)

See every Claude Code agent on your machine at a glance — status, folder, git
branch, what it's doing right now — and drop into any one of them from the
browser. Kiro CLI sessions show up too.

Built for the case where you have a dozen `claude` sessions running across
different projects and one of them has been sitting on a permission dialog for
twenty minutes without you noticing.

![The fleet view: agents grouped Needs you, Working and Idle, one of them a Kiro session](https://raw.githubusercontent.com/ziweiwu/agent-commander/main/assets/fleet-dark.png)

```
npx @ziweiwu/agent-commander        # run it

npm install                         # or from a clone
npm start          # builds the web bundle, then serves on http://127.0.0.1:4317
```

A blocked agent opens straight onto the terminal that can answer it, and the
whole thing works from a phone over Tailscale:

| Answering a blocked agent | On a phone |
|---|---|
| <img src="https://raw.githubusercontent.com/ziweiwu/agent-commander/main/assets/agent-detail.png" alt="An agent waiting on a permission dialog, opened on the Attach tab with a banner naming what it is waiting for" width="100%"> | <img src="https://raw.githubusercontent.com/ziweiwu/agent-commander/main/assets/phone.png" alt="The fleet view on a phone: a single column of agent cards with the filter chips and quota meters stacked in the header" width="240"> |

<details>
<summary>Light theme</summary>

![The same fleet view in the light theme](https://raw.githubusercontent.com/ziweiwu/agent-commander/main/assets/fleet-light.png)

</details>

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

### Other agent CLIs

Kiro CLI sessions appear in the same fleet. They are found through tmux rather
than through a session file, because Kiro's own
`~/.kiro/sessions/cli/<uuid>.json` records neither the pane it runs in nor
whether it is blocked — so tmux is the only thing that knows both. A session is
recognised by its `kiro-<epoch>` name or by `kiro-cli` being the pane's
foreground process, and the second test is what keeps dead sessions out: a
tmux-resurrect husk sitting at a `zsh` prompt is not a running agent, however it
is named.

They carry a folder, a git branch, an uptime and a last-activity clock, and the
**Attach** tab works exactly as it does for Claude. Three things are honestly
missing, and the card says so rather than leaving a blank:

- **No conversation.** Kiro keeps no transcript this app can read, so there is
  no Chat tab — hidden rather than empty, because an empty one reads as a bug.
- **No token counts, no delegation.** Both come from a transcript.
- **Status is inferred, and never `waiting`.** It reads `idle · quiet`, meaning
  only that the pane has stopped producing output. An agent blocked on a
  permission prompt and one that has simply finished look identical from
  outside, and inventing a "needs you" for either would spend the credibility of
  the one alert this dashboard exists to raise (INV-11).

Mode and model controls are hidden for these agents: they work by typing Claude
Code's own slash commands into the prompt, and the server refuses them for any
other CLI rather than typing `/model opus` at something that will take it
literally. Closing still works — it closes the tmux session instead.

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
  for you. A typing indicator shows while it is working. `Enter` sends,
  `Shift+Enter` adds a newline, and `Shift+Tab` cycles the permission mode —
  the same chord the CLI uses, and it works mid-task. An agent that is working
  can be stopped from here too, rather than only from the terminal. Above the box is a
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
with a **Fit width** button when you want the whole pane at a glance, and a
**Full screen** button beside it for when neither is enough. The quick
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
| `Shift`+`Tab` | in the message box: cycle the permission mode, mid-task included |
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

The settings menu carries theme (System / Light / Dark), colour scheme
(Graphite / Nordic / Solar / Ember / Mauve) and language (English / 简体中文).
All three persist. Theme and scheme are separate axes — the scheme picks the
palette family, the theme picks light or dark within it — and
[Colour schemes](#colour-schemes) has the rest of that. "System" writes no
`data-theme` attribute at all, so the `prefers-color-scheme` media query decides
and keeps deciding while the app is open; an explicit choice overrides it. The Attach tab has a **Full screen**
button — useful on a phone, where the terminal is the cramped part — and `Esc`
leaves it. It sits in the key bar under the terminal, next to **Fit width**,
rather than only as a `⤢` in the panel header: the view that needs the room is
the one the button should be in.

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

The status filter you pick — need you / working / idle — is remembered, along
with the sort key and direction, in `localStorage` beside theme and language.
It survives a reload, a new tab and quitting the browser, so a view you chose
once does not have to be chosen again tomorrow. The three are stored as a set:
restoring the filter while resetting the sort leaves you in a view you never
picked, and the half that survived makes the half that did not look deliberate.
Nothing hides: the active chip carries a glyph as well as a fill, so arriving
at an already-filtered dashboard reads as a filter rather than an empty fleet.
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
the switches you reach for while reading a conversation rather than before
opening it: **Mode**, a **Goal** toggle, and the choice of what Send does to an
agent that is already working. Deciding that the next instruction should run in
plan mode happens while typing that instruction. They share that line rather
than taking one of their own because a row of their own cost 44px of a 568px
phone — enough to push the conversation itself under the layout audit's floor.
Opening the goal field gives it the whole strip, so its Set and Cancel are
never scrolled off the end.

**Mode and model both work while the agent is working**, unlike Goal and Close,
which still wait for idle. Those two submit an instruction that changes what the
session does next, and one arriving mid-turn acts on a state nobody chose.

Mode is switched by sending `BTab` — a control key the agent handles wherever it
is, exactly as it would from the keyboard of the terminal this app stands in
for. **Shift+Tab** in the message box does the same, the chord the CLI itself
uses; the cost is that Shift+Tab no longer tabs backwards out of the box, though
Tab and Escape still move focus.

Model is allowed for a different reason: it types, but through the very same
paste the message box already uses on working agents. Sending *"use opus
instead"* as a message is a designed feature — it is what Queue mode is — so
refusing the select while permitting the message was one door open and one shut
onto the same prompt. The CLI reads input that arrives mid-turn when the turn
ends, so a switch made during a task says it is **queued** rather than pretending
to have landed.

Neither is visible the instant you make it. Both are read back out of the
transcript, which a busy session writes only when its turn ends, so the control
keeps showing what you chose until the agent confirms it — otherwise the next
fleet broadcast repaints the old value and the click looks like it did nothing.
That, rather than anything on the server, is what "switching doesn't work"
looked like from the outside.

**Queue or Interrupt** decides what Send does when the agent is mid-task.
*Queue* is the default and is what this app has always done: the message waits
at the agent's prompt and arrives when it next looks. *Interrupt* stops the
agent first and then sends. Choosing it asks once — after that the Send button
reads **Interrupt & send**, which is what makes asking again on every message
unnecessary, and a dialog in front of every send is one people learn to dismiss
without reading. The choice is remembered per agent, because it is a judgement
about that session: an agent grinding through a long sweep is one you interrupt,
one mid-refactor is one you let finish.

Beside Send, and only while there is something to stop, is **Interrupt**. It
asks every time, because unlike the mode choice it is a single destructive act
rather than a standing preference (INV-6). It was previously reachable only by
switching to Attach and finding Esc.

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
The server validates the directory before spawning, and checks the model and
permission mode against fixed allow-lists so an unrecognised value is refused
rather than becoming a flag — see INV-7.

## Pruning sessions you never used

Sessions accumulate: you open one in a directory, get distracted, and it sits
there for a week holding a tmux pane and a `claude` process without ever having
been asked anything. **Prune N unused** appears beside *New agent* whenever the
fleet contains any, and closes them.

"Unused" is deliberately the narrowest claim the data supports: the session is
`idle`, it has a pane, and it carries no activity line, no token spend, no
last-activity clock, no title it generated and no prompt it was given — the same
evidence the card already prints "No prompts yet" from. Anything that has ever
been prompted keeps at least one of those, even long after it goes quiet, so the
button cannot select work in progress. `busy`, `waiting` and delegating agents
are excluded outright, and so is `unknown`: a status the app could not read is an
absence of evidence, not permission to close a session.

Nothing is closed without a confirmation that names the sessions first, they are
closed one at a time through the same `/exit`-then-kill path as **Close agent**,
and one refusing to exit does not stop the rest — the toast afterwards reports
what actually closed rather than what was attempted. The button is unavailable
while the fleet view is not live, because a card from a dropped connection is a
memory rather than a reading (INV-11).

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
    --browse-root <d>  root the folder picker is confined to (default: home)
    --mock          serve fixture agents, touching nothing real
    --install-statusline
                    add the quota bridge to ~/.claude/settings.json and exit
```

`--host` is refused without `--token`. This app can type into live agents and
approve their permission prompts, so it will not expose itself to the network
unauthenticated. It also refuses requests that do not come from this machine's
own origin, because a page in another browser tab is not a stranger on the
network — see INV-3.

For access from your phone, put Tailscale in front of it rather than binding
another address at all:

```
tailscale serve --bg 4317
```

Then open `https://<your-machine>.<tailnet>.ts.net/` on the phone. No token
needed: the proxy forwards this machine's own Tailscale name, which counts as
this machine and nothing else does — another host on the same tailnet is
refused like any other stranger. Add `--token` anyway if you want the tailnet
itself authenticated.

If you would rather bind the tailnet address directly, name it — do **not** use
`--host 0.0.0.0`, which also publishes the app on whatever Wi-Fi you are
currently joined to:

```
npm run serve -- --host 100.x.y.z --token auto
```

Never `tailscale funnel` this: that publishes to the public internet, and
anyone who reached it could drive your agents.

## Development

React 19 + Vite for the browser bundle, a dependency-free Node server, and
Vitest in two projects — node for logic and server, jsdom for components.
Node >= 20.

**Ports are split so development can never masquerade as production.** 4317
serves real agents and nothing in development binds it: `--mock` on 4317 is
refused outright, because a fixture fleet at the address your real one lives at
is indistinguishable from your real one having vanished — and the composer on
that page would be typing into nothing.

| Port | What runs there |
|---|---|
| 4317 | Production. Real agents. `npm start`, `npm run serve`, the installed binary. |
| 4400 | Development. `npm run dev`, `npm run mock`, and what the audit scripts target by default. |
| 4500 | `qa-sweep.sh`, which refuses 4317 for the same reason. |

Any of it moves with `-p` / `--port`, including past an npm script's own
default, since the last one given wins:

```
agent-commander -p 5000
npm run mock -- -p 4501
```

```
npm run mock       # fixture agents on 4400 — safe to iterate against
npm test           # 672 tests: pure logic, server, and React components
npm run e2e        # 105 end-to-end tests in a real browser, at three screen shapes
npm run typecheck
npm run lint
npm run verify:inv1   # asserts attaching never resizes a real pane (server must be running)
npm run themes        # regenerate the colour palettes into src/web/styles/tokens.css
```

`npm test` and `npm run e2e` both run on every push and pull request
(`.github/workflows/ci.yml`); the rest are local habits. See **End-to-end tests**
below for what the second one covers that the first cannot.

### Releasing

Pushing a `v*` tag triggers `.github/workflows/npm-publish.yml`, which refuses
to run if the tag and `package.json` disagree — a mismatch means the thing
published is not the thing the tag names, and npm versions are immutable once
they land. It then runs typecheck, lint, the test suite and a full build before
publishing. Provenance comes with trusted publishing, so the npm page carries a
signed link back to the commit it was built from.

```
npm version patch          # or minor / major
git push --follow-tags
```

Authentication is npm **trusted publishing**: the job mints a short-lived
OIDC token and npm exchanges it for publish rights, matched against the trusted
publisher configured for this package on npmjs.com. There is no `NPM_TOKEN` in
repo secrets to leak, rotate or forget, and no one-time password to type. It
also means the runner needs npm >= 11.5.1, which `ubuntu-latest` does not ship,
hence the `npm install -g npm@latest` step.

The browser audits stay out of the release path on purpose. They need a running
server and a real Chromium, and font rendering differs enough between macOS and
`ubuntu-latest` that a layout finding there would block a release for a reason
that has nothing to do with the release. Run them locally before tagging.

### Review agents

Two subagents do the verification. Neither lives in this repo any more: both
ship in the `harness` plugin and are addressed as `harness:ux-bar-raiser` and
`harness:qa-bar-raiser`. The repo used to carry its own `ux-bar-raiser` under
`.claude/agents/`; that copy fell six months behind the plugin's and, because
project scope shadows plugin scope, this repo was silently getting the weaker
one. It was deleted rather than resynced.

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

### End-to-end tests

```
npm run e2e                      # all three shapes
npm run e2e -- --project=phone   # just one
npm run e2e:ui                   # pick and watch them run
npm run e2e:report               # the last run's report, traces included
```

The specs live in `e2e/`, driven by `@playwright/test` and configured in
`playwright.config.ts`. On a machine that has never run them, fetch the browser
once — the runner ships without one:

```
npx playwright install chromium
```

They need a running tmux server, which any machine using this app already has:
`--mock` swaps the fixtures in but still probes the real host for `ServerEnv`,
and the New Agent dialog correctly refuses to offer a form on a machine that
cannot spawn anything. `tmux new-session -d -s anything` is enough.

`playwright.config.ts` builds the web assets and starts a `--mock` server
itself, so there is nothing else to have running first — and because it is `--mock`,
a suite that types, sends and presses Ctrl-C in a loop cannot reach a real
agent. It listens on 4599, not 4317, for the reason everything else in this repo
avoids that port; set `E2E_PORT` if something else already has 4599.

These exist for the joins. Vitest covers each module and each component; what it
cannot see is a message crossing the socket, being written by the server, coming
back through a transcript tail and settling the optimistic copy the browser drew
— five modules and two processes, each individually tested, with every duplicate
this app has ever sent living somewhere between them.

They run at three shapes, because the layout has three:

| Project | Viewport | Why |
|---|---|---|
| `desktop` | 1280×720 | two columns, hardware keyboard |
| `tablet` | iPad Pro 11, both ways up | the only device that crosses the 900px breakpoint in normal use |
| `phone` | iPhone 13, plus an SE and a landscape check | the sheet layout, where height is scarce |

Specs that only make sense on one shape carry a `@desktop`, `@tablet` or
`@phone` tag, and the tag is what keeps them off the others.

All three run on Chromium, pinned explicitly. Playwright's device descriptors
name WebKit for the iPad and the iPhone, so without the pin a laptop with every
browser installed quietly ran two thirds of the suite on a different engine
than CI, which installs only Chromium. These specs are about the layout and the
wiring rather than engine behaviour; the audits make the same choice.

The tablet is not a third size for completeness. An iPad is 834px wide in
portrait and 1194px in landscape, so turning one over mid-conversation switches
the app between its sheet layout and its two-column one — and what has to
survive that is which agent is open, which tab it is on, what is half-typed, and
the terminal's column count, which INV-1 says may never follow the window.

### Colour schemes

Five palettes ship: **Graphite** (the default — neutral slate, no temperature),
**Nordic** (arctic blues), **Solar** (teal-tinted dark, cream light), **Ember**
(warm browns and ambers) and **Mauve** (soft violet). Pick one in the settings
menu under *Colours*, where every row carries a swatch in that scheme's page,
raised-surface and accent colours: a name tells you nothing about what a palette
does to a screen you are going to sit in front of all day. That menu stays open when you pick one,
unlike the theme and language rows — choosing a palette means trying two or
three, and closing on the first makes comparing them four clicks apiece.

Light and dark stays a separate axis. The scheme picks the palette family;
System / Light / Dark picks which end of it, and "System" still writes no
attribute at all. So there are ten palettes, and *Nordic, following the system*
is a thing you can ask for — which is why the two were not folded into one menu
of ten entries. Both settings persist in `localStorage`.

The palettes are derived, not chosen. `scripts/gen-themes.py` computes every
colour in OKLCH from the contrast that colour's role has to clear, and writes
the stylesheet whole:

```
python3 scripts/gen-themes.py --write   # same as npm run themes
```

Edit the generator, never `src/web/styles/tokens.css`. `test/scheme.test.ts`
re-runs the generator and compares byte for byte, so a hand-edit fails the suite
rather than surviving until the next `--write` quietly reverts it. The same test
checks that the menu's list and the stylesheet agree in both directions — a
scheme in the CSS the menu never offers is unreachable, one in the menu with no
CSS behind it is a click that does nothing — and that all ten palettes define
the whole token set.

Three properties are enforced, not just the first. Contrast is the one WCAG
names, and `audit-contrast.py` is its judge. The other two came out of looking
at the result: status colours have to differ **from each other**, not only from
the surface behind them — amber and red both cleared 4.5:1 while sitting 0.073
apart in OKLab, which is an amber pill and a red one that both just read "warm"
— and the schemes have to differ from each other, since Graphite and Nordic
first arrived 0.006 apart, the same colour twice under two names. Both are
measured by `python3 scripts/gen-themes.py --report`, which is what `--write`
prints after it writes.

`.cleancode.json` at the repo root exists for this file and this reason only:
the coefficients of Ottosson's OKLab matrices are added to the pre-commit
hook's `allowed_numbers`, because `0.4122214708` is not a number wanting a name
— it *is* the name. Every other rule is left on for every file.

Nordic, Solar, Ember and Mauve borrow their hue relationships and their
character from Nord, Solarized, Gruvbox and Catppuccin. They are not those
palettes, and the lightness is re-derived here precisely because the originals
have documented contrast problems: Gruvbox measurably misses WCAG, Catppuccin's
own tracker records that a fully AA version stopped looking pastel, and Nord's
low contrast is its usual complaint. `scripts/gen-themes.py` carries the
research and says which rule each constant came from.

### Audit gates

```
python3 scripts/audit-contrast.py        # WCAG 1.4.3 / 1.4.11 across all ten palettes
PORT=4400 node scripts/audit-a11y.mjs    # WCAG 2.2 AA, desktop + phone, light + dark
PORT=4400 node scripts/audit-ux.mjs      # task flows, keyboard, responsive, features
PORT=4400 node scripts/audit-mobile.mjs  # real device profiles, portrait + landscape
```

All four take `PORT`, or `BASE` for a full URL when the server is not on
localhost. The two that take screenshots write them to `SHOTS`, defaulting to
`/tmp/agent-commander-audit`.

Each exits non-zero on a finding, so they gate a change. `audit-contrast.py`
parses `src/web/styles/tokens.css` and measures every pair the interface uses,
independently for each of the ten palettes — it currently reports `10
palette(s) audited, 0 failing pair(s)`. It is what caught `--faint` sitting at
3.80:1 against a panel, and control borders at 1.25:1 while being the only thing
defining a card's edge. It finds the palettes by parsing the stylesheet rather
than from a list of scheme names, so a scheme added to the generator and
forgotten here cannot ship unaudited.

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
