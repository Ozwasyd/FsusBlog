# Locale-menu readiness diagnostic — OPEN / WIP

Related to FsusBlog #1891 and FsusUI #830. This is a historical diagnostic receipt, not acceptance, publication qualification, or authorization to merge. The coordinating parent subsequently assigned the canonical icon and pending-theme repair to FsusUI #842 / original Blog #1805. The independent `ef36c0d006a1fd330d238ed699b5d1f47d9fbc75` experiment is preserved for comparison only. Do not extend or promote it as the canonical repair.

## Exact identities and evidence

Blog source tested: `60523f506aa7fd867176adeb484bc303d20033db`; implementation: `e863c6fec58dab2de3029e759eb3c4c1f082f7d6`. UI source tested: `ef36c0d006a1fd330d238ed699b5d1f47d9fbc75`, based on frozen `2f3707e6453abebcfd6579683e5685f97a17c9ac`. Run: `locale-menu-local-2026-10-08T05:00:05.701Z`. `binding.json` records commands, exits, source identities, fresh default conflict probes, limitations, and canonical handoff status. `evidence-sha256.json` binds every other file in this directory.

The official icon producer reproducibly emitted five registry-declared aliases. Cold official icon/type and Demo production builds, warm reuse, readiness checks, and a real artifact-corruption rejection/restoration passed on the diagnostic source. No fingerprint implementation, expected hash, glyph, assertion, snapshot or security policy was changed. `source-increment.patch` is the exact two-file diagnostic delta; `complete-candidate.patch` is the cumulative UI candidate delta from the actual UI baseline.

Passing checks: Web typecheck; 67 component tests plus five icon-alignment tests; nine visual-runtime core tests including negative controls; public aliases; Blog 33 focused tests; current public-root API/DOM consumer probe across five viewport/theme/RTL/CSS-zoom variants. The local aliases are actual source. They do not establish published-package parity. CSS zoom is not real browser page zoom, accessibility snapshots are not screen-reader qualification, and the consumer fixture is not real production-service integration.

## Failures retained and owner requests

| Gate | Observed result | Required handoff / next action |
| --- | --- | --- |
| Canonical repair | Not consumed | Parent supplies exact #842/#1805 commit scope and evidence. Issue comments report PR #843 head `06abdea678a8cb74682b83cc93e1ff31d3b271da` and increments `7d9de025…`, `9a482352…`, `06abdea6…`; these observations are not parent authorization. Start integration from frozen `2f3707e…`, avoiding the duplicate diagnostic repair, and rerun exact-candidate preparation and tests. |
| Affected visual | Exit 1: 74 passed, four capture-data failures | Parent assigns canonical Demo image/runtime owner. Browser diagnostics report `ERR_CERT_AUTHORITY_INVALID` for two public `cube.elemecdn.com` image URLs from `vue/packages/demo-app/src/demo-state.ts:131,133`. Four case directories retain screenshots, error context and real traces. No TLS/security bypass. |
| Broader runtime integration | Exit 1: 11/12 on both candidate and clean `f2b3bb89…` | Parent assigns visual-runtime policy/assertion owner. `normal mode keeps only failure evidence while evidence mode is explicit` expects `trace: 'on'` while actual policy is `retain-on-failure`; both baseline and candidate logs are retained. No assertion weakened. |
| Published mode | Blocked | Provide an accessible, authorized locked package and later a published identity for the public additions. Existing registry probe returned E401; no package publication is authorized. |
| Full profile / native / performance | Not qualified here | Do not reuse affected-profile success as full-profile acceptance. Remote visual/macOS leaf logs were inaccessible to this session. Parent assigns or returns the original canonical runtime/native/performance owners and their exact evidence; do not duplicate their implementation. |
| Product qualification | Not run | Independent UX/screen reader, real browser zoom and real production resource/preferences paths remain open. |

The supplied #2228 / PR #844 evidence at `cecf260475fab0a3efb3225f6d7aa39f96a0ae6b` reproduces the same CDN failure titles/cause on its paired baseline. `provided-comparison.json` records this read-only comparison; no sibling source was consumed and it is not this candidate's qualification. Share these component diagnostics with the original #2228 owner through the parent. This probe does not replace its canonical live-backend viewport workflow or create a second qualification matrix.

## Fresh-default check and branch barrier

Fresh Blog master: `0a755584aa256995fd9997ca974806e8a0e29d2e`; UI main: `f2b3bb89ffe5f749da26c388f058efdbb6aee864`. Blog moved from the initial `3bc9bacd…` through release/governance/test-inventory changes; no owned selector implementation paths changed. Read-only `git merge-tree --write-tree` checks returned exit 0 for both frozen source candidates; no refs were changed and no merged tree was tested.

Frozen source branches remain unchanged: Blog `task/1891-multiline-followup` at `60523f506…`, UI `task/830-dropdown-multiline-followup` at `2f3707e…`. Readiness evidence is published separately. Neither owned issue is complete; no issue closure, PR merge, package publication or deployment occurred.

Archive verification: 47 evidence files hashed, four trace ZIPs passed CRC checks, and a credential-pattern scan of text artifacts found no matches. Authored Markdown/JSON passes `git diff --cached --check`. The complete raw-artifact diff reports whitespace in original Node/Playwright output and unified-patch context; those original bytes are deliberately retained for evidence fidelity.
