#!/usr/bin/env python3
"""Run clippy with two lints ratcheted: they fail only on lines a change touches.

`clippy::arithmetic_side_effects` and `clippy::indexing_slicing` flag every
`a + b` and `v[i]`. Hundreds of such sites predate the lints, and rewriting them
all at once would churn every file for little gain, so this holds new and edited
code to them and leaves untouched code alone. Every other clippy diagnostic
fails the run wherever it is, exactly as `-D warnings` would.

A line counts as touched when it differs from the base: `--base`, else the merge
base with origin's default branch. Uncommitted and untracked files count too.
Files under tests/, benches/, examples/ or fuzz/, and code below a file's
`#[cfg(test)]` module, are exempt from the two ratcheted lints, matching the
allow-*-in-tests settings in clippy.toml.

    python3 scripts/clippy_ratchet.py [--base REF] [--manifest-path PATH] [-- CARGO_ARGS]

Exits 0 when clean, 1 when something must be fixed, 2 when it could not run.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

RATCHETED_LINTS = ("clippy::arithmetic_side_effects", "clippy::indexing_slicing")
EXEMPT_DIRS = {"tests", "benches", "examples", "fuzz"}
BASE_CANDIDATES = ("origin/HEAD", "origin/main", "origin/master", "main", "master")
HUNK_HEADER = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
TEST_MODULE_MARKER = re.compile(r"^\s*#\[cfg\(test\)\]")
MAX_REPORTED = 60
COMMAND_WORDS_SHOWN = 3
STDERR_TAIL_CHARS = 800
EXIT_FINDINGS = 1
EXIT_CANNOT_RUN = 2


class CannotRun(Exception):
    """A tool this script depends on is missing or refused to answer."""


def find_cargo():
    """cargo from PATH, else where rustup puts it: hooks and npm scripts run
    without the shell profile that adds ~/.cargo/bin to PATH."""
    found = shutil.which("cargo")
    if found:
        return found
    home = os.environ.get("CARGO_HOME", os.path.expanduser("~/.cargo"))
    candidate = os.path.join(home, "bin", "cargo")
    if os.access(candidate, os.X_OK):
        return candidate
    raise CannotRun("cargo not found on PATH or in $CARGO_HOME/bin")


def run(command, cwd):
    done = subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=False)
    if done.returncode != 0:
        shown = " ".join(command[:COMMAND_WORDS_SHOWN])
        raise CannotRun(f"{shown} failed: {done.stderr.strip()[-STDERR_TAIL_CHARS:]}")
    return done.stdout


def workspace_root(cargo, manifest_path):
    command = [cargo, "metadata", "--no-deps", "--format-version", "1"]
    if manifest_path:
        command += ["--manifest-path", manifest_path]
    return os.path.realpath(json.loads(run(command, os.getcwd()))["workspace_root"])


def resolve_base(requested, repo):
    candidates = (requested,) if requested else BASE_CANDIDATES
    for ref in candidates:
        command = ["git", "merge-base", "HEAD", ref]
        found = subprocess.run(command, cwd=repo, capture_output=True, text=True, check=False)
        if found.returncode == 0:
            return found.stdout.strip()
    raise CannotRun("no merge base with {}; pass --base REF".format(" or ".join(candidates)))


def added_lines_from_diff(diff_text, repo):
    """{absolute path: set of line numbers} for the + side of a -U0 diff."""
    touched = {}
    current = None
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            name = line[len("+++ "):]
            current = None if name == "/dev/null" else os.path.realpath(os.path.join(repo, name[len("b/"):]))
            continue
        header = HUNK_HEADER.match(line)
        if header and current:
            first = int(header.group(1))
            count = int(header.group(2) or 1)
            touched.setdefault(current, set()).update(range(first, first + count))
    return touched


def untracked_lines(repo):
    listing = run(["git", "ls-files", "--others", "--exclude-standard", "-z"], repo)
    touched = {}
    for name in filter(None, listing.split("\0")):
        path = os.path.realpath(os.path.join(repo, name))
        with open(path, encoding="utf-8", errors="replace") as source:
            touched[path] = set(range(1, sum(1 for _ in source) + 1))
    return touched


def touched_lines(base, repo):
    diff_text = run(["git", "diff", "-U0", "--no-color", "--no-ext-diff", base, "--"], repo)
    touched = added_lines_from_diff(diff_text, repo)
    touched.update(untracked_lines(repo))
    return touched


class TestRegions:
    """Where each file's `#[cfg(test)]` module starts, read once per file."""

    def __init__(self, repo):
        self.repo = repo
        self.marker_lines = {}

    def covers(self, path, line):
        if EXEMPT_DIRS.intersection(os.path.relpath(path, self.repo).split(os.sep)):
            return True
        if path not in self.marker_lines:
            self.marker_lines[path] = self._first_marker(path)
        marker = self.marker_lines[path]
        return marker is not None and line > marker

    @staticmethod
    def _first_marker(path):
        try:
            with open(path, encoding="utf-8", errors="replace") as source:
                lines = source.readlines()
        except OSError:
            return None
        markers = (number for number, text in enumerate(lines, start=1) if TEST_MODULE_MARKER.match(text))
        return next(markers, None)


def clippy_messages(cargo, root, cargo_args):
    command = [cargo, "clippy", "--workspace", "--all-targets", "--message-format=json"]
    command += cargo_args + ["--"] + ["-W" + lint for lint in RATCHETED_LINTS]
    done = subprocess.run(command, cwd=root, capture_output=True, text=True, check=False)
    messages = []
    for line in done.stdout.splitlines():
        if line.startswith("{"):
            record = json.loads(line)
            if record.get("reason") == "compiler-message":
                messages.append(record["message"])
    return messages, done


def primary_span(message):
    for span in message.get("spans", []):
        if span.get("is_primary"):
            return span
    return None


def describe(message, span, root):
    code = (message.get("code") or {}).get("code") or ""
    label = "{}[{}]".format(message["level"], code) if code else message["level"]
    if span is None:
        return "{}: {}".format(label, message["message"])
    path = os.path.relpath(os.path.join(root, span["file_name"]))
    return "{}:{}:{}: {}: {}".format(path, span["line_start"], span["column_start"], label, message["message"])


class Verdicts:
    """Sorts each diagnostic into must-fix or grandfathered."""

    def __init__(self, root, repo, touched):
        self.root = root
        self.touched = touched
        self.tests = TestRegions(repo)
        self.findings = []
        self.grandfathered = set()

    def judge(self, message):
        span = primary_span(message)
        if span is None:
            if message["level"] == "error" and not message["message"].startswith("aborting due to"):
                self.findings.append(describe(message, None, self.root))
            return
        code = (message.get("code") or {}).get("code")
        if code in RATCHETED_LINTS and not self._is_touched(span):
            self.grandfathered.add((span["file_name"], span["line_start"], span["column_start"], code))
            return
        finding = describe(message, span, self.root)
        if finding not in self.findings:
            self.findings.append(finding)

    def _is_touched(self, span):
        path = os.path.realpath(os.path.join(self.root, span["file_name"]))
        line = span["line_start"]
        if self.tests.covers(path, line):
            return False
        return line in self.touched.get(path, ())


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", help="ref to compare against (default: merge base with origin's default branch)")
    parser.add_argument("--manifest-path", help="Cargo.toml of the workspace, if not in the current directory")
    parser.add_argument("cargo_args", nargs="*", help="passed to cargo clippy, after --")
    return parser.parse_args(argv)


def report(verdicts, clippy_run):
    if not verdicts.findings and clippy_run.returncode != 0:
        verdicts.findings.append("cargo clippy failed: " + clippy_run.stderr.strip()[-STDERR_TAIL_CHARS:])
    for finding in verdicts.findings[:MAX_REPORTED]:
        print(finding)
    hidden = len(verdicts.findings) - MAX_REPORTED
    if hidden > 0:
        print(f"... and {hidden} more")
    ratcheted = ", ".join(RATCHETED_LINTS)
    summary = "clippy-ratchet: {} to fix; {} untouched {} sites left alone"
    print(summary.format(len(verdicts.findings), len(verdicts.grandfathered), ratcheted), file=sys.stderr)
    return EXIT_FINDINGS if verdicts.findings else 0


def main(argv):
    args = parse_args(argv)
    try:
        cargo = find_cargo()
        root = workspace_root(cargo, args.manifest_path)
        repo = os.path.realpath(run(["git", "rev-parse", "--show-toplevel"], root).strip())
        touched = touched_lines(resolve_base(args.base, repo), repo)
    except CannotRun as problem:
        print("clippy-ratchet: " + str(problem), file=sys.stderr)
        return EXIT_CANNOT_RUN
    messages, clippy_run = clippy_messages(cargo, root, args.cargo_args)
    verdicts = Verdicts(root, repo, touched)
    for message in messages:
        if message["level"] in ("error", "warning"):
            verdicts.judge(message)
    return report(verdicts, clippy_run)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
