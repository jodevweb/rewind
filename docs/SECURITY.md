# REWIND — Security

> Threats to the application itself. PRIVACY.md covers what we collect; this covers who else could get
> to it, and what an attacker could do with the software.

---

## 1. Threat model

**Assets.** The event database (a detailed record of the user's work), the ingest token, any configured
provider API keys, and the integrity of the memory itself — a poisoned memory is as harmful as a leaked
one.

**Adversaries considered.**

| Adversary                                 | Capability                                        | In scope                                |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------- |
| Malicious web page                        | Runs JS in the user's browser, can reach loopback | **Yes**                                 |
| Malicious browser extension               | Can attempt to impersonate our extension          | **Yes**                                 |
| Malicious local process (user privileges) | Reads user-readable files                         | Partial                                 |
| Malicious npm/cargo dependency            | Executes in our build or runtime                  | **Yes**                                 |
| Thief with a powered-off laptop           | Offline disk access                               | Partial (depends on FDE)                |
| Attacker with the unlocked machine        | Full user access                                  | **No** — same as the user's own browser |
| Local admin / EDR / employer agent        | Full machine                                      | **No**                                  |

**Explicitly not defended against:** an attacker who already has the user's unlocked session. At that
point they can read the browser, the IDE and the source tree directly; REWIND is not a meaningful
escalation.

---

## 2. The local ingest surface — the main one

Three producers must reach the daemon: the Chrome extension, the VS Code extension, and shell
integration. The naive design is an HTTP server on `127.0.0.1`, and it is dangerous:

- Any web page can issue requests to loopback. Same-origin does not prevent the request being _sent_.
- A simple `Origin` check is defeated by DNS rebinding, where an attacker's domain resolves to
  `127.0.0.1` and the browser considers it same-origin.
- An open port is discoverable by any local process.

### The chosen design: no TCP port ever opens

| Producer          | Transport                                                             |
| ----------------- | --------------------------------------------------------------------- |
| VS Code extension | Named pipe (Windows) / Unix socket (macOS, Linux), direct from Node   |
| Shell integration | Same pipe                                                             |
| Chrome extension  | `chrome.runtime.connectNative` → `rewind-native-host.exe` → same pipe |

**Windows.** `\\.\pipe\rewind-ingest-<installId>`, created with a SECURITY_DESCRIPTOR granting access to
the current user SID only. The randomised `installId` prevents pipe-squatting by a process racing to
create a predictable name; the daemon also asserts it is the pipe's creator.

**Unix.** Socket in `$XDG_RUNTIME_DIR/rewind/`, mode `0600`, in a `0700` directory.

**Chrome native messaging.** The host manifest names REWIND's extension ID in
`allowed_origins`. Chrome will only connect the allowlisted extension; a web page cannot invoke native
messaging at all. This removes the browser attack surface entirely rather than mitigating it.

### Why this matters more than it seems

`localhost` services are a recurring source of real vulnerabilities in desktop software, precisely
because "it's only local" feels safe. Choosing pipes costs one small binary and removes an entire
vulnerability class.

### If loopback HTTP is ever required

Permitted only with **all** of: bind to `127.0.0.1` (never `0.0.0.0`); mandatory bearer token;
strict `Origin` allowlist; `Host` header validation rejecting anything but `127.0.0.1:<port>`
(anti-rebinding); no CORS wildcards; write-only API. It is a fallback, never the default.

---

## 3. Authentication and pairing

A 256-bit token is generated at install and stored in **Windows Credential Manager** (macOS Keychain,
Secret Service on Linux) — never in a config file, never in the database.

Pairing (P3-002):

1. The extension connects and requests pairing.
2. The desktop app shows an in-app confirmation naming the requesting extension and its ID.
3. On approval, the token is delivered over the already-authenticated native host channel.
4. The pairing is listed in Settings and revocable; revocation takes effect immediately.

Every frame carries the token. Tokens are compared in constant time. Rotation invalidates all pairings
and requires re-approval.

---

## 4. The API is write-only

There is **no read endpoint on the ingest channel**. Producers submit events; nothing can query. A fully
compromised extension with a valid token can inject noise into the timeline — annoying, correctable, and
detectable — but it cannot exfiltrate a single stored event. This asymmetry is deliberate and is the
strongest single mitigation in the design.

---

## 5. Input validation

Producers are untrusted, including our own extensions (they run in environments we do not control).
Every frame is validated (EVENT_MODEL §13):

- Frame size cap (64 KB) and rate limit per producer (200 events/s, then shed with a counter).
- Strict JSON Schema validation; unknown event types rejected.
- Timestamps more than 5 minutes in the future rejected; more than 7 days in the past rejected unless the
  producer is marked as a backfill source.
- `incognito: true` rejected outright.
- Pause-interval check (PRIVACY §5).
- Redaction applied server-side regardless of what the producer claims it did. Producer-side redaction is
  defence in depth, not a substitute — the daemon never trusts a producer's stamp.
- String length caps per field, so a hostile producer cannot bloat the database.

---

## 6. Supply chain

The daemon holds the sensitive data, so its dependency surface is kept deliberately small: no Node
runtime in the daemon, a short, reviewed Cargo dependency list, `cargo-deny` for advisories and licence
policy, `cargo-audit` in CI, and `pnpm audit` plus a lockfile-integrity check for the TypeScript side.
Dependency additions to `rewind-privacy` and `rewind-store` require explicit review.

CI enforces the **forbidden-API check** (P0-008): the build fails if `SetWindowsHookEx`, `WH_KEYBOARD`,
`WH_KEYBOARD_LL`, `CGEventTap`, `IOHIDManager`, or clipboard-read APIs appear anywhere in the tree. The
"no keylogger" promise (§8) is a build gate, not a policy statement.

---

## 7. Extension security

**Chrome.** Minimal permissions (`tabs`, `nativeMessaging`); no `host_permissions`; no content scripts at
MVP; no remote code (MV3 forbids it, and we do not work around it); no analytics; no incognito access
requested. The extension ID is pinned in the native host manifest.

**VS Code.** No `postMessage` surface, no webview, no telemetry. Reads workspace metadata only; never
document text.

Both are open source and reproducible from the monorepo, so a user can verify that the published build
matches the source.

---

## 8. Secrets in the product's own storage

| Secret                                   | Storage               |
| ---------------------------------------- | --------------------- |
| Ingest token                             | OS keychain           |
| Provider API keys                        | OS keychain           |
| Encryption key (future screenshot store) | OS keychain           |
| Anything else                            | There is nothing else |

The config file contains no secrets by construction, so it is safe to sync, share when debugging, or
check into a dotfiles repo. Logs are redacted before writing (P1-005); a crash dump never includes event
content.

---

## 9. Data at rest

Stated honestly, as in PRIVACY §7: **the database is not application-encrypted at v1.** It is protected
by OS file permissions and whatever full-disk encryption the OS provides. Onboarding checks for
BitLocker/FileVault and warns if it is off.

Why not SQLCipher: it conflicts with the FTS5 and vector extensions, costs performance, and does not
defend against the adversary who matters most (someone with the unlocked session). Revisit if the threat
model changes — shared machines, or backups leaving the device.

---

## 10. Memory integrity

A less obvious risk: an attacker who can _write_ to the memory can make the user believe something false
about their own past. Mitigations: producer identity recorded on every event (`producer.name/version`),
pairing required and revocable, rate limits and schema validation, and the data inspector showing which
producers wrote what. Any answer traces to evidence with a visible source (§54), so a fabricated claim
has a fabricated citation the user can inspect.

---

## 11. Update security

Signed releases; Tauri's updater with signature verification and a pinned public key; release notes that
announce any new collector, which ships disabled (§158). No silent capability expansion — an update that
starts collecting something new without saying so would break the §158 contract, and that is treated as a
security defect, not a product decision.

---

## 12. Incident response

If a vulnerability is found in a collector or the ingest path: disable the affected collector by remote
kill-switch in the config schema (local, applied at next start — not a server callback), publish a patch,
and tell users plainly what was exposed and for how long. Given the data involved, the disclosure
standard is higher than typical desktop software, not lower.
