#!/bin/sh
# Assemble dist/bin/<platform>-<arch>/ from whatever this machine has built.
#
# The release workflow builds each target on its own runner and assembles the
# same layout from downloaded artifacts, so this is not how a publish is made —
# it exists so the layout `launch.mjs` resolves against can be built, packed and
# run on one machine before a tag goes anywhere near the registry.
#
# A cross target lands in rust/target/<target>/release; the host's own build
# lands in rust/target/release with no target directory at all, which is why it
# is copied separately rather than looked up in the table.
set -e

cd "$(dirname "$0")/.."

install_binary() {
  source_path=$1
  platform_directory=$2
  mkdir -p "dist/bin/$platform_directory"
  cp "$source_path" "dist/bin/$platform_directory/agent-commander"
  chmod 755 "dist/bin/$platform_directory/agent-commander"
  echo "dist/bin/$platform_directory/agent-commander"
}

host=$(node -p "process.platform + '-' + process.arch")
if [ -f rust/target/release/agent-commander ]; then
  install_binary rust/target/release/agent-commander "$host"
fi

for pair in \
  aarch64-apple-darwin:darwin-arm64 \
  x86_64-apple-darwin:darwin-x64 \
  x86_64-unknown-linux-gnu:linux-x64 \
  aarch64-unknown-linux-gnu:linux-arm64; do
  built="rust/target/${pair%%:*}/release/agent-commander"
  if [ -f "$built" ]; then
    install_binary "$built" "${pair##*:}"
  fi
done

if [ ! -d dist/bin ]; then
  echo "no binaries found under rust/target — run npm run build:server first" >&2
  exit 1
fi
