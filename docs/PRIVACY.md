# REWIND — Privacy Model

> STEP 3 deliverable (§150), written **before** any collector exists (§157). This document is
> normative: if the code disagrees with this document, the code is wrong.

---

## 0. The promise

**Your data belongs to you.** REWIND is a local application. By default it does not send anything about
your work anywhere. There is no account, no server, no telemetry, no sync.

Everything below is stated as a checkable claim, not a marketing sentence. Where a guarantee is
partial, this document says so — an over-promise here is worse than a missing feature.

---

## 1. What REWIND captures

Only these. Nothing else is collected at MVP.

### 1.1 System

| Field                       | Example                                | Notes                                 |
| --------------------------- | -------------------------------------- | ------------------------------------- |
| Active application          | `Code.exe`, `chrome.exe`               | Process name and display name         |
| Window title                | `auth.ts — myapp — Visual Studio Code` | **Sensitive by default** — see §3.3   |
| Focus start/end             | epoch ms + tz offset                   | Duration is derived, not stored twice |
| Idle state                  | idle / active                          | From last-input time only             |
| Lock / unlock, sleep / wake | timestamps                             | Used for session boundaries           |

### 1.2 Browser (Chrome extension)

| Field                                       | Example                                |
| ------------------------------------------- | -------------------------------------- |
| URL                                         | `https://stripe.com/docs/api/invoices` |
| Page title                                  | `Invoices — Stripe API`                |
| Tab activated / opened / closed / navigated | timestamps                             |

Query strings are **stripped by default** except on an allowlist of known-safe hosts, because query
strings routinely carry tokens, session IDs and search terms (see §3.2).

### 1.3 IDE (VS Code family)

Workspace path, repository root, active file path, language ID, file open, file save.
**Never the file contents** (§13).

### 1.4 Filesystem

Created / modified / deleted / renamed, only inside explicitly authorised workspaces, coalesced.
Path and event type only — **never file contents**.

### 1.5 Git

Repository path, remote URL, branch, HEAD SHA, commit SHA + message + changed file paths, checkout,
merge, rebase, stash, dirty/clean summary. **Never diff contents.**

### 1.6 Terminal (explicit shell integration only)

Command line (redacted), working directory, exit code, duration, and — only on non-zero exit — the last
N lines of stderr (redacted). Full stdout capture is **off by default** (§17).

### 1.6b Semantic actions (ADR 0005 D-34)

That an action happened, and where — never what was written.

| Captured                                                                | Never captured                              |
| ----------------------------------------------------------------------- | ------------------------------------------- |
| `message sent`, `composing started`, `item opened`, `document switched` | The message, the document, any field's text |
| The container, from the window title (`#0-pull-requests`)               | Recipients, participants, thread contents   |
| The timestamp                                                           | Keystrokes, in any form                     |

**The safeguard is that the reading code does not exist.** REWIND never calls `AXValue`,
`AXSelectedText` or their UI Automation equivalents on a text element — it observes that a change
notification fired and does not ask what the value became. This is enforced by the same build gate
that enforces the no-keylogger rule: those accessors fail CI.

Reading a text field while someone types is functionally a keylogger even without a keyboard hook.
§8 bans the outcome, not the API.

### 1.7 Manual

Notes, bookmarks, pins, context names, merges and splits you create yourself.

---

## 2. What REWIND never captures

This list is absolute. There is no setting that enables any of it.

- **Keystrokes.** No keyboard hook of any kind exists in the codebase (§8). Not for passwords, not for
  anything. This is enforced by a build-time check that fails CI if a keyboard-hook API is referenced.
- **Screen contents / screenshots.** Not at MVP, in any mode (§111).
- **Camera, microphone, audio.**
- **File contents.** Not from the IDE, not from the filesystem watcher, not from Git diffs.
- **Clipboard.** Not captured, not read (§18).
- **The content of any text field, message, document or web page**, by any means — including the
  accessibility APIs that technically expose it (ADR 0005 D-35). Enforced by a build gate.
- **Passwords, credentials, tokens.** Actively detected and destroyed before storage (§4).
- **Network traffic.** REWIND does not proxy, intercept or inspect traffic.
- **Other users.** There is no multi-user data model; no `userId` column exists to aggregate on.
- **Anything from an excluded app, domain or path.** Not captured, not stored, not "hidden".
- **Anything while Paused.** See §5.
- **Incognito / private browsing.** The extension does not request incognito access, so Chrome never
  runs it there. This guarantee holds unless you manually enable it in Chrome — which REWIND never asks
  you to do.

---

## 3. Exclusions — the privacy rule engine

### 3.1 Rule model (§81)

```ts
type PrivacyRuleType = 'application' | 'domain' | 'path' | 'title' | 'eventType';
type PrivacyAction = 'ignore' | 'redact';

interface PrivacyRule {
  id: string;
  type: PrivacyRuleType;
  matcher: string; // glob for path/app, suffix-match for domain, regex for title
  action: PrivacyAction; // "ignore" = never captured; "redact" = captured, content masked
  enabled: boolean;
  source: 'default' | 'user';
}
```

Evaluation order: `ignore` rules win over `redact`; user rules win over defaults; the most specific
matcher wins. Rules are evaluated **inside the collector, synchronously, before the event leaves the OS
callback**. An excluded event is never constructed, never queued, never written.

### 3.2 Shipped defaults

Enabled out of the box, editable, never silently changed by an update:

**Applications (ignore):** password managers (1Password, Bitwarden, KeePass, LastPass, Dashlane),
banking and authenticator apps, Signal, WhatsApp, Telegram, system credential dialogs, Windows Security.

**Domains (ignore):** password-manager web vaults; `*.bank`-class and major banking domains;
`accounts.google.com`, `login.microsoftonline.com` and comparable identity providers; webmail
(`mail.google.com`, `outlook.live.com`); health portals; adult content.

**Paths (ignore):** `**/.ssh/**`, `**/.gnupg/**`, `**/.aws/**`, `**/.kube/**`, `**/.env*`,
`**/*.pem`, `**/*.key`, `**/*.p12`, `**/id_rsa*`, OS credential stores, browser profile directories.

**Paths (noise, ignored for a different reason):** `**/node_modules/**`, `**/.git/objects/**`,
`**/target/**`, `**/dist/**`, `**/build/**`, `**/.next/**`, `**/__pycache__/**`, `**/*.lock`,
temp directories.

**URL handling:** query strings stripped by default; fragments dropped; `userinfo` (`user:pass@`)
always stripped; a host allowlist (developer documentation, issue trackers, code hosts) keeps query
strings because they carry meaning there.

**Titles:** default `privacyLevel: sensitive` for any application outside the known-safe developer-tool
allowlist (see §3.3).

### 3.3 Why window titles get special treatment

Window titles are the highest-volume source of incidental personal data in the product. Real examples:

```
Reset your password — 1Password
Invoice #4471 — Marie Dubois — Stripe Dashboard
Re: layoffs — confidential — Gmail
psql — postgres://user:hunter2@prod-db:5432
```

Therefore titles are: (a) passed through secret redaction like any other text; (b) matched against
`title` exclusion rules; (c) marked `sensitive` unless the source app is on the safe allowlist
(IDEs, terminals, browsers on allowlisted docs hosts, Git tools). `sensitive` text is stored locally but
is **never included in a prompt sent to a cloud AI provider** without a separate, explicit confirmation.

---

## 4. Secret redaction (§80)

### 4.1 Where it runs

```
collector → privacy rules → SECRET REDACTOR → normalisation → persistence
                                            ↘ (again) → search index
                                            ↘ (again) → AI prompt payload
                                            ↘ (again) → AI output, before persistence
```

Redaction runs **four** times, not once. The fourth pass — on LLM output before it is stored — exists
because summaries are kept forever (§39) and a model can restate something a redactor missed upstream.

### 4.2 Fail-closed contract

`redact()` is total: it cannot throw and cannot return unmarked text. Persistence **rejects** any event
lacking a redaction stamp. If the redactor errors, the event is **dropped**, not stored. Losing an event
is acceptable; storing a secret is not.

### 4.3 Detected patterns

Named detectors, highest confidence first:

| Class                                          | Examples                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Cloud keys                                     | AWS `AKIA…`/`ASIA…` + secret keys, GCP service-account JSON, Azure connection strings          |
| VCS / CI tokens                                | `ghp_`, `gho_`, `ghs_`, `github_pat_`, GitLab `glpat-`, CircleCI, npm `npm_`                   |
| Payment                                        | Stripe `sk_live_`, `sk_test_`, `rk_live_`, `whsec_`                                            |
| Generic bearer                                 | `Authorization: Bearer …`, `-H "Authorization: …"`, `--token=…`                                |
| JWT                                            | `eyJ…​.…​.…` three-segment base64url                                                           |
| Private keys                                   | `-----BEGIN … PRIVATE KEY-----` blocks                                                         |
| Env assignments                                | `FOO_SECRET=…`, `*_TOKEN=`, `*_KEY=`, `*_PASSWORD=`, `PASS=`, in shell/PowerShell/dotenv forms |
| URLs with credentials                          | `scheme://user:pass@host`                                                                      |
| Database URLs                                  | `postgres://`, `mysql://`, `mongodb+srv://` with credentials                                   |
| Slack / Twilio / SendGrid / OpenAI / Anthropic | provider-specific prefixes                                                                     |
| High entropy                                   | last-resort heuristic, §4.4                                                                    |

Replacement is typed and stable: `sk_live_51H…` → `[REDACTED:stripe_secret_key]`. The type is kept
because it is useful ("you were setting a Stripe key") and the value never is.

### 4.4 Entropy detection is deliberately conservative (TR-10)

Generic entropy scanning would destroy data we need — a 40-hex Git SHA is high-entropy _and_ is primary
evidence (§54). So entropy detection: runs **last**, only on tokens no named detector matched; skips
allow-shapes (40/64-hex Git SHAs, UUIDs, ISO timestamps, semver, IP addresses, hex colours); applies a
length window (20–200 chars) and a Shannon-entropy threshold; and is measured for false-positive rate
against a fixture corpus before being enabled.

### 4.5 Extensibility

Detectors are data, not code branches: a registry of `{ id, pattern, confidence, replacement, tests }`.
Adding a provider is adding an entry with fixtures. Users can add their own patterns in Settings.

---

## 5. Pause / Private Mode (§7)

Durations: 5 minutes, 30 minutes, 1 hour, until resumed. Reachable from the tray and the global hotkey.

**During a pause, no event is captured — not hidden, not filtered later, not captured.** Enforced at
three independent points, because one is not enough (PVR-2):

1. **At the source.** Every collector checks pause state before constructing an event; OS hooks are
   detached where the API allows.
2. **At ingest.** The local ingest endpoint rejects any event whose timestamp falls inside a recorded
   pause interval. This catches a Chrome extension whose service worker was asleep when pause began
   (TR-11) and flushed a buffer afterwards.
3. **In storage.** Pause intervals are themselves persisted rows, so the check in (2) survives restarts.

While paused, the tray icon and the in-app indicator both show `⏸ Paused`, with the resume time. There
is no state in which REWIND is capturing without saying so (§84, §158).

---

## 6. Where data lives

| Data                                | Location                                    | Encrypted                                  |
| ----------------------------------- | ------------------------------------------- | ------------------------------------------ |
| Events, activities, contexts, index | `%LOCALAPPDATA%\REWIND\rewind.db` (SQLite)  | Relies on OS full-disk encryption — see §7 |
| Ingest token, provider API keys     | Windows Credential Manager / macOS Keychain | Yes, by the OS                             |
| Config, privacy rules               | `%APPDATA%\REWIND\config.json`              | No — contains no secrets by construction   |
| Logs                                | `%LOCALAPPDATA%\REWIND\logs\`               | No — redacted before writing               |
| Embedding model cache               | `%LOCALAPPDATA%\REWIND\models\`             | N/A                                        |

Nothing leaves the machine unless you configure a cloud AI provider (§8).

---

## 7. Encryption — stated honestly (§42, C-4)

**What is encrypted at v1:**

- All secrets — the ingest token and any provider API keys — live in the OS keychain, never in a config
  file, never in the database.
- Any future screenshot store is encrypted at rest with a key held in the OS keychain.

**What is not encrypted at v1:**

- The SQLite database itself. It is protected by OS file permissions and whatever full-disk encryption
  the OS provides (BitLocker on Windows, FileVault on macOS).

**Why.** Full database encryption (SQLCipher) interacts badly with the FTS5 and vector extensions we
depend on, and would cost performance and packaging complexity for a threat model — an attacker with
your unlocked user session — that it does not actually defeat. Claiming "encrypted at rest" while
shipping this would be the kind of over-promise this document exists to prevent.

**Recommendation to the user, shown in onboarding:** enable BitLocker/FileVault. REWIND checks and tells
you if full-disk encryption is off.

Tracked for reconsideration if the threat model changes (a shared machine, a backup that leaves the
device).

---

## 8. Sending anything to an AI provider (§35)

### 8.1 Default: nothing is sent

No LLM provider is configured after installation. Resume, Timeline, Contexts and deterministic Search
all work with zero network access. Ask requires you to configure a provider first, with a screen that
explains precisely what that means.

### 8.2 The sanitisation pipeline

Before any external call:

```
candidate items
  → drop everything privacyLevel: private
  → drop everything from excluded apps/domains/paths
  → require explicit confirmation for privacyLevel: sensitive
  → secret redaction (pass 3)
  → PII filters (configurable: emails, phone numbers, names in titles)
  → context budget selection (max N items, max M tokens)
  → disclosure
```

### 8.3 The disclosure

Generated from the **actual serialised payload**, not an estimate:

```
This request will send 14 items to Anthropic.
  8 event titles · 3 file paths · 2 commit messages · 1 context summary
  6 values were redacted before sending.
  [ Show exact payload ]   [ Cancel ]   [ Send ]
```

`Show exact payload` displays the literal bytes that will leave the machine. A "don't ask again for this
provider" option exists, and turning it off is one click in Settings.

### 8.4 Local models

The architecture supports a local `LLMProvider` and a local `EmbeddingProvider` (§33, §34, §130).
Embeddings are local by default. When a local LLM is configured, §8.2 and §8.3 do not apply — nothing
leaves the machine — but the sanitisation pipeline still runs, because redaction protects the database
too, not only the network.

---

## 9. Retention (§39, adjusted per A-4 / TR-5)

| Data                                                                   | Default     | Configurable     |
| ---------------------------------------------------------------------- | ----------- | ---------------- |
| Raw events                                                             | **90 days** | 7 days – forever |
| Activities                                                             | 1 year      | yes              |
| Contexts and summaries                                                 | Forever     | yes              |
| Citable evidence (commit SHAs, file paths, URLs, commands, timestamps) | **Forever** | yes              |
| Screenshots (if ever enabled)                                          | 7 days      | yes              |
| Logs                                                                   | 14 days     | yes              |

**Evidence-preserving compaction.** When raw events age out, they are not simply deleted: the activity
and context records retain every identifier needed to cite a source. This is what keeps "why does this
code exist?" answerable six months later (TR-5). Compaction never removes an identifier, only redundant
volume.

---

## 10. Deletion (§99) — real, not soft

Delete: a single event · a context · a day · a project · everything.

Deletion means: rows physically removed, FTS entries removed, vector entries removed, derived
activities and contexts recomputed or removed, any files unlinked, `VACUUM` run. No soft-delete flag,
no tombstone, no recycle bin. There is an integration test asserting that after deletion the target
string cannot be found anywhere in the database file.

"Delete everything" also clears the keychain entries and offers to uninstall the extensions.

---

## 11. Export (§98)

Everything REWIND knows is exportable to JSON (complete, machine-readable) and Markdown (readable
contexts, timelines, notes). Export is local file output; nothing is uploaded. There is no format in
which REWIND can read your data that you cannot also read.

---

## 12. Data inspector (§100)

Settings → **What does REWIND know?**

- applications captured, with event counts and total time;
- domains captured, with counts;
- projects and repositories detected;
- database size, broken down by table;
- redactions performed, by detector type;
- pause history;
- everything sent to an AI provider, ever, with timestamps and payload sizes.

The last item matters most: it is the receipt that §8's disclosures were true.

---

## 13. Transparency requirements (§84, §158)

- The tray icon always shows recording state: `● Recording` or `⏸ Paused`. There is no hidden state.
- Every collector can be disabled individually and shows its status.
- New collectors added by an update are **off by default** and announced.
- The privacy defaults in §3.2 are never changed silently by an update; changes are shown on first run
  after upgrade.

---

## 14. Threat model

| Threat                                                 | Addressed      | How                                                                                    |
| ------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------- |
| Malicious web page reaching the local ingest port      | Yes            | Token auth, `Origin`/`Host` validation, 127.0.0.1 bind, write-only API (SECURITY.md)   |
| Secret typed into a terminal ends up in the DB         | Yes            | Fail-closed redaction, four passes, tested (§126)                                      |
| Secret restated by an LLM into a permanent summary     | Yes            | Redaction pass on model output before persistence                                      |
| Data sent to a cloud provider without the user knowing | Yes            | Off by default, exact-payload disclosure, permanent receipt log                        |
| Another local process reading the DB                   | Partial        | OS file permissions; no app-level DB encryption at v1 (§7)                             |
| Attacker with the unlocked machine                     | No             | Out of scope — same as the user's own browser and IDE                                  |
| Stolen powered-off laptop                              | Partial        | Depends on BitLocker/FileVault; REWIND warns if off                                    |
| Employer coercion / bossware repurposing               | Yes, by design | No multi-user model, no aggregation, no export-to-server path, no scoring (§140, §141) |

---

## 15. Per-collector privacy record (§157)

Every collector must ship this table before it is merged. MVP set:

| Collector        | What                                     | Why                                          | Stored where        | Secrets possible?                                 | Deletion                  |
| ---------------- | ---------------------------------------- | -------------------------------------------- | ------------------- | ------------------------------------------------- | ------------------------- |
| System           | app, title, focus, idle, lock            | Base timeline and session boundaries         | `events`            | Yes, in titles → redacted, `sensitive` by default | With event/day/all        |
| Browser          | URL, title, tab lifecycle                | Research trail, "find that doc"              | `events`            | Yes, in URLs → query stripped, redacted           | With event/day/domain/all |
| IDE              | workspace, file, language, save          | Project attribution and file evidence        | `events`            | Low; paths only                                   | With event/project/all    |
| Filesystem       | path, change type                        | Corroborates edits outside the IDE           | `events`            | Low; paths only                                   | With event/project/all    |
| Git              | repo, branch, SHA, message, paths        | Strongest context signal; permanent evidence | `events` + evidence | Rare, in commit messages → redacted               | With event/project/all    |
| Terminal         | command, cwd, exit, duration, error tail | Highest-value signal for "what failed"       | `events`            | **High** → redaction is mandatory, fail-closed    | With event/day/all        |
| Agent (post-MVP) | session start/end, project, tool counts  | Attribute AI-assisted work                   | `events`            | Metadata only; no prompts, no completions         | With event/day/all        |

---

## 16. What we will not build, ever

- A keyboard hook.
- A mode that uploads raw events to a server.
- An employer-facing dashboard or any cross-person aggregation.
- A productivity score.
- Silent capture of any kind.

If a future feature request requires one of these, the answer is no, and this section is the reason.
