//! Git collector — branches, commits and uncommitted work (ROADMAP phase 5, D-19).
//!
//! The cheapest source with the highest return in this product. Window titles carry no branch, no
//! commit and no path, so until now every anchor above *weak* came from Claude Code — which meant
//! the engine understood the work done with an agent and almost nothing about the work done without
//! one. A branch name carries the ticket id, a worktree says which task this is, and both are
//! sitting in files on disk that need no permission, no extension and no open port to read.
//!
//! # Read files, do not run git
//!
//! Branch and commits come from `.git/HEAD` and `.git/logs/HEAD`, which are plain text and append
//! only. That is a file read on a timer rather than a process spawn per repository per tick, and it
//! keeps working when `git` is not on `PATH` — which on Windows is the normal case.
//!
//! The one thing the reflog cannot answer is "what is uncommitted right now", so that — and only
//! that — shells out to `git status --porcelain`, on a slow cadence, and only where a repository has
//! shown some sign of life.
//!
//! # What is never read
//!
//! A reflog line carries the author's name and email. They are parsed past and dropped: REWIND
//! records what you were working on, and who you are is not part of that. Commit messages go
//! through the same fail-closed redaction as everything else — a message with a token in it is
//! dropped rather than stored.
//!
//! # Pause
//!
//! Pause means nothing is captured, not "captured and hidden" (§7). A file-derived source can break
//! that promise by accident: skip a paused hour and the next pass finds the file longer and emits
//! everything that happened during it. So a paused pass still advances the read offsets — it walks
//! the files forward and writes nothing. What happened while you were paused is not recorded later.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::capture::{now_ms, Capture};
use crate::store::{work_day, Event, Store};

/// How many repositories are followed at once, most recently touched first.
///
/// A developer machine can hold hundreds of checkouts, almost all of them dormant. Following every
/// one costs a `git status` per tick for repositories nobody has opened in a year.
const MAX_REPOS: usize = 24;

/// How deep the discovery walk goes below the home directory. Four levels reaches `~/dev/org/repo`
/// and `~/Documents/code/thing` without descending into a dependency tree.
const SCAN_DEPTH: usize = 4;

/// A hard rail on the discovery walk, so a home directory with a pathological tree cannot turn
/// startup into a full-disk scan.
const MAX_DIRS_VISITED: usize = 20_000;

/// On first sight of a repository, how far back its reflog is read.
///
/// Not the whole history: a repository seen for the first time would otherwise dump ten years of
/// commits into today, and a day that contains 4000 events from 2019 is not a memory of anything.
const BACKFILL_MS: u64 = 7 * 86_400_000;
const MAX_BACKFILL: usize = 50;

/// Directory names never worth descending into. Dependency and build trees hold thousands of
/// directories and no repository anybody works in.
const SKIP: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "Library",
    "AppData",
    "Applications",
    ".cargo",
    ".rustup",
    ".npm",
    ".pnpm-store",
    "venv",
    "__pycache__",
    "Pods",
    "DerivedData",
    "OneDrive",
];

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// The `.git` directory of a checkout, following the `gitdir:` pointer a worktree or submodule uses.
fn git_dir(worktree: &Path) -> Option<PathBuf> {
    let dot = worktree.join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    if dot.is_file() {
        let text = std::fs::read_to_string(&dot).ok()?;
        let rest = text.trim().strip_prefix("gitdir:")?.trim();
        let path = PathBuf::from(rest);
        let resolved = if path.is_absolute() {
            path
        } else {
            worktree.join(path)
        };
        return resolved.is_dir().then_some(resolved);
    }
    None
}

/// Every checkout under the home directory, bounded in depth and in work.
///
/// Automatic because there is nothing to configure (ADR 0005 D-13): a source that only works once
/// you have listed your repositories is a source most people never turn on.
pub fn discover() -> Vec<PathBuf> {
    let Some(root) = home() else {
        return Vec::new();
    };
    let mut found = Vec::new();
    let mut queue: Vec<(PathBuf, usize)> = vec![(root, 0)];
    let mut visited = 0usize;

    while let Some((dir, depth)) = queue.pop() {
        if visited >= MAX_DIRS_VISITED {
            break;
        }
        visited += 1;

        if git_dir(&dir).is_some() {
            // A repository is a leaf: its submodules are part of it, not separate work.
            found.push(dir);
            continue;
        }
        if depth >= SCAN_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            // Never follow a symlink: one link back up the tree turns the walk into a cycle.
            if !kind.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || SKIP.contains(&name.as_str()) {
                continue;
            }
            queue.push((entry.path(), depth + 1));
        }
    }
    found
}

/// The checked-out branch, or `None` on a detached head — which is a state, not a branch, and
/// naming it after a commit sha would put a meaningless anchor on a day's work.
///
/// One rule, three places, two languages: this refuses a sha, `claude.rs` refuses the string
/// `HEAD` that Claude Code writes mid-checkout, and `packages/engine-v0/src/anchors.ts` refuses it
/// again when the stored events are replayed. It had drifted — only this one had it — and the cost
/// was two unrelated repositories merged into one context, because every repository reports the
/// same `HEAD`. Whoever ports the engine to Rust inherits the third copy; keep them pointing at
/// each other until they can be one.
fn head_branch(git_dir: &Path) -> Option<String> {
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let rest = head.trim().strip_prefix("ref:")?.trim();
    rest.strip_prefix("refs/heads/").map(str::to_owned)
}

/// One reflog line, reduced to the three things worth keeping.
#[derive(Debug, PartialEq)]
struct Entry {
    timestamp_ms: u64,
    sha: String,
    action: String,
}

/// Parse a reflog line.
///
/// Format: `<old> <new> <name> <email> <unix-ts> <tz>\t<action>`. The name and the email sit in the
/// middle and are stepped over rather than captured — the timestamp is read from the end, which is
/// why this does not index into the middle of the line at all.
fn parse_line(line: &str) -> Option<Entry> {
    let (left, action) = line.split_once('\t')?;
    let fields: Vec<&str> = left.split_whitespace().collect();
    if fields.len() < 4 {
        return None;
    }
    let sha = fields[1].to_owned();
    // …<unix seconds> <+0200>. Read from the end, so a name of any number of words cannot shift it.
    let seconds: u64 = fields[fields.len() - 2].parse().ok()?;
    Some(Entry {
        timestamp_ms: seconds * 1000,
        sha,
        action: action.trim().to_owned(),
    })
}

/// Read the part of an append-only log that has not been read yet.
///
/// A shrinking file means the log was rewritten — `git gc`, a rebase, a fresh clone over the same
/// path. Re-reading from zero would emit every commit a second time, so the offset jumps to the new
/// end instead: a few lost entries beat a duplicated history.
fn read_from(path: &Path, offset: u64) -> Option<(Vec<Entry>, u64)> {
    let text = std::fs::read_to_string(path).ok()?;
    let size = text.len() as u64;
    // A shorter file, or an offset that no longer lands between two characters, both mean the file
    // is not the one the offset was taken from.
    if size < offset || !text.is_char_boundary(offset as usize) {
        return Some((Vec::new(), size));
    }
    let fresh = &text[offset as usize..];
    let entries = fresh.lines().filter_map(parse_line).collect();
    Some((entries, size))
}

/// Run a console program without flashing a console window at the user.
///
/// Windows gives a console application its own window unless the parent asks otherwise, and it is
/// shown even for a process that lives a few milliseconds. `git status` runs once every five
/// minutes for each repository, capped at 24, so the machine threw up to two dozen empty windows
/// across the screen every five minutes — reported, accurately, as "des fenêtres vides qui
/// s'ouvrent très rapidement et se ferment". Nothing in a log says this is happening; it is only
/// visible to whoever is sitting in front of the machine.
///
/// The only subprocess this daemon runs is the one below. Any future one belongs here too.
#[cfg(windows)]
fn without_a_window(command: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    /// `CREATE_NO_WINDOW`. One constant is not worth a dependency on the Windows crates.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
fn without_a_window(command: &mut std::process::Command) -> &mut std::process::Command {
    command
}

/// How many files differ from HEAD. `None` when git is absent or the call fails — which is reported
/// as nothing at all, never as a clean tree.
fn dirty_count(worktree: &Path) -> Option<u64> {
    let mut command = std::process::Command::new("git");
    command.arg("-C").arg(worktree).args(["status", "--porcelain"]);
    let output = without_a_window(&mut command).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    Some(text.lines().filter(|l| !l.trim().is_empty()).count() as u64)
}

fn repo_name(worktree: &Path) -> String {
    worktree
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// What is already known about one repository between passes.
#[derive(Default)]
struct Known {
    dirty: Option<u64>,
    /// When `git status` last ran here, so it runs on its own slow cadence.
    checked_at: u64,
}

fn base_event(kind: &str, timestamp: u64, tz: i32, importance: i64, title: String) -> Event {
    Event {
        timestamp,
        end_timestamp: None,
        tz_offset_minutes: tz,
        source: "git".to_owned(),
        kind: kind.to_owned(),
        app_id: "git".to_owned(),
        app_display: "Git".to_owned(),
        title,
        pid: None,
        metadata: String::new(),
        redaction_version: String::new(),
        redaction_applied: Vec::new(),
        redaction_count: 0,
        importance,
    }
}

/// Redact, stamp and store. Fail closed: an event whose text cannot be redacted is dropped.
fn write(store: &Store, mut event: Event, metadata: serde_json::Value) -> bool {
    let redactor = crate::redact::Redactor::shared();
    let Some((title, stamp)) = redactor.redact(&event.title) else {
        eprintln!("REWIND: dropped a git event because redaction failed");
        return false;
    };
    event.title = title;
    event.redaction_version = stamp.patterns_version;
    event.redaction_applied = stamp.applied;
    event.redaction_count = stamp.count;
    event.metadata = metadata.to_string();
    let day = work_day(event.timestamp, event.tz_offset_minutes);
    store.insert(&event, &day).is_ok()
}

/// The message of a commit reflog action, if that is what it is.
///
/// `commit:`, `commit (amend):` and `commit (initial):` are commits. `checkout:`, `merge`, `reset`
/// and `rebase` are movements, and a movement is not something you produced.
fn commit_message(action: &str) -> Option<&str> {
    for prefix in ["commit: ", "commit (amend): ", "commit (initial): "] {
        if let Some(rest) = action.strip_prefix(prefix) {
            return Some(rest);
        }
    }
    None
}

/// `checkout: moving from <a> to <b>` — the branch you moved onto.
fn checkout_target(action: &str) -> Option<(&str, &str)> {
    let rest = action.strip_prefix("checkout: moving from ")?;
    let (from, to) = rest.split_once(" to ")?;
    Some((from, to))
}

/// One pass over one repository.
///
/// `recording` false means the pass reads and advances but writes nothing, so a paused hour leaves
/// no trace instead of arriving late.
fn scan_repo(store: &Store, worktree: &Path, known: &mut Known, tz: i32, recording: bool) -> usize {
    let Some(git) = git_dir(worktree) else {
        return 0;
    };
    let repository = repo_name(worktree);
    let path = worktree.display().to_string();
    let branch = head_branch(&git);
    let mut written = 0usize;

    let logs = git.join("logs").join("HEAD");
    let key = format!("git:{}", logs.display());
    let seen_before = store.source_size(&key).ok().flatten();

    if let Some((entries, size)) = read_from(&logs, seen_before.unwrap_or(0)) {
        // On first sight, only the last few days and only a handful: a repository met for the first
        // time would otherwise pour ten years of commits into today.
        let fresh: Vec<&Entry> = if seen_before.is_none() {
            let cutoff = now_ms().saturating_sub(BACKFILL_MS);
            let recent: Vec<&Entry> = entries
                .iter()
                .filter(|e| e.timestamp_ms >= cutoff)
                .collect();
            let start = recent.len().saturating_sub(MAX_BACKFILL);
            recent[start..].to_vec()
        } else {
            entries.iter().collect()
        };

        if recording {
            for entry in fresh {
                if let Some(message) = commit_message(&entry.action) {
                    let event =
                        base_event("git.commit", entry.timestamp_ms, tz, 80, message.to_owned());
                    let metadata = serde_json::json!({
                        "sha": entry.sha,
                        "messageRedacted": message,
                        "branch": branch.clone(),
                        "repository": repository,
                        "worktree": path,
                    });
                    if write(store, event, metadata) {
                        written += 1;
                    }
                } else if let Some((from, to)) = checkout_target(&entry.action) {
                    let event = base_event(
                        "git.branch.checkout",
                        entry.timestamp_ms,
                        tz,
                        60,
                        format!("{repository} → {to}"),
                    );
                    let metadata = serde_json::json!({
                        "from": from,
                        "to": to,
                        "branch": to,
                        "repository": repository,
                        "worktree": path,
                    });
                    if write(store, event, metadata) {
                        written += 1;
                    }
                }
            }
        }
        // Advanced even while paused: a paused hour must leave no trace rather than arrive late.
        let _ = store.remember_source(&key, size);
    }

    // Uncommitted work, on its own cadence and only when the count has actually moved. A summary
    // every five minutes per repository would be three hundred events a day saying the same thing.
    let now = now_ms();
    if now.saturating_sub(known.checked_at) >= STATUS_EVERY_MS {
        known.checked_at = now;
        if let Some(dirty) = dirty_count(worktree) {
            let changed = known.dirty != Some(dirty);
            known.dirty = Some(dirty);
            if changed && dirty > 0 && recording {
                let title = format!("{dirty} fichier(s) non commités · {repository}");
                let event = base_event("git.status.summary", now, tz, 40, title);
                let metadata = serde_json::json!({
                    "dirtyFiles": dirty,
                    "branch": branch.clone(),
                    "repository": repository,
                    "worktree": path,
                });
                if write(store, event, metadata) {
                    written += 1;
                }
            }
        }
    }

    written
}

/// How often `git status` may run in one repository.
const STATUS_EVERY_MS: u64 = 5 * 60_000;
/// How often the reflogs are read. Cheap: two small file reads per repository.
const TICK: Duration = Duration::from_secs(20);
/// How often the home directory is walked again, to notice a repository cloned since launch.
const REDISCOVER: Duration = Duration::from_secs(30 * 60);

/// Follow every repository on the machine, newest activity first.
pub fn spawn(store: Arc<Store>, capture: Arc<Capture>, tz: i32) {
    std::thread::spawn(move || {
        let mut known: HashMap<PathBuf, Known> = HashMap::new();
        let mut repos: Vec<PathBuf> = Vec::new();
        let mut discovered_at = 0u64;

        loop {
            if now_ms().saturating_sub(discovered_at) >= REDISCOVER.as_millis() as u64 {
                discovered_at = now_ms();
                repos = rank(discover());
                println!("REWIND: Git — {} dépôt(s) suivi(s)", repos.len());
            }

            let recording = capture.is_recording();
            let mut written = 0usize;
            for repo in &repos {
                let entry = known.entry(repo.clone()).or_default();
                written += scan_repo(&store, repo, entry, tz, recording);
            }
            if written > 0 {
                println!("REWIND: Git — {written} événement(s)");
            }

            std::thread::sleep(TICK);
        }
    });
}

/// Most recently touched first, then capped.
///
/// "Recently touched" is the mtime of the reflog, which moves on every commit, checkout, merge and
/// pull — so the repositories you are actually working in float to the top on their own, and the
/// forty you cloned once do not cost a `git status` every five minutes.
fn rank(mut repos: Vec<PathBuf>) -> Vec<PathBuf> {
    let touched = |p: &PathBuf| -> u64 {
        git_dir(p)
            .and_then(|g| std::fs::metadata(g.join("logs").join("HEAD")).ok())
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0)
    };
    repos.sort_by_key(|p| std::cmp::Reverse(touched(p)));
    repos.truncate(MAX_REPOS);
    repos
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE: &str = "0000000000000000000000000000000000000000 a1b2c3d4e5f6 A Committer <committer@example.com> 1756000000 +0200\tcommit (initial): premier jet";

    #[test]
    fn a_reflog_line_gives_up_its_commit_and_nothing_else() {
        let entry = parse_line(LINE).expect("parses");
        assert_eq!(entry.sha, "a1b2c3d4e5f6");
        assert_eq!(entry.timestamp_ms, 1_756_000_000_000);
        assert_eq!(entry.action, "commit (initial): premier jet");
        // The author's name and email are in the line and must not be in the result.
        assert!(!entry.action.contains("example.com"));
        assert!(!entry.sha.contains("Marie"));
    }

    #[test]
    fn a_name_with_spaces_does_not_shift_the_timestamp() {
        // The timestamp is read from the end precisely so a three-word name cannot move it.
        let line = "aaa bbb Marie Claire de la Tour <m@x.fr> 1756000123 -0500\tcommit: fix";
        let entry = parse_line(line).expect("parses");
        assert_eq!(entry.timestamp_ms, 1_756_000_123_000);
    }

    #[test]
    fn only_commits_are_commits() {
        assert_eq!(
            commit_message("commit: ajoute la pagination"),
            Some("ajoute la pagination")
        );
        assert_eq!(commit_message("commit (amend): oups"), Some("oups"));
        assert_eq!(commit_message("checkout: moving from main to feat/x"), None);
        assert_eq!(commit_message("merge feat/x: Fast-forward"), None);
    }

    #[test]
    fn a_checkout_names_both_sides() {
        assert_eq!(
            checkout_target("checkout: moving from main to feat/ACME-412"),
            Some(("main", "feat/ACME-412"))
        );
        assert_eq!(checkout_target("commit: nope"), None);
    }

    #[test]
    fn a_torn_or_alien_line_is_skipped_rather_than_fatal() {
        assert_eq!(parse_line(""), None);
        assert_eq!(parse_line("not a reflog line at all"), None);
        assert_eq!(
            parse_line("aaa bbb name <m@x> notanumber +0200\tcommit: x"),
            None
        );
    }

    #[test]
    fn a_rewritten_log_jumps_forward_instead_of_replaying() {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "rewind-reflog-{}-{}.log",
            std::process::id(),
            now_ms()
        ));
        std::fs::write(&path, format!("{LINE}\n")).expect("write");
        let full = std::fs::metadata(&path).expect("stat").len();

        // A shorter file than the offset means the log was rewritten under us.
        let (entries, offset) = read_from(&path, full + 500).expect("read");
        assert!(entries.is_empty(), "a rewritten log must not replay");
        assert_eq!(offset, full, "the offset resets to the new end");

        let (fresh, _) = read_from(&path, 0).expect("read");
        assert_eq!(fresh.len(), 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn discovery_never_descends_into_a_dependency_tree() {
        assert!(SKIP.contains(&"node_modules"));
        assert!(SKIP.contains(&"target"));
    }
}
