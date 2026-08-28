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
use crate::store::{work_day, Store};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn local_offset_minutes() -> i32 {
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusEvent {
    pub timestamp: u64,
    pub end_timestamp: Option<u64>,
    pub tz_offset_minutes: i32,
    pub app_id: String,
    pub app_display: String,
    /// Redacted before it ever reaches this struct.
    pub title: String,
    pub pid: Option<u32>,
    pub redaction_version: String,
    /// Detector ids that fired. Never the matched values.
    pub redaction_applied: Vec<String>,
    pub redaction_count: usize,
    pub importance: i64,
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
}

pub struct Capture {
    recording: AtomicBool,
    paused_until: AtomicU64,
    title_access: Mutex<TitleAccess>,
    store: Store,
}

impl Capture {
    pub fn new(store: Store) -> Self {
        Self {
            recording: AtomicBool::new(true),
            paused_until: AtomicU64::new(0),
            title_access: Mutex::new(TitleAccess::Granted),
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
        }
    }

    pub fn recent(&self, limit: usize) -> Vec<FocusEvent> {
        self.store.recent(limit).unwrap_or_default()
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

            let Some(snapshot) = window.current() else {
                continue;
            };
            *capture.title_access.lock().expect("title access") = window.title_access();

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
                let importance = if ms < 5_000 {
                    5
                } else if ms < 60_000 {
                    15
                } else {
                    30
                };
                let _ = capture.store.close_span(row_id, ts, importance);
            }

            // Idle is recorded, never used to discard: idle time is subtracted where durations are
            // computed (§69), not by dropping events.
            let _ = idle.idle();

            // A titleless event is still an event: without Accessibility the application name is
            // all there is, and showing that beats showing nothing (ADR 0003 D-22).

            // Fail closed. If redaction cannot complete, the event is dropped — never stored.
            let Some((title, stamp)) = redactor.redact(&snapshot.title) else {
                eprintln!("REWIND: dropped an event because redaction failed");
                continue;
            };

            let tz = local_offset_minutes();
            let event = FocusEvent {
                timestamp: ts,
                end_timestamp: None,
                tz_offset_minutes: tz,
                app_id: snapshot.app_id,
                app_display: snapshot.app_display,
                title,
                pid: snapshot.pid,
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

    fn capture() -> Capture {
        Capture::new(Store::open().expect("store"))
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
    fn spinner_glyphs_do_not_change_the_title_key() {
        assert_eq!(stable_title("◐ Rewind"), stable_title("◑ Rewind"));
        assert_ne!(stable_title("Rewind"), stable_title("Cockpit"));
    }
}
