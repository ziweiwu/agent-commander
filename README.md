# agent-commander

See every Claude Code agent on your machine at a glance — status, folder, git
branch, what it's doing right now — and drop into any one of them from the
browser.

Built for the case where you have a dozen `claude` sessions running across
different projects and one of them has been sitting on a permission dialog for
twenty minutes without you noticing.

```
npm install
npm start          # builds the web bundle, then serves on http://127.0.0.1:4317
```

## What it shows

Agents are grouped **Needs you → Working → Idle**, so anything blocked on you is
the first thing on screen. Each card carries the agent's name, status (with the
reason it's blocked, e.g. `waiting · dialog open`), the folder it's scoped to
(`~` when it isn't in a project), its git branch, time since last activity,
output tokens, and a live one-line summary of what it's doing — `Edit:
src/app.ts`, `Task → Rerun the exhaustive sweep`.

Filter with the search box (name, folder, branch, activity or status) or by
clicking a status chip in the header. When an agent starts waiting on you, the
browser tab title becomes `(1) agent-commander`.

Open an agent and you get two tabs:

- **Chat** — the session as a conversation. Your prompts and the agent's replies
  are attributed and grouped like a chat app, with the tool calls each reply
  produced folded underneath it (long runs collapse behind a `6 actions`
  summary). Messages you send appear immediately as *sending…* and settle once
  the agent's transcript confirms them, and a typing indicator shows while it is
  working. `Enter` sends, `Shift+Enter` adds a newline.
- **Attach** — the actual terminal, live. Full keyboard passthrough, so you can
  answer a permission dialog, hit Esc to interrupt, or arrow through a menu.

A blocked agent opens straight onto **Attach** — the only tab that can answer
its dialog — with a banner naming what it's waiting for.

### Keyboard

| Key | Does |
|---|---|
| `/` | focus the filter box |
| `↑` `↓` (or `k` `j`) | move through the agent list |
| `Enter` | open the focused agent |
| `Esc` | close the agent (or clear the filter box) |
| `Enter` / `Shift`+`Enter` | in the message box: send / newline |
| `Shift`+`Esc` | close the agent from inside the terminal, where plain `Esc` belongs to the agent |

## How it works

| Source | Used for |
|---|---|
| `~/.claude/sessions/<pid>.json` | Session list, status, cwd, and the tmux pane id. Read every 2s. |
| `claude agents --json` | Authoritative presence check. Costs ~680ms, so it runs every 30s to reconcile. |
| `~/.claude/projects/*/<sessionId>.jsonl` | The timeline, tailed incrementally by byte offset. |
| `tmux capture-pane` / `send-keys` | The Attach tab, and delivering your input. |

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
```

`--host` is refused without `--token`. This app can type into live agents and
approve their permission prompts, so it will not expose itself to the network
unauthenticated. For access from your phone, run it behind Tailscale:

```
npm run serve -- --host 0.0.0.0 --token auto
```

## Development

```
npm run mock       # fixture agents — safe to iterate against
npm test           # 101 unit tests
npm run typecheck
npm run lint
npm run verify:inv1   # asserts attaching never resizes a real pane (server must be running)
```

`--mock` serves a deliberately awkward fleet: nine agents, five of them sharing
the home directory with auto-generated names, one name too long for its card and
two that have never been prompted. `--mock-transitions` additionally flips the
blocked agent on a timer, so live status changes can be reviewed without waiting
for a real one.
