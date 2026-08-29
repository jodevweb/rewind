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
mod claude;
mod platform;
mod redact;
mod store;

use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};

use capture::{Capture, CaptureStatus};
use store::{DaySummary, Event};

struct AppState {
    capture: Arc<Capture>,
}

#[tauri::command]
fn capture_status(state: State<'_, AppState>) -> CaptureStatus {
    state.capture.status()
}

/// The most recent events, whatever day they fall on.
///
/// The cap was 500 while the window asked for 5000, so the interface silently reconstructed the last
/// couple of hours and called it the day — and the prediction layer, which counts across days, was
/// counting across a fraction of one. The rail is still there, an order of magnitude above a heavy
/// day, because an unbounded query into a webview is a different kind of mistake.
#[tauri::command]
fn recent_events(state: State<'_, AppState>, limit: usize) -> Vec<Event> {
    state.capture.recent(limit.min(20_000))
}

/// Every work day that has anything in it, newest first.
///
/// Counted in SQL: the navigator has to list six months without the interface having loaded six
/// months of events to count them.
#[tauri::command]
fn event_days(state: State<'_, AppState>) -> Vec<DaySummary> {
    state.capture.days(400)
}

/// One work day, whole.
///
/// Whole rather than paged, because the engine reconstructs a day from the day: hand it the first
/// half and it produces contexts that end where the page did.
#[tauri::command]
fn events_for_day(state: State<'_, AppState>, day: String) -> Vec<Event> {
    state.capture.for_day(&day, 20_000)
}

/// Open a file, folder or URL the interface is showing.
///
/// Whitelisted by the provider to paths that exist and http(s) URLs — a captured string must never
/// be able to become a command.
#[tauri::command]
fn open_target(target: String) -> Result<(), String> {
    platform::open_target(&target)
}

/// Reveal a file in Finder or Explorer instead of opening it.
#[tauri::command]
fn reveal_target(target: String) -> Result<(), String> {
    platform::reveal_target(&target)
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
    match app.get_webview_window("main") {
        Some(window) => {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        // A menu item that silently does nothing is how ten minutes get lost. If the label ever
        // stops matching the config, this says so.
        None => eprintln!("REWIND: no webview window labelled \"main\" — check tauri.conf.json"),
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
        .icon(
            app.default_window_icon()
                .cloned()
                .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?,
        )
        .tooltip("REWIND — ● Enregistrement")
        .menu(&menu)
        // Left click opens the menu. It was disabled with nothing handling the click instead, so
        // clicking the icon did nothing at all — the app was running and unreachable.
        .show_menu_on_left_click(true)
        .on_tray_icon_event(|tray, event| {
            // Windows convention: a double click opens the window directly.
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
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
    // If the store cannot be opened there is nowhere to put events, and running would silently
    // discard the day. Failing loudly is the honest outcome.
    let store = Arc::new(store::Store::open().expect("REWIND: could not open the event store"));
    println!("REWIND: store at {}", store.path().display());

    let capture = Arc::new(Capture::new(Arc::clone(&store)));
    capture::spawn(Arc::clone(&capture));

    // Claude Code sessions: the deepest autonomous source in this workflow (ADR 0003 D-27).
    claude::spawn(store, capture::local_offset_minutes());

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            capture: Arc::clone(&capture),
        })
        .invoke_handler(tauri::generate_handler![
            capture_status,
            recent_events,
            event_days,
            events_for_day,
            set_paused,
            open_target,
            reveal_target
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
