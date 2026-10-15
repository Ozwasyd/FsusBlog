# Locale Button independent source intake WIP

This is ordinary source progress for open issue #1895, related to locale menu issue #1891. It is not a frozen baseline, classification or acceptance receipt, runtime evidence, qualification, or completed menu cutover.

## Exact receiving boundary

- Receiving common base: Blog #4385, `b302f58a9aaee9f2399d9274157a478f3c2f78fb`.
- Only selected donor: Blog #4392, exact head `1920bb8bcd9bcc16317c745473a95abe0f2ceb18`, original base `d5773ef97f55176a1eab67e677790f3e13352a7b`.
- Independent branch: `codex/intake-4392-on-4385-20261015`. A dedicated PR base branch will remain fixed at the receiving common base; no other task branch is changed.
- Only changed production file: `src/frontend/src/components/ui/LocaleSelector.vue`.
- Both original donor and receiving preimages are the same blob, `86ec82ec6ffe7f5bfcdddfff7dde7c05686255ba`. The complete production-only patch applies with `git apply --check` and `git apply`, without conflict. No manual conflict or extra adaptation is invented.
- Receiving postimage is byte-for-byte the reviewed donor blob `e7a69205123a67e7b8414a0b78b56f6f73762339`, SHA-256 `93d16fc68cc9023a80e2393cfdc30ddb526097bf488a66ebcc90731bec12a90b`.
- No donor commits/history are replayed. All other receiving production files, policies, locks, tests, frozen artifacts and authority are preserved.

Before creating any intake, authorized GitHub reads searched all states for `4392`, the exact donor SHA, `4385`, and locale plus `4385`. The original donor was the only result for its exact SHA; existing common-base intakes concern other leaves. No matching leaf/common-base intake was found. Search and exact PR metadata are retained in the evidence directory.

## Active real FsusUI source

The actual local source alias is `/workspace/FsusUI-intake-4392`, detached and clean at reviewed UI #981 head `2e0e059f193407170d8e23bcc40d59f1af3291f6`, tree `c6364151c13b0f39ebfcbeb4c977a9519b0c1233`. This includes the accepted Tabs/Input/Button theme source sequence. The theme blob is `842cf20ef632f82ded987d99c9bcbb4fcac2327c`. The original `/workspace/FsusUI` checkout and all other branches remain untouched. Package source metadata is `element-plus@1.5.1`; Git source identity, not this version string, identifies the input.

Both `element-plus` and `@ozwasyd/element-plus` resolve the real source public `vue/packages/element-plus/index.ts` through the original full local-application producer. The effective project retains all 771 application root files and original strict, unused-local, unused-parameter and erasable-syntax settings. Installed original dependencies are linked at the same ten UI dependency locations; the Blog frontend uses its original installed dependencies. The two existing ignored Blog declaration files are copied unchanged and hashed; no declaration producer is run. Generated checker configuration snapshots are ordinary evidence and retain their original path meaning.

**Product theme CSS is NOT BUILT.** Neither old CSS nor source Sass is consumer acceptance. This task performs no product/theme/demo/package build and no Sass compilation. UI981 source presence and static equality do not establish delivered CSS identity, selector cascade, focus ring, contrast, geometry, ARIA, keyboard, browser or consumer UX acceptance. This dependency remains explicit WIP/HOLD for independent review and separately authorized execution.

## Bounded production composition

The reviewed patch delegates the existing locale trigger, both retries and no-href item branch to the public `FsusUiButton` adapter, using its public exposed ref for focus. It preserves the href anchor and all existing select/retry/open-change payloads, locale presentation, pending/error/disabled state, keyboard/menu/outside-pointer handlers and controlled-open behavior. Product-owned slot rows, one-track item layout, zero row margins and content-driven menu-button height retain the reviewed multiline composition. No private selector, DOM query, component fork, new token or controller is added.

The design ownership remains prescribed public Button consumption with bounded product composition in public navigation (`public-editorial`, with the existing menu overlay). The two repository design Skills, Blog governance/surface profiles, and UI981 design/governance/classification/consumer/Button contracts were read and their exact bytes/digests retained. Formal frozen classification and independent UX acceptance are not refreshed. No rendered state is inspected in this held source-only task.

## Original complete static comparison

Completed results and full raw evidence are listed in `locale-button-intake-4392-static/comparison.json` and its delivery map. No failed result is waived or converted into PASS. The initial missing-style-tool invocation is retained separately; installation uses only the original style-toolchain lock with lifecycle scripts disabled and a task-local cache. No tracked source configuration or lock changes.

Checks run before and after the production-only patch from the same Blog worktree, with `FSUSBLOG_USE_LOCAL_FSUSUI=1` and `FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI-intake-4392` for original app/lint commands. Both sides use unchanged original complete configurations and dependencies. The checked candidate was the exact base plus this one production postimage; the final delivery binds that identical production blob with ordinary WIP/evidence additions.

All original processes completed before evidence copying. Original raw bytes, exits, full generated/effective configurations, installed-input identities, patch/preimage/postimage proof and context are persisted as regular repository files. They are ordinary diagnostics, not qualification authority.

| Original complete static command | Base | Receiving source | Comparison |
| --- | --- | --- | --- |
| `npm --prefix src/frontend run typecheck:local-fsusui -- --application` | FAIL exit 2, 29 diagnostics (Blog 4 / UI 25) | FAIL exit 2, same 29 | Complete raw bytes identical |
| `npm --prefix src/frontend run lint:full` | FAIL exit 1, 83,667 diagnostic lines | FAIL exit 1, same 83,667 | Complete raw bytes identical |
| `node src/frontend/node_modules/typescript/bin/tsc --noEmit -p src/frontend/tsconfig.node.json` | FAIL exit 2, TS7016 | FAIL exit 2, same TS7016 | Complete raw bytes identical |
| `node tests/frontend/checks/static/check-fsusui-boundary.mjs` | FAIL exit 1, 20 findings | FAIL exit 1, same 20 | Complete raw bytes identical |
| `node tools/governance/check-code-intent.mjs` | FAIL exit 1, 2 errors / 5,747 checked files | FAIL exit 1, same 2 / 5,747 | Complete raw bytes identical |
| `node tools/docs/generate-document-lifecycle.mjs --check` | FAIL exit 1, 7 output lines | FAIL exit 1, same 7 | Complete raw bytes identical |
| `node tools/docs/check-authoritative-development-docs.mjs` | FAIL exit 1, 41 output lines | FAIL exit 1, same 41 | Complete raw bytes identical |

The original full application log has SHA-256 `19e6624b78fcf688af110d321bd56a86001967e6007c7280554cc1dc23bc6274` on both sides; the complete full lint log has SHA-256 `1a372b6010e60347004476cc6c7ab3ec8c65688767afc9e2378ab5958cb8117d` on both sides. The 83,676 raw lint lines include 83,667 diagnostic lines plus npm invocation/notice lines; no lines are discarded from delivered logs. Neither complete check reports the owned component. Full generated/effective configs are byte-identical before/after. Strict and unused/enum diagnostics, stale baseline configuration/source-state/generatedFrom reports and every other original failure remain failures. Whitespace validation exits 0; it is not product acceptance.

The donor's ordinary WIP is retained byte-for-byte as historical context. Its historical absolute `/tmp/r22-*` log references describe its original session; those earlier raw logs are not present in this environment and are not reconstructed, retimestamped, or claimed to be recovered. Fresh receiving-base/candidate raw checks are separate evidence.

The first staged whitespace check failed on the retained diff patch's blank context lines (a literal patch context marker followed by newline). Production whitespace was clean. The exact patch and the exact initial failure log are losslessly Base64 encoded in ordinary regular files, with original byte counts/digests and delivery encoding recorded in the map. Decoding reproduces their original bytes; no original diagnostic or source patch is trimmed. All complete compiler/linter/governance raw logs remain directly readable. Final staging whitespace is checked again with the unchanged original Git command and no attributes, suppression or configuration changes.

## Execution and delivery HOLD

All existing runtime/tests/testcollection/list/discovery/productimport/moduleexecution/setup/mount/browser/native/worker/kernel/DB/network-security/privacy/receipt/race/backuprestore/IME/frozen/qualification HOLDs remain HOLD/UNRUN. No product/helper/parser module is imported, evaluated or called for runtime behavior; only original static compiler/linter/governance tooling executes. No substitute harness, mock authority, credential/security change, rejected-task restart, authority refresh, safety/API/permission expansion or real-host binding. Original cancellation, settlement and ownership semantics remain unchanged.

Delivery is draft only. No Ready transition, merge, close, package publication or deployment. Missing/skipped remote checks are not PASS. Independent review of this exact receiving increment, product CSS output and all held runtime/consumer qualification remain WIP. Rollback is to omit/revert this single receiving increment to the exact common base; no live state is changed.
