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
`style-initial.txt`; `style-final.txt` has two files, zero violations.

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
and original test TS2349 never-callable callback. `compiler-master.txt` comes from
a detached worktree at the exact verified master; `compiler-head.txt` comes from
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

The initial source offered only an opaque object token for the aggregate's string
`crashJournalRef`. The additive owner-issued locator/content join described below
now supports that original string shape through the same private custody. Actual
Writer forwarding and session wiring remain with their owners. Complete draft/
panel custody, server-authorized DocumentId and disposed-session hydration remain
independent dependencies. Full factory capture/restore stays blocked.

Synchronous inspect proves earlier completed persistence plus current local
custody/actual owner facts. IndexedDB has no synchronous external existence query;
unobserved other-tab mutation is not ruled out by inspect. Original coordination,
list observation and asynchronous restore provide the existing external change
boundary. No second journal, body cache, storage fallback or dispatcher is added.


## Independent asynchronous invalidation review correction

Independent review of `61c156009ee7b2bc540b5efd84071adf171d679e` identified a P2:
an old restore/list completion could invalidate a newly prepared B token. The
original owner now captures custody at list entry and revokes only that exact
custody while it is still current. Restore failure uses the same object-identity
fence. Retired database versionchange/close callbacks check their exact original
connection before revocation.

The same audit found that cleanup using an earlier invalid-ID list needed a
transactional storage recheck. The original cleanup helper now rereads the exact
rows inside its original readwrite transaction and preserves valid replacements.
Unchanged integrity-invalid rows and currently structurally invalid/expired rows
still follow original deletion semantics. Actual conditional deletion revokes
current custody for the row being deleted; an old read's mere observation does
not revoke replacement custody. Removed-invalid count reflects actual deletion.
Original authoritative write/confirm/discard/clear invalidation stays intact.

Added original-source controls delay A's actual recovery-source digest while B
prepares, for both restore and list. A separate delayed integrity-invalid read
proves that its cleanup must preserve valid B, and retired-connection callbacks
must preserve B. These cases are UNRUN. P2 scoped compiler/style results remain
PASS for the service / two original services, respectively; whole-file compiler
remains RED with the same three master diagnostics (`P2-compiler.txt`). This is a
source correction awaiting independent re-review, not accepted runtime closure.


## Actual original stable-ref and native-digest join

Read actual Blog `f92031afab06dbf73e7de085418545504c2e5f89` aggregate/factory/digest
source and UI `c3fa0d377702f41d3a9131ae04012ad52cf5f34e` public native session source.
The aggregate requires a stable string ref, while the public native digest
callback receives its transaction-store source before native snapshot custody is
replaced. Native document identity, revision and body are rechecked after callback.

The journal now issues a stable `info.checkpointRef` when its completed token is
issued. It uses native cryptographic UUID issuance plus a monotonic owner sequence,
with no record ID/hash/caller identity as the locator and no second index/table.
The locator resolves the original private token in the SAME binding's custody
slot; invalidation, replacement, expiry and release retire both together. A string
alone never authenticates completed persistence or product readiness.

The new additive `ArticleRecoveryJournalCheckpointReferenceBinding` extends the
unchanged six-method base interface. The actual owner returns the extension from
`bindCheckpointSource` and provides:

- `validateContent(token, actualNativeSource)`;
- `inspectReference(checkpointRef)`;
- `validateReference(checkpointRef, actualNativeSource)`;
- `restoreReference(checkpointRef)`.

Inspect checks the current independent Writer body as well as all actual owner/
version coordinates. Content validation checks the real native callback body
against the completed original source hash, with size/canonical UTF-8 guards.
No body is retained in a new cache. Native canonical content digest remains the
original `calculateOpenArticleDocumentDigest(source)` **after** owner validation;
the journal source hash uses its original namespaced domain and cannot replace it.
The synchronous checks attest local custody/earlier completed persistence only;
unobserved cross-tab storage mutation still requires original async observation.

The actual Writer was read at `dc98ae399932efa5445b6d4b4781e6ca17b37cd7`, including
its source offer README, actual caller `54ef3efee2ec7f2fff8e6dbcdfa6385a79e933ab`,
`articleWriterMountedEditorSource` and mounted resolver. Its reader verifies native
revision against actual document source revision and supplies the original scope,
including distinct registry and browser recovery tab coordinates. Its exact six-
method Object.freeze wrapper was extracted unchanged into a temporary ambient type
projection, using the real journal return type and declared original closure
bindings. Compiler-only projection PASS, exit 0, no diagnostics:

```bash
node src/frontend/node_modules/typescript/bin/tsc --noEmit --strict --noUnusedLocals --noUnusedParameters --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM --skipLibCheck /tmp/journal-actual-writer-wrapper-contract.ts
```

This checks that precise original wrapper contract, not the entire Writer graph,
installed composition or product behavior. The wrapper currently forwards only
six base methods. Writer must forward the four listed extension methods to the
SAME `journal` returned by `bindCheckpointSource`, retain its original release/
watch cleanup, and expose the extended return type. No caller-generated ref map,
secondary reader, body copy or alternative service is required. These Writer-owned
files remain untouched here. Main session owns passing the actual native callback
source and pairing locator validation with its original expected document state.
Full factory remains blocked on the other original owners and real wiring.

Latest standalone owner compiler with `--moduleResolution Bundler` PASS; scoped
strict-full style PASS (two files, zero violations, `reference-style.txt`). Whole
original unit-source/private-storage compiler remains RED with the exact same
three master diagnostics (`reference-compiler.txt`). Added ref/digest source cases
cover positive same-binding lookup/restore, foreign locators, fake copied tokens,
changed native/Writer body, canonical Unicode, retired refs despite repeated UUID,
issuance failure and released owner. All these cases and P2 interleavings remain
UNRUN; no original runner/list/product/native/storage execution was performed.


## Actual cleanup versus pending issuance audit completion

The asynchronous-path audit additionally fences an original authoritative cleanup
that deletes a row while a prepare awaits its earlier completed valid read.
Actual conditional deletion now revokes in-flight preparation generations before
mutation, while already issued custody remains targeted to the deleted row.
A stale invalid read that finds a valid replacement performs no deletion and does
not invoke this mutation invalidation, so replacement B remains preserved.

The added original-source control holds B's actual integrity-read result, corrupts
and deletes the actual row through the original cleanup path, then releases the
old valid result. Pending B must return null rather than mint from a deleted row.
This control is UNRUN. Latest standalone owner compiler PASS; strict-full original
two-service style PASS (`cleanup-style.txt`). Whole original unit-source/private-
storage compiler remains RED with the same three complete master diagnostics
(`cleanup-compiler.txt`). No testcase, listing, candidate import, storage or
runtime execution is performed by this source audit.


## Failed original cleanup audit completion

Captured invalid custody is revoked before attempting asynchronous cleanup, using
the same captured-object fence. If cleanup fails, the originally observed invalid
token cannot remain admitted; replacement B remains protected from the earlier
observation. The original helper settles both its failed request and transaction,
then retains the primary failure. The original read returns unavailable.

An abort control exercises that original helper path in regression source only,
UNRUN. Initial cleanup-catch style reported Allman/empty-function findings; those
are preserved in `cleanup-failure-initial-style.txt` and corrected. Final original
two-service strict-full style PASS (`cleanup-failure-final-style.txt`); standalone
owner compiler PASS. Whole original unit-source/private-storage compiler remains
RED with exactly the three master diagnostics (`cleanup-failure-compiler.txt`).
All original execution/admission/qualification holds remain intact.

## Original owner two-phase custody source offer

This increment continues the exact original #4225 branch at
`e788d215448c417c214d2c3399352ea173004159`; original verified master base remains
`9d72a1c93b297f719d8695a642cdfb1615cf1d51`. Remote master was read back as
`29051db2a80db7770dfe78a1db6e4c6998337324` for this increment. Its AGENTS and the
two original owner files are unchanged against the original master base. No
rebase, independent acceptance, authority/seal refresh or qualification is inferred.
The first pushed implementation checkpoint is
`abf2d49056eeba7879c4981ec3d01cfe4fe61b4a`.

Actual Main sources inspected are native receiver
`dc684a4b176b646d20a9e9dec943d4a4b6d6a113` and subsequent Document26 intake
`bbed9ae73cc790abf7ff32b28abbd271add08ec3`. Their original complete factory still
refuses full host refs. The actual original native producer source advertised by
Main is UI `59b9a1facc1862e590604973703ffc3d92fb85f9`. Main's exact journal
`hasReferenceCustody` method and interface entry are retained verbatim here;
e788's legal explicit flush-writer field/constructor assignment is also retained.
No Main, Writer, renderer, UI, native transaction/history or Document source is
changed by this offer.

The SAME `bindCheckpointSource()` now returns the additive
`ArticleRecoveryJournalCheckpointPublicationBinding`. Its actual API is:

```typescript
preparePublication(signal?: AbortSignal): Promise<ArticleRecoveryJournalCheckpointPreparation | null>;
validatePrepared(preparation: ArticleRecoveryJournalCheckpointPreparation, content: string): ArticleRecoveryJournalCheckpointInfo | null;
hasPreparedCustody(preparation: ArticleRecoveryJournalCheckpointPreparation, info: ArticleRecoveryJournalCheckpointInfo): boolean;
publishPrepared(preparation: ArticleRecoveryJournalCheckpointPreparation, info: ArticleRecoveryJournalCheckpointInfo): ArticleRecoveryJournalCheckpoint | null;
cancelPrepared(preparation: ArticleRecoveryJournalCheckpointPreparation): boolean;
```

The immutable branded preparation exposes the original candidate `checkpoint` and
`info`. They are not live admission. The existing live token/reference lookup
cannot resolve an unpublished candidate. Fresh validation compares actual source
facts and actual native bytes against the original completed persistence, with
original expiry checks. It reserves before clock/source callbacks; validation
and publication reentry refuse. Its result is the exact original info object,
not a native digest. The actual native digest remains the caller's original
canonical document digest, never the journal's namespaced source hash.

There is one candidate beside one current custody per original binding, at most
32 bindings, and the existing single preparation-in-flight gate. Only scalar
metadata and original owner objects remain after preparation; no source body is
cached. Original persistence has a private protected-row mode: under its original
readwrite transaction, it reuses a protected row only on exact stored metadata
and input match, without put/TTL renewal. A changed protected row, or a row
requiring original cleanup, refuses without mutation. Fresh unprotected writes
still use the original schema/key/TTL/capacity producer. Original list/write
cleanup remains authoritative; genuine cleanup can be performed before retry.
Cancel does not promise rollback of an unprotected original write already
committed before cancellation. A protected existing row is not overwritten to
pretend two differing durable checkpoints coexist at one original key.

Candidate validation/cancellation failure does not replace or invalidate current
custody. Original authoritative write/cleanup/expiry/release/coordination boundaries
retain their original effects. Prepared storage readback uses the original store,
normalizer and payload-integrity hydrator, never a second journal. Stale list
observations are also fenced to the exact captured preparation; actual deletion
revokes its affected candidate. Prior reviewed live A-to-B stale-read fences remain.

Pure private continuity requires exact candidate/info identity, generation,
previous live custody and a completed validation reservation. `publishPrepared`
uses language-private checks and preallocated custody, with no source/clock/hash/
storage/signal/listener cleanup/other owner callback or allocation. Main must
complete every participant's external preparation/admission first, then use a
synchronous callback-free private continuity/publication sequence. Pure custody
checks are not fresh source/expiry/disk admission. Writer must forward these five
methods from its SAME original journal binding and expose the extended port;
Main owns its real native/draft/renderer join. Full atomic host refs remain refused
until those original producers/callers actually integrate their respective source.

## Current two-phase static evidence and held original controls

Only ordinary source compilation and the original frontend style entrypoint run:

```bash
node src/frontend/node_modules/typescript/bin/tsc --noEmit --strict --noUnusedLocals --noUnusedParameters --erasableSyntaxOnly --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM --skipLibCheck src/frontend/src/services/articleRecoveryJournal.ts
node tools/frontend/check-frontend-style.mjs --mode strict-full --file src/frontend/src/services/articleRecoveryJournal.ts --file src/frontend/src/services/privateStorageRegistry.ts
git diff --check
```

Standalone owner compiler PASS (`publication-source-types.txt`, empty stdout);
original two-owner strict-full style PASS, two files/zero violations
(`publication-final-style.txt`). Initial five style findings are preserved in
`publication-initial-style.txt` and repaired without suppressions. Diff check PASS.

The current **original complete Main application** compiler is run before/after
in an isolated exact Main bbed checkout against the actual exact UI 59b9 checkout:

```bash
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/journal-publication-ui-static node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application
```

The original producer generates its original application alias project, extending
the original `tsconfig.app.json`. Before uses exact bbed; after replaces only
`src/frontend/src/services/articleRecoveryJournal.ts` with this owner source.
No configuration or other source is changed. Resolved erasableSyntaxOnly,
strict/noUnusedLocals/noUnusedParameters/noUncheckedSideEffectImports all remain
true (ES2022/ESNext/Bundler). Existing installed dependencies are linked from the
original workspaces; UI entrypoints resolve to the actual 59b9 source checkout.
No package publication, private registry, credential or lifecycle installation.

Before: RED exit 2 / 258 complete diagnostic blocks. After: RED exit 2 / 257.
The only removed block is original journal constructor TS1294 at `(1359,9)`,
from e788's existing compiler repair. Remaining 257 complete blocks are identical;
zero added blocks. No current owner protocol diagnostic. This is not a full
application PASS or acceptance. Raw before/after, original generated config,
resolved option facts and complete-block delta are the `publication-main-*` files.

Compiler-only validation includes the **whole original unit source file** plus
private-storage owner against both exact e788 and this current owner. Temporary
strict/noUnused/erasableSyntaxOnly/noEmit configurations and raw diagnostics are
the `publication-unit-*` files. Both RED exit 2 / three identical complete blocks
after only the known worktree prefix normalization: existing unit TS6133 at 432,
TS2349 at 579 and fixture constructor TS1294 at 600. No added or removed block;
no new regression-source diagnostic. This isolated source compiler is supplemental,
never a replacement for the complete original Main application configuration.

Regression SOURCE is added to the existing original journal file for real
producer/readback-before-staging, callback/IO-free publication, protected-row/TTL
preservation, native mismatch/cancel/actual quota/storage/random failures, required
cleanup refusal, exact/copy/foreign capabilities, reentrant validation/publication,
stale epoch/revision/expiry, original invalidation/release/deletion and delayed
prepared/live A-to-B observation controls. Every control is UNRUN. The original
whole-file Vitest entrypoint, shared setup and matrix shell are inspected only as
source. Setup creates a happy-dom window and loads the real protocol/locale graph;
no test/list/discovery/setup/candidate import, native/browser/security/receipt/
backupmigration or other runtime execution is authorized or performed. Parent
original preflight review and every execution hold remain unchanged.
