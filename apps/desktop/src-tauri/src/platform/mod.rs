//! Platform providers (ADR 0002 D-11, ADR 0004 D-30).
//!
//! Every OS interaction lives behind one of these traits. The domain layer — context engine, search,
//! privacy, persistence — contains no platform-conditional code and no platform types, and a
//! `#[cfg(target_os = ...)]` outside this module is a defect rather than a shortcut.
//!
//! Both macOS and Windows are shipped targets (D-29). Neither is a port of the other: a provider
//! ships with an implementation on both, or an explicit `unimplemented!` and a ticket. Silence is
//! how a second platform quietly rots.

use std::time::Duration;

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
