# REWIND — Collectors

> How each source of events works, what it is allowed to see, and how it behaves badly.
> Every collector must complete the §157 record in §9 before it is merged.

---

## 1. Contract

Every collector obeys the same rules:

1. **Event-driven, not polling** (§91). One documented exception: `IdleWatcher` (ARCHITECTURE §6).
2. **Checks pause first.** Before constructing any event (PRIVACY §5).
3. **Applies privacy rules synchronously**, inside the OS callback where possible, so an excluded event
   is never constructed.
4. **Never writes to the database or the UI** (§46). It emits to the normaliser and nothing else.
5. **Never blocks.** The sink is bounded and non-blocking; a full sink drops and counts, it does not
   stall the OS callback.
6. **Reports status.** Enabled / disabled / degraded / error, visible in Settings.
7. **Is individually disableable**, and new collectors ship disabled (§158).

```rust
pub trait Collector {
    fn id(&self) -> &'static str;
    fn start(&mut self, sink: EventSink, state: CaptureState) -> Result<()>;
    fn stop(&mut self) -> Result<()>;
    fn status(&self) -> CollectorStatus;
}
```

---

## 1b. Two levels of collection (ADR 0002 D-13)

|            | Level 1 — generic                                                                             | Level 2 — rich                                            |
| ---------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Applies to | **Any** application, no connector                                                             | Specific applications                                     |
| Captures   | Bundle id, window title, activation, deactivation, cleanly-available window/document metadata | Structured domain detail, and explicitly declared anchors |
| Today      | System collector (macOS)                                                                      | Browser, Terminal, Claude Code, Cockpit, Git              |
| Later      | —                                                                                             | Linear, then others                                       |

**Level 1 is the foundation and the thing the MVP must prove.** If generic macOS signals plus temporal
and semantic reasoning already reconstruct a meaningful share of contexts, the product works and rich
integrations raise precision. If they do not, no number of integrations rescues it.

Explicitly **not** building now: full Slack, Mail, Figma, Notes or Linear integrations.

### Level 1 privacy rule: metadata first (D-20)

Mail, Notes, Slack and Finder can hold extremely sensitive material. Level 1 takes **metadata only**:

| Application | Captured                                                                                               | Never captured at Level 1              |
| ----------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Notes       | Note title from the window                                                                             | Note content                           |
| Mail        | Subject / window metadata where safely available                                                       | Message bodies, the mailbox, addresses |
| Slack       | Channel / window metadata                                                                              | Message content                        |
| Finder      | Window title, active directory when cleanly available, selected-file metadata within the privacy model | **Any arbitrary filesystem scan**      |
| Figma       | Document name from the window title                                                                    | File contents, the Figma API           |

Deeper reading of any of these is a separately consented integration. The rule: **collect less,
understand better.**

### MVP source priority (D-19)

| Priority | Source                                        |
| -------- | --------------------------------------------- |
| P0       | macOS application and window observation      |
| P1       | Browser — URLs, titles, meaningful navigation |
| P2       | Claude Code / Terminal                        |
| P3       | Cockpit, over the external protocol           |
| P4       | Git and worktrees                             |
| P5       | Rich integrations — Linear first              |

The IDE collector leaves the MVP critical path. It is reprioritised, not deleted.

---

## 2. System collector

> **macOS is the MVP platform (ADR 0002 D-11).** The Windows detail below is retained for the future
> implementation. On macOS: `NSWorkspace` activation notifications for the frontmost application, an
> AX observer for window titles, `CGEventSourceSecondsSinceLastEventType` for idle, and
> `NSDistributedNotificationCenter` for lock and unlock. The application identity is the **bundle
> identifier**.
>
> **Blocker B-1:** window titles need the Accessibility (TCC) permission. Without it there are no
> titles, and without titles Level 1 observation carries almost no information. The
> `CGWindowListCopyWindowInfo` alternative requires Screen Recording permission, which is the wrong
> thing to request for a product that promises it takes no screenshots.

**Sources.** `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` and `EVENT_OBJECT_NAMECHANGE` on a dedicated
message-pump thread; `GetLastInputInfo` at 5 s; `WTSRegisterSessionNotification`; `WM_POWERBROADCAST`.

**Emits.** `system.window.focus`, `system.window.title_changed`, `system.idle.*`, `system.session.*`,
`system.power.*`.

**Care points.**

- Title changes are extremely chatty in editors and browsers — coalesced to one per 10 s.
- Process name resolution is cached by PID with invalidation on process exit; `QueryFullProcessImageName`
  can fail for elevated processes, in which case only the visible name is recorded.
- Titles are redacted and marked `sensitive` unless the app is on the safe allowlist (PRIVACY §3.3).

**Failure modes.** The hook can be silently unregistered by the OS after a shell restart — a watchdog
re-registers and logs `degraded` if it cannot.

---

## 3. Browser collector (Chrome / Chromium)

**Transport.** Native messaging → native host → named pipe. No TCP port (ARCHITECTURE §4).

**Permissions requested.** `tabs`, `nativeMessaging`. **Not** requested: `host_permissions`,
`<all_urls>`, `webRequest`, incognito access (§82, PRIVACY §2).

**Emits.** `browser.tab.activated`, `.opened`, `.closed`, `browser.navigation`.

**Care points.**

- Exclusions and URL policy are applied **inside the extension**, so an excluded URL never leaves the
  browser process.
- MV3 service workers are evicted after ~30 s (TR-11): events buffer in `chrome.storage.session` and
  flush on a `chrome.alarms` heartbeat; ingest is idempotent by event `id`.
- Only the focused tab in the focused window counts as active; background tabs and auto-refresh are
  dropped.
- Dwell time is computed from activation to deactivation, capped by idle state.

**Not captured.** Page content, DOM, form data, cookies, request bodies, incognito anything. Optional
page-text extraction (§12) is deferred past MVP and would be separately opt-in.

---

## 4. IDE collector (VS Code / Cursor / Windsurf)

**Transport.** Named pipe directly from the extension host (Node).

**Emits.** `ide.workspace.*`, `ide.file.opened|saved|closed`, `ide.diagnostic.error`,
`ide.debug.session`.

**Care points.**

- **Never file contents** (§13). `changedLines` is a count derived from the document version, not a diff.
- Path exclusions are applied in the extension.
- Restricted to APIs stable across all three editors; no proposed APIs.
- Diagnostics are summarised (count by severity, top file) plus the single most recent error message,
  redacted — enough for "what was failing", not a copy of the source.

**Failure modes.** The pipe is unavailable when the desktop app is not running: the extension buffers up
to 500 events in memory, drops oldest beyond that, and reconnects with backoff.

---

## 5. Filesystem collector

**Sources.** `notify` watchers, restricted to authorised workspaces (§14).

**Emits.** `fs.file.created|modified|deleted|renamed`, `fs.batch`.

**Care points.**

- Ignore-globs from PRIVACY §3.2 are applied **in the watcher callback**, before the event exists — this
  is both a privacy and a volume requirement (`node_modules` alone can produce tens of thousands of
  events during an install).
- Debounce 3 s per directory; more than 5 changes in a window collapses into `fs.batch`.
- Watch count is bounded; exceeding it degrades to watching only the repository roots, with a warning.

**Why it exists at all**, given the IDE collector: edits from `sed`, code generators, formatters, other
editors, and AI agents never pass through VS Code. Without this, the file evidence is incomplete.

---

## 6. Git collector

**Sources.** `gitoxide` (`gix`), plus filesystem watches on `.git/HEAD` and `.git/refs` — no polling, no
shelling out to `git`.

**Emits.** `git.repo.detected`, `git.commit`, `git.branch.checkout`, `git.merge`, `git.rebase`,
`git.stash`, `git.status.summary`.

**Care points.**

- **Never diff contents.** Paths, counts and messages only.
- Commit messages are redacted, but commit SHAs are exempt from entropy redaction (TR-10) and from
  retention deletion — they are permanent evidence (PRIVACY §9).
- A rebase rewrites many commits at once; deduplicated by tree hash so it does not read as a burst of new
  work.
- Worktrees, submodules and detached HEAD all have fixture coverage.
- `authorIsUser` compares against the repo's configured identity so teammates' commits pulled from a
  remote are not attributed to the user.

**Why this is the strongest signal.** A commit is a human statement that a unit of work concluded. A
branch name is a human label for a unit of work. Both are free, precise, and permanent.

---

## 7. Terminal collector

**The rule (§16).** No generalised shell spy. Capture happens only through integration the user
explicitly installs.

**Integration points.** PowerShell (`Prompt` wrapper + `PSConsoleHostReadLine`), bash
(`DEBUG` trap + `PROMPT_COMMAND`), zsh (`preexec`/`precmd`). The installer shows the exact profile diff
before writing, and uninstall is clean.

**Emits.** `terminal.command`, `terminal.error_tail` (opt-in), `terminal.cwd_changed`.

**Care points.**

- The most secret-dense source in the product. Redaction is mandatory and fail-closed (PRIVACY §4.2): a
  redactor error drops the event.
- Full stdout is never captured (§17). Only, when enabled, the last N stderr lines on non-zero exit.
- Interactive input (a password prompt, an `ssh` session) is never visible to these hooks — they see the
  command line, not the session.
- Shell startup overhead is budgeted at under 5 ms; the snippet does no I/O on the hot path, writing to
  the pipe asynchronously.

**REWIND never executes a captured command.** Restore opens a terminal at the recorded `cwd` and
_displays_ the last command (§62).

---

## 7b. External application collector (ADR 0002 D-17)

**Sources.** Any authorised local application, over the same Unix socket as the other producers, with
its own pairing token. Cockpit is the first consumer.

**Emits.** `external.mission.*`, `external.agent.*`, `external.run.*`, `external.worktree.*`,
`external.context.metadata`.

**Care points.** REWIND defines the protocol; it never links against the emitting application's
internals, and the protocol carries no Cockpit-specific vocabulary. `source` is bound to the pairing
token so one application cannot emit events attributed to another. Anchors declared here are trusted at
high confidence — the emitter knows its own domain better than a title parser does.

**Why it matters.** In this workflow an agent-orchestration app is where a large share of the work is
initiated. Without it there is a hole in the timeline exactly where the intent lives.

---

## 8. Agent collector (Claude Code — first class, ADR 0002 D-18)

**Sources.** Local session directories for Claude Code, Codex, Gemini CLI and similar (§20).

**Emits.** `agent.session.started|ended`, `agent.activity`.

**Care points.** These transcripts are the most sensitive files on the machine — source code, pasted
secrets, whole file contents (PVR-6). Default capture stays **metadata only**: session timing, project
path, tool-call counts, files touched, commands run, error signatures, model name. No prompt text, no
completions, no tool arguments.

ADR 0002 D-18 raises what this collector must eventually _answer_ — what did Claude try, which approach
failed, which files did it modify, where did the session stop — without raising what it captures by
default. Richer capture is a separate opt-in with its own disclosure.

**Open blocker B-7.** Two routes, neither free: parse local session files (rich, undocumented, fragile
across versions) or wrap the CLI via shell integration (stable, much poorer). This needs a decision
before P2.

**Why bother.** In this workflow most code is delegated rather than written. Without at least knowing
_when_, _on what project_ and _with what outcome_, the timeline has an unexplained hole exactly where
the work happened.

---

## 9. Per-collector privacy record (required before merge, §157)

| Collector  | What data?                                         | Why?                                         | Where stored?              | How deleted?               | Can it contain secrets?                 |
| ---------- | -------------------------------------------------- | -------------------------------------------- | -------------------------- | -------------------------- | --------------------------------------- |
| System     | App, title, focus spans, idle, lock, power         | The base timeline and session boundaries     | `events`                   | event / day / all          | Yes, in titles → redacted, `sensitive`  |
| Browser    | URL (policy-filtered), title, tab lifecycle        | Research trail; "find that doc"              | `events`                   | event / day / domain / all | Yes, in URLs → query stripped, redacted |
| IDE        | Workspace, file path, language, saves, diagnostics | Project attribution; file evidence           | `events`                   | event / project / all      | Low — paths and messages, redacted      |
| Filesystem | Path, change type                                  | Edits outside the IDE                        | `events`                   | event / project / all      | Low — paths only                        |
| Git        | Repo, branch, SHA, message, changed paths          | Strongest context signal; permanent evidence | `events` + `context_links` | event / project / all      | Rare, in messages → redacted            |
| Terminal   | Command, cwd, exit code, duration, error tail      | Highest-value "what failed" signal           | `events`                   | event / day / all          | **High** → fail-closed redaction        |
| Agent      | Session timing, project, tool counts               | Attribute AI-assisted work                   | `events`                   | event / day / all          | No — metadata only                      |

---

## 10. Adding a new collector

1. Write the §9 row first. If any answer is uncomfortable, stop.
2. Define the event types and `metadata` schemas in `packages/protocol`.
3. Implement `Collector`; apply pause and privacy rules inside the callback.
4. Add coalescing rules and an importance mapping.
5. Add fixtures; extend at least one golden session.
6. Ship it **disabled by default**, announced in the release notes (§158).
