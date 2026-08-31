# The Rust backend — parked

A port of `src/server` to Rust: the same HTTP and WebSocket surface, the same
five planes, the same invariants. 27 source files, ~15,800 lines, 374 passing
tests (`cargo test`).

**It is not part of the app, and this branch is the only place it exists.** The
published package is the TypeScript server; `package.json` has never referenced
anything here.

## Why it is on a branch rather than on main

It reached the point of being a working, tested port and then stopped being
worked on, while the TypeScript server kept moving. Leaving it in the working
tree meant a repository with two servers and no statement about which one was
real — which is the sort of thing that is obvious to whoever wrote it and
opaque to everyone else, including whoever picks the project up in a year.

Deleting it outright would have been a one-way door for two weeks of work that
demonstrably passes its own tests, so it lives here instead: recoverable,
labelled, and out of the way.

## What it is behind

Everything on the main line since it was last touched. At minimum:

- `poll.ts` — the self-pacing loop shared by the registry, the fleet enricher,
  the quota watcher and the per-tab transcript tail
- the WebSocket heartbeat, and idling the fleet enricher when no tab is
  connected
- `PendingStore` telling "tmux could not be reached" from "the session is gone"
- the registry asking the CLI about an unconfirmed session immediately rather
  than at the next 30s reconcile

Anyone reviving this should read `ARCHITECTURE.md` on the main line first and
treat the list above as the beginning of the diff, not the whole of it.

## The A/B tooling

The four scripts that came with it, and which only make sense alongside it:

| Script | What it answers |
|---|---|
| `scripts/ab-bench.py` | how the two backends compare under load |
| `scripts/ab-compare.py` | whether the HTTP responses are byte-identical |
| `scripts/ab-compare-ws.mjs` | whether the WebSocket surface behaves identically, refusals included |
| `scripts/ws-load.mjs` | drives a realistic Attach-view session, for `ab-bench.py` |

All four run both servers in `--mock`, which is what makes the comparison fair:
a frozen clock and a fixed fixture fleet, so a difference between the two
responses is a porting defect rather than the two servers having observed the
world a few milliseconds apart.

## Running it

```
cd rust
cargo test
cargo run --release -- --mock --port 4502
```

`rust/target/` is gitignored; it is 849M of build artefacts.
