# Article comment composer source receive WIP

Ordinary source handoff for [Blog #1889](https://github.com/Ozwasyd/FsusBlog/issues/1889). This record and its logs are not a receipt, policy, runtime observation, SOURCE aggregate acceptance, independent UX acceptance, qualification or release authority. The new PR stays draft and #1889 stays open.

## Exact source and deduplication

- Blog base: `b302f58a9aaee9f2399d9274157a478f3c2f78fb`.
- Donor: [draft #4375](https://github.com/Ozwasyd/FsusBlog/pull/4375), `b3883458aaceefc3ba6b6fd2a291a38ce55042b7`.
- Only production path: `src/frontend/src/components/article/ArticleCommentComposer.vue`.
- Full preimage blob, both selected base and donor parent: `574110e9146680e248746470789d2bd77098b2d5`.
- Exact received postimage blob: `f37f60daac919884db8c23ed1f70429dc1920bb6`.
- Received component SHA-256: `2525bac81b66a40b9bcd7900d1b89faa7d949961aae8e94fd8d16cddb5bb25ae`.
- Entire script SHA-256, equal in base/donor/candidate: `648379b2c0a5f3b342b88c2da0707053e61071868af738c404d32b4afe57b47f`.
- Source receive commit: `26c2ca5b1b8f8b8685d219038751d40773537ea3`, sole parent exactly the selected Blog base.
- Isolated branch: `codex/1889-receive-composer-ui981-20261016`. The final head is in the PR body; it cannot self-reference this metadata commit.
- Actual fixed FsusUI #981 source: `2e0e059f193407170d8e23bcc40d59f1af3291f6`, clean detached `/workspace/FsusUI-2e0e059`. Both base and candidate use this same original local alias project; generated project snapshots are included in the archive.

Before editing, open PR search and files for #4420 (`4207252d2a15c0029f163b771a44cbfd01560c4d`), #4421 (`91c099d5dd7f886448bd273f68777f790df6a3b7`), #4422 (`5cf3244e29efc5e873c52e02364570f0b57e7636`) and #4412 (`f3c365a96534576964d35b4af6505bf40ae02259`) showed no Composer path in their deltas. Existing historical forks #3928 and #4066 have different Composer blobs (`939d57fd7102f648ef38c777062f852ad78f0eeb` and `f959f4ac716bb55c48653123eec78661e8b6d8e7` respectively). #4375 is the donor, not another receiver on this selected base. No matching receive PR was found. The archive retains the actual read-only metadata. This is a bounded repository check, not a claim about unseen orchestration tasks.

Only the named donor blob was extracted after matching the full preimage. No donor cherry-pick, merge, rebase, whole tree, unrelated history, lockfile, permission, frozen evidence, receipt, registry or shared-gate change is included. Other PRs and the integration base branch are untouched.

## Received behavior and guard preservation

Delegate the existing native identity checkbox to public ElCheckbox; both copied mode controls to public ElTabs/ElTabPane containing the actual editor/preview panels; draft actions to ElButton; expanded textarea to public ElInput. Both editing surfaces retain the same content, options, mode and submission handlers. Public pane names have inline/focus prefixes. Refs remain outside loops. Existing auto-resolution consumes public root exports, with no extra adapter, native fallback, private selector or product CSS patch.

The entire product script is byte-identical to the selected base, so publicIdentityModel, publicSendConfirmed, clearPersistedCommentDraft, privacy purge, draft storage owner, lifecycle/security cleanup, props/emits and focus/submit guard code are preserved. No new account-level preference persistence is introduced. Source equality does not establish runtime/IME/focus or privacy behavior acceptance.

## P2 disposition on actual UI981

1. **Input CSP-safe resize source dependency resolved.** Upstream receive commit `7467b0bd410d2487494c4f32ba33b7c608011570` supplies a library-owned resize modifier for `type=textarea && cspSafe && resize` and static theme rules. Both unchanged Blog Inputs supply `csp-safe` and `resize="none"`. The exact UI981 stylesheet was statically compiled with the existing Sass tool; its output includes `.el-textarea.el-textarea--resize-none .el-textarea__inner { resize: none; }`. This selector is inspected upstream output, not a Blog override. No private selector or custom CSS was added to Blog.
2. **Tabs naming source dependency resolved.** Upstream receive commit `8b8217a3aca591e331b3068b8977c6b2c7f1c9e1` forwards `aria-label` and `aria-labelledby` from public Tabs attrs to TabNav and then to its actual `role="tablist"` element. A TypeScript AST read of the actual UI981 TSX records both forwarding steps. The original Composer labels `评论编辑模式` and `扩展编辑模式` remain unchanged. No label deletion, DOM patch or custom tablist was introduced.

Both are source/static conclusions at UI981, not computed-style, rendered accessibility, keyboard or whole-control acceptance. UI981 was still an open draft at metadata capture. Upstream source review does not accept this entire control or SOURCE aggregate.

## Original full static checks

All commands, start/end timestamps, actual exit codes and complete combined stdout/stderr are in `full-static-logs.tar.gz`; `commands` are original invocations without narrower include/exclude sets, relaxed strictness, diagnostics filtering, stubs, fake modules or registry replacement. Existing installed dependency trees were reused; no installation, dependency resolution/setup script, package build, native setup or safety setting change ran.

| Original static check | Base | Candidate | Difference |
| --- | --- | --- | --- |
| `node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application`, UI981 alias | exit 2, 29 errors | exit 2, 29 errors | Byte-identical logs; no Composer diagnostic |
| From src/frontend: `node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json` | exit 2, 297 errors | exit 2, 297 errors | Same diagnostic locations/codes |
| From src/frontend: `node_modules/.bin/vue-tsc --noEmit -p tsconfig.fsusui-published.json` | exit 2, 17 errors | exit 2, 17 errors | Same diagnostic locations/codes; focused project excludes Composer |
| From src/frontend: `node_modules/.bin/vue-tsc --noEmit -p tsconfig.node.json` | exit 2, 1 TS7016 error | exit 2, 1 TS7016 error | Same missing declaration in vite.config.ts(11,54) |
| `node tools/frontend/check-frontend-style.mjs --mode full`, UI981 alias | exit 1, 83,664 findings | exit 1, 83,664 findings | No added/removed file-rule-message finding |
| SFC script/template/style compilation and TSX AST parse | exit 0 | exit 0 | Actual source only; generated product code never executed |
| Upstream Input stylesheet: `node_modules/.bin/sass --no-source-map vue/packages/theme-chalk/src/input.scss <task-log-root>/input.css` | actual UI981 source, exit 0 | same fixed UI source | Owning stylesheet emits resize:none for CSP-safe class |

The local app and lint commands use `FSUSBLOG_USE_LOCAL_FSUSUI=1 FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI-2e0e059`. The original registry `app`, published and node configurations are also run as-is from each `src/frontend`; no UI source alias is substituted into those registry projects. The published project is a focused export contract and does not include Composer, so its result is not full component evidence. The original full local project is inherited from the full application configuration with strict, noUnusedLocals/noUnusedParameters and erasableSyntaxOnly preserved.

Full lint retains the same three failures on both sides: baseline configuration digest stale, baseline source-state digest stale and baseline generatedFrom mismatch. The inherited Composer `:global` stylelint finding remains. Compared with the historical #4375 record, all four compiler error counts and the lint count are numerically unchanged; historical raw logs are unavailable, so no byte-for-byte claim across restored tasks is made. Current base/candidate comparisons use the newly captured complete logs. No static check is reported as green except the explicitly successful compiler/AST/style compilation tools.

The checks ran against the exact production bytes above in the isolated candidate worktree. This final source receive also archives ordinary WIP data outside the production/static source sets; no whole-tree admission or successful baseline receipt is claimed.

## Historical failures and explicit HOLD

The archived `historical-pr-4375.json` preserves the previous PR record. Its initial UI961 and later UI969 comparisons reported local app 29 errors, registry app 297 errors, focused published 17 errors and node config one TS7016 error, plus 83,664 lint findings on each side and three stale-baseline header failures. The earlier UI969 registry runs also had varying nonzero exit statuses. The first donor lint pass had one new place-self shorthand finding, fixed before the exact received donor blob. The inherited `:global` stylelint finding remained. Historical UI961 resize and UI969 tablist-label source failures are resolved only at the newer upstream source revisions described above; they are not silently erased from history.

The previous raw `/tmp` logs were absent after this environment restore. This handoff retains the historical PR metadata as historical facts, not fabricated/recreated old raw logs. Every current full-static log is newly captured in the committed archive; raw byte lengths and SHA-256 digests are in `log-digests.json`, and decompression was checked byte-for-byte before commit.

Existing static failures, missing legitimate published package access and source/registry/document drift are not repaired through this narrow receive. Neither configuration nor frozen baseline is weakened. Runtime, test discovery/execution, product module execution, mount, browser, installation/setup, safety settings, publishing packages and qualification flows remain HOLD and were not run. No workflow is manually dispatched. The source commit uses `[skip ci]` to respect HOLD; missing/skipped CI statuses are not passing checks.

## Remaining handoff

- Static/library/package/generated-API and baseline owners must resolve the recorded failures through their real source owners, with no local baseline refresh here.
- Runtime, selection/IME continuity, label/disabled/blocked semantics, public/anonymous behavior, draft recovery/cleanup, Ctrl/Cmd+Enter, focus return/trap, CSP computed behavior, keyboard/touch/screen-reader, light/dark, viewports/zoom and independent acceptance remain unexecuted under HOLD.
- Full actual built-theme/WASM/runtime consumption and legitimate published package validation remain unverified; this task fixed the real source alias for static work and compiled only the owning Input stylesheet.
- Frozen tests/fixtures and independent acceptance must be handled by their owners after authorization; this task does not rewrite them or sign their receipts.
- This receive does not integrate other source PRs or the latest master. Rollback before integration is a revert of the receive commit; no API/schema/storage migration is introduced.

## Archive use

The archive contains complete logs, original command metadata, source-identity/dedup snapshots, SFC/TSX AST report, unexecuted compiler output, compiled upstream Input CSS, source diffs and the ordinary capture/audit scripts. Those scripts are archived solely for inspection/reproducibility, not installed or run as product code. `log-digests.json` records archive byte preservation for this handoff only; it is not a policy receipt or qualification gate.
