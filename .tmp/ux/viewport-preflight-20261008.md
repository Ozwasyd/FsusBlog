# Current viewport evidence preflight

This is retained WIP observation, not an admission, release manifest, browser acceptance receipt or device receipt. No Blog product, matrix, helper, snapshot, assertion or governance source was modified. Original issue criteria and updates are preserved in `viewport-issue-contracts-20261008.json`.

## Candidate and environment

- FsusBlog latest `master`: `3bc9bacd55b4453ed0abd48632c6a1bb3f7944f8`, verified by fetch, remote tracking ref and independent ls-remote on 2026-10-08; initially clean.
- Evidence branch: `evidence/2228-current-safe-area-20261008`. Evidence commits do not retrospectively qualify the inspected source candidate.
- FsusUI latest default `main`: `f2b3bb89ffe5f749da26c388f058efdbb6aee864`, fetch/ls-remote verified. Remote `master` is absent. Baseline source preflight used the configured `/workspace/FsusUI` resolver; local source is not published-package parity.
- Saved cloud activation: `/workspace/.setup/activate.sh`. Linux 6.18.44 x86_64; no configured real iOS device capture/verifier channel.
- Default Node v24.19.0 does not match the repository's sealed parser v24.16.0. The official v24.16.0 Linux x64 archive was independently checked against the official SHASUMS256 file: `d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9`. Subsequent matrix preflight uses `/workspace/.setup/node-v24.16.0-linux-x64/bin` first in PATH; authority files are unchanged.
- Playwright 1.59.1 managed Chromium/WebKit were installed in `/workspace/.setup/playwright-browsers`. Browser availability alone does not qualify runtime or fixture identity.
- GitHub current-base check-runs lookup returned zero checks. Ruleset lookup returned HTTP403 (feature unavailable for private repository plan). Neither is recorded as a pass; no merge is attempted.

## Commands actually executed on the inspected source

All commands use FsusBlog root unless stated otherwise. Logs remain below the existing `.tmp/ux` evidence root. Every first failure is retained; later environment repair does not relabel an earlier attempt clean.

| Command | Exit/result | Evidence |
| --- | --- | --- |
| `npm --prefix src/frontend run check:canonical-viewport-safe-area` | 0; 3 surfaces, 4 mutation probes | `viewport-canonical-20261008.log` |
| `npm --prefix src/frontend run check:document-viewport-source` | 0; source=1, dist absent, 3 mutation probes | `viewport-document-20261008.log` |
| `node --test tests/tools/ux-viewport-plan.test.mjs tests/tools/ux-viewport-progress.test.mjs tests/tools/ux-viewport-risk-settle.test.mjs tests/tools/ux-viewport-runner.test.mjs tests/tools/ux-viewport-runtime-contract.test.mjs` | 0; 27 passed, zero skipped | `viewport-node-tests-20261008.log` |
| `FSUSBLOG_VITEST_MAX_WORKERS=1 ./node_modules/.bin/vitest run --config vitest.config.ts ../../tests/frontend/unit/viewport/canonicalViewportSafeArea.test.ts ../../tests/frontend/unit/viewport/uxViewportSafeAreaIntegration.test.ts` (cwd `src/frontend`) | 0; 11 tests in 2 files, zero skipped | `viewport-vitest-20261008.log` |
| `./tools/test.sh ux-viewport-smoke --plan-only` (default Node) | 1; sealed parser/target authority mismatch | `viewport-smoke-unpinned-plan-20261008.log` |
| Same command with official pinned Node v24.16.0 | 1; correctness-attempt producer inventory mismatch | `viewport-smoke-pinned-plan-20261008.log` |
| `./tools/test.sh ux-viewport-smoke --fresh` with pinned Node | 1 before runtime spawn; same inventory mismatch | `viewport-smoke-matrix-first-attempt-20261008.log` |
| `check:ux:viewport-smoke`, `check:ux:viewport-visual`, `check:ux:viewport-boundaries` via `npm --prefix src/frontend run` | Each 1 before browser execution; stale Wasm source commit receipt | Three `viewport-*-first-attempt-20261008.log` files |
| `npm --prefix src/frontend run ensure:wasm` | 0; existing canonical producer sealed current-source receipt for unchanged artifacts | `viewport-wasm-refresh-20261008.log` |
| Second smoke command | 1; managed browser missing, summary pointer absent | `viewport-smoke-second-attempt-20261008.log` |
| Second visual command with installed managed browsers and pinned Node | 1; actual WebKit native launch failed on missing libwoff2dec; summary pointer absent | `viewport-visual-second-attempt-20261008.log` |
| `FSUSBLOG_TEST_NAMESPACE=viewport-2228-20261008 bash tools/test/lanes/ux-viewport-smoke.sh` | 1; same-namespace bootstrap env absent | `viewport-smoke-lane-admission-20261008.log` |

The Node/Vitest negatives exercise their original contracts only. They do not prove live DOM mutation kills, current native/CI qualification or all negative requirements of #2228. The static document check explicitly did not inspect a built dist, AOT response, deep fallback or hydration.

## Exact smallest inventory refusal

The unchanged original `buildCorrectnessAttemptProducerInventory` was invoked read-only to compare the checked-in document with its current projection. All 226 producer entries are identical: zero added, removed or changed. Only `sourceDigests[tests/matrix.yml]` differs:

- Recorded: `sha256:9fdda48b5754dfd62b06c60fa081794b4f1e38cde044dd2bad0c49f704c584b6`.
- Current: `sha256:db612313706fa070e1cc6fa3734c3ab44f5b0e536e72908681b8fec67a093d03`.
- Recorded content digest: `sha256:eaad2a7ca7d62cd1992a96ce944b563a81aa28f3443768d311370a7dab9d30c4`.
- Current projection digest: `sha256:b744466873b75fd56bf1253018c0e874be58b73a45b364935366000025d884e8`.

See `viewport-inventory-drift-observation-20261008.json`. No inventory or gate was rewritten. Canonical source ownership is `tools/test/generate-correctness-attempt-producers.mjs` / `tools/test/correctness-attempt-producers.mjs` and `config/testing/correctness-attempt-producers.json`; the parent must route this exact generated-output repair to its assigned governance owner and return the verified commit/evidence. No sibling branch or qualifying receipt is guessed. This observation grants no policy promotion or runtime admission.

## Per-issue disposition and downstream capability

### #3477: reconciled and closed

The original #3172 commit `a4b1413a2c77f8dd6a595b8fd1b35c9fa5d398cc` intentionally removed account-main-scroll's inner scrolling structure. Independent merged #3479 / PR #3480 commit `2782960c90bd863cbca62345f197b3302c9be9f0` removed only its obsolete required formula. Current checker Git blob `04ecf201800231f71f66388a17a432c87c73c7b5` is identical to the merged fix, retaining drawer canonical token checks and all mutation probes. The current static check and 11 existing viewport tests passed. Evidence comment was added and #3477 closed as completed; no duplicate implementation. #2228 can consume this exact checker capability now. Drawer browser geometry remains a separate unmet #2228 gate.

### #2228: open, evidence preflight blocked

Implemented source is already on master, including `85ad5ad91a2bd7eefb597b70bc07a902f9a79e94` and the verified checker fix above. This lane adds observations only. Current acceptance is not established:

1. DebugStack, ReleasePreview, current backend/build/runtime/source identities and canonical representative fixtures are not admitted. The old cloud onboarding schema-startup failure is historical; current source contains a test materializer, but it was not admitted or run here. Do not label the historical schema error the current first failure.
2. Current source meta passed the static source check. Dist, Public AOT, deep fallback and pre/post-hydration meta identity/count/content are not run.
3. Zero-inset, portrait-notch, landscape-notch and short-visual, both browsers and the actual Dialog/MessageBox/Lightbox/Drawer routes have not executed against an admitted current live stack.
4. Scrim exact 0px edges, safe controls, short-visual reachable/triggerable actions, real focus/scroll/body lock restoration, horizontal overflow and long-content/two-button/alt/caption contracts remain unproved on live DOM.
5. Required WebKit execution has not passed. A native launch failure is retained, never a skip/diagnostic pass. No `.tmp/ux/viewport-{smoke,visual,boundaries}.json` or release qualification manifest is forged when the original producer stops before its current-run pointer.
6. Complete current source/FsusUI/package digest/matrix/plan/helper/schema/HTML/build/runtime/browser/fixture binding and independent verification are not available. Local source observations are not genuine published package parity.
7. Full current negative set is not qualified: missing/duplicate viewport, unsafe controls, shrunken scrim, skipped/missing WebKit, CSS selector patch/mock geometry, screenshot-only/snapshot substitution, Cartesian explosion, stale identities, runtime/readiness mismatch and tamper. Existing unit/static negatives passing do not sign these real-runtime controls.
8. First failures, zero-warning requirement, test-only bundle exclusion, fixed animation/fixture behavior, no extra retries, smoke <=15% budget and bounded full plan retain their original requirements. No current performance budget evidence exists.

Smallest missing capabilities: governance-owned current generated inventory binding; admitted canonical DebugStack/ReleasePreview/fixtures/build/readiness; native WebKit dependency provisioning; verified upstream #828 source and consumer evidence. Parent must return exact owner commits and usable limits, rather than waiting for whole tracking closure. Current source/checker/plan capabilities can be consumed for implementation; none is a runtime qualification receipt. #2229 may prepare its device contract but cannot qualify until the same candidate automated receipt exists.

### #2229: open, external device evidence unavailable

No device source implementation is needed or added. No device scenes were run. Every original portrait/landscape expanded/collapsed address-bar scene, same-session transition, Dialog/MessageBox/Lightbox operation, actual env/DOM/visual viewport/focus/scroll diagnostics, continuous media, exact current candidate/runtime/FsusUI/HTML binding, privacy and independent authenticity/tamper validation remains not run. There is no configured real iOS17+ cutout/Home Indicator capture channel or current #2228 qualifying receipt. These are the exact missing capabilities, owned by the external-device evidence operator and #2228 respectively.

Historical comments upgrading Simulator evidence contradict the current issue body and this task. Simulator/desktop WebKit screenshots and old SHA artifacts are not promoted, reused or represented as current real-device evidence. Device impostor/stale/single-shot/patch/leakage/tamper controls are also not run. #1789 cannot consume a device qualification from this preflight.

### #1789: open, tracking only

No second implementation or evidence system is created. #3477 reconciliation is complete; #2228 automatic and #2229 real-device qualification are unmet. All parent strict criteria, nine test groups, runtime/mutation/current-identity/security evidence, bounded plan/bundle/budget and independent acceptance remain applicable as captured verbatim in the issue snapshot. Closed prerequisite status does not prove their current full acceptance. Boundary issues #1785/#1786/#1787/#1788/#3478/#3479 and FsusUI#262 were reread. FsusUI#262's closure comment calls device evidence optional while its body requires it; preserve the contradiction without changing that owner's issue or relaxing this chain.

## Bounded upstream support

FsusUI#828 source work is separately owned on `fix/828-public-shell-short-landscape`, published initial source commit `c325c600ea2760156d467bfaa375613879211cd9`. Both full and critical CSS use the existing compact/default-menu presentation in short landscape and existing spacing tokens; independent support evidence will bind the final candidate. Chromium 844x390 light/dark header heights changed from 93/139/186px to 61/91/122px at CSS zoom 1/1.5/2. The support PR/remaining checks are reported separately. No Blog private-selector workaround, package publishing or evidence-PR product change is allowed. Local source support does not establish published package or final Blog browser parity.

Native WebKit dependencies were downloaded from official Debian packages into `/workspace/.setup/browser-libs/root`. Native validation still refuses `libGLESv2.so.2` through the system cache. The task-owned namespace probe refused `setting up uid map: Read-only file system`; no host privilege/security change, host validation bypass or fake ldconfig output was used. This is an unmet environment capability, not a WebKit pass.

The coordinating parent supplied optional locked-restore capability lineage through `2c380fee5cff5fa0e368b3da0a4052a4fe124263` / draft Blog PR #3848 (including `bd3dbde7939dc95c81cef4ab6b50f883459ee85d`) and four legal InlineData literals at `a95de1defd39a46f34992bed9eee3c150d990456` / PR #3828. These were not integrated: current execution stops earlier at the inventory gate, so locked restore/compile are not the current first failure. No sibling source is guessed or duplicated. Parent also reports the shared #1950 user-systemd/Landlock/cgroup admission gap; this lane neither repeats that setup nor converts it into a passing skip.

## Local CSS consumer contract preflight

Read-only resolver inspection identified an additional exact consumption requirement. Blog's `src/frontend/src/assets/main.css` imports `@ozwasyd/element-plus/dist/index.css`; `src/frontend/src/assets/public-shell-critical.css` imports the full critical CSS package subpath. `src/frontend/scripts/fsusui-local.ts` maps these to local `vue/packages/theme-chalk/dist/index.css` and `el-public-shell-critical.css`, not directly to the SCSS changed by #828. A compatible public adapter alone does not prove that the consumer CSS includes the candidate.

Before the canonical upstream theme build, both existing local dist files lacked the `max-height:520px` rule. Their hashes/lengths and the resolver/import paths are retained in `viewport-local-css-resolver-20261008.json`. The original support-owned `pnpm run build:theme` first attempt returned exit0 at release-metadata head `79988a85e5f893a5d06eb9ee499c07c3abc37e39`; header SCSS is byte-identical to tested source `c325c600ea2760156d467bfaa375613879211cd9`. Root independently checked both generated bytes: full CSS SHA256 `081d9f1036095d1f7c70326c147e073717888a50570f01686745e3f318f8c74c` (558274 bytes), critical SHA256 `489ffa4cff3a3903dfb9d19e23cdbad084a8e24aa898e3602c5dbe58e35962e0` (16953 bytes), each now including the original short-landscape rule and shared space2 padding. Original support runtime readiness postbuild exit0. The JSON binds both prerebuild failure observations and postbuild local output capability; generation is not package publication. Recheck the exact generated outputs when resuming Blog's genuine runtime. A local rebuild remains distinct from standalone critical browser, Blog live-stack and published-package qualification.

## Resumption and limits

Published Blog draft: https://github.com/Ozwasyd/FsusBlog/pull/3872, initial evidence commit `5d63ff2103ca04f96064330ebd8ae8c8eba6b032`. Its actual API PR/head/base/author/labels were checked by the original `check-change-contract.mjs --github-event`: exit0, 18 changed evidence paths. Independent artifact custody check matched all 17 digests and byte lengths. Head check-runs and statuses were empty (pending combined state), not CI passes. Original merged checker and viewport source commits were confirmed ancestors of inspected master with exit0.

Separate upstream draft: https://github.com/Ozwasyd/FsusUI/pull/839, source `c325c600ea2760156d467bfaa375613879211cd9`. Root independently inspected original Light/Dark zoom200 before screenshots and candidate production-component screenshots: desktop brand/nav/auth visibly overlapped before; compact default brand/Search/Menu is visible on one row after. The original Blog composition uses the public named adapter with `mobile-nav-mode=menu` and `mobile-search-mode=trigger`, matching the implemented source capability. The support owner's production-component report has 36 light/dark x English/Chinese/long-copy x anonymous/authenticated x zoom1/1.5/2 variants checking the 34% budget, 44px targets, no overlap/overflow and keyboard menu/search Escape/focus return. Its original affected visual retry passed 38 Chromium cases; first source-fingerprint failure is retained in that support report. This limited independent inspection is not full independent UX acceptance, WebKit, Blog live-stack, real-device or published-package parity. Expanded search, explicit inline and other short heights retain their own gates; support acceptance stays rejected while gaps remain.

Support final evidence commits may add observations without changing the source above. Verify the exact source ancestry, CSS and baseline when consuming them; no published artifact or merge qualification is inherited.

Consume exact available capability commits after verifying source/API and limits. Resolve only the minimal owner-specific gates above; do not wait for all DAG tasks or duplicate another owner. Re-read current issues, fetch latest default branches and invalidate stale artifacts before resumed qualification. Preserve original first attempts even after environment repair. No direct-master push, merge/auto-merge, deployment or package publishing occurred; later separate review owns merging. Rollback of this PR removes only retained observations and must not relabel failed runtime evidence.

## Final upstream test disposition

The support-owned original full visual command finished with exit1: Preview 645 passed / 43 failed / 688 (10.1m); required Dev 10 passed / 9 failed / 19 (5.4m); aggregate 655 passed / 52 failed / 707. Capture-data and motion-family failures include afterEach diagnostics caused by the external image CDN TLS certificate error, not proof that motion limit assertions failed. Markdown rapid switching records aborted dynamic resource requests; other Markdown failures include screenshot/toolbar geometry expectations. A desktop-dark form case and Dev stress/scrollbar timeouts remain. The exact individual failures/logs belong to the separate upstream report. No TLS bypass, snapshot update, assertion weakening or unrelated implementation was introduced; 14 runner-generated metric PNG deltas were retained in ignored temporary storage, then restored to their original tracked hashes. The original affected retry38, focused30 unit tests and local interaction36 remain their limited passing evidence. Source c325 remote CI is non-green; final evidence-head CI is not inherited.

Release-only metadata commit `79988a85e5f893a5d06eb9ee499c07c3abc37e39` corrects existing workspace changeset names to `element-plus` and `@element-plus/theme-chalk`. Source/header CSS and component APIs remain unchanged; no package was published and no full suite is rerun solely for this metadata. This follow-up and source-bound local theme build can be consumed independently of the upstream issue's retained full-acceptance gaps.

## Resumed diagnosis of the 52 upstream visual failures

Defaults were freshly fetched again and independently verified unchanged: Blog master3bc9, FsusUI mainf2b3. Full current bodies for #2228/#2229/#1789 match the retained originals byte-for-byte; acceptance definitions remain unchanged. #3477 is already closed and is not implemented again.

Root prepared an isolated detached worktree at exact FsusUI baseline `f2b3bb89ffe5f749da26c388f058efdbb6aee864`, with separate Vite cache directories and original production runtime producer/readiness checks both exit0. Dependencies/unchanged WASM and icon artifacts were copied/linked only for validation by that producer; no baseline product source, snapshots, fixtures or assertions were edited. Original targeted Preview configuration ran 116 tests including positive controls: exit1, 74 passed / 42 failed (3.4m). All42 map to42 of the original43 Preview failures, with no additional failures. The originally failed desktop-dark slider overflow case passed in both baseline and candidate reruns; it remains intermittent and unqualified rather than relabelled a clean full-run pass.

The support owner's candidate reruns reproduce the same diagnostic/copy/screenshot families; the light rapid-switch resource-abort failure also passed once and is recorded as intermittent. Root independently compared all22 baseline/candidate mobile actual screenshot files: identical PNG bytes and zero differences in every RGBA channel. The production route observations find no PublicShell or changed-selector matches. These are evidence that the existing failures do not currently justify a PublicShell source repair; they are not acceptance waivers or a full green suite. The raw paired commands and artifacts belong to the separate FsusUI diagnosis archive. Baseline Dev19 is still running; its outcome must be recorded before claiming complete per-failure reproduction.

The exact shared public-type commit `384112ac023a49a8a4fb605f31c05fbd25dd09f5` was fetched from FsusUI and verified as a one-file change to InteractionTraceFixture public MarkdownEditorProfile typing and an existing test-attribute fallthrough pattern. It is not consumed speculatively as a repair for these runtime failures. No assertions or runtime behavior were changed by that capability.

Unchanged Blog formal `./tools/test.sh ux-viewport-smoke --plan-only`, with the sealed Node24.16.0, again exited1 before runtime on the canonical inventory binding refusal; its original ExperimentalWarning is retained as well. No new runtime admission or #2228 automatic receipt exists. The smallest missing governance capability is still the current matrix sourceDigest repair through its assigned canonical owner. #2229 real-device capture/verifier and same-candidate automatic receipt remain unavailable; #1789 aggregates these actual gaps and stays open. Source capabilities remain usable independently of full issue closure, but local theme builds, paired baseline failures and independent pixel checks do not establish published-package, WebKit, live-stack or real-device parity. See `viewport-paired-upstream-diagnosis-20261008.json` and `viewport-followup-plan-20261008.log`.
