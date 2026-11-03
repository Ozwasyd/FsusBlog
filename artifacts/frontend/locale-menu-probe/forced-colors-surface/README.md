# Dropdown forced-colors surface repair — source verified, acceptance OPEN

Related to FsusUI #830 and FsusBlog #1891. The new owned rendering defect is repaired and verified. Both issues remain OPEN/WIP for published-package parity and independent product/UX acceptance; this does not qualify native, performance or Full visual.

## Source and diagnosis

UI baseline `e14c9f8321e77c765128732473bb4121c578f559`; current tested and pushed UI `eb8ed608b263cf2bfd8f7b8b3503c23bedb4c360` on `task/830-canonical-integration` (existing draft PR #857). Blog probe source `94f55bad202d696eb51090c5521e2e296d8cb6c1` on `task/1891-readiness-evidence` (existing draft PR #3927). Source migration remains `e863c6fec58dab2de3029e759eb3c4c1f082f7d6`.

Actual computed styles show a transparent inner menu and a 0.98-alpha popup background. Forced colors maps that background to system Canvas while retaining alpha, exposing background text. This matches the [CSS Color Adjustment specification](https://drafts.csswg.org/css-color-adjust-1/#forced-colors-properties). Source ownership is `dropdown.scss`; the shared theme supplies the ordinary overlay token and transparent inner list. The repair uses opaque Canvas only on the owning Dropdown popup and arrow under forced colors. `forced-color-adjust:auto`, ordinary overlay tokens, focus rings, density and geometry remain. No shared theme/Popper/Input/Dialog/Menu hunk or consumer rendering override was added. The source change is three files including the nearest API document and changeset; `source-increment.patch` is exact.

`classification.json` was schema-validated and frozen before implementation using the actual baseline, Skill and authority digests, with prescribed / ux-local scope. `diagnosis/probe.json` supplies real before styles and screenshots; `red-paint/probe.json` is the stronger pre-repair negative. Its completion time09:02:30Z precedes source edit09:02:44Z and theme producer output09:02:50Z. No mid-run changed-source receipt is promoted.

## Executed current checks

| Command / evidence | Result |
| --- | --- |
| `FSUSBLOG_LOCALE_PROBE_REAL_ZOOM=1 PLAYWRIGHT_BROWSERS_PATH=/tmp/chain-1891-browsers node tests/frontend/checks/runtime/probe-locale-menu.mjs local /workspace/FsusUI …` | Current exit0, run `locale-menu-local-2026-10-08T09:05:06.482Z`; original API/DOM, pending/retry/latest-wins, URL/command, keyboard/touch, cleanup, multiline, five CSS-zoom and four actual2x browser-zoom variants remain. |
| Same unchanged strengthened runner at UI baseline | Exit2, exactly light/dark background-bleed failures, no browser errors. |
| Current opposite-underlay pixel checks | 154326 interior pixels per palette. Before113843(light)/114034(dark) changed, maximum channel delta5. Current and restored surfaces: zero changed pixels, zero delta. Temporary alpha restoration reintroduces the exact changes. |
| Existing focus-removal negatives | Preserved: remove pseudo-content, detect absent focus paint, restore it. Trigger Escape focus,2px inset rings, one checked radio and ten locales remain. |
| Current focused library / consumer tests | 63/63 in9 UI files;33/33 in3 Blog files; exit0. Exact commands/logs in binding/checks. |
| Official API baseline, contract, Vue-public, tokens, design, docs, anti-AI | All exit0. Existing producers/checkers consumed; no copied native digests or fabricated metadata. |
| Theme build / official Demo production preparation / readiness / warm reuse | Exit0. Current runtime fingerprint `872865c413cf4d9204dabed1eef3bd22d70cbaf6f55256848104c33e1a315ba3`. |
| Actual runtime artifact corruption | Ready true→false→true; original bytes restored in finally; exit0. |
| Official Prettier / Blog style / diff checks | Exit0. No visual thresholds, snapshots, test expectations or security controls weakened. |

Inspected current physical375x900 light/dark forced-colors screenshots show no background text bleed and retain visible item focus. Opposite-underlay captures and alpha-restoration negatives are retained. Double requestAnimationFrame waits synchronize real paint frames without fixed sleeps. The initial new control attempt exited3 because compositor frames were stale; its raw screenshots/errors remain under `red/`. That attempt is not the accepted negative. Test-only underlay and alpha mutation are disposed in finally; there is no production consumer selector workaround.

Ordinary dark screenshot is byte-identical before/after. Ordinary light has27 changed antialias pixels outside the popup (bounds y80–261); the popup begins y262. Both normal geometry, surface paint and item/trigger focus paint are exactly equal and popup pixels unchanged. Those outside-control differences are retained, not hidden by a threshold or snapshot update. This comparison is bounded source evidence, not independent product acceptance.

## Independent review of all50 prior Full failures

`full-failure-owner-review.json` independently reads every actual error context and50 trace streams, checks1631 frame snapshots, compares owning source against clean baseline/current source, and binds each assertion, source owner, source provenance and artifact hash. All50 original cases stay failed. The supplied sibling paired-baseline reports are not promoted to independent acceptance here.

| Count | Diagnosis and exact source/contract owner |
| --- | --- |
| 16 | Actual external CDN certificate failures from `demo-state.ts:130-133`; canonical Demo resource and fail-closed diagnostics owner (`#231/#232`, parent must identify active owner). Includes motion and TreeSelect tests whose assertions/afterEach fail on these requests, not on Dropdown geometry. |
| 4 | Local production feature-asset ERR_ABORTED on rapid Markdown mode changes. Markdown feature cancellation plus diagnostics recovery (`#428/#429/#191/#231`). Production /assets/ abort is not automatically a recoverable Vite module request; do not suppress it. |
| 4 | Concrete mismatch: Markdown chrome fixture serializes slotState twice and never emits expected 已同步到草稿箱; original test requires it. Exact fixture source lines27–35 and test400–433; `#427/#429` owner must correct/adjudicate it. |
| 22 | Actual mobile Markdown chrome image differences. Inspected actual/expected/diff shows stale B/I/H/Q/227chars expectation and real source-line clipping/geometry differences. Preserve failed snapshots; `#428` source and `#429` acceptance owners must adjudicate both, not simply refresh images. |
| 4 | Actual Markdown runtime completion/content failures under existing20/30s checks. `MarkdownStressSection.handleRenderComplete` alone commits complete; successful raw WASM timing rows do not prove component completion. Canonical renderer/lifecycle/performance owner (`#191`; parent-bounded #1805/#842 handoff) must return exact applicable source/evidence. |

No recorded target snapshot contains Dropdown classes, and MarkdownEditor has no Dropdown imports. Its source/theme/fixture and diagnostics are byte-identical to the clean baseline; the renderer's only changed source is the already parent-authorized canonical pending-theme increment. The scoped Dropdown CSS/behavior does not own these50 errors. The separately reproduced public Dropdown transparency is owned by#830 and repaired here. This is not a blanket claim that50 failures are merely external acceptance: fixture inconsistency, cancellation, clipping and completion failures are concrete unresolved source/integration gaps with precise owners. Historical closed contract issue numbers identify responsibility, not present acceptance or a new assignment. Current coordinating root/commit is requested from parent where not yet supplied.

## Boundaries and remaining gates

Fresh fetched defaults: Blog `aaba7b8c84ecfb336c71443e30d9fd82d21fb16d`, UI `a96047c3a281df6f0ae035f27fc471ad4a645173`. UI changed Dialog/focus-trap/trace fixture; Blog changed unrelated domain/runtime/governance files. No owned Dropdown/LocaleSelector implementation overlap. Defaults were inspected, not merged or cherry-picked; exact branches remain isolated.

The three historical native counter failures do not block current theme/API/runtime setup: official API/contract gates pass. No #827 governance producer source was guessed or consumed, and no digests/counters were copied. If a native setup gate becomes necessary, obtain the parent's exact applicable reviewed source first. Native/performance and complete Full visual are unqualified; the old Full run remains657 passed/50 failed at `a996d9e742ce31927f3845024eaa72b8a77d13f3`.

Published package remains unavailable (prior current probe exit3 ENOENT, registry E401); no package publishing or fallback. Independent UX/screen reader and live production resource/preference integration remain required. The repository Skill explicitly requires acceptance independent of implementation; this is source/probe evidence and makes no accepted UX receipt.

Only ordinary source/evidence git push is authorized. No PR/comment mutations, merge, issue closure, dependency rewrite, package publication, deployment or another owner's source edits occurred. Frozen branches and previous archives remain unchanged. Local parent handoff is `handoff.md`; all other files are bound by `evidence-sha256.json`.
