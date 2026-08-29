# ADR 0006 — Updates ship from a separate public repository

- **Status:** superseded by [ADR 0007](0007-the-repository-is-public.md)
- **Why:** the repository is public now, so the second repository this created has no reason to
  exist. The failure it describes — an updater that goes quiet and looks healthy — is still the
  thing to be afraid of, and is why 0007 keeps a mirror for one release.
- **Date:** 2026-08-28
- **Amends:** ADR 0003 **B-3** (the source repository is private and shared)
- **Leaves intact:** ADR 0005 **D-13** (no API connections, nothing to configure)

## Context

The in-app updater was wired to `github.com/jodevweb/rewind/releases/latest/download/latest.json`
and shipped without anyone checking that the application could actually read it. It cannot. The
repository is private, and GitHub serves a private repository's release assets only to an
authenticated client; that URL is a 404 to everyone else.

The application has no credential to authenticate with, and giving it one is not available as a fix:

- D-13 says there are no API connections and nothing to configure. A token is both.
- A token baked into a distributed binary is a token published in the binary and in the repository
  that builds it, and it expires, which turns "update automatically" into "update until it silently
  stops".

The failure mode is what makes this worth an ADR rather than a bug fix. The updater does not report
an error when the manifest is missing — by design, since no network and no release yet are both
normal. So a permanently broken updater is indistinguishable from a healthy one with nothing to
offer. It would have been discovered the first time someone wondered why a release never arrived,
which is exactly what happened.

Three ways out were considered: make the source repository public, publish installers to a separate
public repository, or drop in-app updates and keep downloading from the Actions tab.

## Decisions

### D-36 — The source repository stays private; a second public repository holds the installers

`jodevweb/rewind-dist` is public and contains no source. It holds the built installers, the updater
bundles, their signatures, and `latest.json`. `jodevweb/rewind` stays private, which keeps B-3's
intent — the code, the documents, and the golden sessions are not public.

What becomes public is the compiled application. Anyone with the URL can download and run it. That
is accepted: it is a local-first tool that sends nothing anywhere, so a stranger running it learns
nothing about this work. What it does not expose is how it is built or what it knows.

Making the source public was rejected for the obvious reason and one less obvious: it would have
been a decision taken to unblock a workflow rather than on its merits, which is the worst reason to
publish anything.

### D-37 — Signing stays in the private repository

The signing key remains a secret of the private repository, and only its workflow signs. The public
repository is a destination, never a builder — nothing in it can produce an artifact the application
would accept. A write-scoped token for `rewind-dist` lives in the private repository as `DIST_TOKEN`,
because `GITHUB_TOKEN` cannot write across repositories.

This keeps the guarantee the updater actually depends on: an update the application installs came
from a build that ran in the private repository, whatever else may exist in the public one.

### D-38 — A release that covers only one platform is a failed release

`build-latest-json.mjs` refuses to write a manifest unless every expected platform was collected,
and the collector refuses to proceed without a signature.

A manifest naming only macOS tells the Windows machine there is no update, and says so through a
release that looks successful. Partial success is the failure this design has to make loud, because
the updater's silence is indistinguishable from working correctly.

## Consequences

- Two repositories to keep, and one token to rotate.
- The codename becomes public as a repository name. It was already the repository name; ADR 0001
  **A-5** constrains where the name appears in the product, not what the repository is called.
- `createUpdaterArtifacts` is now set. It was absent, so no `.app.tar.gz`, no `.nsis.zip` and no
  `.sig` were ever produced — the updater would have had nothing to install even on a public
  repository. Two independent defects, one symptom, which is the argument for testing the path end
  to end rather than each piece.
