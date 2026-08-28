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

use super::macos_ax;
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
	set appPid to unix id of frontApp
	try
		set winTitle to name of front window of frontApp
	on error
		set winTitle to ""
	end try
end tell
return appId & tab & appName & tab & appPid & tab & winTitle
"#;

#[derive(Default)]
pub struct MacActiveWindow {
    /// Set once we have seen a real title, so a later empty one is read as "this window has no
    /// title" rather than as "the permission was revoked".
    seen_title: bool,
    denied: bool,
    /// Samples that named an application but carried no title.
    titleless: u32,
    /// Distinct applications seen. One application reporting titles is not evidence of anything:
    /// macOS always lets a process read its OWN window title without permission, so REWIND can see
    /// itself while being blind to everything else — which is exactly what a missing grant looks
    /// like from the inside.
    apps_seen: std::collections::BTreeSet<String>,
    /// Verbatim stderr from the last failed osascript call.
    last_error: Option<String>,
    /// The last observation: application, and whether it carried a title.
    last_seen: Option<(String, bool)>,
    samples: u32,
}

impl ActiveWindowProvider for MacActiveWindow {
    fn current(&mut self) -> Option<WindowSnapshot> {
        let output = Command::new("osascript")
            .arg("-e")
            .arg(SCRIPT)
            .output()
            .ok()?;

        self.samples += 1;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            self.last_error = Some(err.trim().to_owned());
            // -1743 is macOS saying the process is not allowed to send Apple events / use
            // accessibility features. That is the permission, not a bug.
            if err.contains("-1743") || err.contains("not allowed") {
                self.denied = true;
            }
            return None;
        }

        let text = String::from_utf8_lossy(&output.stdout);
        let mut parts = text.trim_end().splitn(4, '\t');
        let app_id = parts.next().unwrap_or_default().to_owned();
        let app_display = parts.next().unwrap_or_default().to_owned();
        let pid: Option<u32> = parts.next().and_then(|p| p.trim().parse().ok());

        // Prefer the Accessibility API. The AppleScript path also needs Automation — a second,
        // separate TCC grant whose absence is invisible, because AppleScript swallows its own error
        // and returns an empty title. That is the failure that cost several rounds of guessing.
        let scripted_title = parts.next().unwrap_or_default().to_owned();
        let title = pid
            .and_then(|p| macos_ax::focused_window_title(p as i32))
            .unwrap_or(scripted_title);

        if app_id.is_empty() {
            return None;
        }
        self.last_error = None;
        self.last_seen = Some((app_id.clone(), !title.is_empty()));
        self.apps_seen.insert(app_id.clone());
        if title.is_empty() {
            self.titleless += 1;
            // Many titleless samples across several applications, and never a title from any of
            // them, is a missing Accessibility grant rather than a run of untitled windows.
            if self.titleless > 15 && self.apps_seen.len() > 1 && !self.seen_title {
                self.denied = true;
            }
        } else {
            self.seen_title = true;
            self.denied = false;
            self.titleless = 0;
        }

        Some(WindowSnapshot {
            app_id,
            app_display,
            title,
            pid,
        })
    }

    fn diagnostics(&self) -> String {
        self.describe()
    }

    fn title_access(&self) -> TitleAccess {
        // Asked, not inferred. The heuristic — a run of titleless samples across several
        // applications — was slow to conclude and wrong when the real problem was Automation rather
        // than Accessibility.
        if macos_ax::is_trusted() {
            TitleAccess::Granted
        } else {
            TitleAccess::Denied
        }
    }
}

impl MacActiveWindow {
    fn describe(&self) -> String {
        let mut parts = Vec::new();
        parts.push(format!("{} relevés", self.samples));
        match &self.last_seen {
            Some((app, has_title)) => parts.push(format!(
                "dernier : {app} ({})",
                if *has_title {
                    "avec titre"
                } else {
                    "sans titre"
                }
            )),
            None => parts.push("aucun relevé exploitable".to_owned()),
        }
        parts.push(format!("{} application(s) vues", self.apps_seen.len()));
        parts.push(format!(
            "accessibility : {}",
            if macos_ax::is_trusted() {
                "accordée"
            } else {
                "refusée"
            }
        ));
        if let Some(err) = &self.last_error {
            parts.push(format!("erreur osascript : {err}"));
        }
        parts.join(" · ")
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
