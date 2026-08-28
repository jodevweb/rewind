//! Platform providers (ADR 0002 D-11, ADR 0004 D-30).
//!
//! Every OS interaction lives behind one of these traits. The domain layer — context engine, search,
//! privacy, persistence — contains no platform-conditional code and no platform types, and a
//! `#[cfg(target_os = ...)]` outside this module is a defect rather than a shortcut.
//!
//! Both macOS and Windows are shipped targets (D-29). Neither is a port of the other: a provider
//! ships with an implementation on both, or an explicit `unimplemented!` and a ticket. Silence is
//! how a second platform quietly rots.

use std::path::PathBuf;
use std::time::Duration;

/// Where REWIND keeps its data (STORAGE.md §6). Never a synced or build directory: roaming profiles
/// and cloud folders corrupt WAL files.
#[cfg(target_os = "windows")]
pub fn data_dir() -> PathBuf {
    // LOCALAPPDATA, not APPDATA — the latter roams.
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join("AppData").join("Local"))
        .join("REWIND")
}

/// Where REWIND keeps its data (STORAGE.md §6).
#[cfg(target_os = "macos")]
pub fn data_dir() -> PathBuf {
    home()
        .join("Library")
        .join("Application Support")
        .join("REWIND")
}

/// Where REWIND keeps its data (STORAGE.md §6).
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn data_dir() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local").join("share"))
        .join("rewind")
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub trait ActiveWindowProvider: Send {
    fn current(&mut self) -> Option<WindowSnapshot>;
    fn title_access(&self) -> TitleAccess;
}

pub trait IdleProvider: Send {
    fn idle(&self) -> Duration;
}

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::{WindowsActiveWindow as PlatformActiveWindow, WindowsIdle as PlatformIdle};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{MacActiveWindow as PlatformActiveWindow, MacIdle as PlatformIdle};

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod unsupported;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub use unsupported::{
    UnsupportedActiveWindow as PlatformActiveWindow, UnsupportedIdle as PlatformIdle,
};
