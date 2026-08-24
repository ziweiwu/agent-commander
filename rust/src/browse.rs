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
//! Listing is metadata only: names and directory-ness. It never reads a file.

#![allow(dead_code)]

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

/// Resolve a requested path and refuse anything outside the root.
///
/// Resolution happens before the check, so `~/link-to-slash` is judged by
/// where it points rather than by what it is called. Doing it the other way
/// round — check the string, then follow it — is the bug this ordering exists
/// to prevent.
pub async fn resolve_inside_root(requested: Option<&str>, root: &Path) -> Res<PathBuf> {
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
    Ok(real)
}

/// The root the picker is confined to when none was configured.
pub fn default_root() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// List the subdirectories of a path, contained to the root.
pub async fn list_dirs(
    requested: Option<&str>,
    root: Option<&Path>,
    include_hidden: bool,
) -> Res<DirListing> {
    let configured = root.map(Path::to_path_buf).unwrap_or_else(default_root);
    let root = tokio::fs::canonicalize(&configured)
        .await
        .map_err(|_| BrowseError::root(format!("no such directory: {}", configured.display())))?;
    let path = resolve_inside_root(requested, &root).await?;

    let info = tokio::fs::metadata(&path)
        .await
        .map_err(|_| BrowseError::new(format!("no such directory: {}", path.display())))?;
    if !info.is_dir() {
        return Err(BrowseError::new(format!("not a directory: {}", path.display())));
    }

    let mut read = tokio::fs::read_dir(&path)
        .await
        .map_err(|_| BrowseError::new(format!("cannot read directory: {}", path.display())))?;

    let mut entries: Vec<DirEntryDto> = Vec::new();
    loop {
        let next = read
            .next_entry()
            .await
            .map_err(|_| BrowseError::new(format!("cannot read directory: {}", path.display())))?;
        let Some(entry) = next else { break };

        let name = entry.file_name().to_string_lossy().into_owned();
        let hidden = name.starts_with('.');
        if hidden && !include_hidden {
            continue;
        }
        let child = path.join(&name);
        // `file_type()` would be cheaper, but a symlinked project directory is
        // common and should still be offered; `metadata` follows the link.
        // An unreadable entry or a broken symlink is skipped rather than
        // failing the whole listing.
        match tokio::fs::metadata(&child).await {
            Ok(meta) if meta.is_dir() => entries.push(DirEntryDto {
                name,
                path: child.to_string_lossy().into_owned(),
                hidden,
            }),
            _ => {}
        }
    }

    // `localeCompare` in the TypeScript, which orders case-insensitively and
    // breaks ties on the raw string. A byte-order sort would put every
    // capitalised folder above every lowercase one, which is not what the
    // picker looked like before.
    entries.sort_by(|a, b| {
        a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name))
    });

    // The parent is offered only when it is still inside the root — this is
    // the ".." button, and it must not be the way out.
    let parent_path = crate::options::normalize(&path.join(".."));
    let parent = if path == root || !is_inside(&root, &parent_path) {
        None
    } else {
        Some(parent_path.to_string_lossy().into_owned())
    };

    Ok(DirListing {
        path: path.to_string_lossy().into_owned(),
        parent,
        root: root.to_string_lossy().into_owned(),
        entries,
    })
}

/// Display label for a path, relative to the root.
pub fn label_for(path: &Path, root: &Path) -> String {
    if path == root {
        return "~".to_string();
    }
    match path.strip_prefix(root) {
        Ok(rest) => format!("~/{}", rest.to_string_lossy()),
        Err(_) => path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
    }
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

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    /* ---- is_inside ---- */

    #[test]
    fn inv9_is_inside_accepts_the_root_and_its_descendants() {
        assert!(is_inside(&p("/a"), &p("/a")));
        assert!(is_inside(&p("/a"), &p("/a/b")));
        assert!(is_inside(&p("/a"), &p("/a/b/c/d")));
    }

    /// The bug a naive `startsWith` would have: `/abc` is not inside `/a`.
    #[test]
    fn inv9_is_inside_rejects_a_sibling_that_merely_shares_a_prefix() {
        assert!(!is_inside(&p("/a"), &p("/abc")));
        assert!(!is_inside(&p("/home/me"), &p("/home/melissa/secrets")));
        assert!(!is_inside(&p("/home/me"), &p("/home/me-backup")));
    }

    #[test]
    fn inv9_is_inside_rejects_anything_above_the_root() {
        assert!(!is_inside(&p("/a/b"), &p("/a")));
        assert!(!is_inside(&p("/a/b"), &p("/")));
    }

    /* ---- resolve_inside_root ---- */

    #[tokio::test]
    async fn resolve_defaults_to_the_root() {
        let r = root();
        assert_eq!(resolve_inside_root(None, &r.path).await.unwrap(), r.path);
        // An empty or whitespace-only request is the same as none.
        for blank in ["", "   "] {
            assert_eq!(resolve_inside_root(Some(blank), &r.path).await.unwrap(), r.path);
        }
    }

    #[tokio::test]
    async fn resolve_resolves_a_directory_inside_the_root() {
        let r = root();
        let want = r.path.join("Projects");
        let got = resolve_inside_root(Some(want.to_str().unwrap()), &r.path).await.unwrap();
        assert_eq!(got, want);
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
        let listing = list_dirs(None, Some(&r.path), false).await.unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"Projects"));
        assert!(!names.contains(&"notes.txt"));
    }

    #[tokio::test]
    async fn hides_dotfolders_unless_asked() {
        let r = root();
        let plain = list_dirs(None, Some(&r.path), false).await.unwrap();
        assert!(!plain.entries.iter().any(|e| e.name == ".hidden"));
        let with_hidden = list_dirs(None, Some(&r.path), true).await.unwrap();
        assert!(with_hidden.entries.iter().any(|e| e.name == ".hidden"));
        assert!(with_hidden.entries.iter().find(|e| e.name == ".hidden").unwrap().hidden);
    }

    #[tokio::test]
    async fn has_no_parent_at_the_root_and_one_below_it() {
        let r = root();
        assert!(list_dirs(None, Some(&r.path), false).await.unwrap().parent.is_none());
        let below = list_dirs(
            Some(r.path.join("Projects").to_str().unwrap()),
            Some(&r.path),
            false,
        )
        .await
        .unwrap();
        assert_eq!(below.parent.as_deref(), Some(r.path.to_str().unwrap()));
    }

    #[tokio::test]
    async fn inv9_refuses_to_list_outside_the_root() {
        let r = root();
        for outside in ["/etc", "/"] {
            assert!(list_dirs(Some(outside), Some(&r.path), false).await.is_err(), "{outside}");
        }
        let link = r.path.join("neighbour");
        assert!(list_dirs(Some(link.to_str().unwrap()), Some(&r.path), false).await.is_err());
    }

    /// A directory reached legitimately still never offers an entry outside
    /// the root, and an escaping symlink is not listed as a directory to walk
    /// into — it resolves outside, and `resolve_inside_root` refuses it on the
    /// next request.
    #[tokio::test]
    async fn inv9_a_listed_escaping_symlink_still_cannot_be_entered() {
        let r = root();
        let listing = list_dirs(None, Some(&r.path), false).await.unwrap();
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
            list_dirs(None, Some(&r.path), true).await.unwrap().entries.into_iter().map(|e| e.name).collect();
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
        let err = list_dirs(Some(file.to_str().unwrap()), Some(&r.path), false).await.unwrap_err();
        assert!(err.to_string().contains("not a directory"), "{err}");
    }

    /// The listing carries names and directory-ness and nothing else. If this
    /// ever grows a size or a preview, it has started reading files.
    #[tokio::test]
    async fn listing_is_metadata_only() {
        let r = root();
        let listing = list_dirs(None, Some(&r.path), true).await.unwrap();
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
        let err = list_dirs(None, Some(&missing_root), false).await.unwrap_err();
        assert!(!err.is_client_error(), "a mistyped --browse-root is a 500: {err}");
        assert!(matches!(err, BrowseError::Root(_)));

        for bad_request in ["/etc", "/"] {
            let err = list_dirs(Some(bad_request), Some(&r.path), false).await.unwrap_err();
            assert!(err.is_client_error(), "{bad_request}: {err}");
        }
        let err = resolve_inside_root(Some("/etc"), &r.path).await.unwrap_err();
        assert!(err.is_client_error(), "{err}");
    }

    /* ---- label_for ---- */

    #[test]
    fn shows_the_root_as_tilde_and_descendants_relative_to_it() {
        assert_eq!(label_for(&p("/home/me"), &p("/home/me")), "~");
        assert_eq!(label_for(&p("/home/me/Projects"), &p("/home/me")), "~/Projects");
        assert_eq!(label_for(&p("/home/me/a/b"), &p("/home/me")), "~/a/b");
    }

    /// A path outside the root has no relative form, so it shows as its own
    /// basename rather than leaking the rest of the machine's layout.
    #[test]
    fn shows_a_path_outside_the_root_as_a_bare_name() {
        assert_eq!(label_for(&p("/etc/ssh"), &p("/home/me")), "ssh");
        assert_eq!(label_for(&p("/home/melissa/x"), &p("/home/me")), "x");
    }
}
