# ADR 0007 — The repository is public, and updates ship from it

- **Status:** accepted
- **Date:** 2026-08-29
- **Supersedes:** ADR 0006 **D-36** (a second public repository holds the installers)
- **Amends:** ADR 0003 **B-3** (the source repository is private and shared)
- **Leaves intact:** ADR 0005 **D-13** (no API connections, nothing to configure)

## Context

CI stopped running. Not a broken workflow — every job refused to start:

```
The job was not started because recent account payments have failed or your
spending limit needs to be increased.
```

GitHub Actions bills private repositories by a multiplier: Linux ×1, Windows ×2, **macOS ×10**. A
release builds both platforms and costs roughly 75 billed minutes, so the free 2000 a month holds
about twenty-five of them. That allowance was spent, and with it went the only machine in the
project that can compile anything: the development machine runs Windows 11 with Smart App Control,
which blocks unsigned binaries including `rustc` and `rustfmt`, and disabling it is irreversible.

So for a stretch there was no compiler anywhere. Rust changes were written, reviewed by reading, and
could not be built. That is not a workflow, it is a hope.

**Actions is free and unlimited for public repositories**, on the same GitHub-hosted runners,
macOS included. That is the whole of the decision.

## Decisions

### D-38 — `jodevweb/rewind` is public

The source, the documents and the golden sessions are public. B-3 kept them private with no stated
threat model beyond habit, and the cost of that habit turned out to be the ability to build the
software at all.

What was checked before flipping, because publishing cannot be undone:

- **No secret was ever committed.** `REWIND-UPDATER-PRIVATE-KEY.txt` has never been in a commit and
  is in `.gitignore`. Every token-shaped string in the tree is the redaction corpus, using values
  the vendors publish as examples — `AKIAIOSFODNN7EXAMPLE`, GitHub's own documented `ghp_16C7e42…`.
- **`MEMORY.md` was removed from the repository and from its history.** It is the handover file, and
  it describes how the person working on this works — what wasted their evening, which of their
  habits broke the engine. Those are the right things to write down and the wrong things to publish.
  It lives on the machine and is ignored by git.
- **The author email was rewritten** across all 65 commits to the GitHub `users.noreply` address.

Repository secrets are not exposed by a repository becoming public, and GitHub does not hand secrets
to workflows triggered from forks, so `TAURI_SIGNING_PRIVATE_KEY` is unaffected. Signing still
happens only in CI; an update can still only come from a build that ran here.

### D-39 — Updates ship from this repository's own releases

ADR 0006 created `jodevweb/rewind-dist` for one reason: a private repository serves its release
assets only to an authenticated client, and the application has no token and must not have one. That
reason is gone. The updater endpoint is
`https://github.com/jodevweb/rewind/releases/latest/download/latest.json`, the release workflow
publishes with the built-in `GITHUB_TOKEN`, and `DIST_TOKEN` is no longer needed.

**Transitionally, the manifest is still mirrored to `rewind-dist`.** A copy already installed knows
only the endpoint it was built with; it polls the old location and would never hear about a release
published only here. The mirrored manifest points at the assets published in this repository, which
are public and therefore readable. The mirror step, the `DIST_TOKEN` secret and the second endpoint
in `tauri.conf.json` can all be deleted once every installed copy has updated through it once.

This is deliberate caution rather than tidiness: an updater that goes quiet is indistinguishable
from one with nothing to offer, which is the exact failure ADR 0006 was written about. It must not
happen again on the way out of it.

## Consequences

- CI runs on every push and every pull request, on Windows and macOS, at no cost. The first run
  after this decision was the first time the Git and terminal collectors were ever compiled.
- The `xattr -dr com.apple.quarantine` step on first macOS install is unchanged. Notarisation needs
  a paid Apple Developer account and nobody has taken that decision (ADR 0003 D-23).
- The application is unchanged in every respect that matters to a user. It still sends nothing
  anywhere, has no account and no configuration. What became public is the code, not the data — the
  events stay on the machine that recorded them.
