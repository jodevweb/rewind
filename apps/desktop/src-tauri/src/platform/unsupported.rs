//! Providers for platforms that are not shipped targets.
//!
//! ADR 0004 D-30 requires every provider to have an implementation or an explicit refusal on every
//! platform. Linux is neither macOS nor Windows, so it gets this: the daemon compiles and runs, the
//! UI works, and capture reports honestly that it is unavailable.
//!
//! Deliberately not `unimplemented!()`. Panicking on a platform someone might reasonably try is
//! worse than saying "not here yet" — and the golden benchmark, which is platform-independent by
//! design, still runs.

use std::time::Duration;

use super::{ActiveWindowProvider, IdleProvider, TitleAccess, WindowSnapshot};

#[derive(Default)]
pub struct UnsupportedActiveWindow;

impl ActiveWindowProvider for UnsupportedActiveWindow {
    fn current(&mut self) -> Option<WindowSnapshot> {
        None
    }

    fn title_access(&self) -> TitleAccess {
        TitleAccess::Denied
    }
}

#[derive(Default)]
pub struct UnsupportedIdle;

impl IdleProvider for UnsupportedIdle {
    fn idle(&self) -> Duration {
        Duration::ZERO
    }
}
