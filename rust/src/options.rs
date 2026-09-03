//! Allow-lists for the values that reach a command line or a live agent's
//! prompt, plus the argv parsing that stands in front of the whole program.
//!
//! Port of `src/server/options.ts` and the `parseArgs`/`printHelp` half of
//! `src/server/cli.ts`. The two live together here because Rust has no
//! composition-root module the way `cli.ts` is one: `main.rs` is the entry
//! point and it is contract, so the parsing it calls has to live somewhere a
//! test can reach it.
//!
//! The allow-lists are kept free of any dependency on the tmux control surface
//! so `spawn` can validate without pulling `control` in — the same separation
//! `options.ts` exists for.

#![allow(dead_code)]

use std::path::{Component, Path, PathBuf};

/// The lists themselves live in `types.rs`, because the browser offers exactly
/// what this file accepts and a second copy is how those two stop agreeing —
/// the same reason `options.ts` re-exports them from `shared/types.ts` rather
/// than restating them. Drift here is asymmetric and bad both ways: a model the
/// server accepts but no UI offers is invisible, and one the UI offers but the
/// server rejects is a click that turns into a toast.
///
/// What lives here is the *checking* — the part only the server does, and the
/// only part that is load-bearing (INV-7: "model and permission mode are
/// checked against the fixed allow-lists", not "the UI only offers good ones").
#[allow(unused_imports)]
pub use crate::types::{
    is_cyclable_mode, is_model_alias, MODEL_ALIASES, MODE_CYCLE, SPAWN_MODES,
};

/// Modes settable at spawn time, which is a wider list than the cycle: the CLI
/// takes `dontAsk` as a `--permission-mode` flag and never cycles to it, so a
/// session can start there and no Shift+Tab can return to it. Spelled as its
/// own function because that difference is the whole reason both exist, and
/// because `spawn.rs` and `control.rs` must not accidentally share one.
pub fn is_permission_mode(mode: &str) -> bool {
    crate::types::is_spawn_mode(mode)
}

/* ------------------------------------------------------------------ grants */

/// What a credential is allowed to do, as four separable powers.
///
/// One token used to grant all of them: read every transcript, type arbitrary
/// text into any live pane, answer permission prompts, spawn agents, and
/// enumerate the filesystem. Those have wildly different blast radii, and the
/// link saved on a phone is the one most likely to be over-privileged for what
/// it is actually used for.
///
/// Default is everything, so a server nobody has configured behaves exactly as
/// before. `--grant read,respond` is the opt-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grant {
    /// The fleet, transcripts, frames, and what the server is.
    Read,
    /// Answer the question an agent is blocked on. Deliberately not `Drive`:
    /// it is the one thing you open the app on a phone to do.
    Respond,
    /// Arbitrary input — pastes, keystrokes, mode and model changes, `/clear`.
    Drive,
    /// Start new agents, and walk the filesystem to pick where.
    Spawn,
}

impl Grant {
    /// One bit per grant, in declaration order; `Grants` is the set of them.
    fn bit(self) -> u8 {
        1 << (self as u8)
    }

    fn name(self) -> &'static str {
        match self {
            Grant::Read => "read",
            Grant::Respond => "respond",
            Grant::Drive => "drive",
            Grant::Spawn => "spawn",
        }
    }

    const EVERY: [Grant; 4] = [Grant::Read, Grant::Respond, Grant::Drive, Grant::Spawn];

    fn from_name(name: &str) -> Option<Grant> {
        Grant::EVERY.into_iter().find(|g| g.name() == name)
    }
}

/// A set of `Grant`s.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Grants(u8);

impl Grants {
    pub const ALL: Grants = Grants(1 | 2 | 4 | 8);

    pub fn allows(self, grant: Grant) -> bool {
        self.0 & grant.bit() != 0
    }

    /// Parse `read,respond`. Empty or unknown names are refused rather than
    /// ignored: a typo that silently granted nothing would look like the app
    /// being broken, and one that silently granted everything would be worse.
    pub fn parse(raw: &str) -> Result<Grants, String> {
        let mut bits = 0u8;
        for name in raw.split(',') {
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            match Grant::from_name(name) {
                Some(grant) => bits |= grant.bit(),
                None => {
                    let known: Vec<&str> = Grant::EVERY.iter().map(|g| g.name()).collect();
                    return Err(format!("unknown grant: {name} (known: {})", known.join(", ")));
                }
            }
        }
        if bits == 0 {
            return Err("--grant needs at least one of: read, respond, drive, spawn".to_string());
        }
        // `respond`, `drive` and `spawn` all imply reading: every one of them
        // acts on an agent this app had to list first, and a server that let
        // you answer a question you could not see would be a worse thing to
        // hand someone than the whole token.
        Ok(Grants(bits | Grant::Read.bit()))
    }

    /// The names, for a refusal that says what this credential actually has.
    pub fn names(self) -> String {
        let held: Vec<&str> =
            Grant::EVERY.iter().filter(|g| self.allows(**g)).map(|g| g.name()).collect();
        held.join(",")
    }
}

/// The production port, and the only one that ever serves real agents.
///
/// Nothing in development binds it: the npm dev scripts pass a port
/// explicitly, `qa-sweep.sh` refuses it outright, and the audits default
/// elsewhere. Keeping the two apart is what stops a fixture fleet from
/// appearing at the address the real one lives at.
pub const PROD_PORT: u16 = 4317;

/// Where development serves instead. Also what the audit scripts target.
pub const DEV_PORT: u16 = 4400;

/// Hosts that mean "this machine only", and therefore need no token (INV-3).
const LOOPBACK: &[&str] = &["127.0.0.1", "localhost", "::1"];

#[derive(Debug, Clone)]
pub struct Options {
    pub port: u16,
    pub host: String,
    pub token: Option<String>,
    pub mock: bool,
    pub mock_transitions: bool,
    /// `--mock-empty`: the fixture server with no fixtures, so the genuine
    /// zero-agent screen can be looked at. The ordinary mock fleet always has
    /// fourteen, which is why that screen was never on screen before.
    pub mock_empty: bool,
    pub dev: bool,
    pub web_root: String,
    pub browse_root: Option<String>,
    pub install_statusline: bool,
    pub rotate_token: bool,
    /// What this server's credential is allowed to do.
    pub grants: Grants,
    /// Print the token in the startup banner instead of masking it.
    pub print_url: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            port: PROD_PORT,
            host: "127.0.0.1".into(),
            token: None,
            mock: false,
            mock_transitions: false,
            mock_empty: false,
            dev: false,
            web_root: default_web_root(&exe_dir()).to_string_lossy().into_owned(),
            browse_root: None,
            install_statusline: false,
            rotate_token: false,
            grants: Grants::ALL,
            print_url: false,
        }
    }
}

pub enum Parsed {
    Options(Options),
    Help(String),
    /// `--version`: the one question a running binary could not previously be
    /// asked. Compiled in, so it cannot disagree with the binary that prints it.
    Version(String),
}

/* ------------------------------------------------------------------ paths */

/// `path.resolve` — lexical only, exactly like Node's.
///
/// Symlinks are deliberately *not* followed here. `browse` resolves them
/// itself, after this, and does its containment check on the result; doing it
/// in one step would make it impossible to tell "the caller wrote `..`" from
/// "a link pointed out of the root", and INV-9 needs the second answer.
pub fn resolve_path(input: &str) -> PathBuf {
    let raw = Path::new(input);
    let joined = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")).join(raw)
    };
    normalize(&joined)
}

/// Collapse `.` and `..` without touching the filesystem.
pub fn normalize(path: &Path) -> PathBuf {
    let anchored = if path.is_absolute() { Anchored::ToRoot } else { Anchored::Relative };
    let mut out: Vec<std::ffi::OsString> = Vec::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => step_up(&mut out, anchored),
            other => out.push(other.as_os_str().to_os_string()),
        }
    }
    if out.is_empty() {
        return PathBuf::from(".");
    }
    let mut normalized = PathBuf::new();
    for part in out {
        normalized.push(part);
    }
    normalized
}

/// Whether a path had a root above it, which is the whole of what decides
/// where a leading `..` goes.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Anchored {
    ToRoot,
    Relative,
}

/// Collapse one `..` against whatever has been kept so far.
fn step_up(out: &mut Vec<std::ffi::OsString>, anchored: Anchored) {
    match out.last().map(|part| part.as_os_str()) {
        // `..` above the root is the root, the way every path library does
        // it. There is nowhere further up to go.
        Some(part) if part == Component::RootDir.as_os_str() => {}
        Some(part) if part == std::ffi::OsStr::new("..") => out.push("..".into()),
        Some(_) => {
            out.pop();
        }
        // Nothing to pop from: a relative path keeps the `..` to be resolved
        // against wherever it is later joined, an absolute one has already hit
        // its root.
        None if anchored == Anchored::Relative => out.push("..".into()),
        None => {}
    }
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Where the built web assets live, given the directory the program runs from.
///
/// Built assets always live in `dist/web`; what changes is how far away that
/// is. The two TypeScript cases are kept verbatim so the same reasoning is
/// testable from either port, and a third is added for a Cargo target
/// directory, which is where a Rust build actually runs from. Without that
/// third case a `cargo run` would hand the browser `target/web`, which does
/// not exist — the same class of bug as `npm run serve` serving the unbuilt
/// `index.html`.
pub fn default_web_root(here: &Path) -> PathBuf {
    if here.ends_with(Path::new("src/server")) {
        return normalize(&here.join("../../dist/web"));
    }
    if here.ends_with(Path::new("dist/server")) {
        return normalize(&here.join("../web"));
    }
    // `<crate>/target/{debug,release}` — and `target/{profile}/deps` when a
    // test binary is the thing asking. The crate is `rust/`, one below the
    // repo root that holds `dist/web`.
    let in_target = here.parent().is_some_and(|p| p.ends_with("target"));
    if in_target {
        return normalize(&here.join("../../../dist/web"));
    }
    let in_target_deps = here.file_name().is_some_and(|n| n == "deps")
        && here.parent().and_then(Path::parent).is_some_and(|p| p.ends_with("target"));
    if in_target_deps {
        return normalize(&here.join("../../../../dist/web"));
    }
    /*
     * The npm package: `dist/bin/<platform>-<arch>/agent-commander`, with the
     * bundle beside `bin` at `dist/web`.
     *
     * Without this the fall-through below resolves `dist/bin/web`, which does
     * not exist, and the binary starts, binds, prints a URL and answers 404 for
     * `/`. That is the do-nothing install in its third costume, and neither
     * guard in the release pipeline can see it: `--help` returns before
     * anything is served, and the tarball check only proves the files are
     * present. The one directory level is the whole difference.
     */
    let in_packaged_bin = here.parent().is_some_and(|p| p.ends_with("bin"));
    if in_packaged_bin {
        return normalize(&here.join("../../web"));
    }
    normalize(&here.join("../web"))
}

/* ------------------------------------------------------------------- argv */

/// `Number.parseInt(s, 10)` — leading whitespace, an optional sign, then as
/// many digits as there are. Ported literally rather than using `str::parse`
/// so `--port 5000x` behaves the same in both ports; a stricter parser here
/// would be a difference nobody asked for.
fn parse_int_10(text: &str) -> Option<i64> {
    let trimmed = text.trim_start();
    let (neg, rest) = match trimmed.strip_prefix('-') {
        Some(unsigned) => (true, unsigned),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i64>().ok().map(|n| if neg { -n } else { n })
}

/// 128 bits of randomness, printed as the 32 hex characters `--token auto`
/// hands out. Long enough that guessing it is not a strategy.
const TOKEN_BYTES: usize = 16;

pub fn random_token() -> String {
    use rand::Rng;
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::thread_rng().fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Parse argv. Returns the help text rather than printing it, so a test can
/// read it and `main` stays the only thing that writes to a terminal.
pub fn parse_args(argv: &[String]) -> Result<Parsed, String> {
    parse_args_with_token_file(argv, &crate::token_file::token_file())
}

/// `parse_args`, with the token file named rather than assumed.
///
/// The path is a parameter for one reason: `--token auto` reads and writes it,
/// and a test that exercised the real one would mint a token into the running
/// user's home directory and then reuse it on every later run. The seam is
/// narrow on purpose — `parse_args` is still the only entry point anything but
/// a test calls.
pub fn parse_args_with_token_file(argv: &[String], token_path: &Path) -> Result<Parsed, String> {
    let mut opts = Options::default();
    let mut i = 0usize;
    while i < argv.len() {
        let arg = argv[i].as_str();
        let (flag, inline) = split_on_equals(arg);

        let take_value = |i: &mut usize| flag_value(argv, i, flag, inline.clone());

        match flag {
            "--mock" => opts.mock = true,
            "--browse-root" => opts.browse_root = Some(resolved(&take_value(&mut i)?)),
            "--mock-transitions" => {
                opts.mock = true;
                opts.mock_transitions = true;
            }
            "--mock-empty" => {
                opts.mock = true;
                opts.mock_empty = true;
            }
            "--port" | "-p" => opts.port = port_from(&take_value(&mut i)?)?,
            "--host" => opts.host = take_value(&mut i)?,
            "--token" => opts.token = Some(take_value(&mut i)?),
            "--web-root" => opts.web_root = resolved(&take_value(&mut i)?),
            "--install-statusline" => opts.install_statusline = true,
            "--rotate-token" => opts.rotate_token = true,
            "--grant" => opts.grants = Grants::parse(&take_value(&mut i)?)?,
            "--print-url" => opts.print_url = true,
            "--dev" => opts.dev = true,
            "--help" | "-h" => return Ok(Parsed::Help(help_text())),
            "--version" | "-V" => return Ok(Parsed::Version(version_text())),
            _ if arg.starts_with('-') => return Err(format!("unknown flag: {arg}")),
            _ => {}
        }
        i += 1;
    }

    finalise_options(opts, token_path)
}

/// The value for `flag`: `--flag value` and `--flag=value` both, with the same
/// error when the value is simply missing.
fn flag_value(
    argv: &[String],
    i: &mut usize,
    flag: &str,
    inline: Option<String>,
) -> Result<String, String> {
    if let Some(inline_value) = inline {
        return Ok(inline_value);
    }
    *i += 1;
    argv.get(*i).cloned().ok_or_else(|| format!("{flag} needs a value"))
}

/// Split `--flag=value` into its halves. A bare `--flag` has no inline value,
/// and the one after it in argv is then the candidate.
fn split_on_equals(arg: &str) -> (&str, Option<String>) {
    match arg.find('=') {
        Some(at) => (&arg[..at], Some(arg[at + 1..].to_string())),
        None => (arg, None),
    }
}

/// A path a user typed, made absolute and lexically normalised.
fn resolved(value: &str) -> String {
    resolve_path(value).to_string_lossy().into_owned()
}

/// The top of the TCP port range. Zero is excluded deliberately: it means
/// "any free port" to the kernel, and this app prints the port it is on.
const HIGHEST_PORT: i64 = 65535;

fn port_from(raw: &str) -> Result<u16, String> {
    match parse_int_10(raw) {
        Some(n) if (1..=HIGHEST_PORT).contains(&n) => Ok(n as u16),
        // Report what the user actually wrote. `NaN` is what the TypeScript
        // prints for a non-number, and echoing the input back is more use than
        // echoing that.
        _ => Err(format!("invalid port: {raw}")),
    }
}

/// The rules that are about the command line as a whole rather than any one
/// flag, applied once every argument has been read.
fn finalise_options(mut opts: Options, token_path: &Path) -> Result<Parsed, String> {
    refuse_fixtures_on_the_production_port(&opts)?;
    // `auto` means "the token this machine keeps", not "a token for this
    // process". Reading it back is what lets a saved link outlive a restart;
    // see `token_file`. A literal `--token` is left exactly as typed — it is an
    // explicit override, and writing it to disk would be a surprise.
    if opts.token.as_deref() == Some("auto") {
        opts.token = Some(crate::token_file::read_or_create(token_path)?);
    }
    refuse_an_open_bind_without_a_token(&opts)?;
    Ok(Parsed::Options(opts))
}

/*
 * Fixtures must never be served at the address the real fleet lives at.
 * Someone who opens 4317 out of habit and finds nine invented agents has
 * no way to tell that from their own having vanished — and the composer on
 * that page would then be typing into nothing. `qa-sweep.sh` already
 * refuses this port for the same reason; this closes the same hole one
 * level down.
 */
fn refuse_fixtures_on_the_production_port(opts: &Options) -> Result<(), String> {
    if opts.mock && opts.port == PROD_PORT {
        return Err(format!(
            "refusing to serve mock fixtures on {PROD_PORT} -- that is the production port.\n\
             Use --port {DEV_PORT} for development."
        ));
    }
    Ok(())
}

/// INV-3: this app can send input to live agents and answer their permission
/// prompts. An unauthenticated non-loopback bind hands that to anyone who can
/// route to this machine.
fn refuse_an_open_bind_without_a_token(opts: &Options) -> Result<(), String> {
    if !LOOPBACK.contains(&opts.host.as_str()) && opts.token.is_none() {
        return Err(format!(
            "refusing to bind {} without --token.\n\
             This app can send input to live agents and answer their permission prompts.\n\
             Use --token auto to generate one, or --token <secret> to set your own.",
            opts.host
        ));
    }
    Ok(())
}

/// Capital `-V`, because lowercase `-v` reads as "verbose" to everyone who has
/// used a unix tool, and this binary has no verbose mode to confuse it with.
pub fn version_text() -> String {
    format!("agent-commander {}", env!("CARGO_PKG_VERSION"))
}

pub fn help_text() -> String {
    [
        "agent-commander — see and steer every Claude Code agent on this machine".to_string(),
        String::new(),
        "Usage: agent-commander [options]".to_string(),
        String::new(),
        format!("  -p, --port <n>     port to listen on (default {PROD_PORT})"),
        "      --host <addr>  bind address (default 127.0.0.1; requires --token if not loopback)"
            .to_string(),
        "      --token <s>    require this token; \"auto\" uses the stored one".to_string(),
        "      --rotate-token  replace the stored token and exit".to_string(),
        "      --grant <list>  limit what is allowed: read,respond,drive,spawn (default: all)"
            .to_string(),
        "      --print-url    print the full URL, token and all, then keep serving".to_string(),
        "      --mock         serve fixture agents, touching nothing real".to_string(),
        "      --mock-transitions  like --mock, but statuses change on a timer".to_string(),
        "      --mock-empty   like --mock, with no agents at all".to_string(),
        "      --browse-root <d>  root the folder picker is confined to (default: home)"
            .to_string(),
        "      --install-statusline  add the quota bridge to ~/.claude/settings.json and exit"
            .to_string(),
        "      --web-root <d> directory of built web assets".to_string(),
        "  -V, --version      show the version and exit".to_string(),
        "  -h, --help         show this help".to_string(),
        String::new(),
    ]
    .join("\n")
}

/* ------------------------------------------------------------------ tests */

#[cfg(test)]
mod tests {
    use super::*;

    /// An arbitrary port that is neither the production nor the development
    /// one, so a test can tell which `--port` flag won.
    const LATER_PORT: u16 = 4501;

    /// The two spellings of `--port` are given different values so a passing
    /// assertion cannot be one of them quietly reading the other's.
    const INLINE_PORT: u16 = 5000;
    const SEPARATE_PORT: u16 = 5001;

    /// What `--token auto` prints: two hex characters per random byte.
    const TOKEN_HEX_CHARS: usize = TOKEN_BYTES * 2;

    fn args(argv: &[&str]) -> Vec<String> {
        argv.iter().map(|arg| (*arg).to_string()).collect()
    }

    /// Parse against a token store of its own.
    ///
    /// Never the real one: `--token auto` writes it, so a test that used
    /// `token_file()` would mint a token into the developer's home directory
    /// and every later run would silently adopt it.
    fn parse(argv: &[&str]) -> Result<Options, String> {
        let store = tempfile::tempdir().expect("tempdir");
        parse_in(argv, &store.path().join("token"))
    }

    fn parse_in(argv: &[&str], token_path: &Path) -> Result<Options, String> {
        match parse_args_with_token_file(&args(argv), token_path)? {
            Parsed::Options(o) => Ok(o),
            Parsed::Help(_) => panic!("expected options, got help"),
            Parsed::Version(_) => panic!("expected options, got a version"),
        }
    }

    #[test]
    fn defaults_to_loopback() {
        let o = parse(&[]).unwrap();
        assert_eq!(o.host, "127.0.0.1");
        assert!(o.token.is_none());
        assert_eq!(o.port, PROD_PORT);
        assert!(!o.mock);
    }

    /// INV-3: this app can approve permission prompts, so an open bind needs a
    /// secret.
    #[test]
    fn inv3_refuses_a_non_loopback_bind_without_a_token() {
        for host in ["0.0.0.0", "192.168.1.5", "100.64.0.1", "::"] {
            let err = parse(&["--host", host]).unwrap_err();
            assert!(err.contains("refusing to bind"), "{host}: {err}");
        }
    }

    #[test]
    fn inv3_allows_a_non_loopback_bind_once_a_token_is_supplied() {
        let o = parse(&["--host", "0.0.0.0", "--token", "s3cret"]).unwrap();
        assert_eq!(o.token.as_deref(), Some("s3cret"));
    }

    #[test]
    fn inv3_treats_every_loopback_spelling_as_safe() {
        for host in ["127.0.0.1", "localhost", "::1"] {
            assert!(parse(&["--host", host]).is_ok(), "{host}");
        }
    }

    #[test]
    fn refuses_to_serve_mock_fixtures_on_the_production_port() {
        for v in [
            vec!["--mock"],
            vec!["--mock", "--port", "4317"],
            vec!["--mock-transitions"],
            vec!["--mock-empty"],
        ] {
            let err = parse(&v).unwrap_err();
            assert!(err.contains("production port"), "{v:?}: {err}");
        }
    }

    #[test]
    fn serves_fixtures_anywhere_else_and_real_agents_on_the_production_port() {
        assert_eq!(parse(&["--mock", "--port", "4400"]).unwrap().port, DEV_PORT);
        assert_eq!(parse(&[]).unwrap().port, PROD_PORT);
        assert!(!parse(&[]).unwrap().mock);
    }

    #[test]
    fn an_empty_mock_is_still_a_mock() {
        let o = parse(&["--mock-empty", "--port", "4400"]).unwrap();
        assert!(o.mock && o.mock_empty);
        assert!(!parse(&["--mock", "--port", "4400"]).unwrap().mock_empty);
    }

    #[test]
    fn a_later_port_overrides_an_earlier_one() {
        assert_eq!(parse(&["--mock", "--port", "4400", "--port", "4501"]).unwrap().port, LATER_PORT);
    }

    #[test]
    fn token_auto_generates_thirty_two_hex_characters() {
        let o = parse(&["--host", "0.0.0.0", "--token", "auto"]).unwrap();
        let t = o.token.unwrap();
        assert_eq!(t.len(), TOKEN_HEX_CHARS);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{t}");
        // Two machines must not agree, or it is not a secret.
        let elsewhere = parse(&["--host", "0.0.0.0", "--token", "auto"]).unwrap().token.unwrap();
        assert_ne!(t, elsewhere);
    }

    #[test]
    fn token_auto_returns_the_same_token_on_the_next_start() {
        // The point of persisting it. `auto` used to mint a new secret every
        // start, so every restart broke the link saved on the phone and the
        // only stable option was a literal token in argv, which `ps` can read
        // and which nothing ever rotates.
        let store = tempfile::tempdir().expect("tempdir");
        let path = store.path().join("token");
        let first = parse_in(&["--token", "auto"], &path).unwrap().token.unwrap();
        let second = parse_in(&["--token", "auto"], &path).unwrap().token.unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn a_literal_token_is_never_written_to_the_store() {
        // An explicit `--token` is an override for this run. Persisting it
        // would silently make one invocation's argument the default for every
        // later `--token auto`.
        let store = tempfile::tempdir().expect("tempdir");
        let path = store.path().join("token");
        assert_eq!(parse_in(&["--token", "s3cret"], &path).unwrap().token.as_deref(), Some("s3cret"));
        assert!(!path.exists(), "a literal token must not create the store");
    }

    #[test]
    fn accepts_flag_equals_value_as_well_as_flag_value() {
        assert_eq!(parse(&["--port=5000"]).unwrap().port, INLINE_PORT);
        assert_eq!(parse(&["--port", "5001"]).unwrap().port, SEPARATE_PORT);
        assert_eq!(parse(&["--host=localhost"]).unwrap().host, "localhost");
    }

    #[test]
    fn rejects_a_nonsense_port_instead_of_binding_one() {
        for bad in ["abc", "99999", "0", "-1", ""] {
            let err = parse(&["--port", bad]).unwrap_err();
            assert!(err.contains("invalid port"), "{bad}: {err}");
        }
    }

    #[test]
    fn rejects_unknown_flags() {
        assert!(parse(&["--wat"]).unwrap_err().contains("unknown flag"));
        assert!(parse(&["-z"]).unwrap_err().contains("unknown flag"));
    }

    #[test]
    fn a_flag_with_no_value_is_an_error_rather_than_a_silent_default() {
        assert!(parse(&["--port"]).unwrap_err().contains("needs a value"));
        assert!(parse(&["--host"]).unwrap_err().contains("needs a value"));
        assert!(parse(&["--token"]).unwrap_err().contains("needs a value"));
    }

    /// A bare word is ignored, exactly as the TypeScript ignores it — only
    /// things that look like flags are refused.
    #[test]
    fn a_positional_argument_is_ignored() {
        assert!(parse(&["nonsense"]).is_ok());
    }

    #[test]
    fn help_is_returned_rather_than_printed() {
        for flag in ["--help", "-h"] {
            match parse_args(&args(&[flag])).unwrap() {
                Parsed::Help(text) => assert!(text.contains("Usage: agent-commander")),
                Parsed::Options(_) => panic!("{flag} should ask for help"),
                // The other side of `version_is_not_the_help_text`: neither
                // answer may stand in for the other.
                Parsed::Version(_) => panic!("{flag} should ask for help, not a version"),
            }
        }
    }

    /// The question a running binary could not previously be asked.
    ///
    /// Compiled in rather than read off disk, so it cannot disagree with the
    /// binary printing it — and `test/version.test.ts` keeps the crate in step
    /// with the npm package that ships it.
    #[test]
    fn version_reports_the_compiled_in_version() {
        for flag in ["--version", "-V"] {
            let parsed = parse_args(&args(&[flag])).unwrap();
            let Parsed::Version(text) = parsed else { panic!("{flag} should print a version") };
            assert!(text.contains(env!("CARGO_PKG_VERSION")), "{text}");
        }
    }

    /// Separate from `--help` on purpose: "what am I running" and "how do I use
    /// this" are different questions, and one answering the other is a bug.
    #[test]
    fn version_is_not_the_help_text() {
        let Parsed::Version(version) = parse_args(&args(&["--version"])).unwrap() else {
            panic!("expected a version")
        };
        assert!(!version.contains("Usage:"), "{version}");
    }

    /// `--help` short-circuits, so a combination that would otherwise be
    /// refused still prints help rather than an error — the same order the
    /// TypeScript has, where `printHelp` exits before validation runs.
    #[test]
    fn help_wins_over_a_configuration_error() {
        assert!(matches!(parse_args(&args(&["--mock", "--help"])).unwrap(), Parsed::Help(_)));
    }

    #[test]
    fn browse_root_is_resolved_rather_than_stored_raw() {
        let o = parse(&["--browse-root", "/a/b/../c"]).unwrap();
        assert_eq!(o.browse_root.as_deref(), Some("/a/c"));
    }

    #[test]
    fn default_web_root_matches_the_typescript_cases() {
        assert_eq!(default_web_root(Path::new("/app/dist/server")), PathBuf::from("/app/dist/web"));
        // Running from source via tsx must not serve the unbuilt index.html.
        assert_eq!(default_web_root(Path::new("/app/src/server")), PathBuf::from("/app/dist/web"));
    }

    #[test]
    fn default_web_root_finds_dist_from_a_cargo_target_directory() {
        assert_eq!(
            default_web_root(Path::new("/app/rust/target/debug")),
            PathBuf::from("/app/dist/web")
        );
        assert_eq!(
            default_web_root(Path::new("/app/rust/target/release/deps")),
            PathBuf::from("/app/dist/web")
        );
    }

    /// The npm package's layout, and the reason it needs a case of its own.
    ///
    /// A published install runs `dist/bin/<platform>-<arch>/agent-commander`
    /// while the bundle sits at `dist/web`. The fall-through rule would answer
    /// `dist/bin/web`, and the binary would start, bind, print a URL and serve
    /// 404 for `/` — found by running the packaged binary and asking for the
    /// index, because `--help` returns before anything is served and cannot
    /// show it.
    #[test]
    fn default_web_root_finds_the_bundle_from_the_packaged_bin_layout() {
        for host in ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] {
            assert_eq!(
                default_web_root(&Path::new("/pkg/dist/bin").join(host)),
                PathBuf::from("/pkg/dist/web"),
                "{host}"
            );
        }
    }

    #[test]
    fn normalize_collapses_traversal_and_never_climbs_past_root() {
        assert_eq!(normalize(Path::new("/a/b/../c")), PathBuf::from("/a/c"));
        assert_eq!(normalize(Path::new("/a/./b")), PathBuf::from("/a/b"));
        assert_eq!(normalize(Path::new("/../../..")), PathBuf::from("/"));
    }

    /* ---- the allow-lists ---- */

    #[test]
    fn allow_lists_refuse_anything_that_could_become_a_flag() {
        for hostile in ["--dangerously-skip-permissions", "-n", "opus; rm -rf /", "", "OPUS"] {
            assert!(!is_model_alias(hostile), "model: {hostile}");
            assert!(!is_permission_mode(hostile), "mode: {hostile}");
            assert!(!is_cyclable_mode(hostile), "cyclable: {hostile}");
        }
    }

    #[test]
    fn allow_lists_accept_exactly_what_the_dialog_offers() {
        for m in ["default", "opus", "sonnet", "haiku", "fable", "opusplan"] {
            assert!(is_model_alias(m), "{m}");
        }
        for m in ["default", "acceptEdits", "plan", "bypassPermissions", "auto", "dontAsk"] {
            assert!(is_permission_mode(m), "{m}");
        }
    }

    /// `dontAsk` is reachable by flag at spawn time but is not in the Shift+Tab
    /// cycle, so it must never be a target a running session is cycled towards.
    #[test]
    fn dont_ask_is_spawnable_but_not_cyclable() {
        assert!(is_permission_mode("dontAsk"));
        assert!(!is_cyclable_mode("dontAsk"));
    }

    #[test]
    fn every_cyclable_mode_is_also_spawnable() {
        for m in MODE_CYCLE {
            assert!(is_permission_mode(m), "{m}");
        }
    }
}
