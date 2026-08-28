//! Platform providers (ADR 0002 D-11, ADR 0004 D-30).
//!
//! Every OS interaction lives behind one of these traits. The domain layer — context engine, search,
//! privacy, persistence — contains no platform-conditional code and no platform types, and a
//! `#[cfg(target_os = ...)]` outside this module is a defect rather than a shortcut.
//!
//! Both macOS and Windows are shipped targets (D-29). Neither is a port of the other: a provider
//! ships with an implementation on both, or an explicit refusal. Silence is how a second platform
//! quietly rots.

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

/// The foreground window, as the collectors see it.
///
/// `app_id` is the stable identity: a bundle identifier on macOS, a process name on Windows. The
/// display name is derived and never treated as identity, because it is localised and changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowSnapshot {
    pub app_id: String,
    pub app_display: String,
    /// Empty when the platform cannot supply it — on macOS that means Accessibility is not granted,
    /// which is a degraded mode the product must handle rather than a failure (ADR 0003 D-22).
    pub title: String,
    pub pid: Option<u32>,
}

/// Whether the platform can currently read window titles at all.
///
/// This exists because "Figma" carries no context and "Figma — Home Staging V3" carries all of it.
/// A platform that cannot read titles is not broken, but it is much less useful, and the user has to
/// be told which of the two they are in.
// Every variant is constructed on some platform and none on all of them: `NotRequired` is Windows,
// `Denied` is macOS. That is the shape of a cross-platform enum, not dead code (ADR 0004 D-30).
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitleAccess {
    /// Titles are readable.
    Granted,
    /// The platform needs a permission the user has not given (macOS Accessibility).
    Denied,
    /// No permission is needed on this platform.
    NotRequired,
}

pub trait ActiveWindowProvider: Send {
    fn current(&mut self) -> Option<WindowSnapshot>;
    fn title_access(&self) -> TitleAccess;

    /// What the platform last told us, in plain words.
    ///
    /// Exists because swallowing the underlying error turned a one-line permission problem into
    /// three rounds of guessing. A provider that cannot say why it sees nothing is not debuggable.
    fn diagnostics(&self) -> String {
        String::new()
    }
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
mod macos_ax;
#[cfg(target_os = "macos")]
pub use macos::{MacActiveWindow as PlatformActiveWindow, MacIdle as PlatformIdle};

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod unsupported;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub use unsupported::{
    UnsupportedActiveWindow as PlatformActiveWindow, UnsupportedIdle as PlatformIdle,
};

/// Open a path, a folder or a URL with whatever the system uses for it.
///
/// The `ApplicationLauncher` provider named in ADR 0002 D-11. It is what makes an event actionable
/// rather than a record: seeing that you edited a file matters much less than being able to open it.
///
/// Refuses anything that is not an existing path or an http(s) URL, so a captured string can never
/// become an arbitrary command. Nothing is passed through a shell either, so it is never re-parsed.
pub fn open_target(target: &str) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("cible vide".to_owned());
    }
    let is_url = target.starts_with("http://") || target.starts_with("https://");
    if !is_url && !std::path::Path::new(target).exists() {
        return Err("ni un chemin existant ni une URL http(s)".to_owned());
    }
    spawn_opener(&[target.to_owned()])
}

/// Reveal a file in Finder or Explorer rather than opening it.
pub fn reveal_target(target: &str) -> Result<(), String> {
    let target = target.trim();
    let path = std::path::Path::new(target);
    if !path.exists() {
        return Err("chemin introuvable".to_owned());
    }

    #[cfg(target_os = "macos")]
    let args = vec!["-R".to_owned(), target.to_owned()];
    #[cfg(target_os = "windows")]
    let args = vec![format!("/select,{target}")];
    // Elsewhere there is no reveal, so open the containing folder.
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let args = vec![path
        .parent()
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()];

    spawn_opener(&args)
}

fn spawn_opener(args: &[String]) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    const OPENER: &str = "open";
    // `explorer` rather than `cmd /c start`: no shell means the argument is never re-parsed.
    #[cfg(target_os = "windows")]
    const OPENER: &str = "explorer";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    const OPENER: &str = "xdg-open";

    std::process::Command::new(OPENER)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
