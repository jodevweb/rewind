//! macOS window title, through the Accessibility API directly.
//!
//! # Why this module exists
//!
//! The first implementation shelled out to `osascript`. That was wrong in a way that cost real
//! debugging time: `tell application "System Events"` needs the **Automation** permission, which is
//! a separate TCC grant from Accessibility. Granting Accessibility and still seeing nothing is the
//! exact failure that produces, and it is invisible because AppleScript catches its own error and
//! returns an empty title.
//!
//! Going straight to the Accessibility API removes the subprocess, removes Apple Events, and leaves
//! **one** permission — which is what "no configuration" (ADR 0005 D-33) has to mean in practice.
//!
//! # Why this file is exempt from the forbidden-API gate
//!
//! `AXUIElementCopyAttributeValue` is banned everywhere else (ADR 0005 D-35), because it is the call
//! that could read the contents of a text field — functionally a keylogger. ADR 0005 D-35 is
//! explicit that window titles remain readable: `AXTitle` on a *window* is not text content.
//!
//! So the raw call lives here, in one audited module, behind a single function that can only ever
//! return a window's title. That is the "role-scoped helper" the gate's own message points at. The
//! two attributes named below are the only ones this module will ever request, and it exposes no
//! way to ask for another.

#![allow(non_upper_case_globals)]

use std::ffi::c_void;

#[repr(C)]
struct __CFString(c_void);
type CFStringRef = *const __CFString;
type CFTypeRef = *const c_void;
type AXUIElementRef = *const c_void;
type AXError = i32;

const kAXErrorSuccess: AXError = 0;
const kCFStringEncodingUTF8: u32 = 0x0800_0100;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    // `Boolean` in C is an unsigned char. Mapping it to Rust's bool, which admits only 0 and 1,
    // is undefined for any other non-zero value.
    fn AXIsProcessTrusted() -> u8;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithBytes(
        alloc: *const c_void,
        bytes: *const u8,
        num_bytes: isize,
        encoding: u32,
        is_external: bool,
    ) -> CFStringRef;
    fn CFStringGetCString(string: CFStringRef, buffer: *mut u8, size: isize, encoding: u32)
        -> bool;
    fn CFStringGetLength(string: CFStringRef) -> isize;
    fn CFRelease(cf: CFTypeRef);
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
}

/// The only two attributes this module will ever ask for. Both are structural, neither is content.
const ATTR_FOCUSED_WINDOW: &str = "AXFocusedWindow";
const ATTR_TITLE: &str = "AXTitle";

struct CfString(CFStringRef);

impl CfString {
    fn new(value: &str) -> Option<Self> {
        // SAFETY: the slice outlives the call, and CFStringCreateWithBytes copies it.
        let raw = unsafe {
            CFStringCreateWithBytes(
                std::ptr::null(),
                value.as_ptr(),
                value.len() as isize,
                kCFStringEncodingUTF8,
                false,
            )
        };
        (!raw.is_null()).then_some(Self(raw))
    }
}

impl Drop for CfString {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: created by CFStringCreateWithBytes, released exactly once.
            unsafe { CFRelease(self.0 as CFTypeRef) };
        }
    }
}

/// Does REWIND hold the Accessibility grant right now?
///
/// Asked rather than inferred. The previous implementation guessed from a run of empty titles,
/// which was both slow to conclude and wrong when the real problem was a different permission.
pub fn is_trusted() -> bool {
    // SAFETY: no arguments, no ownership; the call only reads TCC state.
    unsafe { AXIsProcessTrusted() != 0 }
}

/// The title of the focused window of the given process, if it has one.
///
/// Returns `None` when the permission is missing, the process has no focused window, or the window
/// has no title. Those are different situations, but none of them is an error to report from here —
/// `is_trusted` answers the permission question directly.
pub fn focused_window_title(pid: i32) -> Option<String> {
    if pid <= 0 {
        return None;
    }
    // SAFETY: every raw pointer below is checked before use, every value obtained from a Copy call
    // is released exactly once, and no pointer outlives this function.
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return None;
        }

        let title = focused_title(app);
        CFRelease(app as CFTypeRef);
        title
    }
}

unsafe fn focused_title(app: AXUIElementRef) -> Option<String> {
    let attr = CfString::new(ATTR_FOCUSED_WINDOW)?;
    let mut window: CFTypeRef = std::ptr::null();
    if AXUIElementCopyAttributeValue(app, attr.0, &mut window) != kAXErrorSuccess
        || window.is_null()
    {
        return None;
    }

    let title_attr = CfString::new(ATTR_TITLE);
    let mut title: CFTypeRef = std::ptr::null();
    let ok = title_attr
        .as_ref()
        .map(|a| AXUIElementCopyAttributeValue(window as AXUIElementRef, a.0, &mut title))
        .unwrap_or(-1);
    CFRelease(window);

    if ok != kAXErrorSuccess || title.is_null() {
        return None;
    }

    // Refuse anything that is not a string rather than reinterpreting the pointer.
    let text = if CFGetTypeID(title) == CFStringGetTypeID() {
        cf_string_to_owned(title as CFStringRef)
    } else {
        None
    };
    CFRelease(title);
    text
}

unsafe fn cf_string_to_owned(value: CFStringRef) -> Option<String> {
    let len = CFStringGetLength(value);
    if len <= 0 {
        return None;
    }
    // Worst case for UTF-8 is four bytes per UTF-16 unit, plus the terminator.
    let capacity = (len * 4 + 1) as usize;
    let mut buffer = vec![0u8; capacity];
    if !CFStringGetCString(
        value,
        buffer.as_mut_ptr(),
        capacity as isize,
        kCFStringEncodingUTF8,
    ) {
        return None;
    }
    let end = buffer.iter().position(|b| *b == 0).unwrap_or(capacity);
    buffer.truncate(end);
    String::from_utf8(buffer).ok().filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_invalid_pid_yields_nothing_rather_than_crashing() {
        assert_eq!(focused_window_title(0), None);
        assert_eq!(focused_window_title(-1), None);
    }

    /// The guarantee this module exists to keep: it asks for two structural attributes and has no
    /// way to ask for a third. If someone adds a content attribute, this fails.
    #[test]
    fn only_structural_attributes_are_ever_requested() {
        let source = include_str!("macos_ax.rs");
        for banned in [
            "AXValue",
            "AXSelectedText",
            "AXSelectedTextRange",
            "AXStaticText",
        ] {
            assert!(
                !source.contains(&format!("\"{banned}\"")),
                "{banned} must never be an attribute this module requests (ADR 0005 D-35)"
            );
        }
        assert_eq!(ATTR_FOCUSED_WINDOW, "AXFocusedWindow");
        assert_eq!(ATTR_TITLE, "AXTitle");
    }
}
