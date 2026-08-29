//! Capture state and the collection loop.
//!
//! Three product rules are structural here, not cosmetic:
//!
//!   - **Capture runs continuously.** There is no "start a session" — the user pauses, they never
//!     start (§7, §84). Wanting a start button is a symptom of modelling it wrong.
//!   - **Pause means nothing is captured**, not hidden afterwards (§7). The check is at the top of
//!     the loop, before an event is constructed, so a paused daemon builds nothing to discard.
//!   - **Nothing reaches the store unredacted** (PRIVACY §4.2). Redaction runs between the OS and
//!     SQLite, and a failure drops the event rather than persisting it.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::platform::{
    ActiveWindowProvider, IdleProvider, PlatformActiveWindow, PlatformIdle, TitleAccess,
};
use crate::redact::Redactor;
use crate::store::{work_day, DaySummary, Event, Store};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn local_offset_minutes() -> i32 {
    // Tauri targets have a system timezone; deriving the offset from the difference between local
    // and UTC formatting is more portable here than pulling in a date library for one number.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let local = time_local_offset_seconds(now);
    (local / 60) as i32
}

#[cfg(unix)]
fn time_local_offset_seconds(_now: i64) -> i64 {
    // `date +%z` is present on every Unix REWIND targets and needs no dependency.
    std::process::Command::new("date")
        .arg("+%z")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| parse_offset(s.trim()))
        .unwrap_or(0)
}

#[cfg(windows)]
fn time_local_offset_seconds(_now: i64) -> i64 {
    // GetTimeZoneInformation returns Bias in minutes *west* of UTC, so the sign is inverted.
    use windows::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};
    let mut info = TIME_ZONE_INFORMATION::default();
    let id = unsafe { GetTimeZoneInformation(&mut info) };
    let bias = match id {
        2 => info.Bias + info.DaylightBias,
        _ => info.Bias + info.StandardBias,
    };
    (-bias as i64) * 60
}

#[cfg(unix)]
fn parse_offset(text: &str) -> Option<i64> {
    let sign = if text.starts_with('-') { -1 } else { 1 };
    let digits: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 4 {
        return None;
    }
    let hours: i64 = digits[..2].parse().ok()?;
    let minutes: i64 = digits[2..4].parse().ok()?;
    Some(sign * (hours * 3600 + minutes * 60))
}

/// This application, so the capture loop can skip its own window.
///
/// Kept in step with `identifier` in tauri.conf.json by a test below, because a silent mismatch
/// here would quietly reintroduce the very noise this exists to remove.
const SELF_BUNDLE_ID: &str = "com.danim.rewind";

/// How long without input before the machine counts as unattended.
///
/// Long enough that reading a page, watching a build or thinking does not end your span; short
/// enough that a coffee break is not filed as work. Five minutes is the figure §69 assumes.
const IDLE_MS: u64 = 5 * 60_000;

/// How much a span of this length is worth remembering.
///
/// Short spans are kept and scored low rather than dropped: noise reduction is a display concern,
/// and statistics need a complete log. Extracted because idle now closes spans too, and the two
/// paths must not drift into scoring the same duration differently.
fn importance_for(ms: u64) -> i64 {
    if ms < 5_000 {
        5
    } else if ms < 60_000 {
        15
    } else {
        30
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub recording: bool,
    pub paused_until: Option<u64>,
    pub events_today: u64,
    pub events_total: u64,
    pub title_access: &'static str,
    pub platform: &'static str,
    pub store_path: String,
    /// What the platform provider last observed, verbatim. Shown in the window so a permission
    /// problem reads as a sentence rather than as an empty screen.
    pub diagnostics: String,
}

pub struct Capture {
    recording: AtomicBool,
    paused_until: AtomicU64,
    title_access: Mutex<TitleAccess>,
    diagnostics: Mutex<String>,
    store: Arc<Store>,
}

impl Capture {
    pub fn new(store: Arc<Store>) -> Self {
        Self {
            recording: AtomicBool::new(true),
            paused_until: AtomicU64::new(0),
            title_access: Mutex::new(TitleAccess::Granted),
            diagnostics: Mutex::new(String::new()),
            store,
        }
    }

    pub fn is_recording(&self) -> bool {
        if !self.recording.load(Ordering::Relaxed) {
            let until = self.paused_until.load(Ordering::Relaxed);
            // A timed pause resumes on its own; an indefinite one (0) does not.
            if until != 0 && now_ms() >= until {
                self.recording.store(true, Ordering::Relaxed);
                self.paused_until.store(0, Ordering::Relaxed);
                return true;
            }
            return false;
        }
        true
    }

    /// `minutes == 0` pauses until explicitly resumed.
    pub fn pause(&self, minutes: u64) {
        self.recording.store(false, Ordering::Relaxed);
        self.paused_until.store(
            if minutes == 0 {
                0
            } else {
                now_ms() + minutes * 60_000
            },
            Ordering::Relaxed,
        );
    }

    pub fn resume(&self) {
        self.recording.store(true, Ordering::Relaxed);
        self.paused_until.store(0, Ordering::Relaxed);
    }

    pub fn status(&self) -> CaptureStatus {
        let recording = self.is_recording();
        let until = self.paused_until.load(Ordering::Relaxed);
        let tz = local_offset_minutes();
        CaptureStatus {
            recording,
            paused_until: if recording || until == 0 {
                None
            } else {
                Some(until)
            },
            events_today: self
                .store
                .count_for_day(&work_day(now_ms(), tz))
                .unwrap_or(0),
            events_total: self.store.total().unwrap_or(0),
            title_access: match *self.title_access.lock().expect("title access") {
                TitleAccess::Granted => "granted",
                TitleAccess::Denied => "denied",
                TitleAccess::NotRequired => "not_required",
            },
            platform: if cfg!(target_os = "macos") {
                "macos"
            } else if cfg!(target_os = "windows") {
                "windows"
            } else {
                "other"
            },
            store_path: self.store.path().display().to_string(),
            diagnostics: self.diagnostics.lock().expect("diagnostics").clone(),
        }
    }

    pub fn recent(&self, limit: usize) -> Vec<Event> {
        self.store.recent(limit).unwrap_or_default()
    }

    pub fn for_day(&self, day: &str, limit: usize) -> Vec<Event> {
        self.store.for_day(day, limit).unwrap_or_default()
    }

    pub fn days(&self, limit: usize) -> Vec<DaySummary> {
        self.store.days(limit).unwrap_or_default()
    }
}

/// The collection loop.
///
/// Polling at one second is the placeholder the provider interface hides; P2-004 replaces it with
/// `SetWinEventHook` on Windows and `NSWorkspace` notifications on macOS, and nothing outside the
/// provider changes when it does.
#[allow(clippy::default_constructed_unit_structs)]
pub fn spawn(capture: Arc<Capture>) {
    std::thread::spawn(move || {
        let mut window = PlatformActiveWindow::default();
        let idle = PlatformIdle::default();
        let redactor = Redactor::shared();
        let mut last_key = String::new();
        let mut open: Option<(i64, u64)> = None;

        loop {
            std::thread::sleep(Duration::from_secs(1));

            // Pause is checked before anything is read, so a paused daemon does not construct an
            // event and then throw it away — it never builds one (§7).
            if !capture.is_recording() {
                last_key.clear();
                continue;
            }

            // Nobody is here.
            //
            // A focus span is closed when focus moves. Nothing moves while the machine sleeps, so a
            // window left in front at 01:56 held its span until 09:40 — seven hours and forty
            // minutes of "activity" on a game nobody was playing. That span then bracketed the
            // whole night and pulled it into the day's work.
            //
            // §69 always said durations exclude idle time, and the idle reading was taken and
            // thrown away. It is used now: past the threshold the open span is closed *at the
            // moment input stopped*, not at the moment we noticed, and nothing new opens until
            // somebody comes back.
            let idle_ms = idle.idle().as_millis() as u64;
            if idle_ms >= IDLE_MS {
                if let Some((row_id, started)) = open.take() {
                    let stopped = now_ms().saturating_sub(idle_ms).max(started);
                    let ms = stopped.saturating_sub(started);
                    let _ = capture
                        .store
                        .close_span(row_id, stopped, importance_for(ms));
                }
                // Coming back is a new event, not a continuation of the one you walked away from.
                last_key.clear();
                continue;
            }

            let Some(snapshot) = window.current() else {
                continue;
            };
            *capture.title_access.lock().expect("title access") = window.title_access();
            *capture.diagnostics.lock().expect("diagnostics") = window.diagnostics();

            // Never record REWIND looking at itself.
            //
            // Opening the window to read your own day is not part of your day, and recording it
            // makes the tool the subject of everything it observes: contexts named after this
            // application, an application chain that always begins with it, and time attributed
            // to consulting rather than to working. The more useful the window is, the more it
            // corrupts what it shows — which is the worst shape a measurement error can take.
            //
            // The open span is left alone. Reading your history for a minute is an excursion
            // from what you were doing, not the end of it, and closing the span here would cut
            // a piece of work in two every time you glanced at the window.
            if snapshot.app_id == SELF_BUNDLE_ID {
                continue;
            }

            let key = format!("{}|{}", snapshot.app_id, stable_title(&snapshot.title));
            if key == last_key {
                continue;
            }
            last_key = key;

            let ts = now_ms();

            // Close the previous span before opening the next. Short spans are kept and scored low
            // rather than discarded: noise reduction is a display concern, and statistics need a
            // complete log.
            if let Some((row_id, started)) = open.take() {
                let ms = ts.saturating_sub(started);
                let _ = capture.store.close_span(row_id, ts, importance_for(ms));
            }

            // A titleless event is still an event: without Accessibility the application name is
            // all there is, and showing that beats showing nothing (ADR 0003 D-22).

            // Fail closed. If redaction cannot complete, the event is dropped — never stored.
            let Some((title, stamp)) = redactor.redact(&snapshot.title) else {
                eprintln!("REWIND: dropped an event because redaction failed");
                continue;
            };

            let tz = local_offset_minutes();
            let event = Event {
                timestamp: ts,
                end_timestamp: None,
                tz_offset_minutes: tz,
                source: "system".to_owned(),
                kind: "system.window.focus".to_owned(),
                app_id: snapshot.app_id,
                app_display: snapshot.app_display,
                title,
                pid: snapshot.pid,
                metadata: "{}".to_owned(),
                redaction_version: stamp.patterns_version,
                redaction_applied: stamp.applied,
                redaction_count: stamp.count,
                importance: 30,
            };

            match capture.store.insert(&event, &work_day(ts, tz)) {
                Ok(row_id) => open = Some((row_id, ts)),
                Err(err) => eprintln!("REWIND: could not persist an event: {err}"),
            }
        }
    });
}

/// Strip spinner and progress glyphs so a terminal running an agent does not emit an event a second.
/// The real-world form of the title-churn coalescing rule in EVENT_MODEL §5.
fn stable_title(title: &str) -> String {
    title
        .chars()
        .filter(|c| {
            !matches!(
                *c as u32,
                0x2190..=0x21FF | 0x25A0..=0x25FF | 0x2600..=0x27BF | 0x1F000..=0x1FAFF
            )
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_self_bundle_id_matches_the_manifest() {
        // A hardcoded identifier that drifts from tauri.conf.json fails silently: capture simply
        // starts recording this application again, and the noise looks like a regression in the
        // engine rather than a stale constant.
        let manifest = include_str!("../tauri.conf.json");
        let needle = format!("\"identifier\": \"{}\"", SELF_BUNDLE_ID);
        assert!(
            manifest.contains(&needle),
            "SELF_BUNDLE_ID is {} but tauri.conf.json says otherwise",
            SELF_BUNDLE_ID
        );
    }

    /// A store of its own, in a temporary directory. A test must never touch the user's database.
    ///
    /// The name was built from the process id and the millisecond clock. Cargo runs tests in
    /// parallel threads of ONE process, so two tests starting in the same millisecond got the same
    /// path and raced on it — passing or failing depending on timing. A counter removes the
    /// coincidence entirely, which is better than making the collision rarer.
    fn capture() -> Capture {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        let mut path = std::env::temp_dir();
        path.push(format!(
            "rewind-test-{}-{}-{}.db",
            std::process::id(),
            now_ms(),
            n
        ));
        Capture::new(Arc::new(Store::open_at(path).expect("store")))
    }

    #[test]
    fn pause_blocks_recording_and_resume_restores_it() {
        let capture = capture();
        assert!(capture.is_recording());

        capture.pause(0);
        assert!(
            !capture.is_recording(),
            "an indefinite pause must not expire"
        );

        capture.resume();
        assert!(capture.is_recording());
    }

    #[test]
    fn a_timed_pause_expires_on_its_own() {
        let capture = capture();
        capture.pause(0);
        // Backdate the expiry rather than sleeping: the rule under test is the comparison.
        capture.paused_until.store(now_ms() - 1, Ordering::Relaxed);
        assert!(capture.is_recording(), "an elapsed pause resumes by itself");
    }

    #[test]
    fn a_span_is_scored_the_same_however_it_was_closed() {
        // A span closed by idle and a span closed by a focus change describe the same thing, and
        // scoring them differently would make "how long was this open" depend on how you left.
        assert_eq!(importance_for(1_000), 5);
        assert_eq!(importance_for(30_000), 15);
        assert_eq!(importance_for(10 * 60_000), 30);
    }

    #[test]
    fn an_idle_span_ends_when_input_stopped_not_when_it_was_noticed() {
        // The arithmetic the idle branch does: a span opened at 01:56 and noticed idle at 09:40
        // after seven hours and forty minutes of no input ends at 01:56, not at 09:40.
        let started = 1_756_000_000_000u64;
        let noticed = started + 7 * 3_600_000 + 40 * 60_000;
        let idle_ms = noticed - started;
        let stopped = noticed.saturating_sub(idle_ms).max(started);
        assert_eq!(stopped, started, "the night belongs to nobody");
    }

    #[test]
    fn coming_back_after_a_break_does_not_backdate_the_span() {
        // Idle shorter than the span: the span ends where input stopped, part way through.
        let started = 1_756_000_000_000u64;
        let now = started + 3_600_000;
        let idle_ms = 10 * 60_000;
        let stopped = now.saturating_sub(idle_ms).max(started);
        assert_eq!(stopped, started + 50 * 60_000);
    }

    #[test]
    fn spinner_glyphs_do_not_change_the_title_key() {
        assert_eq!(stable_title("◐ Rewind"), stable_title("◑ Rewind"));
        assert_ne!(stable_title("Rewind"), stable_title("Cockpit"));
    }
}
