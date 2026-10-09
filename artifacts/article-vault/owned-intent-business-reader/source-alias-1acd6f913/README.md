# Current intent consumer source-alias verification

The exact runtime source is `1acd6f913bfdcac50e2d38e072668d389946e669`, based on the published consumer `b66ad3ea5e730236af0beba21f7bab39477c5004`. The isolated, read-only upstream source is FsusUI public `main` at `8db0ac8f49749e3e5f28be5051bb3d3ed71ada71`. The documented installation producer is the supplied FsusBlog commit `75e66fa4e7ad7e4c1d58357298ac5fd18735d1f4`. This stage does not inherit supplier controls, the old unexecuted 21 cases, or standalone UI/package qualification.

The original installer projected the unchanged checked-in manifest and v3 lock into a disposable directory. Actual `npm ci` installed 490 public locked packages with lifecycle scripts disabled. Its verifier checked the original locked runtime dependencies and created source import links only in the isolated UI checkout. All 25 physical Vue-provider comparisons across consumer, source root, declaration hosts and actual editor component matched. The original standalone FsusUI checkout was not modified. Theme/Wasm artifacts were copied from the existing real build; their corresponding source trees had no changes between the observed build checkout and the selected UI commit. Their hashes are retained in `source-assets.json`; this stage did not run or qualify Wasm execution.

The first test discovery exposed incorrect imports in the new control file. The corrected file uses the original public `@ozwasyd/element-plus` and markdown-runtime exports. Its first nonempty positive run then exposed the missing original HappyDOM directive: node mode compiled the real component as SSR. Both failures were repaired only in the new control file. Typed source lint also found one optional-chain diagnostic, repaired only in the new consumer. The original owner/host, released reference module, installer, DI and interface files remain unchanged.

Exact final verification, with `FSUSBLOG_USE_LOCAL_FSUSUI=1`, `FSUSBLOG_LOCAL_FSUSUI_ROOT` pointing to the isolated checkout, and `FSUSBLOG_VITEST_MAX_WORKERS=1`:

```bash
# CWD: src/frontend; discovery asserts exactly 21 and the two named positives.
node_modules/.bin/vitest list --config vitest.config.ts \
  ../../tests/frontend/unit/authoring/articleAttachmentBusinessIntentReader.test.ts \
  --json /absolute/task-evidence/discovery.json

node_modules/.bin/vitest run --config vitest.config.ts \
  ../../tests/frontend/unit/authoring/articleAttachmentBusinessIntentReader.test.ts \
  --testNamePattern '^Original owned intent business adapter verifies the actual (current pending handle without a lifecycle receipt or new store|committed successor after the original owner microtask)$'

node_modules/.bin/vitest run --config vitest.config.ts \
  ../../tests/frontend/unit/authoring/articleAttachmentBusinessIntentReader.test.ts

# CWD: repository root, original complete consumer project/typed configuration.
tools/frontend/style-toolchain/node_modules/.bin/eslint \
  --config eslint.config.mjs \
  src/frontend/src/services/authoring/articleAttachmentBusinessIntentReader.ts \
  --max-warnings 0 --format json

node tools/frontend/check-frontend-style.mjs \
  --file src/frontend/src/services/authoring/articleAttachmentBusinessIntentReader.ts

node tools/governance/check-change-contract.mjs \
  --range b66ad3ea5e730236af0beba21f7bab39477c5004..1acd6f913bfdcac50e2d38e072668d389946e669
```

Discovery: 21. Positive gate: 2 passed, 19 intentionally outside the selector. Exact selected regression: **21 passed, zero failed or skipped**. Actual typed lint: one source file, zero errors or warnings. Original canonical source-style executor: one file, zero violations. Commit contract and diff checks passed. Raw final JSON/JUnit, topology, previous failed attempts and physical identity facts are retained beside this record. All 21 runtime start/finish pairs were observed, and the worker process was absent after exit. Original selected `afterEach` disposes attachments and unmounts wrappers; original setup disposes animation frames. No database, Docker, server or standalone browser resources were created by this stage. Owned UI dependency links and transient installation inputs were removed; the isolated checkout and consumer public dependency cache remain for diagnosis.

The factory contract is unchanged: `createArticleAttachmentBusinessIntentReader({ attachments, handle, binding })` supplies the existing business `verifyIntent` port through the original real handle lookup and live public position-map binding. It owns no intent store and does not turn cloned receipts, absent currentness, unknown source relation, or terminal removal into a current intent grant. The original host must still provide the actual handle and binding; this branch does not register a host, route or UI action.

The original private `@ozwasyd/element-plus@1.5.1` installation remains blocked by its recorded **401 Unauthorized**. It was not retried or replaced by a fabricated package. This legitimate source-alias stage does not qualify the published package, standalone UI, complete application typecheck/build, business reference/reuse/cleanup authority, browser product flow, or any held acceptance suite. The parent retains those separate gates.

Related to #1975, #2258 and #2263. No content API write, PR creation, issue closure, merge, deployment or package publication occurred.
