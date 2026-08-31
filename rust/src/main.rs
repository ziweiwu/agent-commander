/*
 * Two lint families are allowed crate-wide, each for a stated reason.
 *
 * `dead_code`: this is a port, and several modules keep the shape of the
 * TypeScript they replace — `PaneHub::size`, `Poller::active`,
 * `TmuxControl::stats`, `AgentKindSpec::label` and friends are read by tests,
 * by the web client, or by nothing yet. Deleting them to satisfy the linter
 * would make the two sources harder to diff while the port is still being
 * reviewed against `old-node-backend-branch`, and would quietly drop the
 * accessors a future `/api/stats` needs. Revisit once the TS is out of living
 * memory.
 *
 * `type_complexity`: the six sites are all the same thing — an
 * `Arc<dyn Fn(..) -> Pin<Box<dyn Future<..>>> + Send + Sync>` injection point,
 * which is what a TypeScript callback parameter becomes in Rust. Naming each
 * one would add six aliases that say nothing the signature does not.
 */
#![allow(dead_code)]
#![allow(clippy::type_complexity)]

//! agent-commander — Rust backend.
//!
//! A protocol-compatible port of `src/server/*.ts`. The React client in
//! `dist/web` is the consumer and is served unchanged, so every JSON shape and
//! every route here must match the Node server byte for byte.

mod agent_kinds;
mod browse;
mod control;
mod enrich;
mod env;
mod frames;
mod limits;
mod mock;
mod options;
mod pane;
mod pane_hub;
mod pending;
mod poll;
mod registry;
mod routes;
mod sources;
mod spawn;
mod subagents;
mod tmux_agents;
mod tmux_source;
mod transcript;
mod tmux_client;
mod types;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let opts = match options::parse_args(&argv) {
        Ok(options::Parsed::Options(o)) => o,
        Ok(options::Parsed::Help(text)) | Ok(options::Parsed::Version(text)) => {
            println!("{text}");
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            eprintln!("agent-commander: {e}");
            return ExitCode::from(2);
        }
    };

    // Checked before the server starts, and it always exits — matching
    // `cli.ts`, where this is a one-shot maintenance flag rather than a mode.
    if opts.install_statusline {
        return if install_statusline() { ExitCode::SUCCESS } else { ExitCode::FAILURE };
    }

    // Clear staging directories left by runs that were killed rather than
    // asked to stop, matching `cli.ts:279`. Nothing waits on this: a failure
    // to tidy up is not a reason to refuse to start, and the files are 0600 in
    // the temp root either way.
    if !opts.mock {
        let root = std::env::temp_dir();
        tokio::spawn(async move { pane::sweep_stale_staging(&root).await });
    }

    match routes::serve(opts).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("agent-commander: {e:#}");
            ExitCode::FAILURE
        }
    }
}

/// Locate `scripts/statusline-bridge.mjs`.
///
/// `cli.ts` resolves this two levels up from its own directory, which works
/// because the compiled entry point sits at `dist/server/cli.js` inside the
/// package. A Rust binary has no such fixed relationship to the package — it
/// can be at `rust/target/release/`, in a Homebrew cellar, or anywhere on
/// PATH — so walk up from the executable instead and take the first hit. The
/// script itself is unchanged and still runs under node; the bridge is a
/// Claude Code statusLine command, not part of this binary.
fn find_bridge() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir: &Path = exe.parent()?;
    loop {
        let candidate = dir.join("scripts").join("statusline-bridge.mjs");
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = dir.parent()?;
    }
}

/// Add the quota bridge to `~/.claude/settings.json`.
///
/// Claude Code reports the 5-hour and 7-day windows to a statusLine command
/// and nowhere else, so the dashboard cannot show quota until
/// `scripts/statusline-bridge.mjs` is running as that command. This does the
/// edit rather than leaving the user to hand-merge JSON.
///
/// It never overwrites an existing statusLine. Someone who already has one has
/// put work into it, and silently replacing it would be the worst possible
/// outcome of a flag whose name promises only an addition. That case returns
/// false — and therefore exit 1 — exactly as `cli.ts` does, because nothing
/// was installed.
fn install_statusline() -> bool {
    let Some(home) = dirs::home_dir() else {
        eprintln!("cannot determine the home directory");
        return false;
    };
    let settings_path = home.join(".claude").join("settings.json");

    let Some(bridge) = find_bridge() else {
        eprintln!("cannot find the bridge script (scripts/statusline-bridge.mjs)");
        return false;
    };
    let command = format!("node {}", bridge.display());
    let snippet = serde_json::json!({ "type": "command", "command": command });

    let Some(existing) = read_settings(&settings_path, &snippet) else {
        return false;
    };
    let mut settings = existing.entries;

    if settings.contains_key("statusLine") {
        report_existing_statusline(&settings_path, &command);
        return false;
    }

    let backup = settings_path.with_extension("json.bak");
    if existing.file_was_there && !back_up(&settings_path, &backup) {
        return false;
    }
    settings.insert("statusLine".into(), snippet);
    if !write_settings(&settings_path, settings) {
        return false;
    }
    println!(
        "added statusLine to {} (backup at {}).\n\
         Start a new Claude Code session and send one prompt; quota appears once it has an API response.",
        settings_path.display(),
        backup.display()
    );
    true
}

/// Explain why nothing was installed, and how to get the quota anyway.
///
/// Someone who already has a statusLine has put work into it, so the only thing
/// on offer is the command to fold into theirs.
fn report_existing_statusline(settings_path: &Path, command: &str) {
    println!(
        "{} already has a statusLine, which this will not overwrite.\n\
         To bridge quota from it, have your command also run:\n  {command}",
        settings_path.display()
    );
}

/// `settings.json` as it stands, plus whether there was a file there at all.
///
/// The two travel together because the caller needs both and the answer to the
/// second is only trustworthy at the moment the first was read: a first run has
/// no file, an empty object and nothing worth backing up, and those are three
/// consequences of one fact rather than three separate questions to ask the
/// filesystem.
struct ExistingSettings {
    entries: serde_json::Map<String, serde_json::Value>,
    file_was_there: bool,
}

/// Read `~/.claude/settings.json`, or `None` when it must not be written over.
///
/// A missing file is an empty object — the ordinary first-run case. A file that
/// is there but is not a JSON object is somebody's, and this prints the snippet
/// for them to merge by hand rather than replacing what it cannot parse.
fn read_settings(
    settings_path: &Path,
    snippet: &serde_json::Value,
) -> Option<ExistingSettings> {
    if !settings_path.is_file() {
        return Some(ExistingSettings { entries: serde_json::Map::new(), file_was_there: false });
    }
    let text = match std::fs::read_to_string(settings_path) {
        Ok(text) => text,
        Err(e) => {
            eprintln!("cannot read {}: {e}", settings_path.display());
            return None;
        }
    };
    if let Ok(serde_json::Value::Object(entries)) = serde_json::from_str(&text) {
        return Some(ExistingSettings { entries, file_was_there: true });
    }
    eprintln!("{} is not valid JSON — fix it, or add this by hand:", settings_path.display());
    let hint = serde_json::json!({ "statusLine": snippet });
    eprintln!("{}", serde_json::to_string_pretty(&hint).unwrap_or_default());
    None
}

/// Copy the settings aside before touching them. False means the copy failed,
/// and the edit is then abandoned rather than made without a way back.
fn back_up(settings_path: &Path, backup: &Path) -> bool {
    if let Err(e) = std::fs::copy(settings_path, backup) {
        eprintln!("cannot write a backup at {}: {e}", backup.display());
        return false;
    }
    true
}

/// Serialise the edited settings back over the file, creating `~/.claude` if
/// this is the first thing to want it.
fn write_settings(
    settings_path: &Path,
    settings: serde_json::Map<String, serde_json::Value>,
) -> bool {
    if let Some(parent) = settings_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("cannot create {}: {e}", parent.display());
            return false;
        }
    }
    let body = match serde_json::to_string_pretty(&serde_json::Value::Object(settings)) {
        Ok(body) => body,
        Err(e) => {
            eprintln!("cannot serialise settings: {e}");
            return false;
        }
    };
    if let Err(e) = std::fs::write(settings_path, format!("{body}\n")) {
        eprintln!("cannot write {}: {e}", settings_path.display());
        return false;
    }
    true
}
