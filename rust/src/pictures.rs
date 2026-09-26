//! Pictures a tab hands to an agent.
//!
//! Everything the composer sends becomes text in a tmux pane, and a pane
//! carries nothing that is not a keystroke. Claude Code will read an image
//! file named in a prompt, though, so a picture reaches an agent the only way
//! it can: the bytes land here first and the *path* is what gets typed. This
//! module owns that file — where it goes, what it is allowed to be, and when
//! it is deleted.
//!
//! **This works only because the server and the agent share a filesystem**,
//! which they do today because both are on this machine. An agent somewhere
//! else would need the bytes themselves to travel, and nothing here would
//! help; the path this hands back would name a file that machine does not
//! have. That is the limit to meet before this grows a remote story.
//!
//! Retention is the part written first rather than last. A directory that only
//! grows is the failure mode for anything that writes files on a user's
//! machine, so `retain` is modelled on `usage::UsageReader::retain` and runs
//! from the same pass: when the fleet no longer holds a session, that session's
//! pictures go with it.

use std::path::{Path, PathBuf};

const MEGABYTE: usize = 1024 * 1024;

/// Big enough for a phone screenshot and far below anything that would make
/// the read itself the cost.
///
/// Its own limit rather than `control::MAX_PASTE`: that one bounds what may be
/// typed into a live agent under INV-12, and an upload is not typing. Sharing
/// it would have meant either refusing ordinary photographs or quietly raising
/// the ceiling on what a tab can put into a pane.
pub const MAX_PICTURE_BYTES: usize = 10 * MEGABYTE;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";
const JPEG: &[u8] = b"\xff\xd8\xff";
const GIF87: &[u8] = b"GIF87a";
const GIF89: &[u8] = b"GIF89a";
const RIFF: &[u8] = b"RIFF";
const WEBP: &[u8] = b"WEBP";

/// A RIFF file is the tag, a `u32` chunk length, then the form type — so the
/// four bytes that say "this is a WebP" sit past both.
const WEBP_FORM_AT: usize = RIFF.len() + std::mem::size_of::<u32>();

/// Where a session's pictures live. Beside `sessions/`, which is already this
/// app's corner of the Claude Code directory.
pub fn pictures_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("agent-commander")
        .join("pictures")
}

/// The extension for a format Claude Code reads, or nothing.
///
/// Sniffed from the file's own first bytes rather than taken from the request's
/// `Content-Type`, which is a claim by the caller about a file the same caller
/// supplied. A `.png` that is really a shell script is the thing this refuses.
fn extension_of(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(PNG) {
        return Some("png");
    }
    if bytes.starts_with(JPEG) {
        return Some("jpg");
    }
    if bytes.starts_with(GIF87) || bytes.starts_with(GIF89) {
        return Some("gif");
    }
    let form = bytes.get(WEBP_FORM_AT..WEBP_FORM_AT + WEBP.len());
    if bytes.starts_with(RIFF) && form == Some(WEBP) {
        return Some("webp");
    }
    None
}

/// A session id that can be a directory name.
///
/// The same rule `usage::safe_id` applies and for the same reason: the id came
/// out of a session file this app did not write, and a `..` in it would put a
/// file somewhere else entirely. INV-9's lesson, at the one place here that
/// turns wire data into a path.
fn safe_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !session_id.starts_with('.')
}

/// The name to write the bytes under: their own digest, plus the sniffed
/// extension.
///
/// Content-addressed so that nothing in the path came off the wire — the
/// caller never names a file here — and so the same screenshot sent twice is
/// one file rather than two.
fn name_of(bytes: &[u8], extension: &str) -> String {
    use base64::Engine as _;
    use sha1::{Digest, Sha1};
    let digest = Sha1::new_with_prefix(bytes).finalize();
    let stem = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    format!("{stem}.{extension}")
}

/// Why a picture was not stored.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    TooLarge,
    Empty,
    NotAPicture,
    UnknownSession,
    /// The picture was fine and the disk was not. Kept apart from the rest
    /// because telling a caller they sent something wrong when they did not is
    /// the kind of wrong answer that sends them looking in the wrong place.
    NotWritten,
}

impl Refused {
    pub fn message(&self) -> String {
        match self {
            Self::TooLarge => format!("that picture is over {}MB", MAX_PICTURE_BYTES / MEGABYTE),
            Self::Empty => "that upload had no bytes in it".to_string(),
            Self::NotAPicture => "that is not a PNG, JPEG, GIF or WebP".to_string(),
            Self::UnknownSession => "no such session".to_string(),
            Self::NotWritten => "the picture could not be stored on this machine".to_string(),
        }
    }

    /// Whether the caller can fix it by sending something else.
    pub fn is_the_callers_fault(&self) -> bool {
        !matches!(self, Self::NotWritten)
    }
}

/// The pictures on disk, one directory per session.
pub struct PictureStore {
    root: PathBuf,
}

impl PictureStore {
    pub fn new() -> Self {
        Self::in_dir(pictures_dir())
    }

    pub fn in_dir(root: PathBuf) -> Self {
        Self { root }
    }

    fn dir_of(&self, session_id: &str) -> Option<PathBuf> {
        safe_id(session_id).then(|| self.root.join(session_id))
    }

    /// Write the picture and answer with the path an agent can be given.
    pub fn save(&self, session_id: &str, bytes: &[u8]) -> Result<PathBuf, Refused> {
        if bytes.is_empty() {
            return Err(Refused::Empty);
        }
        if bytes.len() > MAX_PICTURE_BYTES {
            return Err(Refused::TooLarge);
        }
        let extension = extension_of(bytes).ok_or(Refused::NotAPicture)?;
        let dir = self.dir_of(session_id).ok_or(Refused::UnknownSession)?;
        let file = dir.join(name_of(bytes, extension));
        std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&file, bytes)).map_err(
            |why| {
                eprintln!("agent-commander: could not store a picture for {session_id}: {why}");
                Refused::NotWritten
            },
        )?;
        Ok(file)
    }

    /// Delete the pictures of sessions the fleet no longer holds.
    ///
    /// Reads the directory rather than remembering what it wrote, so pictures
    /// left behind by an earlier run of the server are cleaned up too — a
    /// crash between the write and the session ending is otherwise a leak
    /// nothing would ever collect.
    pub fn retain(&self, live: &[String]) {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(id) = name.to_str() else { continue };
            if live.iter().any(|held| held == id) {
                continue;
            }
            if let Err(why) = std::fs::remove_dir_all(entry.path()) {
                eprintln!("agent-commander: could not clear pictures for {id}: {why}");
            }
        }
    }
}

impl Default for PictureStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether this text hands the agent a picture this app stored.
///
/// Asked of a paste that is about to be submitted, because Claude Code treats
/// such a paste specially and an Enter riding along with it is lost — see
/// `Panes::paste`. It is deliberately this app's own directory rather than
/// "looks like an image path": a path an agent was merely being told about is
/// text like any other, and the browser's own reconciliation draws the line in
/// the same place (INV-11).
pub fn names_a_picture(text: &str) -> bool {
    text.contains(&*pictures_dir().to_string_lossy())
}

/// How the path is handed to the agent.
///
/// A bare path and nothing else, because the prompt around it is the user's to
/// write: this app quotes what a person typed and never composes prose on
/// their behalf (INV-11). Quoted only when it has to be, so the ordinary case
/// reads as the path it is.
pub fn as_typed(path: &Path) -> String {
    let text = path.to_string_lossy();
    if text.chars().any(|c| c.is_whitespace() || c == '\'' || c == '"') {
        return format!("'{}'", text.replace('\'', r"'\''"));
    }
    text.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png() -> Vec<u8> {
        let mut bytes = PNG.to_vec();
        bytes.extend_from_slice(b"whatever follows the header");
        bytes
    }

    fn store() -> (tempfile::TempDir, PictureStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = PictureStore::in_dir(dir.path().to_path_buf());
        (dir, store)
    }

    #[test]
    fn the_format_is_read_off_the_bytes_and_not_off_a_claim() {
        assert_eq!(extension_of(&png()), Some("png"));
        assert_eq!(extension_of(b"\xff\xd8\xff\xe0 jfif"), Some("jpg"));
        assert_eq!(extension_of(b"GIF89a....."), Some("gif"));
        assert_eq!(extension_of(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        // A RIFF that is not a WebP is a WAV, and Claude Code does not read it.
        assert_eq!(extension_of(b"RIFF\0\0\0\0WAVEfmt "), None);
        assert_eq!(extension_of(b"#!/bin/sh\nrm -rf /"), None);
        assert_eq!(extension_of(b""), None);
    }

    #[test]
    fn inv9_a_session_id_that_is_not_a_directory_name_stores_nothing() {
        let (dir, store) = store();
        for bad in ["../escape", "a/b", "", ".hidden", "..", "one two"] {
            assert_eq!(store.save(bad, &png()), Err(Refused::UnknownSession), "{bad:?}");
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "nothing was written");
    }

    #[test]
    fn a_saved_picture_is_named_by_its_own_bytes() {
        let (_dir, store) = store();
        let once = store.save("s1", &png()).unwrap();
        let twice = store.save("s1", &png()).unwrap();
        assert_eq!(once, twice, "the same picture is one file");
        assert_eq!(std::fs::read(&once).unwrap(), png());
        let other = store.save("s1", b"GIF89a and different bytes").unwrap();
        assert_ne!(once, other);
        assert!(other.to_string_lossy().ends_with(".gif"));
        // Nothing in the name came off the wire, so nothing in it can escape.
        assert_eq!(once.parent().unwrap().file_name().unwrap(), "s1");
    }

    #[test]
    fn what_is_not_a_picture_is_refused_before_anything_is_written() {
        let (dir, store) = store();
        assert_eq!(store.save("s1", b"#!/bin/sh").unwrap_err(), Refused::NotAPicture);
        assert_eq!(store.save("s1", b"").unwrap_err(), Refused::Empty);
        let huge = vec![0u8; MAX_PICTURE_BYTES + 1];
        assert_eq!(store.save("s1", &huge).unwrap_err(), Refused::TooLarge);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_session_that_is_gone_takes_its_pictures_with_it() {
        let (dir, store) = store();
        let kept = store.save("s1", &png()).unwrap();
        let dropped = store.save("s2", &png()).unwrap();
        store.retain(&["s1".to_string()]);
        assert!(kept.exists(), "a live session keeps its pictures");
        assert!(!dropped.exists(), "a session that is gone does not");
        assert!(!dir.path().join("s2").exists(), "and neither does its directory");
        // Nothing live at all: the whole directory empties rather than lingering.
        store.retain(&[]);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn retaining_over_a_directory_that_is_not_there_is_not_an_error() {
        let store = PictureStore::in_dir(PathBuf::from("/nonexistent/agent-commander/pictures"));
        store.retain(&["s1".to_string()]);
    }

    #[test]
    fn a_paste_that_hands_over_a_picture_is_told_from_one_that_mentions_a_file() {
        let stored = as_typed(&pictures_dir().join("s1").join("abc.png"));
        assert!(names_a_picture(&format!("what is wrong here? {stored}")));
        assert!(names_a_picture(&stored));
        assert!(!names_a_picture("~/Downloads/abc.png is the one I mean"));
        assert!(!names_a_picture("nothing here names a file at all"));
    }

    #[test]
    fn a_path_is_typed_as_itself_unless_it_needs_quoting() {
        assert_eq!(as_typed(Path::new("/tmp/pics/abc.png")), "/tmp/pics/abc.png");
        assert_eq!(as_typed(Path::new("/tmp/my pics/abc.png")), "'/tmp/my pics/abc.png'");
        assert_eq!(as_typed(Path::new("/tmp/it's/a.png")), r"'/tmp/it'\''s/a.png'");
    }
}
