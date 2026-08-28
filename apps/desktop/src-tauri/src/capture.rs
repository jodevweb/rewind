//! Capture state and the collection loop.
//!
//! Two product rules are structural here, not cosmetic:
//!
//!   - **Capture runs continuously.** There is no "start a session" — the user pauses, they never
//!     start (§7, §84). Wanting a start button is a symptom of modelling it wrong.
//!   - **Pause means nothing is captured**, not hidden afterwards (§7). The check is at the top of
//!     the loop, before an event is constructed, so a paused daemon builds nothing to discard.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::platform::{
    ActiveWindowProvider, IdleProvider, PlatformActiveWindow, PlatformIdle, TitleAccess,
    WindowSnapshot,
};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusEvent {
    pub timestamp: u64,
    pub end_timestamp: Option<u64>,
    pub app_id: String,
    pub app_display: String,
    pub title: String,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub recording: bool,
    /// Epoch ms at which a pause expires. `None` while paused until explicitly resumed.
    pub paused_until: Option<u64>,
    pub events_today: u64,
    pub title_access: &'static str,
    pub platform: &'static str,
}

pub struct Capture {
    recording: AtomicBool,
    paused_until: AtomicU64,
    events_today: AtomicU64,
    title_access: Mutex<TitleAccess>,
    events: Mutex<Vec<FocusEvent>>,
}

impl Capture {
    pub fn new() -> Self {
        Self {
            recording: AtomicBool::new(true),
            paused_until: AtomicU64::new(0),
            events_today: AtomicU64::new(0),
            title_access: Mutex::new(TitleAccess::Granted),
            events: Mutex::new(Vec::new()),
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
        CaptureStatus {
            recording,
            paused_until: if recording || until == 0 {
                None
            } else {
                Some(until)
            },
            events_today: self.events_today.load(Ordering::Relaxed),
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
        }
    }

    pub fn recent(&self, limit: usize) -> Vec<FocusEvent> {
        let events = self.events.lock().expect("events");
        events.iter().rev().take(limit).cloned().collect()
    }
}

impl Default for Capture {
    fn default() -> Self {
        Self::new()
    }
}

/// The collection loop.
///
/// Polling at one second is the placeholder the provider interface hides; P2-004 replaces it with
/// `SetWinEventHook` on Windows and `NSWorkspace` notifications on macOS, and nothing outside the
/// provider changes when it does.
pub fn spawn(capture: Arc<Capture>) {
    std::thread::spawn(move || {
        let mut window = PlatformActiveWindow::default();
        let idle = PlatformIdle::default();
        let mut last_key = String::new();

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

            // Idle is recorded, never used to discard: the log has to be complete for statistics to
            // mean anything, and idle time is subtracted where durations are computed (§69).
            let _ = idle.idle();

            let ts = now_ms();
            let mut events = capture.events.lock().expect("events");
            if let Some(previous) = events.last_mut() {
                previous.end_timestamp = Some(ts);
            }
            events.push(FocusEvent {
                timestamp: ts,
                end_timestamp: None,
                app_id: snapshot.app_id,
                app_display: snapshot.app_display,
                title: snapshot.title,
                pid: snapshot.pid,
            });
            capture.events_today.store(events.len() as u64, Ordering::Relaxed);
        }
    });
}

/// Strip spinner and progress glyphs so a terminal running an agent does not emit an event a second.
/// The real-world form of the title-churn coalescing rule in EVENT_MODEL §5.
fn stable_title(title: &str) -> String {
    title
        .chars()
        .filter(|c| !matches!(*c as u32, 0x2190..=0x21FF | 0x25A0..=0x25FF | 0x2600..=0x27BF | 0x1F000..=0x1FAFF))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pause_blocks_recording_and_resume_restores_it() {
        let capture = Capture::new();
        assert!(capture.is_recording());

        capture.pause(0);
        assert!(!capture.is_recording(), "an indefinite pause must not expire");

        capture.resume();
        assert!(capture.is_recording());
    }

    #[test]
    fn a_timed_pause_expires_on_its_own() {
        let capture = Capture::new();
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
