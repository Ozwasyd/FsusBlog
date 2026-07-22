# Public-preview screenshot governance

The nine images in `docs/assets/screenshots/` are release-derived documentation
assets. The checked-in `manifest.json` proves their provenance and content;
`config/docs/public-preview-screenshots.json` is the fixed registry for route,
viewport, theme, scope, and visual-input ownership.

## Local authority

The fast path is browserless and networkless:

```bash
npm --prefix src/frontend run check:public-preview-screenshot-manifest
npm --prefix src/frontend run check:public-preview-screenshot-sync
```

The first command validates deterministic serialization, complete file-set
registration, identifiers, dimensions of the capture matrix, build identities,
and PNG hashes. The second recalculates classified Git-tree inputs and the
resolved local FsusUI commit/tree/lock identity. A stale category fails closed
and names the category that requires recapture.

## Capture and release verification

```bash
npm --prefix src/frontend run capture:public-preview-docs
npm --prefix src/frontend run verify:public-preview-docs
```

Both commands allocate an isolated acceptance namespace and ports, build the
current checkout, create local PostgreSQL/Redis fixtures, fix locale/timezone,
wait for fonts, reduce motion, and retain runtime/layout audits. The capture
command writes nine files and a manifest to staging, validates the full matrix,
then atomically replaces the checked-in directory. The verify command compares
temporary output without changing the worktree.

Release-final consumes the same comparison inside the existing single-launch
Browser Contract. Its evidence is
`.tmp/release-evidence/public-preview-screenshots.json`, containing the current
source identity, manifest schema, visual-input digest, nine image hashes, audit
status, and command version. GitHub Actions may call these entries but does not
define different behavior or supply required authority.

## Failure and rollback

A manual viewport/theme/scope shard can only write temporary review artifacts.
The retired direct-docs environment switch fails explicitly. A single-writer
lock prevents concurrent publication; a capture/check failure leaves the old
gallery byte-for-byte intact. Runtime cleanup owns only the generated namespace
and never terminates unrelated listeners on conventional development ports.

If a release comparison fails, keep the committed gallery unchanged, inspect
the named screenshot IDs and audit output, fix the UI or fixture, then run the
explicit capture command. Reverting the gallery commit restores the previous
validated PNG/manifest set without a server restart.
