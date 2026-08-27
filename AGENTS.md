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
npm test              # 648 tests: pure logic, server, and React components
npm run build
npm run e2e           # 102 end-to-end tests in a real browser, at three screen shapes
npm run audit         # contrast, a11y, task flows, device layouts — needs a server
npm run qa            # randomised exploration, deterministic per seed
npm run verify:inv1   # attaching never resizes a real pane — server must be running
```

`ARCHITECTURE.md` §"How it is checked" is the table to read before touching any
of them: five gates, each answering a question the others cannot, and the note
on why the last three stay local habits rather than CI gates.

`npm test` and `npm run e2e` run on every push and pull request
(`.github/workflows/ci.yml`). The rest are local.

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
`tokens.css` no longer matches its output.

## Ports, and why there are three

| Port | What runs there |
|---|---|
| 4317 | Production. Real agents. `npm start`, `npm run serve`, the installed binary. |
| 4400 | Development. `npm run dev`, `npm run mock`, and what the audit scripts target. |
| 4500 | `qa-sweep.sh`. |

Never point a fuzzer, an audit or a review agent at 4317. It drives real
agents, and anything that types into whatever it finds will type into someone's
session. `qa-sweep.sh` refuses that port outright and `--mock` on it is rejected.

`npm run mock` serves a deliberately awkward fixture fleet — nine agents, five
sharing a home directory, one name too long for its card, two never prompted.
Because the mock fleet runs the same server, routes and validation as the real
one (`src/server/sources.ts` is the seam), a failure seen in mock mode is the
failure you would get for real.

## The invariant contract

`INVARIANTS.md` numbers every property this app is built against, INV-1 through
INV-12, and each is greppable from a test name:

```sh
npm test -- -t INV-3
```

When you add behaviour worth relying on, add a numbered invariant and a test
carrying its number. When you change behaviour, update the invariant in the same
commit.

## Things that have already bitten

- **`bin` points at compiled output.** Source edits do nothing until
  `npm run build`. Worse: npm installs `bin` as a symlink, so `argv[1]` is the
  symlink and `import.meta.url` is the real `dist/server/cli.js`. Comparing them
  as strings made the CLI conclude it had been imported by a test and never call
  `main()` — every global install from 0.1.0 started a process that produced no
  output, opened no port and reported no error. Compare through `realpathSync`.
- **A token in the URL cannot reach a subresource.** `--token` 401'd the app's
  own bundle, because `index.html`'s `<script>` and `<link>` carry neither the
  token nor a header. `GET`/`HEAD` under `/assets/` skip the token gate and
  nothing else does — so nothing under that prefix may ever serve agent state.
  The same assumption broke the address bar: the router replaces the whole
  location, so navigation has to re-attach the token.
- **A configured token *replaces* the origin gate rather than adding to it**
  (`routes.ts:348`). It is the credential and the exemption from rebinding
  protection at once, and it travels in the query string and is printed to
  stdout. See `ARCHITECTURE.md` §"Where it is fragile" 5 and 5a before touching
  either gate.
- **Development used to default to 4317.** A fixture fleet on the production
  port is indistinguishable from your real one having vanished, and the composer
  on that page types into nothing.
- **`Registry.changed()` does not watch enrichment fields** (`registry.ts:243`).
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
- **`npm test` is flaky under load.** `test/enrich.test.ts` (INV-4 tail counts)
  and `test/scheme.test.ts` (a 5s timeout around spawning `python3`) both fail
  when the machine is busy and pass on a quiet one. A red Stop hook naming only
  those two is worth re-running before believing.

## Review agents

Point `qa-bar-raiser` and `ux-bar-raiser` at a `--mock` server on 4400 and never
at 4317. Both review only — they never edit code — and both are told to say
"nothing found" plainly rather than pad a list. `README.md` §"Review agents"
lists what they have caught.

## The two documents worth reading in full

- **`ARCHITECTURE.md`** — the module graph, the five planes, what is pushed
  versus polled, and §"Where it is fragile", which is ordered by how quietly
  each thing fails. Trim an entry when it is fixed; the record of trimmed ones
  is §"Fixed since this list was written". §"How it is checked" is the gate
  design.
- **`INVARIANTS.md`** — INV-1 … INV-12, each with the tests that prove it.

`README.md` is for the person using the app. These two are for the person
changing it.

## Commits

- Explain *why*, not just what. The body is where the reasoning goes.
- **Never add a `Co-Authored-By: Claude` or any AI-attribution trailer.**
- Commit or push only when asked.
