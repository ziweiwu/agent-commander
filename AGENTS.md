# Working on agent-commander

Instructions for Claude Code and any other agent working in this repository.
Read this before changing anything.

## What this is

A local web dashboard over every Claude Code and Kiro CLI session on the
machine — status, folder, what each one is doing — with a terminal you can
answer a blocked agent from, including from a phone over Tailscale.

It is an observer of somebody else's work in progress. That is the whole design
pressure: the sessions on screen are real, and this app is never allowed to
disturb one.

The fleet has **two renderings**, chosen in settings and stored per browser:
`ForestView` draws each session as a family on one shared time axis, and
`FleetList` is the grouped card list. Neither is deprecated — the list says what
an agent is *doing*, the forest says whether anything in a family is still
moving — so a change to one is not automatically a change to the other, and
anything that must be true of the fleet has to be true in both. `FleetRoute`
picks between them; the layout maths lives in `src/web/lib/forest.ts` as pure
functions so it can be tested without a DOM.

## Two languages, and which is which

**The server is Rust, in `rust/`. The browser app is TypeScript, in `src/web/`.**
`src/shared/types.ts` is the wire contract the browser compiles against, and
`rust/src/types.rs` is its mirror — the two are edited together or not at all,
because nothing checks that they still agree except the tests that compare
against a captured response.

There is no `src/server/` any more. It was ~6,600 lines of TypeScript and it is
preserved, working, on the **`old-node-backend-branch`** branch. Reach for it
when you want to know what the old code did; do not reach for it to copy code
back.

The port is verified by three things rather than by reading:

- `rust/tests/golden/*.json` — real responses captured from the Node server on
  the mock fleet. `mock.rs`'s tests assert the Rust bytes still match them, so a
  drift in any wire field fails a unit test rather than a browser.
- The **233 Playwright tests**, unchanged. They drive HTTP and WebSocket and
  never imported the server, so they arbitrate the port without knowing it
  happened.
- `cargo test`, which carries the invariant numbers the same way the TypeScript
  did: `cargo test --manifest-path rust/Cargo.toml inv13`.

What moved and what did not: every module in `src/server/*.ts` has a
same-named `rust/src/*.rs`, except that `tmux-client.ts` gained
`tmux_source.rs`/`tmux_agents.rs` beside it, `agent-kinds.ts` became
`agent_kinds.rs` on the server side while staying TypeScript for the browser,
and `cli.ts` split into `main.rs` (entry, statusline install) and `options.rs`
(argument parsing, the port guards, INV-3's bind refusal).

## The two constraints everything else follows from

`ARCHITECTURE.md` opens with these, and says explicitly that everything else is
downstream of them.

**INV-1 — no tmux client this app creates may affect the size of a pane.** It is
why the Attach view is `capture-pane` polled, diffed and replayed into xterm.js
rather than a pty. A pty means a client, a client has a size, and under
`window-size latest` with `aggressive-resize on` a browser-shaped client reflows
the pane a working agent is drawing into. The browser's own width only ever sets
a CSS transform.

**INV-2 — nothing reaches a live agent except from an explicit user action.** No
retries, no auto-send, no replay on reconnect. It is why the client carries four
separate duplicate-suppression mechanisms rather than one, why a paste is staged
through a file instead of a command line, and why every control action is
*verified by reading the transcript back* rather than assumed to have worked.

A change that makes either of those less true is the wrong change however
convenient it looks. `ARCHITECTURE.md` §"The two constraints everything else
follows from" carries the reasoning; `INVARIANTS.md` carries the contract.

## Before you say it works

Run these. If you did not run them, say so explicitly rather than implying
success.

```sh
npm run typecheck
npm run lint
npm test              # 906 tests: 501 Rust (the server) + 405 vitest (the web app)
npm run build         # vite bundle, then `cargo build --release`
npm run e2e           # 233 end-to-end tests, five projects: desktop/tablet/phone on
                      # Chromium, and phone/tablet again on WebKit
npm run audit         # contrast, a11y, task flows, device layouts — needs a server
npm run qa            # randomised exploration, deterministic per seed
npm run verify:inv1   # attaching never resizes a real pane — server must be running
```

`ARCHITECTURE.md` §"How it is checked" is the table to read before touching any
of them: five gates, each answering a question the others cannot, and the note
on why the last three stay local habits rather than CI gates.

`npm test` and `npm run e2e` run on every push and pull request
(`.github/workflows/ci.yml`), which installs a stable Rust toolchain (cached
with `Swatinem/rust-cache`) alongside both Chromium and WebKit. The
second engine is not redundancy: every browser on iOS is WebKit, and for this
app's first five releases every "iPhone" and "iPad" result it produced was
Chromium wearing an iPhone user-agent. `ENGINE=webkit npm run audit:mobile`
runs the device audit on WebKit too. The rest are local.

The first three also run as a `Stop` hook, so a turn that leaves the tree
failing is refused rather than summarised. The hook lives in the `harness`
plugin and reads its list from **`.claude/gates.json`** here — `watch`
pathspecs, `gates` as `[name, argv]` pairs, and a per-gate `timeout`. It skips
when nothing under `src/`, `test/`, `scripts/` or the manifests has changed, and
blocks at most once per tree state so a failure it cannot fix never traps the
session.

`build`, `e2e`, `audit:*`, `qa` and `verify:inv1` are deliberately **not** in
that list. Measured on this machine: typecheck 5.0s, lint 0.9s, test ~40s,
build 3.4s — the three that are in it already cost ~46s, and a Stop hook slow
enough to resent is one that gets deleted. The others need a browser, a running
server, or a live tmux session with a real agent in it, none of which a hook can
assume. CI and a deliberate local run own them.

`watch` entries are git pathspecs, not prefixes — git matches whole path
components, so the manifests are spelled out individually. `scripts/` is on the
list because `test/scheme.test.ts` re-runs `scripts/gen-themes.py` and fails if
`tokens.css` no longer matches its output, and because `scripts/cargo.sh` is how
every gate reaches the Rust toolchain. `rust/` is on it for the obvious reason:
it is the server.

**Anything a gate shells out to must go through `scripts/cargo.sh`, never bare
`cargo`.** `~/.cargo/bin` is put on PATH by a line in your shell profile, so it
is present in a terminal and absent in every non-interactive shell — npm
scripts, git hooks, and the Stop hook that runs these gates. Bare `cargo` in a
package script passes locally and fails with `cargo: command not found` for
everyone and everything else, which is exactly how it was first written here.

## Ports, and why there are three

| Port | What runs there |
|---|---|
| 4317 | Production. Real agents. `npm start`, `npm run serve`, the installed binary. |
| 4400 | Development. `npm run dev`, `npm run mock`, and what the audit scripts target. |
| 4500 | `qa-sweep.sh`. |

Never point a fuzzer, an audit or a review agent at 4317. It drives real
agents, and anything that types into whatever it finds will type into someone's
session. `qa-sweep.sh` refuses that port outright and `--mock` on it is rejected.

`npm run mock` serves a deliberately awkward fixture fleet — ten agents, five
sharing a home directory, one name too long for its card, two never prompted,
and one Kiro session so the degraded card an agent with no transcript gets is
on screen rather than only in a test. The delegation trees behind them are
awkward on purpose too: a depth-3 chain, a delegate the user stopped, one node
in each of INV-13's three states, an orphan whose parent is not on disk, an
agent that has delegated nothing, and a CLI that cannot say either way.
Because the mock fleet runs the same server, routes and validation as the real
one (`rust/src/sources.rs` is the seam), a failure seen in mock mode is the
failure you would get for real.

## The invariant contract

`INVARIANTS.md` numbers every property this app is built against, INV-1 through
INV-14, and each is greppable from a test name:

```sh
cargo test --manifest-path rust/Cargo.toml inv3   # the server's half
npm run test:web -- -t INV-3                     # the browser's half
```

When you add behaviour worth relying on, add a numbered invariant and a test
carrying its number. When you change behaviour, update the invariant in the same
commit.

## Things that have already bitten

- **`bin` points at a launcher, not at the server.** The server is a Rust
  binary, and `bin` has to name something node can run, so
  `scripts/launch.mjs` finds `rust/target/release/agent-commander` and execs it.
  Source edits do nothing until `npm run build:server`. The launcher fails
  loudly when the binary is missing, and that is deliberate: every global
  install from 0.1.0 shipped a CLI that produced no output, opened no port and
  reported no error, and a silent launcher would be that bug again wearing a
  different hat. **Publishing to npm still needs per-platform prebuilds** — the
  shim only covers a checkout that has been built and a `cargo install`ed
  binary on PATH.
- **A token in the URL cannot reach a subresource.** `--token` 401'd the app's
  own bundle, because `index.html`'s `<script>` and `<link>` carry neither the
  token nor a header. `GET`/`HEAD` under `/assets/` skip the token gate and
  nothing else does — so nothing under that prefix may ever serve agent state.
  The same assumption broke the address bar: the router replaces the whole
  location, so navigation has to re-attach the token.
- **A configured token *replaces* the origin gate rather than adding to it**
  (`routes.ts:387`). It is the credential and the exemption from rebinding
  protection at once, and it travels in the query string and is printed to
  stdout. See `ARCHITECTURE.md` §"Where it is fragile" 6 and 6a before touching
  either gate.
- **Development used to default to 4317.** A fixture fleet on the production
  port is indistinguishable from your real one having vanished, and the composer
  on that page types into nothing.
- **`Registry.changed()` does not watch enrichment fields** (`registry.ts:320`).
  `activity`, `goal` and `model` reach the browser only because the enricher
  calls `notify()` itself. Forget that and the UI lags indefinitely with nothing
  raising an error.
- **`Registry.enrich()` is a blind shallow merge** with two callers writing
  different field sets, and `undefined` overwrites. That is load-bearing for
  goal-clear and a trap for any new patch producer.
- **`tokens` is output tokens only**, accumulated per tail from a 256 KiB
  backfill — not the session's spend, despite being presented as cost and used
  as a sort key.
- **A half-open socket kept polling for a browser that was gone.** A phone
  asleep behind Tailscale held a transcript tail and a share of a pane poller.
  Fixed by the heartbeat; the general rule is that nothing polls what nobody is
  watching.
- **Widths break in the empty state, not the full one.** A 300-character search
  term echoed verbatim into "No agent matches …" forced the document to 2175px.
  The review agents found that one, plus an xterm use-after-dispose crash on
  every full-screen toggle and a sort that ranked unknown values as smallest.
- **A control whose success cannot be observed must not claim it failed.** The
  permission-mode button was reported broken three times across two rewrites,
  and the key was never at fault: `tmux send-keys BTab` emits `\033[Z`, and
  three presses walk a live session `auto` → `plan` exactly as the keyboard
  would. Claude Code writes its `permission-mode` record at the *end of a
  turn*, so an agent at its prompt — the one usually being switched — reports
  nothing back, and one that has not taken a turn has no transcript to report
  from. Verifying it meant a 2.5s window with the button dead, then
  `unverified`, then the old mode still on the label: three signals of failure
  about something that had worked. It now sends the key and says so. Before
  building verification onto a control, check that the CLI writes anything down
  when the thing happens.

- **A control action that carries no value still goes through `readJson`.**
  Mode, clear and compact take no argument, so the browser sends no body at all
  — and `JSON.parse('')` throws. Every unit test passed while pressing the mode
  button reported *"that did not take effect: Unexpected end of JSON input"*
  about a control the server had never called. The Rust port keeps both halves
  of that lesson: `routes::inv8_mode_and_clear_and_compact_carry_no_body` drives
  the real HTTP handler with an empty body, because `control::tests` calls the
  action functions directly and structurally cannot catch this.
- **`/clear` replaces the session; it does not edit it.** Claude Code opens a
  fresh transcript under a new session id and rewrites
  `~/.claude/sessions/<pid>.json`. Anything holding the old id — a URL, a socket
  focus, a mock fixture, an e2e test — is stale the moment it lands. That is
  also why one fixture (`AGENT.clearable`) is reserved for the clear spec: every
  e2e project shares one mock server, and clearing a fixture another test uses
  deletes that test's agent out from under it.
- **`npm test` is flaky under load.** `test/scheme.test.ts` (a 5s timeout around
  spawning `python3`) fails when the machine is busy and passes on a quiet one.
  A red Stop hook naming only that is worth re-running before believing. The
  INV-4 tail-count flake that used to sit beside it went away with the port:
  `enrich.rs`'s cadence re-arms after the work instead of on a wall clock, so a
  slow pass no longer drops a tick.
- **The e2e `/clear` follow test flakes on slow CI runners.** `control.spec.ts`
  "INV-8 follows the agent to the session it is now running" failed both
  attempts on one GitHub runner and passed on rerun with nothing changed. One
  red occurrence of exactly that test is worth a rerun before it is believed —
  and worth root-causing if it ever fails twice in a row on different runs.
- **The Mac bundle's path constraints went from four to one, and the one that
  survived changed shape.** The Node bundle needed `dist/web` beside
  `dist/server`, `scripts/statusline-bridge.mjs` two levels up, `dist/shared` as
  a sibling, and a `package.json` carrying `"type": "module"` — without that last
  one Node read the ESM output as CommonJS and died before printing a character,
  a do-nothing binary wearing a Dock icon. Three of those were Node's and left
  with it. What remains is the web root: the launcher passes `--web-root`
  explicitly, and `Resources/web` is laid out as a sibling of `Resources/bin` so
  `default_web_root()`'s own `../web` fallback lands in the same place for
  anyone running the staged binary by hand. `--help` returns before anything is
  served, so the smoke test cannot prove this one — `build-mac-app.py` checks for
  `web/index.html` directly instead.

- **`codesign` runs before the smoke test, not after.** The launched thing is a
  Mach-O now rather than a script, and on Apple silicon an *invalid* signature is
  a kernel kill rather than a warning. Signing first means the smoke test runs
  the exact bytes the user will. It stays non-fatal, so a benign codesign failure
  does not stop a build while a lethal one cannot slip past it.

- **The bundle ships no `statusline-bridge.mjs`, deliberately.** A bridge path
  written into `~/.claude/settings.json` that points inside a `.app` breaks the
  next time the app is replaced, so `--install-statusline` belongs to the npm
  package. Run from inside the bundle it now reports that it cannot find the
  bridge script rather than writing a path that will rot.

- **Piping a test run through `tail` eats the verdict.** `npm run e2e | tail`
  reports tail's exit code, not Playwright's, and the failure list scrolls out
  of the kept lines — a 92-failure run once read as "141 passed" that way.
  Redirect to a file and check the exit code, never pipe a gate.

## The macOS bundle

```sh
npm run build                      # the Vite bundle, then cargo build --release
python3 scripts/build-mac-app.py   # --out defaults to build/
```

One self-contained binary in `Contents/Resources/bin` plus the Vite bundle in
`Contents/Resources/web`; `Contents/MacOS/agent-commander` is `launcher.sh`,
which probes the port, detaches the server, opens a browser and exits. It
detaches rather than `exec`s because launchd kills the job's process group —
the Node bundle used `node`'s own `spawn()` for that and there is no interpreter
left to borrow, so it forks through `/usr/bin/perl` with a logged
plain-background fallback.

`build-mac-app.py` runs the staged binary with `--help` before promoting the
bundle. That check is why the do-nothing bundles above were caught rather than
shipped, and it is worth keeping whatever else changes.

**It is not covered by any gate.** `npm test` does not touch it, no e2e test
builds it, and `.claude/gates.json` reaches it only through the `scripts/`
watch entry, which triggers the three cheap gates rather than a bundle build.
Build it by hand after changing anything it stages.

## Review agents

Point `harness:qa-bar-raiser` and `harness:ux-bar-raiser` at a `--mock` server on
4400 and never at 4317. Both review only — they never edit code — and both are told to say
"nothing found" plainly rather than pad a list. `README.md` §"Review agents"
lists what they have caught.

## The two documents worth reading in full

- **`ARCHITECTURE.md`** — the module graph, the five planes, what is pushed
  versus polled, and §"Where it is fragile", which is ordered by how quietly
  each thing fails. Trim an entry when it is fixed; the record of trimmed ones
  is §"Fixed since this list was written". §"How it is checked" is the gate
  design.
- **`INVARIANTS.md`** — INV-1 … INV-14, each with the tests that prove it.

`README.md` is for the person using the app. These two are for the person
changing it.

## Commits

- Explain *why*, not just what. The body is where the reasoning goes.
- **Never add a `Co-Authored-By: Claude` or any AI-attribution trailer.**
- Commit or push only when asked.
