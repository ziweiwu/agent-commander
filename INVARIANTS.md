# Invariants

Properties that must hold for agent-commander to be safe to leave running.
Each is greppable from a test name: `npm test -- -t INV-3`.

## INV-1 — Never disturb the real terminal

The server must never create a tmux client. It reads with `capture-pane` and
`display-message`, and writes with `send-keys` and `paste-buffer`. It never runs
`attach-session` or `new-session`.

**Why this matters here:** this machine runs tmux with `window-size latest` and
`aggressive-resize on`. A browser client attaching at a different size would
resize the user's live panes mid-work — reflowing a TUI that a working agent is
drawing into. That is why the Attach view is built on frame capture rather than
a pty.

The Attach view is sized *from* the pane's reported geometry. Browser resizes
change a CSS transform only; cols and rows never travel back to tmux.

- `test/safety.test.ts` — asserts `pane.ts` contains no attach/new-session call
- `npm run verify:inv1` — snapshots every tmux client and pane size, runs a real
  attach session, and asserts the snapshot is byte-identical afterwards

## INV-2 — No input without intent

Nothing reaches a live agent except from an explicit user action in the UI. No
retries, no auto-send, no replay of buffered input on reconnect.

Pane ids are validated against `/^%\d+$/` before they reach argv, and control
keys are checked against `ALLOWED_KEYS` server-side — the client's allowlist is
a convenience, not the boundary.

The chat's optimistic echo is display-only. A pending message is drawn
immediately so sending feels instant, but it is sent exactly once; `reconcile()`
only ever *removes* the local copy once the transcript confirms it, and never
re-submits. A message that is never confirmed stays visibly pending rather than
being retried into a live agent.

## INV-3 — Localhost by default

Binds `127.0.0.1`. `--host` is accepted for Tailscale use but is refused without
`--token`, because this app can type into live agents and answer their
permission prompts. `--token auto` generates one.

## INV-4 — Bounded polling cost

- `capture-pane` runs only for the agent currently focused *and* attached.
- Frames that changed no row and moved no cursor are not sent at all.
- Transcript reads are incremental by byte offset; the file is never re-read.
  A day-old transcript is already several MB.
- The session list refreshes from local file reads every 2s. The authoritative
  `claude agents --json` costs ~680ms per call, so it only runs every 30s as a
  reconcile.

## INV-5 — Degrade, don't error

A missing or malformed `~/.claude/sessions/<pid>.json`, an absent `tmux` field, a
dead pane, or an unreadable transcript downgrades one agent's capabilities and
renders a reason. It never removes other agents or takes down the fleet view.

The session file is an internal Claude Code format. If it changes shape, agents
must still list from `claude agents --json` — they simply lose the Attach tab.

## INV-6 — Guard destructive keys

`Ctrl-C`, `Ctrl-D`, and `Escape` (interrupt) require a confirmation step before
being sent. Sending them to a busy agent discards in-flight work.
