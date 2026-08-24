#!/usr/bin/env python3
"""
Differential test: is the Rust backend a drop-in for the Node one?

Both servers are started in `--mock` mode, which is the whole reason this is
possible. Mock mode is deterministic — a frozen clock and a fixed fixture
fleet — so any difference between the two responses is a real porting defect
and not the two servers having observed the world a few milliseconds apart.

The React client is the consumer of both, so "compatible" means byte-identical
JSON shapes, not merely "equivalent". A `waitingFor: null` where the Node
server omits the key is a failure here, because the client checks
`!== undefined`.

Usage:
    python3 scripts/ab-compare.py --node-port 4501 --rust-port 4502
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NODE_ENTRY = REPO / "dist" / "server" / "cli.js"
RUST_BIN = REPO / "rust" / "target" / "release" / "agent-commander"
RUST_BIN_DEBUG = REPO / "rust" / "target" / "debug" / "agent-commander"


# --------------------------------------------------------------------------
# process handling
# --------------------------------------------------------------------------

class Server:
    def __init__(self, label: str, argv: list[str], port: int, cwd: Path):
        self.label = label
        self.argv = argv
        self.port = port
        self.cwd = cwd
        self.proc: subprocess.Popen | None = None
        self.log = REPO / f".ab-{label}.log"

    def start(self, extra: list[str] | None = None) -> None:
        # Refuse to run against something already listening here. Without this,
        # a stale server from an earlier run answers the readiness probe, the
        # new server never binds, and every subsequent check silently describes
        # the wrong process — which is exactly how a phantom "node serves the
        # fleet without a token" result appeared.
        if self.ready():
            raise RuntimeError(
                f"port {self.port} is already serving before {self.label} started; "
                "kill the stale process and re-run"
            )
        args = list(self.argv) + ["--mock", "--port", str(self.port)] + (extra or [])
        fh = open(self.log, "wb")
        self.proc = subprocess.Popen(
            args, cwd=self.cwd, stdout=fh, stderr=subprocess.STDOUT,
            preexec_fn=os.setsid,
        )
        for _ in range(120):
            if self.ready():
                return
            if self.proc.poll() is not None:
                raise RuntimeError(
                    f"{self.label} exited early (rc={self.proc.returncode}):\n"
                    + self.log.read_text()[-2000:]
                )
            time.sleep(0.1)
        raise RuntimeError(f"{self.label} did not come up on :{self.port}")

    def ready(self) -> bool:
        # A 401 means the server is up and guarding itself, which is exactly as
        # "ready" as a 200 — this check also runs against --token servers.
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/agents", timeout=1):
                return True
        except urllib.error.HTTPError:
            return True
        except Exception:
            return False

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)


# --------------------------------------------------------------------------
# deep diff
# --------------------------------------------------------------------------

def diff(a, b, path: str = "") -> list[str]:
    """Structural diff. Reports missing keys and null-vs-absent separately,
    because the client distinguishes them."""
    out: list[str] = []
    if type(a) is not type(b) and not (isinstance(a, (int, float)) and isinstance(b, (int, float))):
        return [f"{path or '<root>'}: type {type(a).__name__} vs {type(b).__name__}"]
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            p = f"{path}.{k}" if path else k
            if k not in a:
                out.append(f"{p}: absent in node, present in rust ({b[k]!r})")
            elif k not in b:
                out.append(f"{p}: present in node ({a[k]!r}), absent in rust")
            else:
                out += diff(a[k], b[k], p)
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append(f"{path}: length {len(a)} vs {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            out += diff(x, y, f"{path}[{i}]")
    elif a != b:
        out.append(f"{path}: {a!r} vs {b!r}")
    return out


# --------------------------------------------------------------------------
# http probes
# --------------------------------------------------------------------------

def fetch(port: int, path: str, method: str = "GET", body: dict | None = None,
          headers: dict | None = None) -> tuple[int, object]:
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, raw.decode("utf8", "replace")[:200]
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw.decode("utf8", "replace")[:200]
    except Exception as e:
        return -1, f"{type(e).__name__}: {e}"


# volatile keys: legitimately differ run to run, compared for presence/type only
VOLATILE = {"port", "at", "cliPath", "dnsName", "ip"}


def strip_volatile(obj, keys=VOLATILE):
    if isinstance(obj, dict):
        return {k: ("<volatile>" if k in keys else strip_volatile(v, keys))
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [strip_volatile(v, keys) for v in obj]
    return obj


# --------------------------------------------------------------------------
# the checks
# --------------------------------------------------------------------------

class Results:
    def __init__(self):
        self.rows: list[tuple[str, bool, str]] = []

    def add(self, name: str, ok: bool, detail: str = "") -> None:
        self.rows.append((name, ok, detail))
        mark = "PASS" if ok else "FAIL"
        line = f"  [{mark}] {name}"
        if detail and not ok:
            line += f"\n         {detail}"
        print(line, flush=True)

    @property
    def failed(self) -> int:
        return sum(1 for _, ok, _ in self.rows if not ok)


def compare_json_route(res: Results, node_port: int, rust_port: int, path: str,
                       method: str = "GET", body: dict | None = None) -> None:
    sn, bn = fetch(node_port, path, method, body)
    sr, br = fetch(rust_port, path, method, body)
    label = f"{method} {path}"
    if sn != sr:
        res.add(f"{label} — status", False, f"node {sn} vs rust {sr}")
        return
    res.add(f"{label} — status {sn}", True)
    d = diff(strip_volatile(bn), strip_volatile(br))
    res.add(f"{label} — body", not d, "\n         ".join(d[:12]) if d else "")


def security_matrix(res: Results, node_port: int, rust_port: int, token: str) -> None:
    """INV-3. Both servers were started with --token for this phase."""
    cases = [
        ("no token", {}, "", 401),
        ("token in query", {}, f"?token={token}", 200),
        ("bearer header", {"Authorization": f"Bearer {token}"}, "", 200),
        ("wrong token", {}, "?token=nope", 401),
    ]
    for name, headers, qs, want in cases:
        sn, _ = fetch(node_port, f"/api/agents{qs}", headers=headers)
        sr, _ = fetch(rust_port, f"/api/agents{qs}", headers=headers)
        ok = sn == sr == want
        res.add(f"auth: {name} -> {want}", ok, f"node {sn}, rust {sr}, want {want}")


def origin_matrix(res: Results, node_port: int, rust_port: int) -> None:
    """INV-3 on a TOKENLESS server: cross-origin is refused, loopback is not."""
    cases = [
        ("same-origin loopback", {"Origin": f"http://127.0.0.1:{{port}}"}, 200),
        ("cross-origin evil.example", {"Origin": "http://evil.example"}, 403),
        ("no origin header", {}, 200),
    ]
    for name, headers, want in cases:
        hn = {k: v.replace("{port}", str(node_port)) for k, v in headers.items()}
        hr = {k: v.replace("{port}", str(rust_port)) for k, v in headers.items()}
        sn, _ = fetch(node_port, "/api/agents", headers=hn)
        sr, _ = fetch(rust_port, "/api/agents", headers=hr)
        ok = sn == sr == want
        res.add(f"origin: {name} -> {want}", ok, f"node {sn}, rust {sr}, want {want}")


def traversal_matrix(res: Results, node_port: int, rust_port: int) -> None:
    """Static serving must not escape webRoot.

    A 200 is NOT itself a failure: this is a client-routed SPA, so an unknown
    path correctly falls back to index.html. What matters is that the response
    is never the file being reached for. Asserting `status != 200` instead
    flagged the correct SPA fallback as a traversal — a false alarm that would
    have sent someone hunting a vulnerability that was not there.
    """
    probes = [
        ("/../package.json", '"name"'),
        ("/../../etc/passwd", "root:"),
        ("/..%2fpackage.json", '"name"'),
        ("/assets/../../package.json", '"name"'),
        ("/../../../../../../etc/hosts", "localhost"),
    ]
    for attack, marker in probes:
        sn, bn = fetch(node_port, attack)
        sr, br = fetch(rust_port, attack)
        leaked_n = marker in str(bn)
        leaked_r = marker in str(br)
        ok = sn == sr and not leaked_n and not leaked_r
        detail = f"node {sn} leak={leaked_n}, rust {sr} leak={leaked_r}"
        res.add(f"traversal {attack} contained alike", ok, detail)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--node-port", type=int, default=4501)
    ap.add_argument("--rust-port", type=int, default=4502)
    ap.add_argument("--rust-bin", type=str, default=None)
    args = ap.parse_args()

    rust_bin = Path(args.rust_bin) if args.rust_bin else (
        RUST_BIN if RUST_BIN.exists() else RUST_BIN_DEBUG)
    if not rust_bin.exists():
        print(f"rust binary not found at {rust_bin} — run: cd rust && cargo build --release")
        return 2
    if not NODE_ENTRY.exists():
        print(f"node entry not found at {NODE_ENTRY} — run: npm run build:server")
        return 2

    res = Results()
    token = "differential-test-token"

    # ---- phase 1: tokenless, the default posture ----
    print("\n=== phase 1: tokenless (default posture) ===")
    node = Server("node", ["node", str(NODE_ENTRY)], args.node_port, REPO)
    rust = Server("rust", [str(rust_bin)], args.rust_port, REPO)
    try:
        node.start()
        rust.start()
        compare_json_route(res, args.node_port, args.rust_port, "/api/agents")
        compare_json_route(res, args.node_port, args.rust_port, "/api/env")
        compare_json_route(res, args.node_port, args.rust_port, "/api/dirs")
        origin_matrix(res, args.node_port, args.rust_port)
        traversal_matrix(res, args.node_port, args.rust_port)
        # Control routes. The client sends `{value}` for every action and no
        # body at all for `close` — see `controlAgent` in transport.ts. Getting
        # this shape wrong makes the harness report false differences.
        for action, value in [("mode", "plan"), ("model", "opus"), ("goal", "ship it")]:
            compare_json_route(res, args.node_port, args.rust_port,
                               f"/api/agents/mock-waiting/{action}", "POST", {"value": value})
        # rejection paths must reject identically
        for action, value in [("mode", "not-a-mode"), ("model", "gpt"), ("goal", "x" * 500)]:
            compare_json_route(res, args.node_port, args.rust_port,
                               f"/api/agents/mock-waiting/{action}", "POST", {"value": value})
        # missing body, and an unknown agent
        compare_json_route(res, args.node_port, args.rust_port,
                           "/api/agents/mock-waiting/mode", "POST", {})
        compare_json_route(res, args.node_port, args.rust_port,
                           "/api/agents/does-not-exist/mode", "POST", {"value": "plan"})
    finally:
        node.stop()
        rust.stop()

    # ---- phase 2: with a token ----
    # Fresh ports, not the phase-1 ones. Reusing them meant a phase-1 server
    # that had not yet released its socket left the new server unable to bind,
    # while `ready()` cheerfully probed the *old* tokenless one still listening
    # there — which reported "node answers 200 without a token", a security
    # failure that did not exist.
    print("\n=== phase 2: --token ===")
    tok_node, tok_rust = args.node_port + 20, args.rust_port + 20
    node = Server("node-tok", ["node", str(NODE_ENTRY)], tok_node, REPO)
    rust = Server("rust-tok", [str(rust_bin)], tok_rust, REPO)
    try:
        node.start(["--token", token])
        rust.start(["--token", token])
        security_matrix(res, tok_node, tok_rust, token)
    except RuntimeError as e:
        res.add("token-mode startup", False, str(e)[:300])
    finally:
        node.stop()
        rust.stop()

    print("\n" + "=" * 66)
    total = len(res.rows)
    print(f"  {total - res.failed}/{total} checks agree")
    print("=" * 66)
    return 1 if res.failed else 0


if __name__ == "__main__":
    sys.exit(main())
