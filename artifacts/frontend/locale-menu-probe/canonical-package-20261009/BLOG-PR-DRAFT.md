# Draft PR material — root metadata writer only

Title: [WIP] Bind LocaleSelector public-menu migration to canonical package evidence
Head: `task/1891-canonical-package-evidence-20261009` (exact published SHA in final handoff)
Base: `master` at `537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea`

## Problem and resulting behavior

LocaleSelector uses the documented public Dropdown/Menu/Item composition instead of owning popup refs, document pointerdown, roving focus or a second keyboard state machine. Blog retains locale codec/content, latest-wins resource/preference transactions, committed/pending state, URL/command activation, error and retry. This continuation adds current canonical source/package receipts without changing that migration.

Related to #1891 and [FsusUI #830](https://github.com/Ozwasyd/FsusUI/issues/830). Both remain OPEN/WIP.

## Reviewable source and evidence

The product source remains `e863c6fec58dab2de3029e759eb3c4c1f082f7d6`; this branch adds evidence only relative to `bba57bab07d2fcb87da3c30a2f65ad88bfb3b651`. Current UI candidate is `f8a2153903b24c5304b8fd8b048ce14f6f5a1037` on `task/830-canonical-package-20261009`. Full main-to-candidate and frozen-to-candidate UI patches, supplied-owner blob provenance, exact commands/exits and real screenshots are under `artifacts/frontend/locale-menu-probe/canonical-package-20261009/`.

Unchanged reviewer cancellation probe and original public-menu probe are current executable checks. The report has qualification=false; the fresh local tarball and canonical npm/pnpm receipts cannot attest registry publication or complete product UX. Read README.md and handoff.json for precise passed/failed/blocked/not-run distinctions, including retained environment failures and successful setup corrections.

## Impact and release checklist

- [x] One menu owner; no fallback, private import, private selector repair or parallel locale selector.
- [x] Pending/error/retry and mixed URL/command product semantics preserved.
- [x] Evidence binds exact candidate, harness hashes and real run identity.
- [x] Prior reviewed/frozen evidence and source branches preserved.
- [ ] Published-package probe and semantic parity (no publication authorized).
- [ ] Full 10-locale/viewport/zoom/theme/input product acceptance, independent screen reader/UX, real device and live-service acceptance.

The root coordinator is the sole GitHub metadata writer. This task does not create/update a PR, post a comment, close issues, merge or deploy. Root may use this material for an OPEN/WIP draft only. Rollback condition: public contract or locale transaction regression; retain the previous frozen evidence and investigate the owning source before promoting any package.
