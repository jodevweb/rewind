//! Terminal collector — the commands you ran and whether they worked (ROADMAP phase 6, §62).
//!
//! Until now "what failed" could only be answered for work done inside Claude Code, because that was
//! the only source that knew a command had been run at all. A shell hook closes that: a failing
//! `pnpm check` at 18:40 is the single most useful thing a resume can tell you the next morning, and
//! it is the one thing you never write down.
//!
//! # The transport, and why it is a directory of tiny files
//!
//! No local HTTP server, ever (ADR 0001 D-5), and the daemon never speaks back to the shell. So the
//! hook writes and REWIND reads, one file per command, deleted the moment it is read.
//!
//! One file per command rather than one growing log per session, because a log has to be read at an
//! offset while a shell is appending to it, and the failure mode of getting that wrong is a torn
//! line — that is, a command attributed to the wrong exit code. A file that is written once and
//! deleted once cannot tear.
//!
//! # The format, and why it is not JSON
//!
//! ```text
//! v=1
//! ts=1756000000000
//! exit=1
//! ms=4210
//! shell=zsh
//! cwd=/Users/j/dev/acme-web
//! cmd=pnpm check --filter @rewind/ui
//! ```
//!
//! `cmd` comes last and everything after it is the command, verbatim, to the end of the file. A
//! shell hook that has to emit valid JSON has to escape quotes, backslashes and newlines in a string
//! it did not write, in three different shells — and the first command containing a quote produces
//! either a parse error or, worse, a silently mangled command. Nothing here needs escaping.
//!
//! # What is on disk, and for how long
//!
//! The spool holds the command line unredacted for as long as it takes to read it — a second or two,
//! in a directory inside the user's own profile. That is deliberate and it is bounded: redaction
//! happens here, fail-closed, before anything is stored, and the spool file is deleted whether the
//! event was stored or dropped. The same command line is already in `~/.zsh_history` for ever, so
//! this adds no exposure that outlives the read.
//!
//! **The output of a command is never captured.** Only the command, its exit code and how long it
//! took. There is no `terminal.error_tail` here for that reason: the tail of an error is program
//! output, and REWIND does not read program output.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::capture::{now_ms, Capture};
use crate::platform::data_dir;
use crate::store::{work_day, Event, Store};

/// Commands longer than this are stored truncated. A 4 kB pasted one-liner is not a memory of
/// anything, and it is the shape a pasted secret arrives in.
const MAX_COMMAND: usize = 400;

/// A spool file older than this is stale — a shell that died mid-write, or a clock that moved. It is
/// deleted unread rather than replayed into the wrong day.
const MAX_AGE_MS: u64 = 6 * 3_600_000;

const TICK: Duration = Duration::from_secs(2);

pub fn spool_dir() -> PathBuf {
    data_dir().join("spool")
}

/// The file that tells a shell hook whether anybody is listening.
///
/// Without it the hook writes command lines into a directory nothing is reading — for as long as
/// REWIND happens to be closed, which could be a fortnight. The hook reads this file with a shell
/// builtin (no process spawn, so it costs nothing per prompt) and stays silent unless the stamp in
/// it is recent. Closing REWIND stops the collection at the source rather than downstream of it.
pub fn heartbeat_path() -> PathBuf {
    spool_dir().join(".alive")
}

/// One command, as the hook reported it.
#[derive(Debug, Default, PartialEq)]
struct Command {
    version: u32,
    timestamp: u64,
    exit_code: i64,
    duration_ms: u64,
    shell: String,
    cwd: String,
    command: String,
}

/// Parse the spool format. `cmd=` takes the rest of the file, so a command containing newlines,
/// quotes or `=` arrives intact.
fn parse(text: &str) -> Option<Command> {
    let mut out = Command::default();
    let mut rest = text;

    while !rest.is_empty() {
        let (line, tail) = match rest.split_once('\n') {
            Some((line, tail)) => (line, tail),
            None => (rest, ""),
        };
        let Some((key, value)) = line.split_once('=') else {
            rest = tail;
            continue;
        };
        match key.trim() {
            "v" => out.version = value.trim().parse().ok()?,
            "ts" => out.timestamp = value.trim().parse().ok()?,
            "exit" => out.exit_code = value.trim().parse().unwrap_or(-1),
            "ms" => out.duration_ms = value.trim().parse().unwrap_or(0),
            "shell" => out.shell = value.trim().to_owned(),
            "cwd" => out.cwd = value.trim().to_owned(),
            "cmd" => {
                // Everything from here to the end, verbatim.
                let start = line.len() - value.len();
                out.command = rest[start..].trim_end_matches(['\n', '\r']).to_owned();
                rest = "";
                continue;
            }
            _ => {}
        }
        rest = tail;
    }

    if out.version != 1 || out.timestamp == 0 || out.command.trim().is_empty() {
        return None;
    }
    if out.command.chars().count() > MAX_COMMAND {
        out.command = out.command.chars().take(MAX_COMMAND).collect::<String>() + "…";
    }
    Some(out)
}

fn event_for(command: &Command, tz: i32) -> Event {
    Event {
        timestamp: command.timestamp,
        end_timestamp: if command.duration_ms > 0 {
            Some(command.timestamp + command.duration_ms)
        } else {
            None
        },
        tz_offset_minutes: tz,
        source: "terminal".to_owned(),
        kind: "terminal.command".to_owned(),
        app_id: if command.shell.is_empty() {
            "shell".to_owned()
        } else {
            command.shell.clone()
        },
        app_display: "Terminal".to_owned(),
        title: command.command.clone(),
        pid: None,
        metadata: String::new(),
        redaction_version: String::new(),
        redaction_applied: Vec::new(),
        redaction_count: 0,
        // A command that failed is the one you come back to. It outranks one that worked.
        importance: if command.exit_code == 0 { 45 } else { 75 },
    }
}

/// One pass over the spool. Every file is removed, read or not: a file left behind is a command line
/// left on disk, and the next pass would emit it a second time.
fn drain(store: &Store, tz: i32, recording: bool) -> usize {
    let dir = spool_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let redactor = crate::redact::Redactor::shared();
    let mut written = 0usize;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("cmd") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let _ = std::fs::remove_file(&path);

        // Pause means nothing is captured, not captured-and-hidden (§7). The file is still removed.
        if !recording {
            continue;
        }
        let Some(command) = parse(&text) else {
            continue;
        };
        if now_ms().saturating_sub(command.timestamp) > MAX_AGE_MS {
            continue;
        }

        let mut event = event_for(&command, tz);
        // Fail closed. A command whose secrets cannot be masked is dropped, never stored.
        let Some((title, stamp)) = redactor.redact(&event.title) else {
            eprintln!("REWIND: dropped a terminal command because redaction failed");
            continue;
        };
        event.title = title.clone();
        event.redaction_version = stamp.patterns_version;
        event.redaction_applied = stamp.applied;
        event.redaction_count = stamp.count;
        event.metadata = serde_json::json!({
            "commandRedacted": title,
            "exitCode": command.exit_code,
            "durationMs": command.duration_ms,
            "cwd": command.cwd,
            "shell": command.shell,
        })
        .to_string();

        let day = work_day(event.timestamp, event.tz_offset_minutes);
        if store.insert(&event, &day).is_ok() {
            written += 1;
        }
    }
    written
}

/// Read the spool for as long as the daemon runs.
///
/// The directory is created here rather than by the hook: a hook that has to create directories is a
/// hook that fails silently in the one shell where it does not have permission to.
pub fn spawn(store: Arc<Store>, capture: Arc<Capture>, tz: i32) {
    std::thread::spawn(move || {
        let dir = spool_dir();
        if let Err(err) = std::fs::create_dir_all(&dir) {
            eprintln!("REWIND: no terminal spool at {} — {err}", dir.display());
            return;
        }
        println!("REWIND: terminal spool at {}", dir.display());

        loop {
            // Stamped before the drain, and stamped even while paused: a paused REWIND is still
            // running, and a hook that stopped writing during a pause would make the pause
            // indistinguishable from the application being closed.
            let _ = std::fs::write(heartbeat_path(), now_ms().to_string());

            let written = drain(&store, tz, capture.is_recording());
            if written > 0 {
                println!("REWIND: terminal — {written} commande(s)");
            }
            std::thread::sleep(TICK);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "v=1\nts=1756000000000\nexit=1\nms=4210\nshell=zsh\ncwd=/Users/j/dev/acme\ncmd=pnpm check --filter @rewind/ui\n";

    #[test]
    fn parses_a_command_the_hook_wrote() {
        let parsed = parse(SAMPLE).expect("parses");
        assert_eq!(parsed.timestamp, 1_756_000_000_000);
        assert_eq!(parsed.exit_code, 1);
        assert_eq!(parsed.duration_ms, 4210);
        assert_eq!(parsed.shell, "zsh");
        assert_eq!(parsed.cwd, "/Users/j/dev/acme");
        assert_eq!(parsed.command, "pnpm check --filter @rewind/ui");
    }

    /// The reason the format is not JSON: none of this needs escaping, and all of it is normal.
    #[test]
    fn a_command_full_of_quotes_equals_and_newlines_survives_intact() {
        let raw = "v=1\nts=1756000000000\nexit=0\ncmd=git commit -m \"fix: don't = break\"\nand more\n";
        let parsed = parse(raw).expect("parses");
        assert_eq!(parsed.command, "git commit -m \"fix: don't = break\"\nand more");
    }

    #[test]
    fn a_long_command_is_truncated_rather_than_stored_whole() {
        let long = "x".repeat(2000);
        let parsed = parse(&format!("v=1\nts=1756000000000\ncmd={long}\n")).expect("parses");
        assert_eq!(parsed.command.chars().count(), MAX_COMMAND + 1, "truncated, with a marker");
    }

    #[test]
    fn a_file_from_a_future_version_or_a_torn_write_is_refused() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("v=2\nts=1\ncmd=ls\n"), None, "an unknown version is not guessed at");
        assert_eq!(parse("v=1\ncmd=ls\n"), None, "no timestamp, no place in the day");
        assert_eq!(parse("v=1\nts=1756000000000\ncmd=   \n"), None, "an empty command is not one");
    }

    #[test]
    fn a_failing_command_outranks_one_that_worked() {
        let ok = parse("v=1\nts=1756000000000\nexit=0\ncmd=ls\n").expect("parses");
        let bad = parse("v=1\nts=1756000000000\nexit=1\ncmd=ls\n").expect("parses");
        assert!(event_for(&bad, 60).importance > event_for(&ok, 60).importance);
    }

    #[test]
    fn a_command_that_reported_no_duration_has_no_end() {
        let instant = parse("v=1\nts=1756000000000\nexit=0\ncmd=cd ..\n").expect("parses");
        assert_eq!(event_for(&instant, 60).end_timestamp, None);
    }
}
