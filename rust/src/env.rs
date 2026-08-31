//! Facts about this machine that the help page needs.
//!
//! Port of `src/server/env.ts`.
//!
//! The Tailscale hostname is detected rather than typed in, so the help page can
//! show the address that will actually work instead of a placeholder the user
//! has to translate.
//!
//! Everything in here is best-effort by construction: a missing CLI, a CLI that
//! answers with something we do not understand, or no tmux server at all each
//! resolve to a value the UI can render, never to an error (INV-5).

use crate::types::{ServerEnv, TailscaleEnv};
use async_trait::async_trait;
use std::sync::Arc;
use std::time::Duration;

/// The Mac app keeps its CLI inside the bundle, so it is usually not on PATH.
pub const TAILSCALE_PATHS: &[&str] = &[
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
];

/// How long a probe subprocess gets before it is written off. Matches the
/// 5s `execFile` timeout in `env.ts`.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Running one external command and getting its stdout, or nothing.
///
/// This is the seam the TS version does not have: Node's `execFile` was easy to
/// stub per-test with a module mock, whereas Rust wants the dependency handed
/// in. Every failure mode a caller cares about — binary absent, non-zero exit,
/// timeout, output that is not UTF-8 — collapses to `None`, exactly as the
/// `err ? null : stdout` callback in `env.ts` did. Registry uses the same trait
/// so `claude agents --json` is stubbable too.
#[async_trait]
pub trait CommandRunner: Send + Sync + 'static {
    /// stdout on success, `None` on any failure whatsoever.
    async fn run(&self, bin: &str, args: &[&str], timeout: Duration) -> Option<String>;
}

/// The real thing: fork, wait, give up after `timeout`.
pub struct ExecRunner;

#[async_trait]
impl CommandRunner for ExecRunner {
    async fn run(&self, bin: &str, args: &[&str], timeout: Duration) -> Option<String> {
        let mut cmd = tokio::process::Command::new(bin);
        cmd.args(args)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        let fut = cmd.output();
        // `kill_on_drop` above is what makes the timeout real: dropping the
        // future on elapse reaps the child rather than leaving it parented to
        // the server for the rest of the run.
        let out = tokio::time::timeout(timeout, fut).await.ok()?.ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8(out.stdout).ok()
    }
}

/// The subset of `tailscale status --json` this cares about.
#[derive(serde::Deserialize)]
struct TailscaleStatus {
    #[serde(rename = "BackendState")]
    backend_state: Option<String>,
    #[serde(rename = "Self")]
    self_node: Option<TailscaleSelf>,
}

#[derive(serde::Deserialize)]
struct TailscaleSelf {
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
    #[serde(rename = "TailscaleIPs")]
    ips: Option<Vec<String>>,
}

/// Try each known location in order; the first one that answers with JSON we
/// understand *and* names this machine wins.
pub async fn detect_tailscale(runner: &dyn CommandRunner) -> Option<TailscaleEnv> {
    for bin in TAILSCALE_PATHS {
        let Some(out) = runner.run(bin, &["status", "--json"], PROBE_TIMEOUT).await else {
            continue;
        };
        let Ok(status) = serde_json::from_str::<TailscaleStatus>(&out) else {
            // A CLI that answered but not with JSON we understand; try the next
            // path rather than concluding Tailscale is absent.
            continue;
        };
        let self_node = status.self_node;
        let dns_name = self_node
            .as_ref()
            .and_then(|s| s.dns_name.clone())
            .unwrap_or_default();
        // MagicDNS names come back fully qualified, with the root dot. Nothing
        // downstream wants to render `box.tail1234.ts.net.`.
        let dns_name = dns_name.strip_suffix('.').unwrap_or(&dns_name).to_string();
        // First IPv4: the help page prints it as a fallback the user can type,
        // and a v6 literal would need bracketing in a URL.
        let ip = self_node
            .as_ref()
            .and_then(|s| s.ips.as_ref())
            .and_then(|ips| ips.iter().find(|v| v.contains('.')).cloned())
            .unwrap_or_default();
        if dns_name.is_empty() && ip.is_empty() {
            continue;
        }
        return Some(TailscaleEnv {
            cli_path: (*bin).to_string(),
            dns_name,
            ip,
            // Installed but logged out is a real state, and a different one
            // from not installed: the UI says so instead of hiding the row.
            running: status.backend_state.as_deref() == Some("Running"),
        });
    }
    None
}

/// Is a tmux server reachable at all?
///
/// `env.ts` calls `pane.ts`'s `available()`, which is this same one-shot
/// `display-message`. It is inlined here instead of reaching into `pane` so the
/// probe can be driven by the injected runner in tests — a false answer here
/// only greys out attach and spawn, so degrading beats erroring (INV-5).
pub async fn tmux_available(runner: &dyn CommandRunner) -> bool {
    runner
        .run("tmux", &["display-message", "-p", "ok"], PROBE_TIMEOUT)
        .await
        .is_some()
}

/// Node's `process.platform`, which is what the wire type promises.
///
/// Rust spells these differently (`macos`, `windows`), and the field is a
/// straight passthrough to a client that was written against Node's spelling,
/// so translate rather than leak the difference.
fn node_platform() -> String {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
    .to_string()
}

/// Probed once at startup. None of this changes while the server runs, and the
/// Tailscale probe costs up to four subprocesses, so it is not worth repeating
/// per request.
pub async fn server_env(port: u16) -> ServerEnv {
    server_env_with(port, &ExecRunner).await
}

/// Same, against an injected runner. Split out for tests, which must not depend
/// on a real `tailscale` or a real tmux being installed.
pub async fn server_env_with(port: u16, runner: &dyn CommandRunner) -> ServerEnv {
    // Concurrent, like the `Promise.all` in `env.ts`: the Tailscale walk can
    // cost four failed spawns and there is no reason tmux waits behind it.
    let (tailscale, tmux) = tokio::join!(detect_tailscale(runner), tmux_available(runner));
    ServerEnv {
        tailscale,
        tmux,
        port,
        platform: node_platform(),
    }
}

/// Shared handle to the real runner, for callers that need to keep one.
pub fn exec_runner() -> Arc<dyn CommandRunner> {
    Arc::new(ExecRunner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Records what it was asked to run and replies from a fixed script.
    struct FakeRunner {
        replies: Vec<(&'static str, Option<String>)>,
        calls: Mutex<Vec<String>>,
    }

    impl FakeRunner {
        fn new(replies: Vec<(&'static str, Option<String>)>) -> Self {
            Self { replies, calls: Mutex::new(Vec::new()) }
        }
    }

    #[async_trait]
    impl CommandRunner for FakeRunner {
        async fn run(&self, bin: &str, args: &[&str], _timeout: Duration) -> Option<String> {
            self.calls.lock().unwrap().push(format!("{bin} {}", args.join(" ")));
            self.replies
                .iter()
                .find(|(k, _)| *k == bin)
                .and_then(|(_, v)| v.clone())
        }
    }

    /// A port with no meaning beyond being the one handed in — the test is
    /// that it comes back out unchanged, not that anything listens there.
    const PROBE_PORT: u16 = 4123;

    /// Long enough that a command which is going to answer has answered.
    const AMPLE_TIMEOUT: Duration = Duration::from_secs(5);

    /// Shorter than the `sleep` it is given, so the timeout is what ends the
    /// wait rather than the child finishing.
    const IMPATIENT_TIMEOUT: Duration = Duration::from_millis(150);

    /// A child abandoned on its timeout has to be abandoned promptly, not
    /// merely eventually; this is the outer bound the test holds it to.
    const PROMPTLY: Duration = Duration::from_secs(5);

    const STATUS: &str = r#"{
        "BackendState": "Running",
        "Self": { "DNSName": "box.tail1234.ts.net.", "TailscaleIPs": ["fd7a::1", "100.64.0.1"] }
    }"#;

    #[tokio::test]
    async fn reports_none_when_no_tailscale_cli_answers() {
        let r = FakeRunner::new(vec![]);
        assert!(detect_tailscale(&r).await.is_none());
        // Every candidate path was tried before giving up.
        assert_eq!(r.calls.lock().unwrap().len(), TAILSCALE_PATHS.len());
    }

    #[tokio::test]
    async fn trims_the_root_dot_and_picks_the_v4_address() {
        let r = FakeRunner::new(vec![("tailscale", Some(STATUS.into()))]);
        let ts = detect_tailscale(&r).await.expect("detected");
        assert_eq!(ts.cli_path, "tailscale");
        assert_eq!(ts.dns_name, "box.tail1234.ts.net");
        assert_eq!(ts.ip, "100.64.0.1");
        assert!(ts.running);
    }

    #[tokio::test]
    async fn falls_through_to_the_next_path_when_output_is_not_json() {
        let r = FakeRunner::new(vec![
            ("tailscale", Some("command not found, sort of".into())),
            ("/usr/local/bin/tailscale", Some(STATUS.into())),
        ]);
        let ts = detect_tailscale(&r).await.expect("detected");
        assert_eq!(ts.cli_path, "/usr/local/bin/tailscale");
    }

    /// A CLI that answers but names no machine is no better than no CLI.
    #[tokio::test]
    async fn skips_a_status_with_neither_name_nor_address() {
        let r = FakeRunner::new(vec![("tailscale", Some(r#"{"BackendState":"NoState"}"#.into()))]);
        assert!(detect_tailscale(&r).await.is_none());
    }

    /// Installed but logged out: still reported, with `running` false, because
    /// "no Tailscale" and "Tailscale stopped" are different things to say.
    #[tokio::test]
    async fn reports_a_stopped_backend_rather_than_hiding_it() {
        let json = r#"{"BackendState":"Stopped","Self":{"DNSName":"box.ts.net.","TailscaleIPs":["100.64.0.2"]}}"#;
        let r = FakeRunner::new(vec![("tailscale", Some(json.into()))]);
        let ts = detect_tailscale(&r).await.expect("detected");
        assert!(!ts.running);
        assert_eq!(ts.dns_name, "box.ts.net");
    }

    #[tokio::test]
    async fn tmux_probe_is_false_when_no_server_answers() {
        let r = FakeRunner::new(vec![]);
        assert!(!tmux_available(&r).await);
        assert_eq!(r.calls.lock().unwrap()[0], "tmux display-message -p ok");
    }

    #[tokio::test]
    async fn tmux_probe_is_true_when_the_server_answers() {
        let r = FakeRunner::new(vec![("tmux", Some("ok\n".into()))]);
        assert!(tmux_available(&r).await);
    }

    /// The whole probe degrades to a renderable answer on a bare machine.
    #[tokio::test]
    async fn server_env_degrades_rather_than_erroring() {
        let r = FakeRunner::new(vec![]);
        let env = server_env_with(PROBE_PORT, &r).await;
        assert!(env.tailscale.is_none());
        assert!(!env.tmux);
        assert_eq!(env.port, PROBE_PORT);
        assert!(!env.platform.is_empty());
    }

    /// The client was written against `process.platform`, so the Rust spelling
    /// must never reach the wire.
    #[test]
    fn platform_uses_the_node_spelling() {
        let p = node_platform();
        assert_ne!(p, "macos");
        assert_ne!(p, "windows");
        #[cfg(target_os = "macos")]
        assert_eq!(p, "darwin");
        #[cfg(target_os = "linux")]
        assert_eq!(p, "linux");
    }

    /// The real runner must return `None`, not panic or hang, for a binary that
    /// does not exist — that is the common case on a machine without Tailscale.
    #[tokio::test]
    async fn exec_runner_returns_none_for_a_missing_binary() {
        let r = ExecRunner;
        assert!(r
            .run("definitely-not-a-real-binary-9f3a", &[], Duration::from_secs(2))
            .await
            .is_none());
    }

    /// ...and `None` for a binary that exists but fails.
    #[tokio::test]
    async fn exec_runner_returns_none_on_non_zero_exit() {
        let r = ExecRunner;
        assert!(r.run("false", &[], AMPLE_TIMEOUT).await.is_none());
        assert_eq!(
            r.run("echo", &["hi"], AMPLE_TIMEOUT).await.as_deref(),
            Some("hi\n")
        );
    }

    /// A hung child is abandoned on the timeout rather than stalling startup.
    #[tokio::test]
    async fn exec_runner_gives_up_on_a_slow_child() {
        let r = ExecRunner;
        let started = std::time::Instant::now();
        assert!(r.run("sleep", &["30"], IMPATIENT_TIMEOUT).await.is_none());
        assert!(started.elapsed() < PROMPTLY);
    }
}
