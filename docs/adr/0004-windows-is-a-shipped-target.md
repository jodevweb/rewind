# ADR 0004 — Windows is a shipped target, not a future one

- **Status:** accepted
- **Date:** 2026-08-28
- **Amends:** ADR 0002 **D-11** (macOS-first, "Windows becomes an important future platform")
- **Leaves intact:** everything else in ADR 0002 and 0003

## Context

D-11 made macOS first and pushed Windows to "future". That was the right ordering and the wrong
status. The request is a real application on both platforms — not a macOS product with a Windows port
someday.

Two things make this cheap now rather than expensive later:

1. **The abstraction already exists and is already honoured.** D-11 named eight providers and put the
   Windows implementations behind them. Nothing in the domain layer knows what platform it is on.
2. **Tauri is cross-platform by construction.** The same Rust daemon and the same React UI build on
   both; what differs is the eight provider implementations and the installer.

The cost of treating Windows as "future" is not the code — it is the decisions taken while nobody is
looking at the second platform. Those are the expensive ones to reverse.

## Decisions

### D-29 — Both platforms ship

macOS and Windows are both shipped targets. Neither is a port of the other.

**Ordering is unchanged: macOS first.** It is where the real work happens, so it is the only machine
where the product's value is measurable (ADR 0002 D-21). Windows follows immediately, not eventually.

Practically, this means a change is not finished when it works on macOS. A provider added without its
Windows counterpart lands as an explicit `unimplemented!` with a tracking ticket — never as silence.

### D-30 — Platform parity rules

| Rule                                                                                    | Why                                                                                    |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| No platform-conditional code outside `rewind-collect::os` and `rewind-daemon::platform` | The rule from D-1, now enforced on two platforms rather than aspirationally on one     |
| Every provider has an implementation or an explicit `unimplemented!` on both            | Silence is how a second platform quietly rots                                          |
| CI builds both from the first Rust commit                                               | A platform that is not built is not supported, whatever the documents say              |
| The golden benchmark is platform-independent                                            | It runs on fixtures; if it ever needs a platform, something has leaked into the domain |
| Feature gaps are named in the UI, not hidden                                            | A Windows user must know what is missing and why, not discover it                      |

### D-31 — Where the platforms genuinely differ

Honest list, so nobody discovers these late:

| Concern              | macOS                                                  | Windows                                   |
| -------------------- | ------------------------------------------------------ | ----------------------------------------- |
| Window titles        | Accessibility permission required (B-1, ADR 0003 D-22) | No permission needed                      |
| Application identity | Bundle identifier                                      | Process name, plus executable path        |
| Idle                 | `CGEventSourceSecondsSinceLastEventType`               | `GetLastInputInfo`                        |
| Focus events         | `NSWorkspace` + AX observer                            | `SetWinEventHook`, genuinely event-driven |
| Secure storage       | Keychain                                               | Credential Manager                        |
| Local IPC            | Unix domain socket, `0600`                             | Named pipe, ACL'd to the user SID         |
| Signing              | Apple Developer Program, notarisation                  | Authenticode certificate                  |
| Data directory       | `~/Library/Application Support/REWIND`                 | `%LOCALAPPDATA%\REWIND`                   |

The asymmetry worth noticing: **Windows needs no permission to read window titles, macOS does.** So
the degraded mode ADR 0003 D-22 requires exists only on macOS, and Windows is the platform where
Level 1 observation always works. That makes Windows the better place to develop the context engine
against real data, and macOS the only place to judge whether the product is useful. Both are needed,
for different reasons.

### D-32 — Toolchain

Windows: Rust MSVC toolchain, Visual Studio Build Tools with the C++ workload, WebView2 (already
present on Windows 11). macOS: Rust, Xcode Command Line Tools.

Both are documented in CONTRIBUTING.md. Neither is a one-off: CI needs them too, which is what D-30's
build rule enforces.

## Consequences

- ROADMAP P1-000 covers both toolchains rather than one.
- The provider tables in ARCHITECTURE §6 stop being "macOS now, Windows later" and become two columns
  of equal standing.
- Installer and signing work doubles. Accepted: it is the cost of the request, and it is bounded.
- The capture probe, already cross-platform, keeps earning its place — it is the fastest way to check
  a platform's real window titles without a full build.

## What would make us revisit

If Windows parity starts dictating macOS design — if a decision gets worse on the machine that
matters in order to keep the two identical — the ordering in D-29 wins and Windows waits. Parity is a
goal, not a veto.
