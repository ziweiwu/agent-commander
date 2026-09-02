//! The access token, kept on disk so it survives a restart.
//!
//! `--token auto` used to generate a fresh secret every start. That rotated at
//! exactly the wrong moment: every restart invalidated the link saved on the
//! phone, so the way to get a stable one was `--token <literal>` in an alias or
//! a plist — which then sits in argv where `ps` can read it, sits in shell
//! history, and never rotates at all. The convenient option and the safe one
//! pointed in opposite directions.
//!
//! Persisting it separates the two lifetimes. The credential is long-lived and
//! bookmarkable; rotation becomes a deliberate act (`--rotate-token`) rather
//! than a side effect of restarting.
//!
//! It lives beside `rate-limits.json` in `~/.claude/agent-commander/` — the one
//! directory this project already owns on every platform it ships to. The Mac
//! app's `~/Library/Application Support/agent-commander` is the launcher's, is
//! macOS-only, and a plain `npm start` never goes near it.

use std::io::Write;
use std::path::PathBuf;

/// Where the token lives. The directory is shared with `limits::limits_file`.
pub fn token_file() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("agent-commander").join("token")
}

/// The stored token, or `None` if there is not a usable one.
///
/// A blank or whitespace-only file reads as absent rather than as an empty
/// token: an empty secret would authorise everyone, and a truncated write is a
/// likelier explanation for one than an intent to disable the gate.
pub fn read(path: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let token = raw.trim().to_string();
    (!token.is_empty()).then_some(token)
}

/// Write `token` readable only by this user.
///
/// The mode is set as the file is created rather than afterwards, so there is
/// no instant at which the secret exists at the default umask.
pub fn write(path: &std::path::Path, token: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    let mut file = open.open(path).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    writeln!(file, "{token}").map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// What `--token auto` resolves to: the stored token, or a new stored one.
pub fn read_or_create(path: &std::path::Path) -> Result<String, String> {
    if let Some(existing) = read(path) {
        return Ok(existing);
    }
    let fresh = crate::options::random_token();
    write(path, &fresh)?;
    Ok(fresh)
}

/// What `--rotate-token` does: replace it, whatever was there.
///
/// This is the revoke that did not previously exist. Restarting with
/// `--token auto` was the closest thing, and it only worked because the token
/// was not kept — which is the property being removed.
pub fn rotate(path: &std::path::Path) -> Result<String, String> {
    let fresh = crate::options::random_token();
    write(path, &fresh)?;
    Ok(fresh)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 128 bits, hex-encoded.
    const TOKEN_HEX_CHARS: usize = 32;

    fn scratch() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("token");
        (dir, path)
    }

    #[test]
    fn a_generated_token_survives_the_next_read() {
        let (_dir, path) = scratch();
        let first = read_or_create(&path).expect("create");
        let second = read_or_create(&path).expect("reuse");
        assert_eq!(first, second, "--token auto must stop rotating on restart");
        assert_eq!(first.len(), TOKEN_HEX_CHARS, "still 128 bits of hex");
    }

    #[test]
    fn rotating_replaces_it_and_the_old_one_is_gone() {
        let (_dir, path) = scratch();
        let before = read_or_create(&path).expect("create");
        let after = rotate(&path).expect("rotate");
        assert_ne!(before, after);
        assert_eq!(read(&path).as_deref(), Some(after.as_str()));
    }

    #[test]
    fn a_blank_file_reads_as_no_token_rather_than_an_empty_one() {
        // An empty secret would authorise every caller. A half-finished write
        // is a likelier cause than someone meaning to turn the gate off.
        let (_dir, path) = scratch();
        write(&path, "   ").expect("write");
        assert_eq!(read(&path), None);
        // ...and `auto` then mints a real one rather than adopting the blank.
        let made = read_or_create(&path).expect("create");
        assert_eq!(made.len(), TOKEN_HEX_CHARS);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_never_readable_by_anyone_else() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, path) = scratch();
        read_or_create(&path).expect("create");
        let mode = std::fs::metadata(&path).expect("stat").permissions().mode();
        assert_eq!(mode & 0o077, 0, "group and other must have nothing: {mode:o}");
    }

    #[test]
    fn the_stored_token_carries_no_newline_into_the_comparison() {
        // `write` appends one so the file is a well-formed text line; a token
        // read back with it attached would never match the query parameter.
        let (_dir, path) = scratch();
        let made = read_or_create(&path).expect("create");
        assert!(!made.ends_with('\n'));
        assert_eq!(std::fs::read_to_string(&path).expect("read").trim(), made);
    }
}
