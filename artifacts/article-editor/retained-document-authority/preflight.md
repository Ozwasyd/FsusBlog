# Original retained document authority source execution preflight

This is source-stage evidence and caller handoff, not runtime or acceptance
authority. Parent authorized the necessary original Registry issuance seam on
2026-10-11 after the original absent capability was reported.

## Bound original owners

- Canonical Registry/Group source base:
  `a27a5c1922d681d9796a05acdd7f424362f26869`, original PR3839.
- Existing document adapter notifications, cancellation fencing and TypeScript
  compatibility source consumed from Writer:
  `de6df11110b5d060a001fad36bb604627323e32a`.
- Actual Writer consumer request:
  `9932613b500476d6921283200aedfe705b5f4e04`, original PR4153,
  `artifacts/article-editor/chain-2246-retained-owner-producer-boundary/consumer-request.md`.
- Host/factory source inspected from original PR4210:
  `2461844ebcb79aa9eabb46d8ae7d42e4261e07ad`.
- Original #2243, #2293, #2294 and #2295 issue bodies were read with their original
  comments. PR3503 is the merged #2243 source owner. Historical qualifications
  are not new grants.

New source is restricted to the original Registry and document authority,
dedicated source-test files, nearest boundary document and this preflight.
Writer/Write/Layout/Frame/shared Vue/factory/Host/Group/ratio implementations,
server DocumentId, persistence policy, dependencies, frozen authority/seals and
qualification gates remain with their original owners.

## Actual caller API

1. Primary retains its actual original `ArticleDocumentContextBinding` and native
   mount. After canonical Registry admission, issue the handle by that canonical
   tab selector and call `adoptPrimaryRetainedDocument(registry, handle,
   originalBinding, scopeReaders)`. Do not call legacy acquire again.
2. A new document/draft uses `prepareRetainedDocument(registry, originalInput,
   scopeReaders)`. Its original issued `context` supplies Registry admission
   identity/epoch/source/draft coordinates. Obtain the actual issued handle and
   pass both to `acquireRetainedDocument(handle, preparation)`. Already-open
   activation uses `acquireRetainedDocument(handle)` to return the existing owner,
   and discards its unused preparation.
3. `scopeReaders` are the actual Writer's fresh `readPrincipalIdentityId()` and
   `readSiteScope()` sources. They are reread around admission and subsequent
   reads/use. The original principal/site scope is not authentication proof.
4. `binding.attachConsumer(originalStableFactory)` stores/returns the SAME
   actual original Writer resources, without body or form copying. This hook
   does not implement consumer form/effects or instantiate a route composable.
   Writer supplies view/body/selection/focus/attachment/save/submit and mounted
   source/checkpoint ports. Layout borrows them.
5. `binding.inspect()` returns actual canonical member/session association and
   original document context, pending tasks and callback-failure facts.
   `subscribeLifetime` delivers ownership/block/final-revocation observations;
   `adapter.subscribeContext` is the actual context-change subscription.
6. Registry final detach/preview replacement invalidates old lifetime, including
   equal-ID reopen. Changed document/draft/session/epoch revokes old custody.
   Permission/delete/archive blocks but retains canonical risk facts and original
   consumer. Actual principal/site retirement calls `revokeRetainedScope` or is
   observed through the original readers; final consumer invalidation runs once
   on revocation, retaining actual references when cleanup fails.
7. Producers acknowledge actual canceled/terminal work settlement using
   `lease.settle()` in their real completion/cleanup path. Abort alone leaves
   `pendingTaskRefs`. No safe-eviction API exists here; original full Host/native
   recovery/disposal and pending-work prerequisites remain necessary.

Multiple unsaved drafts have distinct original issued process-local IDs.
Original storage/journal owners must supply proper existing-policy coordinates;
the shared literal create key cannot overwrite A with B. Multi-draft persistence
is not supplied or qualified. Canonical Registry revision refs may lag actual
numeric source edits: inspection reports the mismatch. Original revision
publication and native mount/restoration remain original-owner integration work.

## Original complete test entrances: UNRUN / HOLD

Existing original document-context source file has 14 cases. New Registry handle
source file has 10 cases; new retained-authority source file has 29 cases. Counts
come from source inspection, not Vitest list/discovery. Existing original cases
are unchanged. All files remain complete; no `-t`, skip, mock/config replacement,
timeout increase, worker override, coverage threshold or runner substitution is
used. The dedicated cases use original Registry/authority classes and original
real-issued capabilities in source fixtures; they are not production evidence.

The original focused command below is a proposed entry for parent review, NOT
executed. It runs whole files through the original configuration:

```sh
cd src/frontend
FSUSBLOG_LOCAL_FSUSUI_ROOT=<exact approved local UI source> node_modules/.bin/vitest run --config vitest.config.ts ../../tests/frontend/unit/authoring/articleDocumentContext.test.ts ../../tests/frontend/unit/authoring/openArticleDocumentRegistry.test.ts ../../tests/frontend/unit/authoring/retainedArticleDocumentHandle.test.ts ../../tests/frontend/unit/authoring/articleDocumentRetainedAuthority.test.ts
```

Production's canonical matrix entrance remains `tests/matrix.yml` lane
`frontend-unit-shard` -> `tools/test/lanes/frontend-unit-shard.sh` -> original
lane support/`RunFrontendUnitShardLane`. It is executionClass=runtime, with
original behavior-doc-static-admission dependency, frontend-vitest-unit exclusive
resource, source/toolchain/cache inputs and required result/receipt producers.
That entrance and `./tools/test.sh help` were not executed.

## Config/setup/import preflight

- Original `src/frontend/vitest.config.ts`: original Vue/Vue JSX plugins,
  `scripts/fsusui-local.ts` and root resolver, `vitest.shared.mjs`, canonical
  `@`, WASM, Vue and local UI aliases, Node environment, complete unit includes,
  original setup and coverage/reporter/worker policy.
- `vitest.shared.mjs`: canonical support root, original grant-aware worker
  selection, JSON/JUnit outputs, ordinary/coverage lanes and source-bound paths.
- Original `tests/frontend/support/unit/setup.ts`: happy-dom Window and globals,
  actual animation-frame helper and FrameType source, original Vitest lifecycle
  hooks, original AEDS/PoW/search mocks, then real `vi.importActual` locale-domain
  and locale-runtime/API import graph in beforeAll. No candidate modules were
  imported or hooks run during preflight.
- Existing original context test imports the complete `@/services/authoring`
  barrel. New source files import original document authority/Registry modules
  directly through existing alias. Original Registry imports noble hashes and
  utilities, original ratio owner and Group types. Source inspection does not
  claim executed/dynamically complete import discovery.

## Allowed static checks and preserved failures

The exact original full application helper is used, without a substitute config:

```sh
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application
```

The available local UI source for compiler-only inspection is
`8db0ac8f49749e3e5f28be5051bb3d3ed71ada71`. It is not asserted to be PR4210's
required combined UI source or a qualified native provider. Exact locked Blog
frontend dependencies are reused only after byte-equal package-lock comparison.
The first application compiler check and fixed a27a baseline both exit 2: baseline
255 diagnostics, first candidate 249, zero newly added complete headline messages,
six removed original authority diagnostics already repaired in consumed de6df.
This does not waive existing RED or prove full native/compiler/runtime acceptance.
Latest source must be rechecked after repairs; final results belong in WIP metadata.

Pure TypeScript AST parsing of both owners and both dedicated source-test files
reported zero parse diagnostics. `git diff --check` passed. No imported candidate
module execution was used. The original strict-full style command is:

```sh
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI node tools/frontend/check-frontend-style.mjs --mode strict-full --file src/frontend/src/services/authoring/articleDocumentContext.ts --file src/frontend/src/services/authoring/openArticleDocumentRegistry.ts
```

Original locked style-toolchain installation attempted offline first and preserved
ENOTCACHED. A default-cache attempt failed ENOENT on the unavailable agent cache.
The same original lock was installed with scripts disabled into task-owned
node_modules using the configured writable cache; no dependency version or
lockfile changed. These are tooling setup outcomes, not tests or gate passes.

All tests/list/discovery/candidate-import/browser/mount/native/security/privacy/
receipt/race/real-database/storage/full Host lifecycle/full CI qualification remain
HOLD/UNRUN. Parent and original Registry owner must independently review the actual
exact remote head; no previous source acceptance is inherited by this new seam.

## Delivery source validation checkpoint

The final production owner source passed the original strict-full checker: two
files, zero violations. Initial two optional-chain findings remain preserved in
`.tmp/retained-document-authority/strict-full-initial.txt`; repaired and subsequent
current passes remain separate. Final publication/inspection notifications also
contain post-commit clone/inspection failures without rewriting original success
receipts/history. The authority is bound to one original Registry instance.

Result acceptance, stale rejection and logical `complete()` never acknowledge real
work settlement: producer `settle()` is explicit after actual completion/cleanup.
A consumer's actually returned asynchronous cleanup promise is retained with
pending/settled/failed facts, and does not confer native disposal or release.
Canceled lease and failed consumer custody remain actual references.

Latest compiler-only and four-file AST results are retained separately in the
task-owned `.tmp/retained-document-authority/` directory. Complete original full
application RED is not waived; previous fixed-baseline comparison is 255 versus
249 diagnostics with no added complete headline messages. No test/qualification
was run. Source tests are 29 retained-authority and 10 Registry-handle controls,
counted by pure TypeScript AST reading. Original context/Registry tests unchanged.

## Independent review repair source increment

Original Registry and Document reviewers inspected8769. Their overlapping
adoption finding is repaired once, including primary release rereading. New
cell/owner/preparation/lease/adapter custody and internal helpers use runtime
private fields; shadow public properties cannot reach the actual records.
Admission reserves the actual handle/adapter before any scope-reader call,
validates current handle state and full context/scope facts afterward, and closes
the subscription window. Failed unpublished live admission rolls back; actual
revocation retains recovery custody. Canonical close marks an actual incarnation
ended even after scope retirement, so equal-ID reopening issues a new token and
never resurrects the old one. Notification and cross-scope retirement obligations
are drained after reentrancy. Unbound preparations participate in retirement,
including equal-value ABA and retirement during admission.

Original source mutation and task slots reserve before external guards. Result
digest/getter exceptions retain an active recoverable lease rather than a finished
running envelope; queued cancellation can publish a terminal, and real producer
settlement remains explicit. Source反例 are written only:23 authority +10 Registry
cases, no tests/list/discovery or candidate module execution.

Writer160913cf40242f7ad603e080bb49871f584d1ce4's four constructor diagnostics
were identified exactly in the original api/authoringWorkspaceSnapshot owner.
Parent corrected ownership after intermediate691d: original owner
1df8314c8000130448d798e7bf5d38f50e7f1ecd supplies the complete fix and Writer
consumes it. This lane removes its intermediate Snapshot edit entirely from the
final net diff against a27a, preserving the intermediate emitted-JS equality
observation as historical evidence only. Consume this lane's final NET changes,
not the intermediate Snapshot hunks; no Snapshot postimage is supplied here.

Original strict-full style checks the two owned production owners. Original
full application compiler remains baseline RED with Snapshot's four TS1294
findings still in this producer checkout; they are an original-owner dependency,
not waived or reclassified. The intermediate 245 result included Snapshot edits
and is historical. Final restored-scope results must be recorded separately;
no previous source acceptance is inherited. All held execution remains UNRUN.
Original Group startup cell/guard, joint ownership/ratio publication, ownership-set
and exact projection method texts compare byte-for-byte with8769 and remain
unchanged, preserving a27a. Runtime and independent repaired-head review remain
required.

## Second Document P2 source repair

Fixed reviewed base9e7b9de1cee9925f78ade7e6a24b2cc01882fe8e. Registry's five
findings were independently source-closed; Registry/Group/ratio/Snapshot bytes
remain exactly the fixed base. This increment changes only Document authority,
its dedicated source controls and nearest explanations.

New task issuance checks the real context-mutation reservation before any external
guard, preventing a new producer key from escaping cancelAll at the old revision.
Actual target owner/preparation admission closes synchronously when another scope
retirement is queued. Canonical notification and cleanup still drain later. Local
admission facts are checked before/after external readers; the actual Registry
observation remains truthful and separate. inspect().admissionClosed reports the
real owner fact, not write/restore permission or a fabricated terminal receipt.
Existing running work is preserved pending actual cancellation and explicit real
producer settlement; stale never counts as settlement.

Three complete source cases cover final source/draft guard new-key issuance,
B task/source/draft/consumer denial immediately after queued B retirement within
A's callback, pending-resource retention/deferred cleanup, and retirement inside
the actual borrowed reader. Authority controls26, Registry controls10, all UNRUN.
Original lint/type/AST/diff checks are static only. Repaired-head independent
review is required; no closed source counterexample is reclassified as runtime
acceptance, and all original HOLD gates remain.

Second P2 static recheck: original strict-full2files/0violations; original full
application exits2, fixed9e7b baseline249/current249 diagnostics with zero added/
removed complete headline messages. Owned source diagnostics0. Two changed code/
source-test files parse without diagnostics; frozen Registry/Group/ratio/Snapshot
postimages match9e7b byte-for-byte. No runtime/test/list/discovery executed.

## Consumer external-boundary source repair

Fixed reviewed5cf956db65c99ba0bf4e0ccd5712454006dbb542. Mutation task issuance
was independently source-closed. Remaining factory-return retirement window is
repaired with a real consumer-slot reservation before the first borrowed reader
and admission checks after factory, method getter and later original scope reads.
The local retirement and actual canonical membership states remain distinct.
Actual created consumers and original factories remain retained on rejection or
exception; queued cleanup drains normally, while already-finished canonical
retirement receives its missed cleanup against the same returned consumer. Pending
leases/promises are not dropped or converted to synthetic settlement.

Adjacent external boundaries were inspected: existing primary/handle returns and
post-subscription adoption recheck local retirement; adapter guards recheck after
readers; mutable context and task creation keep the source-closed reservations.
No Registry/Group/ratio/Snapshot bytes changed. New complete source matrices cover
factory/getter/post-factory-reader retirement, reader exception, slot reentry from
entry readers and factory, and cleanup failure after canonical retirement precedes
consumer return. Authority29/Registry10 source cases, all UNRUN/HOLD.

Original strict-full style, full application alias compiler, pure AST and diff
checks run without candidate imports or tests. Existing full-app RED remains
unwaived; this repaired exact head requires new independent Document review.

Consumer-boundary current static results: original strict-full2files/0violations;
original application compiler exits2, fixed5cf baseline249/current249 diagnostics,
0added/removed complete headline messages and0owned diagnostics. AST/diff checks
PASS; fixed Registry/Group/ratio/Snapshot postimages match5cf byte-for-byte.
Source controls29 authority/10 Registry remain UNRUN; no execution qualification.

## Loaded primary handover source increment

Continues original producer17c2e with only original authority/consumer registration,
its dedicated source controls and boundary documentation. New
`preparePrimaryRetainedHandover` requires real original primary binding and Registry
handle, sole live primary binding, matching article/draft/source/draft coordinates.
It pins the actual loaded context and canonical target identity/epoch. Existing
`acquireRetainedDocument(handle, preparation)` consumes that genuine preparation
on the same adapter, retaining its editor-session identity/content digest and
actual pending tasks; unused discard does not dispose the borrowed primary.
Registered retained consumers cannot move between owners.

Eight appended original-module source cases cover genuine identity handover/one
receipt/late result rejection/pending settlement, unused discard, copied/foreign
provenance, unmatched revision/draft, intervening edit, synchronous primary release
on cancellation, published notification failure custody and duplicate consumer
refusal. They add no imports/config/mock/setup/test invocation. The COMPLETE
original Vitest entry/setup/import preflight above still applies; every case is
UNRUN, with all tests/list/discovery/candidate-import/native/browser/mount/security/
privacy/receipt/race/DB/storage/full-ref/resource settlement qualification HOLD.

This seam does not prove body freshness or restore native state. Mismatched
revision/draft requires original Writer/body/draft/Registry source-publication
capability; arbitrary string metadata, revision relabeling or new draft IDs cannot
fill it. It does not transfer already retained adapter/consumer custody. Static
results and exact source/consumer offers are recorded separately in PR4228 WIP.
