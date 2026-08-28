// The window is a view onto a daemon that runs whether it is open or not (ARCHITECTURE §16), so
// closing it hides it rather than quitting. On Windows that also means no console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! REWIND desktop daemon.
//!
//! The real application, as opposed to the studio: a tray icon that is always visible, capture that
//! runs continuously from launch, and a window you open when you want it.
//!
//! Two rules the user should never have to think about, and which the code makes structural:
//!
//!   - **There is no start button.** Capture begins with the app and you pause it (§7, §84). Having
//!     to start a session is how the studio got it wrong.
//!   - **The recording state is always visible.** The tray glyph says `● Recording` or `⏸ Paused`,
//!     and there is no third state in which capture happens quietly (§158).

mod capture;
mod platform;

use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State, WindowEvent};

use capture::{Capture, CaptureStatus, FocusEvent};

struct AppState {
    capture: Arc<Capture>,
}

#[tauri::command]
fn capture_status(state: State<'_, AppState>) -> CaptureStatus {
    state.capture.status()
}

#[tauri::command]
fn recent_events(state: State<'_, AppState>, limit: usize) -> Vec<FocusEvent> {
    state.capture.recent(limit.min(500))
}

#[tauri::command]
fn set_paused(app: AppHandle, state: State<'_, AppState>, minutes: Option<u64>) -> CaptureStatus {
    match minutes {
        Some(m) => state.capture.pause(m),
        None => state.capture.resume(),
    }
    let status = state.capture.status();
    refresh_tray(&app, &status);
    status
}

fn refresh_tray(app: &AppHandle, status: &CaptureStatus) {
    let tooltip = if status.recording {
        "REWIND — ● Enregistrement".to_owned()
    } else {
        "REWIND — ⏸ En pause".to_owned()
    };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Ouvrir REWIND", true, None::<&str>)?;
    let pause_5 = MenuItem::with_id(app, "pause_5", "5 minutes", true, None::<&str>)?;
    let pause_30 = MenuItem::with_id(app, "pause_30", "30 minutes", true, None::<&str>)?;
    let pause_60 = MenuItem::with_id(app, "pause_60", "1 heure", true, None::<&str>)?;
    let pause_until = MenuItem::with_id(
        app,
        "pause_until",
        "Jusqu'à reprise manuelle",
        true,
        None::<&str>,
    )?;
    let pause = Submenu::with_id_and_items(
        app,
        "pause",
        "Mettre en pause",
        true,
        &[&pause_5, &pause_30, &pause_60, &pause_until],
    )?;
    let resume = MenuItem::with_id(app, "resume", "Reprendre", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &pause,
            &resume,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::AssetNotFound("default window icon".into())
        })?)
        .tooltip("REWIND — ● Enregistrement")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let state = app.state::<AppState>();
            match event.id().as_ref() {
                "open" => show_window(app),
                "pause_5" => state.capture.pause(5),
                "pause_30" => state.capture.pause(30),
                "pause_60" => state.capture.pause(60),
                "pause_until" => state.capture.pause(0),
                "resume" => state.capture.resume(),
                // Quitting is explicit and only from here (§85). Closing the window hides it.
                "quit" => app.exit(0),
                _ => {}
            }
            let status = state.capture.status();
            refresh_tray(app, &status);
        })
        .build(app)?;

    Ok(())
}

fn main() {
    let capture = Arc::new(Capture::new());
    capture::spawn(Arc::clone(&capture));

    tauri::Builder::default()
        .manage(AppState {
            capture: Arc::clone(&capture),
        })
        .invoke_handler(tauri::generate_handler![
            capture_status,
            recent_events,
            set_paused
        ])
        .setup(|app| {
            build_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // The daemon outlives the window: closing hides, it does not quit (ARCHITECTURE §16).
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("REWIND failed to start");
}
