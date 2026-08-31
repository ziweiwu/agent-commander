#!/usr/bin/env python3
"""Package the built server as a macOS launcher app.

The bundle is a thin wrapper: `Contents/Resources/app` is the npm package, and
`Contents/MacOS/agent-commander` is a shell script that finds a Node, starts
that package's CLI on 4317 and opens a browser at it. Nothing is compiled and
nothing is vendored except `ws`, the server's only runtime dependency.

Four things must be true of the layout or the app fails, and two of them are
invisible until it does:

  1. dist/web beside dist/server      — defaultWebRoot() resolves '../web'
  2. scripts/ two levels above it     — --install-statusline resolves '../../scripts'
  3. dist/shared beside dist/server   — nine files in dist/server import it at runtime
  4. Resources/app/package.json with  — without it Node finds no package.json
     "type": "module"                   anywhere up to /, reads the ESM output as
                                        CommonJS, and dies on the first import
                                        before printing a character

`node cli.js --help` exercises all four at once, which is why this script runs
it against the staged bundle before that bundle is allowed to become the real
one. A bundle that cannot print its own usage line never reaches the target
path.

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
# The launcher must be executable, and defensively so: if git ever loses the
# bit, the app fails to launch with no dialog and no log.
EXECUTABLE_MODE = 0o755
BYTES_PER_KB = 1024
SMOKE_TIMEOUT_S = 30
# Old enough that Finder shows the new icon rather than a cached one.
LSREGISTER = (
    "/System/Library/Frameworks/CoreServices.framework/Frameworks"
    "/LaunchServices.framework/Support/lsregister"
)

# Copied by name rather than as `dist/`, so that pointing --out inside dist/
# could never make the copy recurse into itself.
DIST_PARTS = ("server", "shared", "web")


def fail(message: str, code: int = 1) -> None:
    sys.stderr.write(f"{message}\n")
    raise SystemExit(code)


def run(argv: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, **kwargs)


def version() -> str:
    return json.loads((ROOT / "package.json").read_text())["version"]


def ws_dir() -> Path | None:
    """Where `ws` actually is, which is not always beside us.

    From a clone it is `node_modules/ws` right here. From an npm install the
    package sits at `node_modules/@ziweiwu/agent-commander` and npm hoists `ws`
    to a `node_modules` further up — so this walks the way Node's own resolver
    does rather than assuming the clone's layout.
    """
    for base in [ROOT, *ROOT.parents]:
        candidate = base / "node_modules" / "ws" / "package.json"
        if candidate.exists():
            return candidate.parent
    return None


def layout() -> dict:
    """Every path this build will write, relative to the .app root.

    Returned rather than merely used, so a test can check the four constraints
    above against the plan without needing macOS or a built bundle.
    """
    resources = "Contents/Resources"
    app = f"{resources}/app"
    return {
        "app": APP_NAME,
        "executable": f"Contents/MacOS/{EXECUTABLE}",
        "typeField": "module",
        "paths": [
            "Contents/Info.plist",
            "Contents/PkgInfo",
            f"Contents/MacOS/{EXECUTABLE}",
            f"{resources}/{ICON_STEM}.icns",
            f"{app}/package.json",
            *(f"{app}/dist/{part}" for part in DIST_PARTS),
            f"{app}/scripts/statusline-bridge.mjs",
            f"{app}/node_modules/ws",
        ],
    }


def preflight() -> None:
    if sys.platform != "darwin":
        fail(f"this builds a macOS bundle; you are on {sys.platform}", 2)

    needed = [
        ROOT / "dist" / "server" / "cli.js",
        ROOT / "dist" / "shared",
        ROOT / "dist" / "web" / "index.html",
        ROOT / "scripts" / "statusline-bridge.mjs",
        ROOT / "scripts" / "mac-app" / "launcher.sh",
        ROOT / "scripts" / "mac-app" / "Info.plist",
    ]
    ws = ws_dir()
    if ws is None:
        fail("cannot find node_modules/ws, which the bundle has to carry", 2)

    missing = [p for p in needed if not p.exists()]
    if missing:
        for path in missing:
            sys.stderr.write(f"missing: {path.relative_to(ROOT)}\n")
        # Deliberately not building it here. `npm run build` is one of this
        # project's own gates, and a packager that runs it silently turns a
        # build failure into a packaging failure one layer from the error.
        fail("run `npm run build` first, or use `npm run app`", 2)

    for tool in ("iconutil", "plutil"):
        if shutil.which(tool) is None:
            fail(f"{tool} is not on PATH; install the Xcode Command Line Tools", 2)

    # The bundle copies node_modules/ws on its own rather than resolving a tree.
    # That is only correct while ws has nothing under it.
    meta = json.loads((ws / "package.json").read_text())
    if meta.get("dependencies"):
        fail(
            f"ws {meta['version']} now has dependencies "
            f"{sorted(meta['dependencies'])}; this script copies it alone and "
            f"would ship a tree that cannot resolve them"
        )


def write_wrapper(contents: Path, ver: str) -> None:
    """Everything outside the package: the plist, the type code, the launcher."""
    plist = (ROOT / "scripts" / "mac-app" / "Info.plist").read_text()
    plist = plist.replace(VERSION_TOKEN, ver)
    if VERSION_TOKEN in plist:
        fail(f"{VERSION_TOKEN} survived substitution in Info.plist")
    (contents / "Info.plist").write_text(plist)

    (contents / "PkgInfo").write_text("APPL????")

    launcher = contents / "MacOS" / EXECUTABLE
    shutil.copy2(ROOT / "scripts" / "mac-app" / "launcher.sh", launcher)
    launcher.chmod(EXECUTABLE_MODE)


def write_package(app: Path, ver: str) -> None:
    """The npm package the launcher runs, assembled to satisfy all four of the
    path constraints in this file's docstring."""
    # Generated rather than copied: the repo's own manifest carries
    # devDependencies, a `files` list and a `bin` that all mean something
    # different inside a bundle.
    (app / "package.json").write_text(
        json.dumps(
            {"name": "agent-commander-app", "version": ver, "private": True, "type": "module"},
            indent=2,
        )
        + "\n"
    )

    for part in DIST_PARTS:
        shutil.copytree(ROOT / "dist" / part, app / "dist" / part)
    (app / "scripts").mkdir()
    shutil.copy2(ROOT / "scripts" / "statusline-bridge.mjs", app / "scripts")

    ws = ws_dir()
    if ws is None:
        fail("node_modules/ws vanished between preflight and copy")
    shutil.copytree(ws, app / "node_modules" / "ws")


def assemble(stage: Path, ver: str) -> None:
    contents = stage / "Contents"
    resources = contents / "Resources"
    app = resources / "app"
    (contents / "MacOS").mkdir(parents=True)
    app.mkdir(parents=True)

    write_wrapper(contents, ver)
    write_icon(resources)
    write_package(app, ver)


def write_icon(resources: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / f"{ICON_STEM}.iconset"
        made = run([sys.executable, str(ROOT / "scripts" / "gen-icons.py"), "--iconset", str(iconset)])
        if made.returncode != 0:
            fail(f"gen-icons.py failed:\n{made.stderr}")
        out = run(["iconutil", "-c", "icns", "-o", str(resources / f"{ICON_STEM}.icns"), str(iconset)])
        if out.returncode != 0:
            fail(f"iconutil failed:\n{out.stderr}")


def verify(stage: Path) -> None:
    """Everything that can be checked before this bundle becomes the real one."""
    plist = stage / "Contents" / "Info.plist"
    linted = run(["plutil", "-lint", str(plist)])
    if linted.returncode != 0:
        fail(f"Info.plist is not valid:\n{linted.stdout}{linted.stderr}")

    launcher = stage / "Contents" / "MacOS" / EXECUTABLE
    shebang = launcher.read_text().splitlines()[0]
    interpreter = "bash" if shebang.endswith("bash") else "sh"
    checked = run([interpreter, "-n", str(launcher)])
    if checked.returncode != 0:
        fail(f"the launcher has a syntax error:\n{checked.stderr}")

    cli = stage / "Contents" / "Resources" / "app" / "dist" / "server" / "cli.js"
    node = shutil.which("node")
    if node is None:
        fail("node is not on PATH, so the bundle cannot be smoke-tested")
    smoke = run([node, str(cli), "--help"], timeout=SMOKE_TIMEOUT_S)
    if smoke.returncode != 0 or "agent-commander" not in smoke.stdout:
        fail(
            "the staged bundle cannot print its own usage line, so it would not "
            f"have started:\n{smoke.stdout}{smoke.stderr}"
        )

    # Ad-hoc, so the bundle has a code identity for any permission prompt it
    # raises. Not a real signature: the identity is derived from the contents,
    # so it changes on every rebuild. Never fatal.
    run(["codesign", "--force", "--deep", "--sign", "-", str(stage)])


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
