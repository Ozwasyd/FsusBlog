# Journal checkpoint source preflight and static evidence

Source handoff only for #2295/#1813. No acceptance, waiver, authority or receipt.

## Exact provenance and original owners

- Verified master base: `9d72a1c93b297f719d8695a642cdfb1615cf1d51` (fetch plus remote ref readback).
- Original AGENTS blob: `1445755f3eceb7c05fec62ae9feea4badd7b30fc`.
- Original journal introduction: `98b480fe9681e42720b94067409453e5574ae8e5`.
- #3413 plaintext/168h alignment: `9463e62468e6c2f81e123f91a205ae9ef826c1d0`.
- Unmodified original journal blob shared by master, Writer and session consumer: `2c8df95d2403a62330a8a32153b5b8895871266a`.
- Session contract: Blog #4210 exact `114661988af3ab6022a5adf9a0e7b18d6c630388`.
- Writer caller audit: `7b203a3f4fd8346f05b7aeb176eb653bdb4b2fc9`, original `artifacts/article-editor/chain-2246-upload-source-boundaries/draft-flush-consumer-source-audit.md`.
- Initial published owner source checkpoint: `97e9177ddad479f01e96b58128d4cae690b31724`; final source additionally drops the reader reference on binding release and adds unexecuted regression source.
- Draft PR: https://github.com/Ozwasyd/FsusBlog/pull/4225, base branch master. Writer/session work remains with their delegated original owners. No Writer/runtime/components/Write.vue edit or FsusUI change.

## Actual static commands and results

From the Blog root:

```bash
node src/frontend/node_modules/typescript/bin/tsc --noEmit --strict --noUnusedLocals --noUnusedParameters --target ES2022 --module ESNext --lib ES2022,DOM --skipLibCheck src/frontend/src/services/articleRecoveryJournal.ts
node tools/frontend/check-frontend-style.mjs --mode strict-full --file src/frontend/src/services/articleRecoveryJournal.ts --file src/frontend/src/services/privateStorageRegistry.ts
git diff --check
```

All three PASS at the final source. The initial style check found two unused body
destructuring bindings; the owner now compares the original input and persisted
round-trip body before custody issuance. The initial failure is retained in
`style-initial.log`; `style-final.log` has two files, zero violations.

Compiler-only checking also included the **whole original**
`tests/frontend/unit/services/articleRecoveryJournal.test.ts` and
`src/frontend/src/services/privateStorageRegistry.ts`. The temporary TypeScript
configuration used strict/noUnused/noEmit, target ES2022, module ESNext,
moduleResolution Bundler, ES2022/DOM libraries, skipLibCheck, no ambient type list,
and actual `@/*`, `vitest`, `fake-indexeddb` source/dependency paths. No test setup,
Vitest runner or candidate module was evaluated. The command was:

```bash
node src/frontend/node_modules/typescript/bin/tsc -p /tmp/journal-checkpoint-source-tsconfig.json
node src/frontend/node_modules/typescript/bin/tsc -p /tmp/journal-checkpoint-baseline-tsconfig.json
```

Both compiler checks are RED (exit 2), with the same three complete diagnostics:
original private-storage TS2345 narrowing, original test TS6133 unused input,
and original test TS2349 never-callable callback. `compiler-master.log` comes from
a detached worktree at the exact verified master; `compiler-head.log` comes from
this candidate. Their complete diagnostic text is identical after only baseline
worktree prefix and the known +5 registry / +1 test import line shifts. No new
journal or regression-source diagnostic appears. This comparison does not waive
the original compiler failure, change source gates or qualify runtime behavior.

The original pinned style toolchain was installed with
`npm ci --ignore-scripts --prefix tools/frontend/style-toolchain --cache /tmp/journal-npm-cache --no-audit --no-fund`.
Only public npm lock inputs were used; no package publication, private registry,
credentials, lifecycle scripts, authority refresh or manual seal/hash edits.

## Original executable preflight remains for parent review

Read-only entrypoint inspection covered `tools/test.sh`, `tests/matrix.yml`,
`docs/testing.md`, `docs/testing/frontend-private-runtime-governance.md`, the
original `src/frontend/vitest.config.ts`, `src/frontend/vitest.shared.mjs`,
`src/frontend/scripts/fsusui-local.ts` and the actual
`tests/frontend/support/unit/setup.ts`. No replacement configuration, filter,
reduced case list, alternate runner or fixture authority is introduced.

The original Vitest config installs Vue/Vue JSX plugins, resolves the real
FsusUI alias helper, uses the original unit setup, and declares the original
unit include roster. The shared setup creates happy-dom and animation-frame
environments, imports the original WASM protocol frame, installs existing
WASM mocks, and asynchronously imports/activates the actual locale graph.
Consequently this source review does **not** treat the original runner as a
zero-execution source check. Parent review/admission is still required before
any whole-file unit execution, listing/collection or import execution. Existing
matrix, assertions, coverage thresholds, reporter output and full qualification
are unchanged and unwaived.

The appended regression source covers completed persistence/restore, frozen
custody, copied/foreign tokens, every caller coordinate including epoch/revision,
stale async completion, reentrant invalidation, owner release, unavailable/quota
storage, pre/post-persistence cancellation, original overwrite/confirm/discard/
clear semantics, TTL/integrity cleanup, database deletion/versionchange,
observed foreign overwrite, lossy UTF-8 refusal, earlier-write settlement,
bounded bindings and busy prepare refusal. These are source cases, not results.
All tests, test listing/discovery, browser/mount/native/WASM/security/privacy/
receipt/race/backuprestore qualification remain UNRUN.

## Required caller joins and limitations

The original Writer supplies the independently read principal/site/draft/mount/
registry/session/document/epoch/native revision/write coordinates, invalidates on
staging/context/external changes and releases on original owner release. See the
maintained `docs/security/private-surface-runtime.md` contract. Journal metadata
is not an identity source, backend DocumentId binding or saved draft checkpoint.

The original session aggregate currently has string `crashJournalRef`; this owner
issues an opaque object token. Session must review the real custody join/contract
instead of converting a record ID or digest into a ref. Complete draft/panel
custody, server-authorized DocumentId and disposed-session hydration remain
independent dependencies. Full factory capture/restore stays blocked.

Synchronous inspect proves earlier completed persistence plus current local
custody/actual owner facts. IndexedDB has no synchronous external existence query;
unobserved other-tab mutation is not ruled out by inspect. Original coordination,
list observation and asynchronous restore provide the existing external change
boundary. No second journal, body cache, storage fallback or dispatcher is added.
