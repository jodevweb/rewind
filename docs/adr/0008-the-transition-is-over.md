# ADR 0008 — The transition is over: the mirror is removed

- **Status:** accepted
- **Date:** 2026-08-29
- **Completes:** ADR 0007 **D-39** (the manifest is mirrored to `rewind-dist`, transitionally)
- **Retires:** the last thing ADR 0006 left standing

## Context

ADR 0007 moved releases into this repository and kept one thing from the old arrangement: the update
manifest was still mirrored to `jodevweb/rewind-dist`. The reason was narrow and had a stated end.
A copy already installed knows only the endpoint it was built with, so a copy from before the change
polls `rewind-dist` and nothing else; publishing only here would have left it silent, which is the
exact failure ADR 0006 was written about. The mirror was to be deleted "once every installed copy
has updated through it once" — a condition, not a date.

The condition is met, and it was checked rather than assumed:

- **The Windows machine** was running 0.5.0 and is now on 0.5.1, which it reached through the
  in-app updater. Verified in the uninstall registry, not by asking the application.
- **The MacBook** is on the current version, confirmed by its owner.

Both therefore run a build whose `endpoints` list this repository first. There is no third install.

## Decisions

### D-40 — The mirror step, the second endpoint and `DIST_TOKEN` are removed

- `.github/workflows/release.yml` no longer publishes to `rewind-dist`.
- `tauri.conf.json` lists one endpoint:
  `https://github.com/jodevweb/rewind/releases/latest/download/latest.json`.
- The `DIST_TOKEN` secret has nothing left to authenticate and is deleted.

`jodevweb/rewind-dist` itself is left in place, holding its old releases up to v0.5.1. Deleting it
would break the download links in any release note or message that ever pointed there, and it costs
nothing to leave a public repository standing. It receives nothing further.

## Consequences

- One publish per release instead of two, and one fewer secret to hold.
- **The cost of being wrong about the install count is that a copy goes quiet** — the failure this
  project has already had once, and the reason the mirror was kept for two versions rather than
  removed in the same commit that made it redundant. If a third install ever appears from before
  0.5.0, it will not find an update and must be reinstalled from
  https://github.com/jodevweb/rewind/releases rather than repaired remotely.
- The next release is the first published to a single endpoint, so it is also the test of this
  decision. If the machines take it, nothing else was depending on the mirror.
