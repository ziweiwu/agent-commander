//! Starting a new agent.
//!
//! Port of `src/server/spawn.ts`.
//!
//! INV-7: this is the only place the app creates a process. It runs exactly
//! one command shape — `tmux new-session -d -s <generated> -c <validated dir>
//! claude` — with the directory validated first and every value passed as a
//! separate argv entry, never through a shell. The session name is generated
//! here, so nothing user-supplied reaches tmux's argument parser.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::options::{is_model_alias, is_permission_mode, normalize};
use crate::types::NewAgentRequest;

/// Same shape Claude Code uses for its own tmux sessions.
const SESSION_PREFIX: &str = "claude";

/// A directory that is not usable, or a tmux invocation that failed.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct SpawnError(pub String);

/// A model or mode that is not on its allow-list. Separate from [`SpawnError`]
/// because the caller renders it against the field the user chose it in.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct SpawnOptionError(pub String);

/// Either refusal, so one call site can propagate both.
#[derive(Debug, Clone, thiserror::Error)]
pub enum SpawnFailure {
    #[error("{0}")]
    Spawn(#[from] SpawnError),
    #[error("{0}")]
    Option(#[from] SpawnOptionError),
}

impl SpawnFailure {
    /// Both of these are the caller's mistake rather than the server's, and
    /// the new-agent dialog renders a 400 as a reason next to the field.
    pub fn is_client_error(&self) -> bool {
        true
    }
    pub fn message(&self) -> String {
        self.to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnResult {
    pub tmux_session: String,
    pub cwd: String,
}

/// Expand a leading `~` and make the path absolute.
pub fn normalize_dir(input: &str, home: &Path) -> Result<PathBuf, SpawnError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(SpawnError("a directory is required".into()));
    }
    let expanded: PathBuf = if trimmed == "~" {
        home.to_path_buf()
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        normalize(&home.join(rest))
    } else {
        PathBuf::from(trimmed)
    };
    if !expanded.is_absolute() {
        // A relative path would resolve against whatever directory this server
        // happens to have been started in, which is not a thing the user chose.
        return Err(SpawnError("the directory must be an absolute path".into()));
    }
    Ok(normalize(&expanded))
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Reject anything that is not an existing directory before spawning.
pub async fn validate_dir(input: &str, home: &Path) -> Result<PathBuf, SpawnError> {
    let dir = normalize_dir(input, home)?;
    let info = tokio::fs::metadata(&dir)
        .await
        .map_err(|_| SpawnError(format!("no such directory: {}", dir.display())))?;
    if !info.is_dir() {
        return Err(SpawnError(format!("not a directory: {}", dir.display())));
    }
    Ok(dir)
}

/// Everything checked before a process could be created: the directory exists,
/// and the model and mode are on their allow-lists.
///
/// Split out so mock mode can run the identical checks without spawning —
/// INV-7 promises that the failure a user sees in `--mock` is the failure they
/// would get for real, and that only holds if it is the same code.
///
/// Returns the resolved directory, because validating it and resolving it are
/// the same operation and the caller needs the result.
pub async fn check_spawn_request(req: &NewAgentRequest) -> Result<PathBuf, SpawnFailure> {
    // The directory is checked first, so a bad path is reported as a bad path
    // rather than as whatever the next check happens to dislike.
    let cwd = validate_dir(&req.cwd, &home_dir()).await?;
    if let Some(model) = req.model.as_deref() {
        if !is_model_alias(model) {
            return Err(SpawnOptionError(format!("unknown model: {model}")).into());
        }
    }
    if let Some(mode) = req.permission_mode.as_deref() {
        if !is_permission_mode(mode) {
            return Err(SpawnOptionError(format!("unknown permission mode: {mode}")).into());
        }
    }
    Ok(cwd)
}

/// Generated, not user-supplied.
///
/// A tmux session name containing `:` or `.` would collide with tmux's own
/// target syntax, and anything else in it would be a value the user chose
/// reaching a program that parses its arguments. Everything outside
/// `[A-Za-z0-9-]` is dropped rather than escaped, because there is no escaping
/// to get wrong if the characters are simply not there.
pub fn session_name(now: i64, suffix: &str) -> String {
    let clean: String = suffix
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(24)
        .collect();
    if clean.is_empty() {
        format!("{SESSION_PREFIX}-{now}")
    } else {
        format!("{SESSION_PREFIX}-{now}-{clean}")
    }
}

/// The exact argv `start_agent` would run, built and returned rather than
/// executed.
///
/// Pulled out so INV-7's promise — one command shape, every value its own
/// entry, nothing free-text becoming a flag — is a thing a test can read back
/// instead of a thing a comment claims.
pub fn spawn_argv(session: &str, cwd: &Path, req: &NewAgentRequest, claude_bin: &str) -> Vec<String> {
    let mut argv: Vec<String> = vec![
        "new-session".into(),
        "-d".into(),
        "-s".into(),
        session.to_string(),
        "-c".into(),
        cwd.to_string_lossy().into_owned(),
        claude_bin.to_string(),
    ];
    // INV-7: every value is its own argv entry, and model and mode were checked
    // against fixed allow-lists above, so nothing free-text becomes a flag.
    if let Some(name) = req.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        argv.push("-n".into());
        argv.push(name.to_string());
    }
    if let Some(model) = req.model.as_deref().filter(|s| !s.is_empty()) {
        argv.push("--model".into());
        argv.push(model.to_string());
    }
    if let Some(mode) = req.permission_mode.as_deref().filter(|s| !s.is_empty()) {
        argv.push("--permission-mode".into());
        argv.push(mode.to_string());
    }
    argv
}

async fn tmux(args: &[String]) -> Result<String, SpawnError> {
    // No shell. `Command` execs tmux directly, so there is no lexer between
    // these strings and tmux's own argument list.
    let run = tokio::process::Command::new("tmux")
        .args(args)
        .kill_on_drop(true)
        .output();
    let out = match tokio::time::timeout(Duration::from_secs(10), run).await {
        Err(_) => return Err(SpawnError("tmux did not answer in time".into())),
        Ok(Err(e)) => return Err(SpawnError(e.to_string())),
        Ok(Ok(out)) => out,
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(SpawnError(if stderr.is_empty() {
            format!("tmux exited with {}", out.status)
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Create a detached tmux session running `claude` in the chosen directory.
///
/// The new process registers itself in ~/.claude/sessions, so it appears in
/// the fleet on the next refresh without this module having to tell anyone —
/// with `pending.rs` covering the gap until it does.
pub async fn start_agent(
    req: &NewAgentRequest,
    now: i64,
    claude_bin: Option<&str>,
) -> Result<SpawnResult, SpawnFailure> {
    let cwd = check_spawn_request(req).await?;
    let session = session_name(now, req.name.as_deref().unwrap_or(""));
    let argv = spawn_argv(&session, &cwd, req, claude_bin.unwrap_or("claude"));
    tmux(&argv).await?;
    Ok(SpawnResult { tmux_session: session, cwd: cwd.to_string_lossy().into_owned() })
}

/* ------------------------------------------------------------------ tests */

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/Users/tester";

    fn home() -> PathBuf {
        PathBuf::from(HOME)
    }

    fn req(cwd: &str) -> NewAgentRequest {
        NewAgentRequest {
            cwd: cwd.into(),
            name: None,
            model: None,
            permission_mode: None,
        }
    }

    /* ---- normalize_dir ---- */

    #[test]
    fn expands_a_leading_tilde() {
        assert_eq!(normalize_dir("~", &home()).unwrap(), home());
        assert_eq!(
            normalize_dir("~/Projects/x", &home()).unwrap(),
            PathBuf::from("/Users/tester/Projects/x")
        );
    }

    #[test]
    fn keeps_an_absolute_path() {
        assert_eq!(normalize_dir("/opt/src", &home()).unwrap(), PathBuf::from("/opt/src"));
    }

    #[test]
    fn collapses_traversal_rather_than_passing_it_through() {
        assert_eq!(
            normalize_dir("/opt/src/../other", &home()).unwrap(),
            PathBuf::from("/opt/other")
        );
        assert_eq!(normalize_dir("~/../../etc", &home()).unwrap(), PathBuf::from("/etc"));
    }

    /// A relative path would resolve against the server's working directory,
    /// which is not a directory the user picked.
    #[test]
    fn refuses_a_relative_path() {
        for relative in ["Projects/x", "./x", "../x", "x"] {
            assert!(normalize_dir(relative, &home()).is_err(), "{relative}");
        }
    }

    #[test]
    fn refuses_an_empty_directory() {
        for blank in ["", "   ", "\t"] {
            assert!(normalize_dir(blank, &home()).unwrap_err().0.contains("required"), "{blank:?}");
        }
    }

    /* ---- validate_dir ---- */

    #[tokio::test]
    async fn accepts_a_real_directory() {
        let dir = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(validate_dir(real.to_str().unwrap(), &home()).await.unwrap(), real);
    }

    #[tokio::test]
    async fn refuses_a_path_that_does_not_exist() {
        let err = validate_dir("/definitely/not/here", &home()).await.unwrap_err();
        assert!(err.0.contains("no such directory"), "{err}");
    }

    #[tokio::test]
    async fn refuses_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, "x").unwrap();
        let err = validate_dir(file.to_str().unwrap(), &home()).await.unwrap_err();
        assert!(err.0.contains("not a directory"), "{err}");
    }

    /* ---- session_name ---- */

    /// tmux reads `:` and `.` as target syntax, so a user-supplied name must
    /// never reach it intact.
    #[test]
    fn inv7_strips_everything_tmux_could_read_as_target_syntax() {
        assert_eq!(session_name(1000, "a:b.c"), "claude-1000-abc");
        assert_eq!(session_name(1000, "../../etc"), "claude-1000-etc");
        assert_eq!(session_name(1000, "$(whoami)"), "claude-1000-whoami");
        assert_eq!(session_name(1000, "x; kill-server"), "claude-1000-xkill-server");
        assert_eq!(session_name(1000, "-d -s evil"), "claude-1000--d-sevil");
    }

    #[test]
    fn falls_back_to_a_bare_timestamped_name() {
        assert_eq!(session_name(1000, ""), "claude-1000");
        assert_eq!(session_name(1000, "!!!"), "claude-1000");
        assert_eq!(session_name(1000, "  "), "claude-1000");
        assert_eq!(session_name(1000, "日本語"), "claude-1000");
    }

    #[test]
    fn bounds_the_length() {
        assert_eq!(session_name(1000, &"x".repeat(80)), format!("claude-1000-{}", "x".repeat(24)));
    }

    /// Whatever a name contains, the result is only ever the two characters
    /// tmux cannot misread plus the prefix.
    #[test]
    fn inv7_a_generated_name_is_always_safe_to_hand_tmux() {
        for hostile in ["a:b", "%1", "@2", "a.b", "$(x)", "`x`", "'", "\"", "\n", "\0", "..", "-"] {
            let name = session_name(7, hostile);
            assert!(
                name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
                "{hostile:?} produced {name}"
            );
            assert!(name.starts_with("claude-7"), "{name}");
        }
    }

    /* ---- check_spawn_request ---- */

    #[tokio::test]
    async fn accepts_the_aliases_the_dialog_offers() {
        let dir = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap();
        let path = real.to_str().unwrap();
        for model in ["opus", "sonnet", "haiku", "fable", "opusplan", "default"] {
            let r = NewAgentRequest { model: Some(model.into()), ..req(path) };
            assert_eq!(check_spawn_request(&r).await.unwrap(), real, "{model}");
        }
        for mode in ["default", "acceptEdits", "plan", "bypassPermissions", "auto", "dontAsk"] {
            let r = NewAgentRequest { permission_mode: Some(mode.into()), ..req(path) };
            assert_eq!(check_spawn_request(&r).await.unwrap(), real, "{mode}");
        }
    }

    /// The allow-lists exist so that a free-text field cannot become a flag.
    #[tokio::test]
    async fn inv7_refuses_anything_off_the_allow_list_rather_than_making_it_a_flag() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        for hostile in ["--dangerously-skip-permissions", "-n", "opus --resume", "", "sonnet;x"] {
            let r = NewAgentRequest { model: Some(hostile.into()), ..req(path) };
            assert!(
                matches!(check_spawn_request(&r).await, Err(SpawnFailure::Option(_))),
                "model {hostile:?}"
            );
            let r = NewAgentRequest { permission_mode: Some(hostile.into()), ..req(path) };
            assert!(
                matches!(check_spawn_request(&r).await, Err(SpawnFailure::Option(_))),
                "mode {hostile:?}"
            );
        }
    }

    #[tokio::test]
    async fn reports_a_missing_directory_before_it_looks_at_the_options() {
        let r = NewAgentRequest { model: Some("nonsense".into()), ..req("/definitely/not/here") };
        let err = check_spawn_request(&r).await.unwrap_err();
        assert!(err.to_string().contains("no such directory"), "{err}");
    }

    /* ---- the one command shape ---- */

    #[test]
    fn inv7_builds_exactly_one_command_shape() {
        let argv =
            spawn_argv("claude-1-x", Path::new("/w"), &req("/w"), "claude");
        assert_eq!(argv, ["new-session", "-d", "-s", "claude-1-x", "-c", "/w", "claude"]);
    }

    #[test]
    fn inv7_every_value_is_its_own_argv_entry() {
        let r = NewAgentRequest {
            cwd: "/w".into(),
            name: Some("  my agent  ".into()),
            model: Some("opus".into()),
            permission_mode: Some("plan".into()),
        };
        let argv = spawn_argv("claude-1", Path::new("/w"), &r, "claude");
        assert_eq!(
            argv,
            [
                "new-session",
                "-d",
                "-s",
                "claude-1",
                "-c",
                "/w",
                "claude",
                "-n",
                "my agent",
                "--model",
                "opus",
                "--permission-mode",
                "plan",
            ]
        );
        // Nothing is ever concatenated into one string, so there is no quoting
        // rule to get wrong.
        assert!(argv.iter().all(|a| !a.contains('\n')));
    }

    /// A name is the one free-text value that still reaches argv — as `-n`'s
    /// value, never as a flag of its own, because it is a separate entry.
    #[test]
    fn inv7_a_hostile_name_stays_one_argv_entry() {
        let r = NewAgentRequest {
            cwd: "/w".into(),
            name: Some("--dangerously-skip-permissions".into()),
            ..req("/w")
        };
        let argv = spawn_argv("claude-1", Path::new("/w"), &r, "claude");
        let at = argv.iter().position(|a| a == "-n").unwrap();
        assert_eq!(argv[at + 1], "--dangerously-skip-permissions");
        assert_eq!(argv.len(), at + 2, "nothing follows it that it could modify");
    }

    #[test]
    fn a_blank_name_or_model_adds_no_flag() {
        let r = NewAgentRequest {
            cwd: "/w".into(),
            name: Some("   ".into()),
            model: Some(String::new()),
            permission_mode: Some(String::new()),
        };
        let argv = spawn_argv("claude-1", Path::new("/w"), &r, "claude");
        assert_eq!(argv.len(), 7, "{argv:?}");
    }

    /// INV-7 also promises the mock path fails the way the real one does, and
    /// that only holds because both call `check_spawn_request`.
    #[tokio::test]
    async fn mock_and_real_share_the_same_validation() {
        let r = NewAgentRequest { model: Some("gpt-9".into()), ..req("/definitely/not/here") };
        // Whatever the caller does with the result, the refusal is produced
        // before anything could be spawned.
        assert!(check_spawn_request(&r).await.is_err());
    }
}
