#!/usr/bin/env python3
"""
Performance comparison: Node backend vs Rust backend.

Both run in `--mock` mode. That is a deliberate choice and it cuts both ways:
mock mode removes tmux, so these numbers measure *the server itself* rather
than the tmux round trips that dominate real use. That makes the comparison
maximally favourable to Rust — every microsecond it wins here is a microsecond
that, in production, sits behind a ~7 ms tmux round trip.

Report both. A benchmark that flatters one side without saying so is worse
than no benchmark.

Usage:
    python3 scripts/ab-bench.py [--seconds 20] [--samples 5]
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import statistics as st
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NODE_ENTRY = REPO / "dist" / "server" / "cli.js"
RUST_REL = REPO / "rust" / "target" / "release" / "agent-commander"
RUST_DBG = REPO / "rust" / "target" / "debug" / "agent-commander"


def rss_kb(pid: int) -> int | None:
    out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)],
                         capture_output=True, text=True).stdout.strip()
    return int(out) if out.isdigit() else None


def cpu_seconds(pid: int) -> float | None:
    out = subprocess.run(["ps", "-o", "time=", "-p", str(pid)],
                         capture_output=True, text=True).stdout.strip()
    if not out:
        return None
    parts = [float(p) for p in out.split(":")]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return parts[0]


def probe(port: int, path: str = "/api/agents") -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=1):
            return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False


class Backend:
    def __init__(self, label: str, argv: list[str], port: int):
        self.label, self.argv, self.port = label, argv, port
        self.proc: subprocess.Popen | None = None

    def start(self) -> float:
        """Start and return seconds until the first request succeeds."""
        t0 = time.perf_counter()
        self.proc = subprocess.Popen(
            self.argv + ["--mock", "--port", str(self.port)],
            cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            preexec_fn=os.setsid,
        )
        while time.perf_counter() - t0 < 30:
            if probe(self.port):
                return time.perf_counter() - t0
            if self.proc.poll() is not None:
                raise RuntimeError(f"{self.label} exited rc={self.proc.returncode}")
            time.sleep(0.002)
        raise RuntimeError(f"{self.label} never became ready")

    @property
    def pid(self) -> int:
        return self.proc.pid

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
                self.proc.wait(timeout=5)
            except Exception:
                try:
                    os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
                except Exception:
                    pass


def http_latency(port: int, n: int = 600) -> dict:
    """Sequential request latency. Sequential on purpose: this measures
    per-request cost, not how many cores the runtime can saturate."""
    url = f"http://127.0.0.1:{port}/api/agents"
    lat = []
    for _ in range(n):
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                r.read()
        except Exception:
            continue
        lat.append((time.perf_counter() - t0) * 1000)
    lat.sort()
    if not lat:
        return {}
    pick = lambda p: lat[min(len(lat) - 1, int(len(lat) * p))]
    return {
        "n": len(lat), "p50": st.median(lat), "p95": pick(0.95),
        "p99": pick(0.99), "min": lat[0], "max": lat[-1],
        "mean": st.fmean(lat),
    }


def throughput(port: int, seconds: float = 5.0) -> float:
    url = f"http://127.0.0.1:{port}/api/agents"
    end = time.perf_counter() + seconds
    n = 0
    while time.perf_counter() < end:
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                r.read()
            n += 1
        except Exception:
            pass
    return n / seconds


def ws_load(port: int, seconds: int) -> None:
    """Drive a real WebSocket session so the frame path is exercised."""
    script = REPO / "scripts" / "ws-load.mjs"
    subprocess.run(["node", str(script), str(port), str(seconds)],
                   cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   timeout=seconds + 30)


def measure(label: str, argv: list[str], port: int, seconds: int, samples: int) -> dict:
    out: dict = {"label": label}

    # startup, cold-ish, repeated
    starts = []
    for _ in range(samples):
        b = Backend(label, argv, port)
        starts.append(b.start() * 1000)
        b.stop()
        time.sleep(0.3)
    out["startup_ms"] = {"median": st.median(starts), "min": min(starts), "max": max(starts)}

    b = Backend(label, argv, port)
    b.start()
    try:
        time.sleep(2.0)
        out["rss_idle_mb"] = (rss_kb(b.pid) or 0) / 1024

        out["latency_ms"] = http_latency(port)
        out["throughput_rps"] = throughput(port, 5.0)

        c0 = cpu_seconds(b.pid) or 0.0
        r0 = rss_kb(b.pid) or 0
        ws_load(port, seconds)
        c1 = cpu_seconds(b.pid) or 0.0
        r1 = rss_kb(b.pid) or 0

        out["ws_cpu_seconds"] = c1 - c0
        out["ws_cpu_pct_of_core"] = (c1 - c0) / seconds * 100
        out["rss_after_load_mb"] = r1 / 1024
        out["rss_growth_mb"] = (r1 - r0) / 1024

        time.sleep(3)
        out["rss_settled_mb"] = (rss_kb(b.pid) or 0) / 1024
    finally:
        b.stop()
    return out


def fmt(v, unit="", nd=2):
    return f"{v:.{nd}f}{unit}" if isinstance(v, (int, float)) else str(v)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=20)
    ap.add_argument("--samples", type=int, default=5)
    ap.add_argument("--node-port", type=int, default=4511)
    ap.add_argument("--rust-port", type=int, default=4512)
    ap.add_argument("--out", type=str, default=None)
    args = ap.parse_args()

    rust_bin = RUST_REL if RUST_REL.exists() else RUST_DBG
    if not rust_bin.exists():
        print("rust binary missing — cd rust && cargo build --release")
        return 2
    if not NODE_ENTRY.exists():
        print("node entry missing — npm run build:server")
        return 2
    if rust_bin == RUST_DBG:
        print("WARNING: benchmarking a DEBUG rust build; numbers are not meaningful.\n")

    print(f"node: {NODE_ENTRY}")
    print(f"rust: {rust_bin}\n")

    node = measure("node", ["node", str(NODE_ENTRY)], args.node_port, args.seconds, args.samples)
    rust = measure("rust", [str(rust_bin)], args.rust_port, args.seconds, args.samples)

    rows = [
        ("startup to first 200 (median)", lambda d: fmt(d["startup_ms"]["median"], " ms")),
        ("RSS idle", lambda d: fmt(d["rss_idle_mb"], " MB")),
        ("RSS after load", lambda d: fmt(d["rss_after_load_mb"], " MB")),
        ("RSS growth under load", lambda d: fmt(d["rss_growth_mb"], " MB")),
        ("GET /api/agents p50", lambda d: fmt(d["latency_ms"].get("p50", 0), " ms", 3)),
        ("GET /api/agents p95", lambda d: fmt(d["latency_ms"].get("p95", 0), " ms", 3)),
        ("GET /api/agents p99", lambda d: fmt(d["latency_ms"].get("p99", 0), " ms", 3)),
        ("throughput (sequential)", lambda d: fmt(d["throughput_rps"], " req/s", 0)),
        (f"CPU over {args.seconds}s WS streaming", lambda d: fmt(d["ws_cpu_seconds"], " s")),
        ("  as % of one core", lambda d: fmt(d["ws_cpu_pct_of_core"], " %")),
    ]

    w = 34
    print(f"\n{'metric'.ljust(w)} {'node'.rjust(16)} {'rust'.rjust(16)}")
    print("-" * (w + 34))
    for name, get in rows:
        try:
            print(f"{name.ljust(w)} {get(node).rjust(16)} {get(rust).rjust(16)}")
        except Exception as e:
            print(f"{name.ljust(w)} {'n/a'.rjust(16)} {'n/a'.rjust(16)}  ({e})")

    print("\nNote: --mock removes tmux. In production a pane read costs a tmux")
    print("round trip measured at ~6.9 ms on this machine, which both backends")
    print("pay identically and which dwarfs every difference above.")

    if args.out:
        Path(args.out).write_text(json.dumps({"node": node, "rust": rust}, indent=2))
        print(f"\nraw: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
