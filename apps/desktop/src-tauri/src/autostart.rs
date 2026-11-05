//! Start with the session.
//!
//! A memory that is only running when you remember to open it has holes exactly where you forgot,
//! and you forget on the days you are busiest. That is not hypothetical: nothing launched REWIND at
//! login, and a real machine went weeks with no window, no commit and no command captured, while
//! the interface quietly showed the few Claude Code sessions it could read back from disk
//! afterwards.
//!
//! So launching at login is switched on once, the first time the installed application runs, and
//! from then on it is the user's choice from the tray. Never re-enabled behind their back: a marker
//! file records that the first-run decision was made, and turning it off sticks.
//!
//! Debug builds never register themselves — `cargo run` from a checkout must not leave a stale
//! development binary starting at every login.

use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

use crate::platform::data_dir;

const MARKER: &str = "autostart-initialized";

/// On the first run of an installed build, turn launch-at-login on.
pub fn first_run(app: &AppHandle<impl Runtime>) {
    if cfg!(debug_assertions) {
        return;
    }
    let marker = data_dir().join(MARKER);
    if marker.exists() {
        return;
    }
    match app.autolaunch().enable() {
        Ok(()) => {
            let _ = std::fs::write(&marker, "1");
            println!("REWIND: lancement à l'ouverture de session activé");
        }
        // Not written on failure, so the next launch tries again rather than giving up for good.
        Err(err) => eprintln!("REWIND: could not enable launch at login: {err}"),
    }
}

pub fn is_enabled(app: &AppHandle<impl Runtime>) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Flip it from the tray. Returns the state actually in force afterwards.
pub fn toggle(app: &AppHandle<impl Runtime>) -> bool {
    let manager = app.autolaunch();
    let result = if is_enabled(app) {
        manager.disable()
    } else {
        manager.enable()
    };
    if let Err(err) = result {
        eprintln!("REWIND: could not change launch at login: {err}");
    }
    // Whatever the user chose, the first-run default must never come back over it.
    let _ = std::fs::write(data_dir().join(MARKER), "1");
    is_enabled(app)
}
