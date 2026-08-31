#!/bin/sh
#
# Agent Commander — Contents/MacOS/agent-commander
#
# An opener, not a host. It makes sure the server is up, points the browser at
# it, and exits; the server outlives it. That is not a shortcut — a .app whose
# executable is a shell script never links AppKit, so it cannot receive ⌘Q or
# Dock→Quit (both are Apple Events) and cannot complete the Dock's launch
# handshake. Staying in the foreground would mean an icon that bounces forever
# and a Quit that degrades to SIGKILL, skipping the server's own shutdown() and
# leaking its tmux control client and paste staging directory.
#
# POSIX sh rather than the project's usual Python: /usr/bin/python3 is a Command
# Line Tools stub, and on a Mac without them it pops an "install developer
# tools" panel. A launcher whose first act can be an Xcode prompt is not one.
#
# Every system tool is called by absolute path, because this script deliberately
# rewrites PATH and must not be re-pointed by what it just wrote. Only tmux,
# claude and node are looked up *through* PATH — that is the point of it.

set -u

BUNDLE=$(cd "$(/usr/bin/dirname "$0")/../.." && pwd)
APP="$BUNDLE/Contents/Resources/app"
CLI="$APP/dist/server/cli.js"
PORT=4317
URL="http://127.0.0.1:$PORT/"

STATE="$HOME/Library/Application Support/agent-commander"
LOGDIR="$HOME/Library/Logs/agent-commander"
LOG="$LOGDIR/server.log"
PIDFILE="$STATE/server.pid"
PATHCACHE="$STATE/path"

LOG_MAX_BYTES=1048576
READY_TRIES=100
READY_SLEEP=0.2
STOP_TRIES=25
HARVEST_TRIES=60
HARVEST_SLEEP=0.1
MIN_NODE_MAJOR=20
CURL_REFUSED=7

/bin/mkdir -p "$STATE" "$LOGDIR" 2>/dev/null || true

# --- talking to the user -----------------------------------------------------

# Text goes in as arguments, never concatenated into the script: a path with a
# quote in it would otherwise end the string and run as AppleScript.
#
# `activate` targets osascript's own process. Routing through System Events
# would raise an Automation permission prompt from an unsigned bundle, turning
# an error dialog into a permission dialog.
alert() {
  /usr/bin/osascript \
    -e 'on run argv' \
    -e 'activate' \
    -e 'display alert (item 1 of argv) message (item 2 of argv) as critical buttons {"OK"} default button 1' \
    -e 'end run' -- "$1" "$2" >/dev/null 2>&1
}

# Two buttons, the second of which opens a URL. Same argument discipline.
alert_link() {
  choice=$(/usr/bin/osascript \
    -e 'on run argv' \
    -e 'activate' \
    -e 'display alert (item 1 of argv) message (item 2 of argv) as critical buttons {item 3 of argv, "OK"} default button "OK"' \
    -e 'button returned of result' \
    -e 'end run' -- "$1" "$2" "$3" 2>/dev/null) || choice=""
  [ "$choice" = "$3" ] && /usr/bin/open "$4"
  return 0
}

say() { printf '%s\n' "$*" >>"$LOG" 2>/dev/null || true; }

# --- is it already up, and is it ours? ---------------------------------------

PROBE_BODY=""

# 0 ours · 1 nothing listening · 2 something else · 3 ours but token-gated
#
# /api/env rather than /api/agents: it is small, it exists only in this app, and
# it answers only once listen() has succeeded — so the same call serves as both
# the identity check and the readiness check. curl sends no Origin and a
# 127.0.0.1 Host, which is what the server's same-origin gate wants.
probe() {
  raw=$(/usr/bin/curl -sS --max-time 2 -w '\n%{http_code}' "http://127.0.0.1:$PORT/api/env" 2>/dev/null)
  rc=$?
  [ "$rc" -eq "$CURL_REFUSED" ] && return 1
  [ "$rc" -ne 0 ] && return 2
  code=$(printf '%s' "$raw" | /usr/bin/tail -1)
  PROBE_BODY=$(printf '%s' "$raw" | /usr/bin/sed '$d')
  case "$code" in
    200)
      # Two fields, because one is not enough to tell this app from any other
      # JSON on the port. A --mock server cannot be here: the CLI refuses
      # --mock on 4317 before it binds anything.
      case "$PROBE_BODY" in
        *'"port":'"$PORT"*)
          case "$PROBE_BODY" in *'"platform":"darwin"'*) return 0 ;; esac ;;
      esac
      return 2 ;;
    401)
      case "$PROBE_BODY" in *'append ?token='*) return 3 ;; esac
      return 2 ;;
    *) return 2 ;;
  esac
}

# --- replacing a server this app started, after a reinstall -------------------

# Only ever a server *we* started, identified by the pid we wrote down and by
# its command line still naming this bundle.
#
# The narrowness is the point. Something else on 4317 answering /api/env is
# almost certainly a copy started from a terminal or a clone, and killing it
# because a version string differs would be this app reaching outside itself to
# stop somebody's work. It gets opened, not replaced.
ours_to_replace() {
  [ -r "$PIDFILE" ] || return 1
  pid=$(/bin/cat "$PIDFILE" 2>/dev/null) || return 1
  case "$pid" in "" | *[!0-9]*) return 1 ;; esac
  /bin/kill -0 "$pid" 2>/dev/null || return 1
  cmd=$(/bin/ps -o command= -p "$pid" 2>/dev/null) || return 1
  case "$cmd" in *"$BUNDLE"*) return 0 ;; esac
  return 1
}

# Is the bundle's code newer than the server that is running it?
#
# Compared as timestamps rather than as versions, because a version only moves
# on a release: rebuild and reinstall at 0.7.0 all afternoon and every build
# calls itself 0.7.0, so a version check would miss exactly the case that
# happens most. `cli.js` carries the mtime `tsc` gave it, which `copytree`
# preserves through the install, and the pid file is written when the server is
# launched. Code newer than the launch means an install landed underneath a
# server still running what it started with.
stale_running() {
  [ -f "$CLI" ] && [ -f "$PIDFILE" ] || return 1
  built=$(/usr/bin/stat -f %m "$CLI" 2>/dev/null) || return 1
  started=$(/usr/bin/stat -f %m "$PIDFILE" 2>/dev/null) || return 1
  [ "$built" -gt "$started" ]
}

stop_ours() {
  pid=$(/bin/cat "$PIDFILE" 2>/dev/null) || return 1
  say "replacing pid $pid: the app was reinstalled after that server started"
  # SIGTERM only. The server cleans up its tmux control client and its paste
  # staging directory on the way out, and a KILL would skip both.
  /bin/kill -TERM "$pid" 2>/dev/null || return 1
  i=0
  while [ "$i" -lt "$STOP_TRIES" ] && /bin/kill -0 "$pid" 2>/dev/null; do
    /bin/sleep "$READY_SLEEP"
    i=$((i + 1))
  done
  /bin/kill -0 "$pid" 2>/dev/null && return 1
  return 0
}

# --- PATH ---------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }
found_all() { have tmux && have claude && have node; }

login_shell() {
  if [ -n "${SHELL:-}" ] && [ -x "${SHELL:-}" ]; then printf '%s\n' "$SHELL"; return 0; fi
  # SHELL is not always set under launchd, and the directory service knows.
  s=$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" UserShell 2>/dev/null \
        | /usr/bin/sed -n 's/^UserShell: //p')
  if [ -n "$s" ] && [ -x "$s" ]; then printf '%s\n' "$s"; else printf '/bin/zsh\n'; fi
}

# Ask the login shell what its PATH is.
#
# Both -l and -i: -l sources .zprofile, -i sources .zshrc, and version managers
# live in one or the other depending on who set them up. Sentinels bracket the
# payload because an interactive rc file writes prompt escape sequences to
# stdout. `env` rather than echoing $PATH so fish, whose $PATH is a list, still
# yields a colon-joined value. A hard kill ceiling because macOS has no
# timeout(1) and an rc file that blocks would hang the launch forever.
harvest_path() {
  sh_bin=$(login_shell)
  tmp=$(/usr/bin/mktemp -t agent-commander-path) || return 1
  soh=$(printf '\001')
  stx=$(printf '\002')

  "$sh_bin" -lic '/usr/bin/printf "\001"; /usr/bin/env; /usr/bin/printf "\002"' \
      >"$tmp" 2>/dev/null </dev/null &
  hp=$!
  n=0
  while /bin/kill -0 "$hp" 2>/dev/null && [ "$n" -lt "$HARVEST_TRIES" ]; do
    /bin/sleep "$HARVEST_SLEEP"
    n=$((n + 1))
  done
  /bin/kill -0 "$hp" 2>/dev/null && /bin/kill -TERM "$hp" 2>/dev/null
  wait "$hp" 2>/dev/null

  out=$(/bin/cat "$tmp" 2>/dev/null)
  /bin/rm -f "$tmp"
  case "$out" in *"$soh"*"$stx"*) ;; *) return 1 ;; esac
  out=${out#*"$soh"}
  out=${out%%"$stx"*}
  out=$(printf '%s\n' "$out" | /usr/bin/sed -n 's/^PATH=//p' | /usr/bin/head -1)
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}

# Three tiers, cheapest first, because the expensive one is worth avoiding and
# neither tier can do the job alone: a fixed list misses every version-manager
# shim, and a harvested PATH misses a `node` that is defined as a shell
# *function*, which is how the lazy-loading nvm setups do it.
repair_path() {
  PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:$HOME/.local/bin:$HOME/bin:$HOME/.claude/local:$PATH"
  export PATH
  found_all && return 0

  if [ -r "$PATHCACHE" ]; then
    PATH="$PATH:$(/bin/cat "$PATHCACHE")"
    export PATH
    found_all && return 0
  fi

  harvested=$(harvest_path) || return 0
  PATH="$PATH:$harvested"
  export PATH
  printf '%s\n' "$harvested" >"$PATHCACHE" 2>/dev/null || true
}

# --- node ---------------------------------------------------------------------

node_version() {
  [ -x "$1" ] || return 1
  v=$("$1" -v 2>/dev/null) || return 1
  v=${v#v}
  case "$v" in [0-9]*.[0-9]*.[0-9]*) printf '%s\n' "$v" ;; *) return 1 ;; esac
}

# Every plausible node, including ones no PATH will ever mention. nvm publishes
# no shim, and ~/.nvm/alias/default is a text file holding an alias *name*
# rather than a symlink, so resolving it would mean reimplementing nvm's alias
# chain. Enumerating the installs and ranking them is simpler and cannot be
# wrong about which ones exist.
node_candidates() {
  command -v node 2>/dev/null
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/.volta/bin" \
           "$HOME/Library/Application Support/fnm/aliases/default/bin" \
           "$HOME/.fnm/aliases/default/bin" \
           "$HOME/.local/share/mise/shims" "$HOME/.asdf/shims"; do
    [ -x "$d/node" ] && printf '%s\n' "$d/node"
  done
  for n in "${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin/node \
           "$HOME"/.asdf/installs/nodejs/*/bin/node \
           "$HOME"/.local/share/mise/installs/node/*/bin/node \
           /usr/local/n/versions/node/*/bin/node; do
    [ -x "$n" ] && printf '%s\n' "$n"
  done
}

NODE=""
NODE_VERSION=""
BEST=""
BEST_VERSION=""

# Kept out of the ranking loop below on purpose: a `case` whose patterns close
# with `)` inside a `$( )` substitution is where POSIX shells lose track of the
# nesting, and this one has to run inside one.
new_enough() {
  major=${1%%.*}
  case "$major" in
    "" | *[!0-9]*) return 1 ;;
  esac
  [ "$major" -ge "$MIN_NODE_MAJOR" ]
}

# Each candidate is *executed*, not merely stat'd: an asdf or mise shim is a
# shell script that exits non-zero when its manager is not on PATH, and a shim
# that cannot run is not a Node.
choose_node() {
  # A node the user's own PATH already points at wins outright, even if some
  # nvm directory holds a higher version — they chose that one.
  first=$(command -v node 2>/dev/null) || first=""
  if [ -n "$first" ]; then
    v=$(node_version "$first") || v=""
    if [ -n "$v" ] && new_enough "$v"; then
      NODE=$first
      NODE_VERSION=$v
      BEST=$first
      BEST_VERSION=$v
      return 0
    fi
  fi

  ranked=$(node_candidates | while IFS= read -r c; do
    v=$(node_version "$c") && printf '%s\t%s\n' "$v" "$c"
  done | /usr/bin/sort -t. -k1,1n -k2,2n -k3,3n)
  [ -n "$ranked" ] || return 1

  BEST_VERSION=$(printf '%s\n' "$ranked" | /usr/bin/tail -1 | /usr/bin/cut -f1)
  BEST=$(printf '%s\n' "$ranked" | /usr/bin/tail -1 | /usr/bin/cut -f2)

  ok=$(printf '%s\n' "$ranked" | while IFS= read -r line; do
    new_enough "${line%%	*}" && printf '%s\n' "$line"
  done | /usr/bin/tail -1)
  [ -n "$ok" ] || return 1
  NODE_VERSION=${ok%%	*}
  NODE=${ok#*	}
}

# --- logging ------------------------------------------------------------------

rotate_log() {
  [ -f "$LOG" ] || return 0
  size=$(/usr/bin/stat -f %z "$LOG" 2>/dev/null) || size=0
  # Rotated rather than truncated, so the crash that made you look survives the
  # relaunch you did to reproduce it.
  [ "$size" -gt "$LOG_MAX_BYTES" ] && /bin/mv -f "$LOG" "$LOG.1"
  return 0
}

# Most of what anyone will ever need to debug a launch, written before the
# launch: which node, which PATH, and whether the two things the server shells
# out to actually resolved.
write_header() {
  {
    printf '\n=== %s  node %s (%s)\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')" "$NODE_VERSION" "$NODE"
    printf '    bundle=%s\n' "$BUNDLE"
    printf '    PATH=%s\n' "$PATH"
    printf '    tmux=%s claude=%s\n' \
      "$(command -v tmux 2>/dev/null || printf MISSING)" \
      "$(command -v claude 2>/dev/null || printf MISSING)"
  } >>"$LOG" 2>/dev/null || true
}

tail_log() { /usr/bin/tail -n 5 "$LOG" 2>/dev/null; }

# --- the two bare-name shell-outs ---------------------------------------------

# Logged every time, shown once. A dialog on every launch is how an app gets
# dragged to the Trash.
warn_missing() {
  tool=$1
  have "$tool" && return 0
  say "warning: $tool not found on PATH"
  marker="$STATE/warned-$tool"
  [ -e "$marker" ] && return 0
  : >"$marker" 2>/dev/null || true
  case "$tool" in
    tmux)
      alert "Agent Commander could not find tmux" \
"Agent Commander reads your agents, and types into them, through tmux. Without it the fleet will look empty, and Attach and New agent will not work.

Install it with:
    brew install tmux

This is shown once. The server started anyway." ;;
    claude)
      # Worth its own dialog because this failure is completely silent
      # otherwise: the server swallows the error, skips the reconcile, and the
      # fleet quietly accumulates sessions that ended hours ago.
      alert "Agent Commander could not find the claude command" \
"Without it, sessions that have ended are never removed from the fleet, so the list will slowly fill with agents that are gone. Everything else works.

Agent Commander looks on the PATH your login shell gives it. If claude works in Terminal but not here, make sure its directory is added in ~/.zprofile or ~/.zshrc — a shell function or alias cannot be found from here.

This is shown once. The server started anyway." ;;
  esac
}

# --- starting it --------------------------------------------------------------

# Detached through node's own spawn(), which is fork() + setsid() done properly.
#
# It has to be detached: a LaunchServices-opened app is a launchd job, and
# launchd kills what is left of the job's process group when the main process
# exits. `nohup` would not help — it blocks SIGHUP, not that — and macOS ships
# no setsid(1).
#
# The child's argv[1] is the cli.js path, which is what makes the CLI run at
# all: it compares argv[1] against its own realpath and silently does nothing
# when they differ.
spawn_server() {
  # The log is opened once, by the helper, and everything that has anything to
  # say about this launch writes through that one descriptor -- the server's
  # stdout and stderr, and the helper's own failure. The shell deliberately adds
  # no redirect of its own: a second append to a file already open for append is
  # safe but indistinguishable, to a reader or to shellcheck, from the mistake
  # of reading and writing one file in a single pipeline.
  "$NODE" -e '
    const { spawn } = require("node:child_process")
    const fs = require("node:fs")
    const os = require("node:os")
    const fd = fs.openSync(process.argv[2], "a")
    try {
      const child = spawn(process.argv[1], [process.argv[3], "--port", process.argv[4]], {
        detached: true,
        cwd: os.homedir(),
        stdio: ["ignore", fd, fd],
      })
      child.unref()
      process.stdout.write(String(child.pid))
    } catch (err) {
      fs.writeSync(fd, `could not start the server: ${err && err.message}\n`)
      process.exit(1)
    }
  ' "$NODE" "$LOG" "$CLI" "$PORT"
}

READY=0
DIED=0

# The same probe again, because "answers /api/env" is exactly the condition
# under which it is safe to point a browser at it. Reading the banner off
# stdout would be guessing at a format string, and stdout is in the log anyway.
wait_ready() {
  i=0
  while [ "$i" -lt "$READY_TRIES" ]; do
    if ! /bin/kill -0 "$1" 2>/dev/null; then DIED=1; return 0; fi
    if probe; then READY=1; return 0; fi
    /bin/sleep "$READY_SLEEP"
    i=$((i + 1))
  done
}

# --- main ---------------------------------------------------------------------

if [ "$(/usr/bin/id -u)" -eq 0 ]; then
  alert "Do not run Agent Commander as root" \
"It would write root-owned files into ~/.claude and break the sessions you run normally."
  exit 1
fi

if [ ! -f "$CLI" ]; then
  alert "Agent Commander is damaged" \
"dist/server/cli.js is missing from inside the app. Rebuild it with 'npm run app:install'."
  exit 1
fi

probe
case $? in
  0)
    # Ours, and up to date -- or ours but somebody else's copy, which is not
    # this app's to restart. Either way: show it.
    if stale_running && ours_to_replace; then
      if ! stop_ours; then
        alert "Agent Commander could not restart" \
"The running server is an older version than the app, and it did not stop when asked.

It is not being force-quit, because that would leave a tmux control client and a
temporary directory behind. Its log is at ~/Library/Logs/agent-commander/server.log"
        exit 1
      fi
    else
      /usr/bin/open "$URL"
      exit 0
    fi
    ;;
  3) alert "Agent Commander is already running with a token" \
"A copy is listening on port $PORT and asking for a token, so this launcher cannot open it for you.

Use the address that copy printed when it started — it ends in ?token=…"
     exit 0 ;;
  2) alert "Port $PORT is already in use" \
"Something that is not Agent Commander is listening on 127.0.0.1:$PORT.

Find out what, with:
    lsof -nP -iTCP:$PORT -sTCP:LISTEN

Quit it, then open Agent Commander again."
     exit 1 ;;
esac

repair_path

if ! choose_node; then
  if [ -n "$BEST_VERSION" ]; then
    alert_link "Agent Commander needs Node.js $MIN_NODE_MAJOR or newer" \
"The newest Node.js on this Mac is v$BEST_VERSION, at $BEST.

Update it with Homebrew:
    brew upgrade node

or install a newer version, then open Agent Commander again." \
      "Get Node.js" "https://nodejs.org/"
  else
    alert_link "Agent Commander needs Node.js $MIN_NODE_MAJOR or newer" \
"I could not find Node.js on this Mac.

Install it with Homebrew:
    brew install node

then open Agent Commander again." \
      "Get Node.js" "https://nodejs.org/"
  fi
  exit 1
fi

rotate_log
write_header
warn_missing tmux
warn_missing claude

SERVER_PID=$(spawn_server) || SERVER_PID=""
if [ -z "$SERVER_PID" ]; then
  alert "Agent Commander could not start" \
"Node could not launch the server at all. The last thing in the log was:

$(tail_log)

The full log is at ~/Library/Logs/agent-commander/server.log"
  exit 1
fi
printf '%s\n' "$SERVER_PID" >"$PIDFILE" 2>/dev/null || true

wait_ready "$SERVER_PID"

if [ "$READY" -eq 1 ]; then
  /usr/bin/open "$URL"
  exit 0
fi

if [ "$DIED" -eq 1 ]; then
  # Whatever the server actually wrote, rather than a translation of it kept in
  # this file — including "port 4317 is already in use" for the narrow race
  # between the probe above and the bind.
  alert_link "Agent Commander could not start" \
"The server stopped while starting up. The last thing it said was:

$(tail_log)" \
    "Open Log" "$LOG"
  exit 1
fi

alert_link "Agent Commander is taking too long to start" \
"The server has not answered on $URL after 20 seconds. It may still be coming up — try that address in your browser.

The full log is at ~/Library/Logs/agent-commander/server.log" \
  "Open Log" "$LOG"
exit 1
