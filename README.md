# agent-commander

[![npm](https://img.shields.io/npm/v/@ziweiwu/agent-commander?color=cb3837&logo=npm)](https://www.npmjs.com/package/@ziweiwu/agent-commander)
[![Publish](https://github.com/ziweiwu/agent-commander/actions/workflows/npm-publish.yml/badge.svg)](https://github.com/ziweiwu/agent-commander/actions/workflows/npm-publish.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@ziweiwu/agent-commander)](https://nodejs.org)

A local web dashboard over every Claude Code and Kiro CLI session on your
machine: which one needs you, what each is doing, and a way to answer it, from
a laptop or from a phone.

![The fleet view: agents grouped Needs you, Working and Idle](https://raw.githubusercontent.com/ziweiwu/agent-commander/main/assets/fleet-dark.png)

## What it does

- **One list of every agent**, grouped **Needs you → Working → Idle**, with the
  folder, branch, current activity and delegates on each card.
- **Answer a blocked agent from the Chat tab.** The options are read from the
  agent's own transcript, so every button is a choice the agent actually named.
- **A faithful terminal capture.** The Attach tab shows the real tmux pane and
  never resizes it: it is a capture, not a second terminal. **Earlier output**
  reads back through its scrollback a page at a time, including for a pane
  whose process has exited.
- **What a busy agent is running**, read from the process table: the tool
  process under it and how long it has been going. It is the only account of
  the work an agent that keeps no transcript can give.
- **Steer a running session**: message it, switch model or permission mode,
  set a goal, compact or clear its context, or close it.
- **Notifications** when an agent starts waiting on you, off by default.
- **Works on a phone** over Tailscale. The on-screen keyboard takes the keys
  and nothing else: the message box, the last message and any error stay above
  it.
- **Eight colour schemes**, light and dark, every one audited for contrast, in
  English and 简体中文.

## Install

```sh
npm install -g @ziweiwu/agent-commander
agent-commander                      # serves http://127.0.0.1:4317
```

Or `npx @ziweiwu/agent-commander`. The package ships prebuilt binaries for
macOS (arm64, x64) and Linux (x64, arm64); nothing compiles at install time.
Windows is not supported, because the terminal view is tmux.

**Your agents must run inside tmux.** The terminal view is a capture of the
agent's tmux pane, and every message, answer and keystroke you send goes into
that pane. So start each agent in a tmux session:

```sh
tmux new -s work
claude
```

An agent started outside tmux still appears in the list with its status, and
its Chat tab still shows the conversation, because that is read from the
transcript file rather than from the terminal. It is read-only, though: there
is no Attach tab, and the message box, the quick replies and the answer card
are disabled, since all three deliver by typing into the pane. Agents started
from the **+ New agent** button are put in tmux for you.

From a clone, `npm install && npm start`. On macOS, `npm run app:install`
puts a launcher in `~/Applications`.

### From a phone

```sh
agent-commander --token auto --print-url   # prints the link, token and all
tailscale serve --bg 4317
```

Open the printed link on the phone once. The token becomes a cookie and the
plain address works from then on. The token is required: `tailscale serve`
hands every peer on your tailnet the same name, so the name alone cannot tell
your phone from anything else.

## Use

1. Open <http://127.0.0.1:4317>. Agents that need you are at the top.
2. Tap a card. **Chat** shows the conversation, with an answer card when the
   agent is blocked. **Attach** shows the terminal.
3. The strip above the message box holds the session controls: permission
   mode, model, goal, compact and clear, and a menu of common replies.
4. Press `/` to filter, `↑` `↓` to move, `Enter` to open, `Esc` to close.

Start a new agent with **+ New agent**, and prune sessions you opened and never
used with **Prune**.

## Safety

- **It never resizes a real pane.** The terminal is captured and replayed, not
  attached; your `tmux` layout is untouched.
- **Nothing reaches an agent without a click.** No retries, no replays, and
  every destructive key asks first.
- **Loopback by default.** Binding anything else requires a token, and the
  server answers only same-origin requests, so a page in another tab cannot
  drive your agents.

## More

- [Handbook](https://github.com/ziweiwu/agent-commander/blob/main/docs/HANDBOOK.md)
  — every feature, option and gate, at length.
- [ARCHITECTURE.md](https://github.com/ziweiwu/agent-commander/blob/main/ARCHITECTURE.md)
  — how it is built and where it is fragile.
- [INVARIANTS.md](https://github.com/ziweiwu/agent-commander/blob/main/INVARIANTS.md)
  and [SPEC.md](https://github.com/ziweiwu/agent-commander/blob/main/SPEC.md)
  — what must always hold, and what it is supposed to do.
- [CONTRIBUTING.md](https://github.com/ziweiwu/agent-commander/blob/main/CONTRIBUTING.md)
  — how to work on it.

MIT licensed.
