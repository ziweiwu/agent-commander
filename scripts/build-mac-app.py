#!/usr/bin/env python3
"""Package the built server as a macOS launcher app.

The bundle holds two things: the release binary and the web assets it serves.
`Contents/MacOS/agent-commander` is a shell script that starts that binary
detached on 4317 and opens a browser at it. Nothing is compiled here and
nothing is vendored — the Rust binary carries no interpreter and no runtime
dependencies, and that alone retired three of the four path constraints the
Node bundle was built around:

  * `dist/shared` beside `dist/server`, because nine files under `dist/server`
    imported it at runtime. There is no `dist/server` any more.
  * `Resources/app/package.json` carrying `"type": "module"`, without which
    Node found no package.json anywhere up to `/`, read the ESM output as
    CommonJS and died on the first import before printing a character. Nothing
    in this bundle parses JavaScript.
  * `scripts/` two levels above the entry point, where `--install-statusline`
    resolved the bridge. The binary now walks up from its own location until it
    finds `scripts/statusline-bridge.mjs`, and this bundle deliberately ships
    no copy: a bridge path recorded into ~/.claude/settings.json that points
    inside a .app stops working the moment the app is replaced, so that flag
    belongs to the npm package rather than here.

The fourth survives, and still fails the quiet way:

    the web assets have to be where the server looks for them.

It is satisfied twice over. The launcher passes `--web-root` explicitly, and
that is the mechanism relied on — an argument cannot be invalidated by someone
editing the resolution rules in `rust/src/options.rs`. Underneath it,
`Resources/web` is laid out as a sibling of `Resources/bin` so that
`default_web_root()`'s own `../web` fallback lands on the same directory for
anyone who runs the staged binary by hand.

Running `agent-commander --help` against the staged bundle is still the gate
between a broken app and the target path, but it proves something different
now. Not that a module graph resolves — that the file copied into the bundle
executes at all: right architecture, intact ad-hoc signature, not truncated.
An app that could not print its own usage line has shipped from this repo
before, and looked perfectly well until somebody double-clicked it. The web
root is checked by looking for the file instead, because `--help` exits long
before anything is served.

  build-mac-app.py                 -> build/mac/Agent Commander.app
  build-mac-app.py --install       -> also copy to ~/Applications
  build-mac-app.py --install-system-> also copy to /Applications
  build-mac-app.py --print-layout  -> print the planned layout as JSON, touch nothing
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_NAME = "Agent Commander.app"
EXECUTABLE = "agent-commander"
ICON_STEM = "AppIcon"
DEFAULT_OUT = ROOT / "build" / "mac"
VERSION_TOKEN = "__VERSION__"
SMOKE_TIMEOUT_S = 30
# Owner rwx, everyone else rx — what an executable inside a .app has to be.
EXECUTABLE_MODE = 0o755
BYTES_PER_KB = 1024
# Old enough that Finder shows the new icon rather than a cached one.
LSREGISTER = (
    "/System/Library/Frameworks/CoreServices.framework/Frameworks"
    "/LaunchServices.framework/Support/lsregister"
)

BINARY = ROOT / "rust" / "target" / "release" / EXECUTABLE
WEB_BUILD = ROOT / "dist" / "web"
MAC_APP = ROOT / "scripts" / "mac-app"

# Inside the bundle. `bin` and `web` are siblings deliberately; see the header.
RESOURCES = "Contents/Resources"
LAUNCHER_IN_BUNDLE = f"Contents/MacOS/{EXECUTABLE}"
BINARY_IN_BUNDLE = f"{RESOURCES}/bin/{EXECUTABLE}"
WEB_IN_BUNDLE = f"{RESOURCES}/web"


def fail(message: str, code: int = 1) -> None:
    sys.stderr.write(f"{message}\n")
    raise SystemExit(code)


def run(argv: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, **kwargs)


def version() -> str:
    return json.loads((ROOT / "package.json").read_text())["version"]


def layout() -> dict:
    """Every path this build will write, relative to the .app root.

    Returned rather than merely used, so the surviving constraint can be read
    off the plan without macOS and without a built bundle.
    """
    return {
        "app": APP_NAME,
        "executable": LAUNCHER_IN_BUNDLE,
        "binary": BINARY_IN_BUNDLE,
        "webRoot": WEB_IN_BUNDLE,
        "paths": [
            "Contents/Info.plist",
            "Contents/PkgInfo",
            LAUNCHER_IN_BUNDLE,
            f"{RESOURCES}/{ICON_STEM}.icns",
            BINARY_IN_BUNDLE,
            f"{WEB_IN_BUNDLE}/index.html",
        ],
    }


def preflight() -> None:
    if sys.platform != "darwin":
        fail(f"this builds a macOS bundle; you are on {sys.platform}", 2)

    needed = [
        BINARY,
        WEB_BUILD / "index.html",
        MAC_APP / "launcher.sh",
        MAC_APP / "Info.plist",
        ROOT / "scripts" / "gen-icons.py",
    ]
    missing = [path for path in needed if not path.exists()]
    if missing:
        for path in missing:
            sys.stderr.write(f"missing: {path.relative_to(ROOT)}\n")
        # Deliberately not building it here. `npm run build` is one of this
        # project's own gates, and a packager that runs it silently turns a
        # build failure into a packaging failure one layer from the error.
        fail("run `npm run build` first", 2)

    for tool in ("iconutil", "plutil"):
        if shutil.which(tool) is None:
            fail(f"{tool} is not on PATH; install the Xcode Command Line Tools", 2)


def check_out_dir(out: Path) -> None:
    """Refuse an `--out` under dist/web, which the assets copy would recurse into."""
    resolved = out.resolve()
    if WEB_BUILD.resolve() in (resolved, *resolved.parents):
        fail(f"--out must not be inside {WEB_BUILD.relative_to(ROOT)}", 2)


def assemble(stage: Path, ver: str) -> None:
    contents = stage / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    resources = contents / "Resources"
    (resources / "bin").mkdir(parents=True)

    plist = (MAC_APP / "Info.plist").read_text().replace(VERSION_TOKEN, ver)
    if VERSION_TOKEN in plist:
        fail(f"{VERSION_TOKEN} survived substitution in Info.plist")
    (contents / "Info.plist").write_text(plist)

    (contents / "PkgInfo").write_text("APPL????")

    launcher = stage / LAUNCHER_IN_BUNDLE
    shutil.copy2(MAC_APP / "launcher.sh", launcher)
    # Defensively, not decoratively: if git ever loses the bit, the app fails to
    # launch with no dialog and no log.
    launcher.chmod(EXECUTABLE_MODE)

    binary = stage / BINARY_IN_BUNDLE
    shutil.copy2(BINARY, binary)
    binary.chmod(EXECUTABLE_MODE)

    shutil.copytree(WEB_BUILD, stage / WEB_IN_BUNDLE)
    write_icon(resources)


def write_icon(resources: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / f"{ICON_STEM}.iconset"
        made = run([sys.executable, str(ROOT / "scripts" / "gen-icons.py"), "--iconset", str(iconset)])
        if made.returncode != 0:
            fail(f"gen-icons.py failed:\n{made.stderr}")
        out = run(["iconutil", "-c", "icns", "-o", str(resources / f"{ICON_STEM}.icns"), str(iconset)])
        if out.returncode != 0:
            fail(f"iconutil failed:\n{out.stderr}")


def sign(stage: Path) -> None:
    """Give the bundle a code identity for any permission prompt it raises.

    Ad-hoc, so not a real signature: the identity is derived from the contents
    and changes on every rebuild. Never fatal, and now deliberately *before*
    the smoke test rather than after it — what is being launched is a Mach-O
    binary, and on Apple silicon a signature that is invalid rather than absent
    gets the process killed by the kernel. Signing first means the smoke test
    runs the exact bytes the user will, so a benign codesign failure does not
    stop the build while a lethal one cannot slip past.
    """
    run(["codesign", "--force", "--deep", "--sign", "-", str(stage)])


def smoke_test(stage: Path) -> None:
    printed = run([str(stage / BINARY_IN_BUNDLE), "--help"], timeout=SMOKE_TIMEOUT_S)
    if printed.returncode != 0 or EXECUTABLE not in printed.stdout:
        fail(
            "the staged binary cannot print its own usage line, so the app would "
            f"not have started:\n{printed.stdout}{printed.stderr}"
        )


def verify(stage: Path) -> None:
    """Everything that can be checked before this bundle becomes the real one."""
    plist = stage / "Contents" / "Info.plist"
    linted = run(["plutil", "-lint", str(plist)])
    if linted.returncode != 0:
        fail(f"Info.plist is not valid:\n{linted.stdout}{linted.stderr}")

    launcher = stage / LAUNCHER_IN_BUNDLE
    shebang = launcher.read_text().splitlines()[0]
    interpreter = "bash" if shebang.endswith("bash") else "sh"
    checked = run([interpreter, "-n", str(launcher)])
    if checked.returncode != 0:
        fail(f"the launcher has a syntax error:\n{checked.stderr}")

    # The surviving path constraint, checked by hand because `--help` returns
    # before the server has looked for a single asset.
    if not (stage / WEB_IN_BUNDLE / "index.html").is_file():
        fail(f"{WEB_IN_BUNDLE}/index.html is missing; the app would serve nothing")

    sign(stage)
    smoke_test(stage)


def promote(stage: Path, target: Path) -> None:
    """Swap the staged bundle in, leaving no window with a half-built app in it."""
    target.parent.mkdir(parents=True, exist_ok=True)
    previous = target.parent / f".{target.name}.old-{os.getpid()}"
    had_previous = target.exists()
    if had_previous:
        os.replace(target, previous)
    try:
        # os.replace onto a non-empty directory fails, which is why the old one
        # is moved aside first rather than this being a single call.
        os.replace(stage, target)
    except OSError:
        if had_previous:
            os.replace(previous, target)
        raise
    if had_previous:
        shutil.rmtree(previous, ignore_errors=True)
    if Path(LSREGISTER).exists():
        run([LSREGISTER, "-f", str(target)])


def build(out: Path) -> Path:
    preflight()
    check_out_dir(out)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob(f".{APP_NAME}.staging-*"):
        shutil.rmtree(old, ignore_errors=True)

    stage = out / f".{APP_NAME}.staging-{os.getpid()}"
    try:
        assemble(stage, version())
        verify(stage)
        promote(stage, out / APP_NAME)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    return out / APP_NAME


def install(built: Path, into: Path) -> None:
    into.mkdir(parents=True, exist_ok=True)
    stage = into / f".{APP_NAME}.staging-{os.getpid()}"
    shutil.rmtree(stage, ignore_errors=True)
    try:
        shutil.copytree(built, stage, symlinks=True)
        promote(stage, into / APP_NAME)
    except PermissionError:
        shutil.rmtree(stage, ignore_errors=True)
        # Deliberately not escalating. A build script that calls sudo itself is
        # one people stop reading before they approve it.
        fail(
            f"no permission to write {into}. Either install to ~/Applications "
            f"(drop --install-system), or run:\n"
            f"  sudo cp -R '{built}' '{into}/'"
        )
    print(f"installed {into / APP_NAME}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="directory to build into")
    parser.add_argument("--install", action="store_true", help="also copy to ~/Applications")
    parser.add_argument(
        "--install-system", action="store_true", help="also copy to /Applications"
    )
    parser.add_argument(
        "--print-layout", action="store_true", help="print the planned layout and exit"
    )
    args = parser.parse_args()

    # Before anything platform-specific, so a test can read the plan anywhere.
    if args.print_layout:
        print(json.dumps(layout(), indent=2))
        return

    built = build(args.out)
    size = sum(f.stat().st_size for f in built.rglob("*") if f.is_file())
    print(f"built {built} ({size // BYTES_PER_KB} KB)")

    if args.install:
        install(built, Path.home() / "Applications")
    if args.install_system:
        install(built, Path("/Applications"))


if __name__ == "__main__":
    main()
