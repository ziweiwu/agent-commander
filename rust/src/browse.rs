//! Directory listing for the new-agent folder picker.
//!
//! Port of `src/server/browse.ts`.
//!
//! INV-9: browsing cannot leave the root. Every requested path is resolved
//! with `realpath` and confirmed to sit inside it, so a symlink pointing at
//! `/` does not become a filesystem tour. This app is reachable over Tailscale,
//! so an endpoint that enumerates directories deserves a hard boundary rather
//! than a string-prefix check on an unresolved path.
//!
//! The check happens once, in `resolve_inside_root`, and its result is a
//! [`WithinRoot`] rather than a `PathBuf`. Everything downstream takes that
//! type, so a path that was never checked is not a value those functions can
//! be handed. The boundary is the type, and the runtime check is its only
//! constructor.
//!
//! Listing is metadata only: names and directory-ness. It never reads a file.

use std::path::{Path, PathBuf};

use crate::options::resolve_path;
use crate::types::{DirEntryDto, DirListing};

/// Why a listing did not happen.
///
/// Two cases, because the caller renders them with different status codes and
/// the TypeScript already draws the same line — it just draws it by throwing
/// two different classes. `listDirs` resolves the configured root *outside*
/// its try block, so a `--browse-root` that does not exist escapes as a plain
/// `Error` and `routes.ts` answers 500; every refusal below it is a
/// `BrowseError` and answers 400.
///
/// That split is right on its own terms as well as for parity. A browse root
/// the operator mistyped is not something the person clicking through the
/// folder picker did wrong, and telling them their request was invalid would
/// send them looking in the wrong place.
#[derive(Debug, Clone, thiserror::Error)]
pub enum BrowseError {
    /// The request cannot be served — outside the root, missing, not a
    /// directory. The caller's problem: 400.
    #[error("{0}")]
    Refused(String),
    /// The configured root itself is unusable. The server's problem: 500.
    #[error("{0}")]
    Root(String),
}

impl BrowseError {
    fn new(msg: impl Into<String>) -> Self {
        BrowseError::Refused(msg.into())
    }
    fn root(msg: impl Into<String>) -> Self {
        BrowseError::Root(msg.into())
    }
    /// True when this is worth a 400 rather than a 500.
    pub fn is_client_error(&self) -> bool {
        matches!(self, BrowseError::Refused(_))
    }
}

type Res<T> = Result<T, BrowseError>;

/// True when `candidate` is the root itself or sits underneath it.
///
/// A path-segment comparison, not a string prefix. `startsWith` would call
/// `/abc` a child of `/a`, and the folder picker's whole boundary is this one
/// predicate — the cheapest possible place for an off-by-one to become an
/// escape hatch.
pub fn is_inside(root: &Path, candidate: &Path) -> bool {
    if candidate == root {
        return true;
    }
    // `Path::starts_with` is already segment-wise, which is exactly the check
    // the TypeScript has to build by hand out of a separator.
    candidate.starts_with(root)
}

/// A resolved path that has been proven to sit inside a browse root, together
/// with the root it was proven against.
///
/// The only constructor is [`resolve_inside_root`]. A function that takes one
/// therefore has INV-9 in its signature rather than in a check each caller has
/// to remember: handing it a path that never went through the resolver does
/// not compile. Before this type, the resolver returned a bare `PathBuf`, and
/// both the parent computation and the label carried a runtime branch for "the
/// path is outside the root" — a state that, with the check done once, no
/// caller could reach and no test could tell from a real one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WithinRoot {
    path: PathBuf,
    root: PathBuf,
}

impl WithinRoot {
    /// The resolved path, inside `root()`.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The resolved root this path was checked against.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The ".." button's destination, offered only below the root — this
    /// control must not be the way out of it.
    ///
    /// No containment check: the parent of a path strictly inside the root is
    /// the root or something beneath it, so the result is `WithinRoot` by
    /// construction rather than by testing.
    pub fn parent(&self) -> Option<WithinRoot> {
        if self.path == self.root {
            return None;
        }
        let path = crate::options::normalize(&self.path.join(".."));
        Some(WithinRoot { path, root: self.root.clone() })
    }

    /// `~` for the root itself and `~/…` beneath it, so the picker can say
    /// where you are without putting the absolute path of somebody's home on
    /// screen.
    pub fn label(&self) -> String {
        match self.path.strip_prefix(&self.root) {
            Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
            Ok(rest) => format!("~/{}", rest.to_string_lossy()),
            // Unreachable by construction; a reader who somehow got here is
            // told they are at the root rather than shown a path.
            Err(_) => "~".to_string(),
        }
    }
}

/// Resolve a requested path and refuse anything outside the root.
///
/// Resolution happens before the check, so `~/link-to-slash` is judged by
/// where it points rather than by what it is called. Doing it the other way
/// round — check the string, then follow it — is the bug this ordering exists
/// to prevent.
///
/// This is the one place a [`WithinRoot`] is made.
pub async fn resolve_inside_root(requested: Option<&str>, root: &Path) -> Res<WithinRoot> {
    let real_root = tokio::fs::canonicalize(root)
        .await
        .map_err(|_| BrowseError::root(format!("no such directory: {}", root.display())))?;

    let target = match requested.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => resolve_path(s),
        None => real_root.clone(),
    };

    let real = tokio::fs::canonicalize(&target)
        .await
        .map_err(|_| BrowseError::new(format!("no such directory: {}", target.display())))?;

    if !is_inside(&real_root, &real) {
        return Err(BrowseError::new("that directory is outside the browsable root"));
    }
    Ok(WithinRoot { path: real, root: real_root })
}

/// The root the picker is confined to when none was configured.
pub fn default_root() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Whether a listing offers directories whose name starts with a dot.
///
/// A named pair rather than a bare boolean: `list_dirs(path, root, true)` at a
/// call site says nothing about what the `true` is asking for, and the picker
/// sends this straight through from a query parameter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DotDirs {
    /// Offer them — the picker's "show hidden" toggle is on.
    Shown,
    /// Leave them out, which is what the picker asks for by default.
    Hidden,
}

/// List the subdirectories of a path, contained to the root.
pub async fn list_dirs(
    requested: Option<&str>,
    root: Option<&Path>,
    dot_dirs: DotDirs,
) -> Res<DirListing> {
    let configured = root.map(Path::to_path_buf).unwrap_or_else(default_root);
    let within = resolve_inside_root(requested, &configured).await?;
    let path = within.path();

    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|_| BrowseError::new(format!("no such directory: {}", path.display())))?;
    if !metadata.is_dir() {
        return Err(BrowseError::new(format!("not a directory: {}", path.display())));
    }

    Ok(DirListing {
        path: path.to_string_lossy().into_owned(),
        parent: within.parent().map(|up| up.path().to_string_lossy().into_owned()),
        root: within.root().to_string_lossy().into_owned(),
        entries: subdirectories_of(&within, dot_dirs).await?,
    })
}

/// The subdirectories of a contained path, in the order the picker draws them.
///
/// The children are offered by name and not checked here: a child of a
/// contained directory is contained, except through a symlink, and a symlink
/// is judged by where it points when the picker asks to enter it.
async fn subdirectories_of(within: &WithinRoot, dot_dirs: DotDirs) -> Res<Vec<DirEntryDto>> {
    let path = within.path();
    let unreadable =
        || BrowseError::new(format!("cannot read directory: {}", path.display()));
    let mut read = tokio::fs::read_dir(path).await.map_err(|_| unreadable())?;

    let mut entries: Vec<DirEntryDto> = Vec::new();
    loop {
        let Some(entry) = read.next_entry().await.map_err(|_| unreadable())? else { break };

        let name = entry.file_name().to_string_lossy().into_owned();
        let hidden = name.starts_with('.');
        if hidden && dot_dirs == DotDirs::Hidden {
            continue;
        }
        let child = path.join(&name);
        if !is_listable_dir(&child).await {
            continue;
        }
        entries.push(DirEntryDto {
            name,
            path: child.to_string_lossy().into_owned(),
            hidden,
        });
    }

    // `localeCompare` in the TypeScript, which orders case-insensitively and
    // breaks ties on the raw string. A byte-order sort would put every
    // capitalised folder above every lowercase one, which is not what the
    // picker looked like before.
    entries.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

/// Whether a child is a directory the picker can offer.
///
/// `file_type()` would be cheaper, but a symlinked project directory is common
/// and should still be offered; `metadata` follows the link. An unreadable
/// entry or a broken symlink answers no, and is skipped rather than failing the
/// whole listing.
async fn is_listable_dir(child: &Path) -> bool {
    matches!(tokio::fs::metadata(child).await, Ok(meta) if meta.is_dir())
}


/* ------------------------------------------------------------------ tests */

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A root with the shapes that matter: a nested directory, a dotfolder, a
    /// plain file, and a symlink pointing clean out of the root.
    struct Root {
        _dir: tempfile::TempDir,
        path: PathBuf,
        outside: tempfile::TempDir,
    }

    fn root() -> Root {
        let dir = tempfile::tempdir().unwrap();
        // macOS puts temp dirs behind /private, so the root has to be the
        // resolved one or every comparison in here is testing the wrong path.
        let path = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir_all(path.join("Projects/app")).unwrap();
        fs::create_dir(path.join(".hidden")).unwrap();
        fs::write(path.join("notes.txt"), "x").unwrap();

        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(outside.path().join("secrets")).unwrap();
        // The case a prefix check would miss entirely.
        std::os::unix::fs::symlink("/", path.join("escape-hatch")).unwrap();
        std::os::unix::fs::symlink(
            fs::canonicalize(outside.path()).unwrap(),
            path.join("neighbour"),
        )
        .unwrap();
        // A sibling of the root that merely shares its textual prefix.
        let sibling = PathBuf::from(format!("{}-evil", path.display()));
        let _ = fs::create_dir(&sibling);

        Root { _dir: dir, path, outside }
    }

    fn path_of(text: &str) -> PathBuf {
        PathBuf::from(text)
    }

    /* ---- is_inside ---- */

    #[test]
    fn inv9_is_inside_accepts_the_root_and_its_descendants() {
        assert!(is_inside(&path_of("/a"), &path_of("/a")));
        assert!(is_inside(&path_of("/a"), &path_of("/a/b")));
        assert!(is_inside(&path_of("/a"), &path_of("/a/b/c/d")));
    }

    /// The bug a naive `startsWith` would have: `/abc` is not inside `/a`.
    #[test]
    fn inv9_is_inside_rejects_a_sibling_that_merely_shares_a_prefix() {
        assert!(!is_inside(&path_of("/a"), &path_of("/abc")));
        assert!(!is_inside(&path_of("/home/me"), &path_of("/home/melissa/secrets")));
        assert!(!is_inside(&path_of("/home/me"), &path_of("/home/me-backup")));
    }

    #[test]
    fn inv9_is_inside_rejects_anything_above_the_root() {
        assert!(!is_inside(&path_of("/a/b"), &path_of("/a")));
        assert!(!is_inside(&path_of("/a/b"), &path_of("/")));
    }

    /* ---- resolve_inside_root ---- */

    #[tokio::test]
    async fn resolve_defaults_to_the_root() {
        let r = root();
        assert_eq!(resolve_inside_root(None, &r.path).await.unwrap().path(), r.path);
        // An empty or whitespace-only request is the same as none.
        for blank in ["", "   "] {
            assert_eq!(resolve_inside_root(Some(blank), &r.path).await.unwrap().path(), r.path);
        }
    }

    #[tokio::test]
    async fn resolve_resolves_a_directory_inside_the_root() {
        let r = root();
        let want = r.path.join("Projects");
        let got = resolve_inside_root(Some(want.to_str().unwrap()), &r.path).await.unwrap();
        assert_eq!(got.path(), want);
    }

    #[tokio::test]
    async fn inv9_refuses_an_absolute_path_outside_the_root() {
        let r = root();
        for outside in ["/etc", "/", "/usr/bin"] {
            let err = resolve_inside_root(Some(outside), &r.path).await.unwrap_err();
            assert!(err.to_string().contains("outside"), "{outside}: {err}");
        }
    }

    #[tokio::test]
    async fn inv9_refuses_traversal_out_of_the_root() {
        let r = root();
        let attacks = [
            r.path.join("..").to_string_lossy().into_owned(),
            r.path.join("Projects/../../..").to_string_lossy().into_owned(),
            r.path.join("Projects/app/../../../etc").to_string_lossy().into_owned(),
            format!("{}/./../.", r.path.display()),
        ];
        for attack in attacks {
            let err = resolve_inside_root(Some(&attack), &r.path).await.unwrap_err();
            assert!(err.to_string().contains("outside") || err.to_string().contains("no such"), "{attack}: {err}");
        }
    }

    /// Resolution happens before the check, so a link is judged by where it
    /// points. This is the one a prefix check on the requested string passes.
    #[tokio::test]
    async fn inv9_refuses_a_symlink_that_escapes_the_root() {
        let r = root();
        for link in ["escape-hatch", "neighbour"] {
            let target = r.path.join(link);
            let err =
                resolve_inside_root(Some(target.to_str().unwrap()), &r.path).await.unwrap_err();
            assert!(err.to_string().contains("outside"), "{link}: {err}");
        }
        // And through the link, not merely at it.
        let through = r.path.join("neighbour/secrets");
        let err = resolve_inside_root(Some(through.to_str().unwrap()), &r.path).await.unwrap_err();
        assert!(err.to_string().contains("outside"), "{err}");
    }

    /// A sibling directory whose name starts with the root's is the classic
    /// string-prefix escape. It must be refused even though it exists.
    #[tokio::test]
    async fn inv9_refuses_a_sibling_that_shares_the_roots_textual_prefix() {
        let r = root();
        let sibling = format!("{}-evil", r.path.display());
        if fs::metadata(&sibling).is_ok() {
            let err = resolve_inside_root(Some(&sibling), &r.path).await.unwrap_err();
            assert!(err.to_string().contains("outside"), "{err}");
        }
        let _ = fs::remove_dir_all(&sibling);
    }

    /// A path that arrived percent-encoded and was never decoded is just a
    /// directory name with odd characters in it — it must not resolve to `..`.
    #[tokio::test]
    async fn inv9_url_encoded_traversal_is_not_traversal() {
        let r = root();
        for attack in ["%2e%2e/%2e%2e/etc", "..%2f..%2fetc", "%2E%2E%2F"] {
            let target = format!("{}/{attack}", r.path.display());
            let err = resolve_inside_root(Some(&target), &r.path).await.unwrap_err();
            assert!(err.to_string().contains("no such directory"), "{attack}: {err}");
        }
    }

    /// A NUL byte cannot be part of a path, and must be an error rather than a
    /// truncated path that resolves somewhere else.
    #[tokio::test]
    async fn inv9_refuses_a_path_with_an_interior_nul() {
        let r = root();
        let attack = format!("{}/Projects\0/../../etc", r.path.display());
        assert!(resolve_inside_root(Some(&attack), &r.path).await.is_err());
    }

    #[tokio::test]
    async fn refuses_a_path_that_does_not_exist() {
        let r = root();
        let missing = r.path.join("nope");
        let err = resolve_inside_root(Some(missing.to_str().unwrap()), &r.path).await.unwrap_err();
        assert!(err.to_string().contains("no such directory"), "{err}");
    }

    /// A relative request resolves against the server's own working directory,
    /// which is almost never inside the browse root — so it is refused rather
    /// than quietly listing wherever the process happens to have been started.
    #[tokio::test]
    async fn a_relative_request_does_not_resolve_against_the_root() {
        let r = root();
        assert!(resolve_inside_root(Some("Projects"), &r.path).await.is_err());
    }

    /* ---- list_dirs ---- */

    #[tokio::test]
    async fn lists_only_directories_not_files() {
        let r = root();
        let listing = list_dirs(None, Some(&r.path), DotDirs::Hidden).await.unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"Projects"));
        assert!(!names.contains(&"notes.txt"));
    }

    #[tokio::test]
    async fn hides_dotfolders_unless_asked() {
        let r = root();
        let plain = list_dirs(None, Some(&r.path), DotDirs::Hidden).await.unwrap();
        assert!(!plain.entries.iter().any(|e| e.name == ".hidden"));
        let with_hidden = list_dirs(None, Some(&r.path), DotDirs::Shown).await.unwrap();
        assert!(with_hidden.entries.iter().any(|e| e.name == ".hidden"));
        assert!(with_hidden.entries.iter().find(|e| e.name == ".hidden").unwrap().hidden);
    }

    #[tokio::test]
    async fn has_no_parent_at_the_root_and_one_below_it() {
        let r = root();
        assert!(list_dirs(None, Some(&r.path), DotDirs::Hidden).await.unwrap().parent.is_none());
        let below = list_dirs(
            Some(r.path.join("Projects").to_str().unwrap()),
            Some(&r.path),
            DotDirs::Hidden,
        )
        .await
        .unwrap();
        assert_eq!(below.parent.as_deref(), Some(r.path.to_str().unwrap()));
    }

    #[tokio::test]
    async fn inv9_refuses_to_list_outside_the_root() {
        let r = root();
        for outside in ["/etc", "/"] {
            assert!(list_dirs(Some(outside), Some(&r.path), DotDirs::Hidden).await.is_err(), "{outside}");
        }
        let link = r.path.join("neighbour");
        assert!(list_dirs(Some(link.to_str().unwrap()), Some(&r.path), DotDirs::Hidden).await.is_err());
    }

    /// A directory reached legitimately still never offers an entry outside
    /// the root, and an escaping symlink is not listed as a directory to walk
    /// into — it resolves outside, and `resolve_inside_root` refuses it on the
    /// next request.
    #[tokio::test]
    async fn inv9_a_listed_escaping_symlink_still_cannot_be_entered() {
        let r = root();
        let listing = list_dirs(None, Some(&r.path), DotDirs::Hidden).await.unwrap();
        for entry in &listing.entries {
            if entry.name == "escape-hatch" || entry.name == "neighbour" {
                assert!(
                    resolve_inside_root(Some(&entry.path), &r.path).await.is_err(),
                    "{} was enterable",
                    entry.name
                );
            }
        }
    }

    #[tokio::test]
    async fn sorts_entries_by_name() {
        let r = root();
        fs::create_dir(r.path.join("apple")).unwrap();
        fs::create_dir(r.path.join("Banana")).unwrap();
        let names: Vec<String> =
            list_dirs(None, Some(&r.path), DotDirs::Shown).await.unwrap().entries.into_iter().map(|e| e.name).collect();
        let mut sorted = names.clone();
        sorted.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)));
        assert_eq!(names, sorted);
        // Case-insensitive, the way localeCompare orders it.
        let i = names.iter().position(|n| n == "apple").unwrap();
        let j = names.iter().position(|n| n == "Banana").unwrap();
        assert!(i < j, "{names:?}");
    }

    #[tokio::test]
    async fn a_file_is_not_a_listable_directory() {
        let r = root();
        let file = r.path.join("notes.txt");
        let err = list_dirs(Some(file.to_str().unwrap()), Some(&r.path), DotDirs::Hidden).await.unwrap_err();
        assert!(err.to_string().contains("not a directory"), "{err}");
    }

    /// The listing carries names and directory-ness and nothing else. If this
    /// ever grows a size or a preview, it has started reading files.
    #[tokio::test]
    async fn listing_is_metadata_only() {
        let r = root();
        let listing = list_dirs(None, Some(&r.path), DotDirs::Shown).await.unwrap();
        for entry in &listing.entries {
            assert!(!entry.name.is_empty());
            assert!(entry.path.ends_with(&entry.name));
        }
        drop(r.outside);
    }

    /// The status codes the two backends hand back have to agree, and these
    /// are the two sides of that line.
    #[tokio::test]
    async fn a_broken_root_is_the_servers_problem_and_a_bad_request_is_the_callers() {
        let r = root();
        let missing_root = r.path.join("no-such-root");
        let err = list_dirs(None, Some(&missing_root), DotDirs::Hidden).await.unwrap_err();
        assert!(!err.is_client_error(), "a mistyped --browse-root is a 500: {err}");
        assert!(matches!(err, BrowseError::Root(_)));

        for bad_request in ["/etc", "/"] {
            let err = list_dirs(Some(bad_request), Some(&r.path), DotDirs::Hidden).await.unwrap_err();
            assert!(err.is_client_error(), "{bad_request}: {err}");
        }
        let err = resolve_inside_root(Some("/etc"), &r.path).await.unwrap_err();
        assert!(err.is_client_error(), "{err}");
    }

    /* ---- label_for ---- */

    /// Built directly, which only this module can do. There used to be a second
    /// test here for a path *outside* the root showing as a bare name; that
    /// input is no longer a `WithinRoot` anyone can construct, so the case is
    /// gone rather than asserted.
    fn within(path: &str, root: &str) -> WithinRoot {
        WithinRoot { path: path_of(path), root: path_of(root) }
    }

    #[test]
    fn shows_the_root_as_tilde_and_descendants_relative_to_it() {
        assert_eq!(within("/home/me", "/home/me").label(), "~");
        assert_eq!(within("/home/me/Projects", "/home/me").label(), "~/Projects");
        assert_eq!(within("/home/me/a/b", "/home/me").label(), "~/a/b");
    }

    /// INV-9 by type: the parent of a contained path is contained, and the
    /// root has none. No `is_inside` runs here — there is nothing left for it
    /// to refuse.
    #[test]
    fn inv9_a_parent_is_within_the_same_root_or_absent() {
        assert!(within("/home/me", "/home/me").parent().is_none());
        let up = within("/home/me/a/b", "/home/me").parent().unwrap();
        assert_eq!(up.path(), path_of("/home/me/a"));
        assert_eq!(up.root(), path_of("/home/me"));
        assert_eq!(up.parent().unwrap().path(), path_of("/home/me"));
        assert!(up.parent().unwrap().parent().is_none());
    }
}
