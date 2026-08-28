//! Windows providers (ADR 0004 D-29 — a shipped target, not a port).
//!
//! Windows needs no permission to read a window title, which is the one place it is meaningfully
//! ahead of macOS: Level 1 observation always works here (D-31).
//!
//! This first implementation polls. The real collector must be event-driven via
//! `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` (§91), which is ticket P2-004; polling keeps the first
//! Rust commit small enough to verify, and the provider interface does not change when it is
//! replaced.

use std::time::Duration;

use windows::Win32::Foundation::{HWND, MAX_PATH};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
};

use super::{ActiveWindowProvider, IdleProvider, TitleAccess, WindowSnapshot};

#[derive(Default)]
pub struct WindowsActiveWindow;

impl ActiveWindowProvider for WindowsActiveWindow {
    fn current(&mut self) -> Option<WindowSnapshot> {
        // SAFETY: every call below is a read of window or process metadata. Nothing is mutated, no
        // buffer is written beyond its stated capacity, and a null or stale HWND is handled rather
        // than dereferenced.
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }

            let title = window_title(hwnd);
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));

            let (app_id, app_display) = process_name(pid).unwrap_or_else(|| {
                // A window whose process we cannot open is still a window; it is named honestly
                // rather than dropped, because dropping it would silently lose activity.
                ("unknown".to_owned(), "Unknown".to_owned())
            });

            Some(WindowSnapshot {
                app_id,
                app_display,
                title,
                pid: if pid == 0 { None } else { Some(pid) },
            })
        }
    }

    fn title_access(&self) -> TitleAccess {
        TitleAccess::NotRequired
    }
}

unsafe fn window_title(hwnd: HWND) -> String {
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; len as usize + 1];
    let written = GetWindowTextW(hwnd, &mut buf);
    if written <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..written as usize])
}

/// Returns `(app_id, display_name)`. The identity is the executable stem, lower-cased, so it is
/// stable across locales and versions the way a bundle identifier is on macOS.
unsafe fn process_name(pid: u32) -> Option<(String, String)> {
    if pid == 0 {
        return None;
    }
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = vec![0u16; MAX_PATH as usize];
    let mut size = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(
        handle,
        PROCESS_NAME_WIN32,
        windows::core::PWSTR(buf.as_mut_ptr()),
        &mut size,
    );
    let _ = windows::Win32::Foundation::CloseHandle(handle);
    ok.ok()?;

    let full = String::from_utf16_lossy(&buf[..size as usize]);
    let stem = full
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(&full)
        .trim_end_matches(".exe")
        .to_owned();
    Some((stem.to_lowercase(), stem))
}

#[derive(Default)]
pub struct WindowsIdle;

impl IdleProvider for WindowsIdle {
    fn idle(&self) -> Duration {
        // GetLastInputInfo requires polling, which brushes against §91's no-polling preference. The
        // alternative is a low-level keyboard hook, which is forbidden outright (§8) — so this is
        // the documented exception, not an oversight.
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        // SAFETY: `info` is fully initialised and `cbSize` matches its actual size.
        let ok = unsafe { GetLastInputInfo(&mut info) };
        if !ok.as_bool() {
            return Duration::ZERO;
        }
        let now = unsafe { GetTickCount() };
        Duration::from_millis(now.wrapping_sub(info.dwTime) as u64)
    }
}
