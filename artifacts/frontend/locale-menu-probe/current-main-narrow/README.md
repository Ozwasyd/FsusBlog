# Current-main narrow Dropdown source handoff

Related to FsusBlog #1891 and FsusUI #830. Both remain **OPEN/WIP**. This is a source-review handoff, not an independent UX acceptance receipt or chain completion.

- Verified FsusUI main: `a96047c3a281df6f0ae035f27fc471ad4a645173` (remote checked again after testing).
- Published narrow UI candidate: `ee05723abce8c5e7f39b1895bc3c3044e998a6b0`, branch `task/830-dropdown-current-main`.
- Runtime source tested: `27400297308912df12d109cbd8d756fe7cd98230`; the candidate successor changes only three generated metadata paths. `scope-verification-final.json` proves identical owning runtime source across that successor.
- Blog harness tested: `09802dd34e902122672ee6b72fb42ea0d17061b5`, isolated branch `task/1891-current-main-narrow-evidence`; LocaleSelector product source remains `e863c6fec58dab2de3029e759eb3c4c1f082f7d6`.
- Initial assigned Blog master: `3bc9bacd55b4453ed0abd48632c6a1bb3f7944f8`.

## Complete review surface and provenance

Review **the full main-to-candidate diff**, not the last commit: [current-main-full.diff](current-main-full.diff), [stat](current-main-full.stat), [scope verification](scope-verification-final.json), [per-path provenance](provenance.json), and [command ledger](handoff.json).

The candidate has 18 changed paths: 15 owning Dropdown production/test/docs/changeset paths and 3 officially generated public API/contract inventory files. Thirteen selected source blobs remain byte-identical to preserved broad `eb8ed608b263cf2bfd8f7b8b3503c23bedb4c360`. Two owning menu/test files were formatted with repository Prettier, committed separately; no behavior added in that formatting commit. The single docs/design sentence is specific to the explicit multiline/viewport Dropdown contract. Official producers rebuilt public metadata; no copied or hand-written baseline digest.

No prerequisite source commit was consumed. No Markdown producer/theme listener, icon index/changeset, shared Dialog/focus-trap/Input/Popper/Menu/theme implementation, historical demo/type fix, or trace-policy test repair was imported. Current-main shared changes remain intact. Broad UI `eb8ed608b263cf2bfd8f7b8b3503c23bedb4c360` and broad Blog `a42dffa1512d9933b90a99fffaf317547cec8e8c` branches and evidence are unchanged.

## Current executable results

- 82 focused library tests / 12 files: exit 0, including current-main focus-trap, Dropdown radio/multiline, Popper and CheckTag regressions.
- 33 Blog locale component/adapter/coordinator tests / 3 files: exit 0 with explicit narrow source alias.
- Affected Web/Vitest type checks: exit 0; direct Web and Vitest **no-cache** checks also exit 0. Node/Vite-config type gates were not selected and are not claimed.
- Official API baseline, Contract V2, Vue public contract gate (12 negative-control tests), owning source ESLint, owning changed-path Prettier, tokens, interactions, domain design, documentation architecture, design-source drift and anti-AI visual checks: exit 0 on the metadata successor, with command logs and source identities in handoff.json.
- Actual browser public API/DOM probe: exit 0, run `locale-menu-local-2026-10-08T11:06:30.760Z`, Chromium 147.0.7727.15. Exact narrow root, source SHA and clean starting status are in `final-consumer/probe.json`.

Browser coverage includes committed radio state, pending/failure/retry, links versus commands, Arrow/Home/End/Enter/Space/Escape, outside dismissal, focus return, disabled activation, repeated cleanup, latest-wins transaction, all ten locales, RTL/LTR, light/dark, reduced motion, five CSS viewport/zoom variants and four actual 200% browser-tab zoom variants. Browser-tab zoom uses `chrome.tabs.setZoom/getZoom`, with measured DPR and inner-width changes; it is distinct from CSS zoom.

Both forced-colors palettes were inspected from this run's rendered screenshots. Each underlay comparison inspects 154,326 popup-interior pixels: current and restored surfaces produce zero changed pixels against opposite black/white underlays. Test-only alpha restoration produces 113,843/114,034 changed pixels (light/dark), proving the opacity assertion detects the prior defect. Removing the focus pseudo-element is detected, then restored; Escape trigger paint is checked. Diagnostic changes are confined to temporary test DOM and cleaned up; the product has no private-selector repair. Scrollport clipping at the top of a tail-scrolled menu is not represented as whole-menu product acceptance.

## Setup, red evidence and remaining blockers

Frozen offline install and theme build succeeded. Fresh native preparation first failed because emcc was absent from PATH, then because CMake was absent. The existing Emscripten 6.0.0 / CMake 4.3.3 / Ninja installation was activated; official `pnpm ensure:wasm` then compiled the real scalar/SIMD native artifacts and bundle successfully. Artifact readiness inspection was fresh; this is build preparation, not native acceptance-counter qualification.

The official affected visual command actually ran, exit 1 **before browser suites**. Its cold icons producer changed an unowned index to add AddDocument, ApplicationMenu, RefreshReplace, Replace and SearchFilter. The exact patch was saved as `icons-producer-unowned.patch` and the task-generated source change restored. The final candidate excludes that repair. An exact canonical icons producer source commit and its acceptance evidence were requested from the coordinating parent; the final candidate affected visual qualification stays blocked until that prerequisite is supplied. No fingerprints, gates or baselines were bypassed. The historical broad 50 full-profile failures remain diagnostic only; they were not rerun or inherited as narrow acceptance.

The published-mode probe ran again, exit 3: the locked package is unavailable (ENOENT). It did not fall back to local source. An accessible exact published package identity and parity evidence are still required. Product backend/runtime acceptance and independent screen-reader/UX acceptance remain outstanding. The repository Skill requires “evidence that acceptance is independent from implementation”; this implementation does not supply such a receipt.

Early consumer probes in `invalid-binding/` actually resolved the preserved broad repository because the runner ignored the override environment variable. They are explicitly excluded from narrow proof. The Blog harness fix passes the override to the existing root resolver; all current results above use the corrected harness. Other initial setup/API/format errors are retained as red evidence and superseded only by the stated successful commands. Prettier on the entire source directory also finds unchanged `useDropdown.ts`; that file was excluded from owning-path formatting and remains untouched.

## Requested independent source review

Review exact `a96047c3a281df6f0ae035f27fc471ad4a645173..ee05723abce8c5e7f39b1895bc3c3044e998a6b0` and the complete diff artifact, including the owning public API semantics, unchanged main shared dependencies, generated field coverage and evidence limits. The UI source is available on the published branch. No new PR, PR update, issue comment, package publication, merge, deployment or acceptance waiver was performed. Rollback uses the isolated candidate/evidence branches; preserved broad heads remain available.
