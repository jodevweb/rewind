//! macOS providers (ADR 0002 D-11 — the first platform).
//!
//! This first implementation shells out to `osascript`, reusing the AppleScript the capture probe
//! already validated on a real machine. That is a deliberate choice for the first Rust commit:
//!
//!   - it compiles without any Objective-C bridging, so the first build is verifiable;
//!   - reading `name of front window` goes through the Accessibility API either way, so it exercises
//!     blocker B-1 with exactly the same semantics the native version will have;
//!   - and it makes the degraded mode real from day one — no permission means no title, and the
//!     product has to handle that rather than pretend (ADR 0003 D-22).
//!
//! It is replaced by `NSWorkspace` activation notifications plus an `AXObserver` in ticket P2-004.
//! The provider interface does not change when that happens, which is the whole point of D-30.

use std::process::Command;
use std::time::Duration;

use super::{ActiveWindowProvider, IdleProvider, TitleAccess, WindowSnapshot};

const SCRIPT: &str = r#"
tell application "System Events"
	set frontApp to first application process whose frontmost is true
	set appName to name of frontApp
	try
		set appId to bundle identifier of frontApp
	on error
		set appId to appName
	end try
	try
		set winTitle to name of front window of frontApp
	on error
		set winTitle to ""
	end try
end tell
return appId & tab & appName & tab & winTitle
"#;

#[derive(Default)]
pub struct MacActiveWindow {
    /// Set once we have seen a real title, so a later empty one is read as "this window has no
    /// title" rather than as "the permission was revoked".
    seen_title: bool,
    denied: bool,
}

impl ActiveWindowProvider for MacActiveWindow {
    fn current(&mut self) -> Option<WindowSnapshot> {
        let output = Command::new("osascript")
            .arg("-e")
            .arg(SCRIPT)
            .output()
            .ok()?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            // -1743 is macOS saying the process is not allowed to send Apple events / use
            // accessibility features. That is the permission, not a bug.
            if err.contains("-1743") || err.contains("not allowed") {
                self.denied = true;
            }
            return None;
        }

        let text = String::from_utf8_lossy(&output.stdout);
        let mut parts = text.trim_end().splitn(3, '\t');
        let app_id = parts.next().unwrap_or_default().to_owned();
        let app_display = parts.next().unwrap_or_default().to_owned();
        let title = parts.next().unwrap_or_default().to_owned();

        if app_id.is_empty() {
            return None;
        }
        if !title.is_empty() {
            self.seen_title = true;
            self.denied = false;
        }

        Some(WindowSnapshot {
            app_id,
            app_display,
            title,
            pid: None,
        })
    }

    fn title_access(&self) -> TitleAccess {
        if self.seen_title {
            TitleAccess::Granted
        } else if self.denied {
            TitleAccess::Denied
        } else {
            // Not yet known. Reported as granted so the UI does not accuse the user of withholding a
            // permission before there is any evidence they did.
            TitleAccess::Granted
        }
    }
}

#[derive(Default)]
pub struct MacIdle;

impl IdleProvider for MacIdle {
    fn idle(&self) -> Duration {
        // `ioreg -c IOHIDSystem` exposes HIDIdleTime in nanoseconds without any permission and
        // without linking IOKit. Replaced by CGEventSourceSecondsSinceLastEventType in P2-005.
        let Ok(output) = Command::new("ioreg")
            .args(["-c", "IOHIDSystem", "-d", "4", "-r"])
            .output()
        else {
            return Duration::ZERO;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            if let Some(rest) = line.split("\"HIDIdleTime\" =").nth(1) {
                if let Ok(nanos) = rest.trim().trim_matches('"').parse::<u64>() {
                    return Duration::from_nanos(nanos);
                }
            }
        }
        Duration::ZERO
    }
}
