# Cancelled-Escape focus correction handoff

Related to FsusUI #830 and FsusBlog #1891. Both remain **OPEN/WIP**. This bounded correction goes back to the same reviewer, `01a11b3a-b8fa-7638-ae1c-eaea38fdb032`. No new review task or content API write occurred.

## Exact source identities

- Preserved reviewed head: `ee05723abce8c5e7f39b1895bc3c3044e998a6b0`, branch `task/830-dropdown-current-main`.
- Published correction branch: `task/830-cancelled-escape-focus`.
- Actual production/test correction: `ea4e16b9b8bb62c5b75b1b60d66c6b73a489b8e4`.
- Published final candidate: `f1e8a8cd6f22ded63f2fa2320381e82caa3076e3`; its successor changes only three official generated metadata files.
- Verified main: `a96047c3a281df6f0ae035f27fc471ad4a645173`.
- Blog harness/consumer source tested: `49472afcbdc6a0321d53fe236aa42b26b29492f1`; product LocaleSelector source remains `e863c6fec58dab2de3029e759eb3c4c1f082f7d6`. Evidence is on separate `task/1891-cancelled-escape-evidence`; prior evidence branches stay unchanged.

Review [the complete eight-path correction](correction-full.diff), [its stat](correction-full.stat), [the full current-main candidate](main-full.diff), [scope/assertion preservation](scope.json), and [actual commands and results](handoff.json). The correction includes two owning Dropdown implementation files, the existing radio regression file, its nearest doc and a changeset, plus three generated source-provenance files. Shared Menu/Popper/focus-trap and other component source remain untouched.

## Behavior and proof

Previously, menu capture handling armed a restore flag before a public item could cancel Escape. The popup remained open, but later outside dismissal consumed the stale flag and focused the trigger.

The menu now handles Escape during bubbling, after item/menu cancellation. A non-cancelled Escape explicitly requests this Dropdown's close with its event. Focus restoration uses the actual Tooltip hide reason, eliminating the earlier flag. A cancelled event does not close or arm restoration. A child Dropdown consumes its own Escape without propagating closure to the parent.

All original test-file lines remain as an ordered unchanged subsequence, verified in scope.json; no original assertion was removed or weakened. Added controls cover the exact cancelled-item Escape then outside-button sequence, plus ordinary and cancelled nested Escape, committed checked state, parent visibility and subsequent outside focus.

The complete transferred reviewer fixture and runner are preserved under `cancellation-fixture/` and `cancellation.mjs`, with every assertion unchanged. On the reviewed implementation, its browser report records **active=trigger**, page errors empty, exit 1. On the final clean corrected candidate, it records **active=outside**, page errors empty, exit 0. Reports, screenshots, harness hashes and exact source binding are retained. The reviewed-source negative test temporarily selected only the two exact reviewed Dropdown source blobs inside the separate correction worktree; a finally block restored both. No reviewed branch was edited.

Early synthetic unit variants lacked the actual browser click's mousedown event, leaving shared focus-reason state in keyboard mode; those failures are retained. The complete pointerdown/mousedown/focus/click input sequence still rejects the reviewed implementation (1 failed, 11 passed) and passes the correction (12 passed). No shared focus behavior or focus assertion was changed to obtain this result.

## Current executed checks

- 85 library tests / 12 files passed: original 82 controls plus 3 new regressions, exit 0.
- 33 Blog locale component/adapter/coordinator tests / 3 files passed, exit 0.
- Existing consumer probe passed against exact `ea4e16b9b8bb62c5b75b1b60d66c6b73a489b8e4`, clean at start. Radio, pending/error/retry, URL/command, keyboard/outside/focus, ten-locale/RTL/theme/touch, actual 200% browser zoom and forced-colors focus/opacity negative controls remained intact. This is probe evidence, not independent product acceptance.
- Additional public-import browser fixture passed 12 real cycles across single/nested and ordinary/cancelled Escape. It verifies checked state, parent visibility, repeated reopen/close and outside focus using public data attributes and root exports.
- Same reviewer's unmodified probe passed again at final `f1e8a8cd6f22ded63f2fa2320381e82caa3076e3` after build cleanup, with sourceStatus/statusAfter clean.
- Direct no-cache Web and Vitest types, official API baseline, Contract V2, public-contract gate, owning ESLint/Prettier, interactions, domain conformance and documentation checks all exit 0 at final `f1e8a8cd6f22ded63f2fa2320381e82caa3076e3`. Logs and arguments are in handoff.json.

Only metadata changed between the runtime test source and final candidate; scope.json proves the runtime source is unchanged. Rendered current reviewer, negative-control and forced-colors screenshots were inspected. No new independent acceptance receipt is claimed.

## Local package attempt and open gates

The permitted `pnpm package:candidate:build` command actually started at final `f1e8a8cd6f22ded63f2fa2320381e82caa3076e3`. WASM preparation reused its source-matching artifacts. The canonical icons producer then changed an unowned index to add AddDocument, ApplicationMenu, RefreshReplace, Replace and SearchFilter. A task-scope guard stopped the build before candidate packaging; actual process exit was 129. This was an intentional source-binding stop, not a compiler failure or a successful package build. The exact patch and raw log are retained; only that task-generated index change was restored.

The package build's clean stage removed generated theme output. The official theme build was rerun successfully, and the reviewer probe then passed again against the final clean source. No manual fingerprint stamp or fake artifact was created. There is no valid narrow tarball, so candidate verify and fresh consumer install remain **not run / blocked** until the parent supplies the exact applicable canonical icons prerequisite and acceptance evidence.

A locally built and freshly installed immutable tarball would be local package-artifact evidence, not an attestation of registry provenance. The issues' explicitly published acceptance requirement remains OPEN. No package publication is authorized or performed.

Other limits remain preserved: official affected visual previously exited 1 before browser suites; the unavailable-package probe previously exited 3; parent-reported generated-contract formatting and build-utils checks exited 1 and are not claimed repaired here. Full/native/performance/release and independent product/screen-reader/UX qualification were not rerun or accepted. No unrelated owner work, acceptance waiver, merge, deployment, closure, PR update or issue comment occurred.

The exact source correction and evidence are ready for the **same reviewer**. This task does not create or select another reviewer. Rollback remains branch-scoped; the reviewed head and both broad candidates/evidence are preserved.
