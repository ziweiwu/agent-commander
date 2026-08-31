#!/bin/sh
# Run cargo, wherever rustup put it.
#
# `~/.cargo/bin` is added to PATH by a line in the user's shell profile, so it
# is there in a terminal and absent everywhere else: npm scripts, git hooks, the
# Stop hook that runs this project's gates, and most CI steps all get a
# non-interactive shell that never reads that profile. The first version of the
# Rust gates worked only because the author happened to be exporting PATH by
# hand, which is the kind of thing that passes locally and fails for everyone
# else.
#
# Fails loudly rather than skipping: a lint gate that silently does nothing when
# it cannot find its linter is worse than no gate at all.
set -e

if command -v cargo >/dev/null 2>&1; then
  exec cargo "$@"
fi

for candidate in "${CARGO_HOME:-$HOME/.cargo}/bin/cargo" /usr/local/cargo/bin/cargo; do
  if [ -x "$candidate" ]; then
    exec "$candidate" "$@"
  fi
done

echo "cargo not found — the server is Rust and needs a toolchain to build." >&2
echo "Install one from https://rustup.rs, or set CARGO_HOME if it is elsewhere." >&2
exit 127
