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
change a CSS transform only; cols and rows never travel back to tmux. That holds
on a phone too: rather than reflowing the agent's pane to a narrow screen, the
view keeps the captured geometry, refuses to scale text below ~9.5px, and pans.
`computeScale` never returns a scale above 1 — the pane is a faithful capture,
not a canvas to stretch.

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
re-submits. A message that is never confirmed is marked *not delivered* rather
than being retried into a live agent — marking is the only response, because
re-sending is the user's decision, not the app's.

"Exactly once" cannot rest on React state. `draft` is read from a closure and
`setDraft('')` does not land until React flushes, so three Enter keydowns
delivered in one batch — key repeat, a double click on Send, input queued behind
a busy main thread — each read the same uncleared draft and each sent it. The
authority is a ref, cleared synchronously, so the second call in the batch finds
it empty. Quick-prompt chips have no draft to clear and a double tap is two
separate tasks, so an identical chip within a second is treated as a mis-tap.

- `test/ui/burst-send.test.tsx` — asserts one send from a burst of three, for
  Enter, for the Send button, and for a double-tapped chip

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
- The quota cache is `stat`-ed every 2s — the cadence the session list already
  runs at — and read only when its mtime has moved. `fs.watch` on its directory
  sits on top of that as a low-latency path, not as the guarantee: on macOS it
  silently drops writes landing within a few ms of the watch being registered,
  which is precisely the "server starts, live session writes" case.

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

- `test/limits.test.ts` — truncated and junk documents parse to `null`; a
  deleted file keeps the last good value

## INV-6 — Guard destructive keys

`Ctrl-C`, `Ctrl-D`, and `Escape` (interrupt) require a confirmation step before
being sent. Sending them to a busy agent discards in-flight work.

## INV-7 — One command shape

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

- `test/spawn.test.ts` — path expansion, absolute-path requirement, refusal of
  files and missing directories, and session-name sanitising
- `test/ui/NewAgentDialog.test.tsx` — a rejected directory surfaces the server's
  reason and leaves the dialog open

## INV-8 — Control actions are guarded and verified

Closing an agent, changing its mode or model, and setting or clearing its goal
all work by typing into that agent's own prompt. A keystroke landing
mid-tool-call would interleave with work in flight, so every one of them
refuses an agent whose status is `busy`. Idle and waiting are allowed — a
waiting agent is precisely the one you may want to redirect.

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

- `test/limits.test.ts` — asserts the entrypoint is wrapped in a catch, that an
  absent `rate_limits` leaves an existing cache intact, and that the bridge and
  `src/server/limits.ts` name the same file
