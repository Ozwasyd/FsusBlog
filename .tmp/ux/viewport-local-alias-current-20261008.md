# Current local-alias viewport followup

WIP observations only. No qualification receipt, runtime admission, release manifest or device receipt is created. Blog product, matrix, helpers, snapshots, assertions and generated authorities are unchanged.

## Exact candidate and preserved history

Tests below ran on freshly fetched and independently ls-remote-verified Blog master `0a755584aa256995fd9997ca974806e8a0e29d2e`, in isolated branch `evidence/2228-local-alias-current-20261008`. The frozen Blog drafts #3872 (`34106bc85d4d76c58d04ac556dbc1e8c858a405c`) and #3908 (`1a03ce3355a5036bf4ff0de463fdd7366ec62867`) remain unchanged. Source candidate and later evidence-only commit identities are distinct.

At 2026-10-08 05:22 UTC, a further fetch/ls-remote found master `53da546cc8ab9fd8603067395d988b7ddb650394`: PR #3897 changes fixture lifecycle tests, fixture authority and two change-contract observations. Relevant viewport source/matrix/inventory paths are byte-identical (`git diff --quiet`, exit0). This observation does not upgrade the tested candidate to new-master runtime qualification.

FsusUI default main remains `f2b3bb89ffe5f749da26c388f058efdbb6aee864`; local alias for these attempts was `/workspace/FsusUI-828-geometry` at `cecf260475fab0a3efb3225f6d7aa39f96a0ae6b`, with PublicShell source `c325c600ea2760156d467bfaa375613879211cd9`. That separate branch is progressing #828 full-completion work. Frozen UI #839 (`49e64498d5f060482cd0c924070481f30e3e19d4`) and #844 (`cecf260475fab0a3efb3225f6d7aa39f96a0ae6b`) remain unchanged. Generated local full/critical CSS is required by the original resolver; local source/tarball evidence does not prove published-package parity. Missing publication does not prevent authorized local-alias development/testing.

## Commands actually run

Activation used the saved cloud environment, then official sealed Node24.16.0 ahead of the environment's Node24.19.0. Dependencies were linked individually, excluding mutable .vite/.cache directories. The original Wasm producer rebuilt this worktree's current artifacts; no other worktree's product dist, readiness receipt or viewport evidence was copied.

| Original command | Exit and observed result | Log in existing `.tmp/ux` |
| --- | --- | --- |
| `npm --prefix src/frontend run check:canonical-viewport-safe-area` | 0; 3 surfaces / 4 mutation probes | `viewport-current-canonical-20261008.log` |
| `npm --prefix src/frontend run check:document-viewport-source` | 0; source=1 / dist absent / 3 mutation probes | `viewport-current-document-20261008.log` |
| `node --test tests/tools/ux-viewport-plan.test.mjs tests/tools/ux-viewport-progress.test.mjs tests/tools/ux-viewport-risk-settle.test.mjs tests/tools/ux-viewport-runner.test.mjs tests/tools/ux-viewport-runtime-contract.test.mjs` | 0; 27 passed / zero skipped | `viewport-current-node-tests-20261008.log` |
| `FSUSBLOG_VITEST_MAX_WORKERS=1 ./node_modules/.bin/vitest run --config vitest.config.ts ../../tests/frontend/unit/viewport/canonicalViewportSafeArea.test.ts ../../tests/frontend/unit/viewport/uxViewportSafeAreaIntegration.test.ts` (cwd src/frontend) | 0; 11 passed in 2 files | `viewport-current-vitest-20261008.log` |
| `./tools/test.sh ux-viewport-smoke --plan-only` | 1; canonical inventory binding refusal, before runtime | `viewport-current-local-alias-plan-20261008.log` |
| `npm --prefix src/frontend run ensure:wasm` | 0; canonical producer rebuilt current source artifacts | `viewport-current-wasm-producer-20261008.log` |
| `npm --prefix src/frontend run check:ux:viewport-smoke` | 1; native WebKit launch failed before runtime summary | `viewport-current-smoke-first-attempt-20261008.log` |
| `npm --prefix src/frontend run check:ux:viewport-visual` | 1; same native launch failure before runtime summary | `viewport-current-visual-first-attempt-20261008.log` |
| `npm --prefix src/frontend run check:ux:viewport-boundaries` | 1; same native launch failure before runtime summary | `viewport-current-boundaries-first-attempt-20261008.log` |

The three entrypoints used managed Playwright browsers and the existing extracted official Debian library path. WebKit's bundled MiniBrowser wrapper resets LD_LIBRARY_PATH to its own directories; actual launch fails on `libwoff2dec.so.1.0.2`, exit127. No managed wrapper, host cache, launch policy or validation was modified. Missing current-run summary pointers are retained secondary diagnostics, not fabricated results. These attempts did not admit DebugStack, ReleasePreview or fixtures, execute surface cases, or establish Chromium/WebKit acceptance. Their first failures remain available separately from the matrix's earlier inventory refusal.

## Minimal capability requests and downstream limits

The original inventory producer was called read-only: all226 entries are identical; only `tests/matrix.yml` sourceDigest differs, recorded `9fdda48b5754dfd62b06c60fa081794b4f1e38cde044dd2bad0c49f704c584b6` versus actual `db612313706fa070e1cc6fa3734c3ab44f5b0e536e72908681b8fec67a093d03`. Recorded/projection content digests are `eaad2a7ca7d62cd1992a96ce944b563a81aa28f3443768d311370a7dab9d30c4` / `b744466873b75fd56bf1253018c0e874be58b73a45b364935366000025d884e8`. Request the coordinator's canonical governance owner and exact producer-generated repair commit; this evidence issue does not regenerate `config/testing/correctness-attempt-producers.json`. See `viewport-current-inventory-observation-20261008.json` and issue comment6052915178.

Native dependency provisioning and canonical #1950 runtime admission remain separate missing environment capabilities. #1950 is parent-coordinated; no parallel setup or security bypass is introduced. A precise native browser capability is required; no pending remote-CI blanket blocker is added. Applicable exact-candidate local checks can substitute remote CI under the user's authorization, while real unit/security/runtime/device failures remain applicable.

Verified canonical upstream capabilities are UI #842 / Blog #1805 commits `7d9de0259f26eb87ac102ca4ceddc2918ff7890a` (original icon producer output) and `9a482352ebb34b2c6fb079be5742626268cc34a7` (pending activation theme invalidation). Their owner evidence does not qualify #828 or this Blog candidate. The distinct #828 implementation branch will consume exact source with provenance and rerun affected checks. Identity-only generated baseline commit `06abdea678a8cb74682b83cc93e1ff31d3b271da` must not be blindly copied across different source inputs.

New #828 before captures discovered an actual uncovered compact-header failure at736×320 zoom200:122px>108.8px. Expanded-search/inline/bottom variants also exceed chrome budget and require their existing public interaction contracts to be reconciled; no exclusions or assertions were invented. That source work belongs solely to #828 in FsusUI, not this evidence PR. Existing52 visual failures retain exact paired baseline evidence (51 reproduced; one slider intermittent), with coordinator owner requests for Markdown/status/stress/asset-abort/CDN diagnostics. No sibling implementation is duplicated. See UI issue comment6052915824.

## Each owned issue

Full current bodies and relevant updates were reread and retained verbatim in `viewport-current-issue-contracts-20261008.json`; #2228/#2229/#1789 bodies match the previous preserved contracts. Closed boundary issues do not prove current acceptance.

- **#3477 completed reconciliation:** existing merged #3479 / PR3480 fix `2782960c90bd863cbca62345f197b3302c9be9f0` and current checker share blob `04ecf201800231f71f66388a17a432c87c73c7b5`. Original source semantics and negative probes are retained; current 3/4 static and11 viewport tests pass. No second implementation. This checker capability is usable by #2228; actual Drawer/browser geometry is still unqualified. #3477 remains closed with its existing exact evidence comment6051491777.
- **#2228 open:** static/tool/unit results above are real. Current live HTML source/dist/AOT/deep fallback/hydration, scrim/safe controls/actions, scroll/focus/body lock, overflow, all required Chromium+WebKit cases, runtime/fixture/readiness/binding, live mutation, tamper and0errors/0warnings acceptance are failed/blocked/not run. Smallest requests are canonical inventory repair, native browser provisioning, #1950 admitted runtime, and tested #828 source capability. Downstream #2229 may prepare the unchanged device contract but cannot consume a qualifying automated receipt.
- **#2229 open:** no real iOS17+ cutout/Home Indicator Safari capture/verifier channel and no same-candidate #2228 automatic receipt. Portrait/landscape/address-bar transitions, all three actual surfaces, continuous media, device/OS/browser/build/HTML/runtime identity, interaction/restoration, independent authenticity/privacy/tamper and all impostor/stale/single-shot/patch controls remain not run. Desktop WebKit or Simulator is not a substitute. The coordinator must provide the external real-device operator/verifier capability; none is invented or assumed. #1789 has no device qualification to consume.
- **#1789 tracking-only open:** aggregates all unchanged child requirements, nine test groups, bounded plan and15% smoke budget, bundle/test-only isolation, security/current identity and independent acceptance. #3477 source reconciliation is proved; automated and real-device qualification are not. Existing upstream sources may unlock implementation before their tickets close, without waiving their unfinished acceptance. FsusUI#262's historical closure/device-optional comment contradicts its body and is preserved, not adopted as a relaxation.

No package publication, deployment, default-branch push, merge, auto-merge or issue-boundary weakening occurred. A later separate review/merge task remains required. Every artifact here is supplemental WIP observation with qualificationEligible=false.
