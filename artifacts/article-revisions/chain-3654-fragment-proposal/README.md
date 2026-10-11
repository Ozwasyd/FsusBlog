# Historical task handoff: unexecuted revision fragment proposal

Status: source WIP. This handoff is evidence, not a new authority contract.
Related to #2275 and #3654. All fifteen chain issue acceptances remain OPEN.

Source base: `d1f8a4e95348039d9db4cbcefce57d406399dc21` (original PR3828).
Source increments: `fc949d97a9bdad49ceab55705c26c7ca0ebb3d41`, then
`24b351cee936e681a18016efe8925b334a547ce0`.
Branch: `task/3654-revision-fragment-proposal`.
Observed origin/master: `9d72a1c93b297f719d8695a642cdfb1615cf1d51`.
The Vault enrollment branch is not a source base or prerequisite here.

## Downstream interface

`createRevisionFragmentProposal(presentation, selection, readCurrent, signal?)`
returns an immutable `RevisionFragmentProposal` with status `unexecuted`.
The host must preserve the article association of the original authorized compare
read. Source bytes or a client digest alone cannot prove historical authorization.

`selection` binds article/action, plan/base/compare package digests, selected side,
source identity/digest, package digest, unique chunk digest, hunk index and exact
UTF-8 byte range. Only historical revision packages and nonempty changed-hunk
ranges qualify for proposal construction. Both complete source byte arrays are
rehashed against the original package/diff references; incomplete UTF-8, wrong
package/plan, absent/ambiguous hunk and out-of-hunk ranges reject. Raw BOM, CRLF,
CJK, emoji, HTML-looking source and trailing bytes are retained without conversion.

`readCurrent` is a synchronous fresh capture of the actual native editor selection:
`{ document: ArticleDocumentContext, selection: { start, end, direction } }`.
It is called before and after asynchronous hashing. The complete validated current
context and native selection are bound, including document ID, epoch and source
revision. Request, package, hunk or source mutation during hashing also rejects.
Returned bytes are a frozen numeric array; native insertion positions are never
inferred from the historical UTF-8 offsets.

PR4153 exact source `8f3811352120d907fd4cd88eb465284ed2de415e` was fetched and
read only. Its runtime exposes `context`, `positionBinding()` and guarded
`dispatchTransaction`; continuity has `capture(binding, captureOptions)` based on
observed native selection. Context schema/identity validation fields remain
compatible. These interfaces are references for the host owner, not consumed
runtime implementation or a runtime acceptance receipt. No Writer, runtime,
existing inspector, rollback command, metadata restoration or shared API changed.

A future host adapter can obtain this module's capture input from the existing
runtime, using the host's actual current capture options:

```ts
const captured = runtime.continuity.capture(runtime.positionBinding(), captureOptions);
return {
    document: captured.document,
    selection: { start: captured.anchor.range.start, end: captured.anchor.range.end,
        direction: captured.anchor.direction }
};
```

This is a downstream composition recipe, not an executed adapter. The module has
no dispatch port. Proposal preparation does not grant permission or an action
receipt. Before execution the canonical owners must recheck current permission,
the historical package/article association/deletion status, current native context
and selection, and fragment digest, and compose the actual canonical transaction
with position-map authority. Execution deduplication, undo/redo, dirty/autosave,
conflict, continuity, action receipts and immutable rollback acceptance remain
missing. Repeated proposal preparation is intended to be deterministic for the
same input; it does not qualify duplicate insertion behavior.

## Historical source verification

The results in `evidence.json` bind to source `24b351cee936e681a18016efe8925b334a547ce0`.

- Official frontend style: exit 0, one production module checked. The original
  policy excludes the unit TS file; do not describe it as linted.
- Original revision-compare authority check: exit 0.
- Original incremental change-contract and diff checks: exit 0.
- Scoped TypeScript no-emit program: exit 1, thirty diagnostics in the unchanged
  dependency closure and zero in the two new source files. An original-dependency
  root control reports the exact same diagnostics. This is a retained failure,
  not a whole frontend typecheck pass. No casts or rules in those owners changed.
- Original matrix preflight: exit 1 before matrix parse completed. It rejects
  independent release-final parser identity and owner/content/dependency closure.
- The default system-manager state probe `systemctl is-system-running` exits 1
  with `offline`. It is an environment hint, not the original runner guard and
  not a blanket ban on pure unit tests. The original canonical matrix CLI does
  register a managed process and uses `systemd-run --user` on Linux. A separate
  read-only `systemctl --user show --property=Version --value` probe exits 1
  because DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR are unset. This is not
  a lifecycle execution receipt; matrix parsing already failed before that path.

The source unit file includes positive byte-preservation/base-side selection and
negative identity, package/plan, hunk/range, UTF-8, document/selection drift,
mutation, cancellation and repeated-preparation controls. None executed. No
historical PASS is inherited and no broad runtime/database/browser test ran.

## Original test entry and remaining lifecycle gate

```sh
node tools/run-test-matrix.mjs preflight
./tools/test.sh frontend-unit-shard
```

The original matrix physical command is `tools/test/lanes/frontend-unit-shard.sh`,
which consumes the original `src/frontend/package.json` `test:unit:fast` script and
`vitest.config.ts`. The exact new file is
`tests/frontend/unit/services/revisionFragmentProposal.test.ts`.
The existing ordinary debug entry is `npm run test:unit:fast` in `src/frontend`,
which accepts the existing file selector as a trailing argument. Its script has
no systemctl pre-guard. This observation does not authorize bypassing the original
selected entry admission or qualify a different entry as canonical execution.
The canonical matrix entry has a managed Linux user-service lifecycle; default
system-manager state alone cannot prove whether that user manager is available.
Keep original guard and setup/configuration requirements, and distinguish pure
unit regression results from held transaction/permission/package qualification.

The master-targeted draft inherits ninety-three existing PR3828 paths; the new
source review is the two-file `d1f8a4e..24b351ce` increment plus this handoff.
Keep the inherited Vault/security/qualification holds. No source WIP or draft
review accepts #2275 or the chain; no merge, auto-merge, issue closure or deploy is
performed.


## Static clarification of the ordinary unit scope

AST inspection with the real TypeScript 6.0.3 parser reports zero parse diagnostics:
15 declarations, eleven ordinary `it` cases and four literal `it.each` groups
expanding to twenty cases, total **31 statically declared ordinary cases**. The
`for` loops inside tests are assertions within a case, not additional cases.
`evidence.json` includes every template/data combination. This is source expansion,
not runtime discovery or execution; all thirty-one remain NOT RUN.

The original configuration is `src/frontend/vitest.config.ts`, environment `node`,
include `../../tests/frontend/unit/**/*.test.ts`, and setup
`tests/frontend/support/unit/setup.ts` resolved by `vitest.shared.mjs`. The setup
retains Happy DOM globals, animation-frame lifecycle, existing Wasm mocks and its
actual locale-domain/runtime imports in `beforeAll`. Test API imports are type-only;
proposal runtime imports are the original context/digest/source-range helpers.
No configuration, setup, guard or test entry is changed.

The thirty retained TypeScript diagnostics remain in eight unchanged dependency
files. New proposal module diagnostics: zero. New unit source diagnostics: zero.
The source control uses the complete no-emit diagnostic result and exits 1; it
never filters those failures into a green frontend typecheck.

`scopeAccounting` records the full four-path owned increment and all ninety-three
inherited PR3828 paths against merge-base 3bc9bacd. All chain execution and tracking
issue identities are listed separately. This clarification changes handoff text
only; source blobs 99199b5c286dc7be8b29ee4d4da4cb1980dbc811 and
2959550796d99e69001e57428308ca3e42daf212 remain exact. No additional proposal-source
error was found by this static review, and no unrelated dependency owner is patched.


## 2026-10-11 source review and canonical consumer routing

The coordinator reports independent P2 source CLOSED, with no new P1/P2, for
`4815da650d1c64b55dde6203e385aa29619a2ede..d21c9328703c2387c33f7b8e672316734aa45269`.
The scope is the [proposal module at d21c](https://github.com/Ozwasyd/FsusBlog/blob/d21c9328703c2387c33f7b8e672316734aa45269/src/frontend/src/services/revisionFragmentProposal.ts)
and [unit source at d21c](https://github.com/Ozwasyd/FsusBlog/blob/d21c9328703c2387c33f7b8e672316734aa45269/tests/frontend/unit/services/revisionFragmentProposal.test.ts).
The original 31 cases plus one first-capture reentrancy case are all UNRUN; no
runner listing or execution occurred. The scoped d21c TypeScript check is still
FAIL with the same 30 dependency diagnostics and zero in the two owned files.
The original matrix identity/provenance preflight FAIL remains bound to 24b351ce,
not d21c or this documentation increment. No old evidence was rebound, and no
execution, permission, package, native or runtime qualification is released.
`evidence.json` remains the original historical record, including its 31-case
roster; it is not a current 32-case execution receipt.

Current origin/master was fetched and verified again as
`9d72a1c93b297f719d8695a642cdfb1615cf1d51`. The upstream PR4153 read-only reference
still has exact head `8f3811352120d907fd4cd88eb465284ed2de415e`, branch
`codex/chain-2246-preack-runtime-intake`, draft/open. It was not incorporated.
The local FsusUI transaction source was read at
`f2b3bb89ffe5f749da26c388f058efdbb6aee864`, with a clean worktree. These are source
observations, not API execution or acceptance of the closed #268 boundary.

The existing canonical execution consumer is
[`ArticleEditorRuntimeBinding.dispatchTransaction(context, transaction)`](https://github.com/Ozwasyd/FsusBlog/blob/8f3811352120d907fd4cd88eb465284ed2de415e/src/frontend/src/services/authoring/articleEditorRuntimeBinding.ts#L83).
It accepts the actual public `MarkdownEditorTransaction`, checks current context,
document identity/epoch and expected native source revision, then consumes the
real accepted result through attachment and continuity owners. A post-dispatch
observation exception must not become a fabricated rejection, inverse write or
rollback receipt. No new FsusUI transaction API is required for this edge.

The smallest host interface is the caller-held existing runtime binding together
with the host's actual current `ArticleAnchorCaptureOptions` and document-task
cancellation lifecycle. The binding already exposes `context`,
`positionBinding()`, `continuity.capture(...)` and `dispatchTransaction(...)`;
no new context registry, digest capability, grant boolean or receipt type is
needed. Native capture is supplied by
[`ArticleEditorContinuityAdapter.capture`](https://github.com/Ozwasyd/FsusBlog/blob/8f3811352120d907fd4cd88eb465284ed2de415e/src/frontend/src/services/authoring/articleEditorContinuity.ts#L439).
Its observed current native selection must be used; historical UTF-8 offsets
cannot become transaction insertion coordinates. Capture can fail when native
observations are missing, and the caller must preserve that failure.

The concrete composition edge currently ends in
[`authoringEditorRuntime.bindEditor(...).binding`](https://github.com/Ozwasyd/FsusBlog/blob/8f3811352120d907fd4cd88eb465284ed2de415e/src/frontend/src/composables/useAdminArticleWrite.ts#L976)
and the actual
[`Write.vue` binding lifecycle](https://github.com/Ozwasyd/FsusBlog/blob/8f3811352120d907fd4cd88eb465284ed2de415e/src/frontend/src/views/admin/article/Write.vue#L1145).
Neither exposes a fragment proposal intake. Wiring there would modify the
previously excluded Writer/runtime composition, so this increment does not add
an invented port or take over that owner's implementation.

Dispatch request for the coordinating parent: route the host-binding handoff to
existing root task **#2246**, under its **#1809** prerequisite and execution child
**#2250** (continuity/tool lifecycle). The current #1809 comment explicitly owns
`#2243 -> (#2245 || #2246) -> #2250 -> #2253`; the anchor issue #2246 alone does
not own fragment actions. Ask for the accepted exact commit and source evidence
for passing the existing caller-held binding, actual capture options and
cancellation/disposal to the #2275 consumer. Do not ask this owner to implement
fragment validation, historical authorization, rollback or a new transaction
API. PR4153 at the supplied exact head is the reference to this request, not an
accepted prerequisite. The coordinator thread is
`01a1142b-a0b5-7419-a4df-a8bbe54660dd`; the root #2246 cloud-thread identifier is
not supplied here and must be resolved by the coordinator rather than guessed.

The #2275 owner retains the action consumer: after the accepted host handoff,
join the original authorized historical package, fresh permission/package
rechecks, exact current native capture and fragment-byte recheck, duplicate
rejection and one canonical transaction. The existing
[`compareArticleRevisionSources` API](https://github.com/Ozwasyd/FsusBlog/blob/d21c9328703c2387c33f7b8e672316734aa45269/src/frontend/src/api/articleRevisionCompare.ts#L325)
uses the existing server route's ArticleWrite gate and package/plan verifier;
these source locations do not grant a proposal continuing authorization. No
public validate-original-proposal or atomic permission-plus-native-write API was
found. Rechecking a new compare request must not silently rebind the original
plan/package identities. This authority join remains #2268/#2275 work, not a
host-owner grant or a cached frontend permission check.

All fifteen assignment acceptances remain OPEN: execution issues #3654, #2175,
#2690, #2691, #2268, #2270, #2271, #2273, #2275, #2277, #2543 and #2544; tracking
issues #2176, #1724 and #1811. The source review and interface observations do not
satisfy their original DAG, current publication/AOT evidence, missing external
prerequisite acceptance, runtime controls or tracking-child acceptance gates.

## 2026-10-11 borrowed compare loan preflight WIP

The coordinator supplied upstream runtime source
`4d3ee43721b2fae113ffb86338e85a951335138c` and handoff head
`9595e4edabb482768fcc93c844f87301f55fc75d` from PR4153. Both were fetched/read;
neither was merged, cherry-picked or accepted. The upstream source offer now
contains `borrowCompareTask(...)`, returning the real task, `captureCurrent()`
and idempotent `release()`. Its new source is independently unreviewed; the old
8f38 377 PASS does not cover it. The actual host viewport/options callback is
still missing, so there is no executed Writer fragment consumer.

The #2275 source increment adds `recheckRevisionFragmentProposal(proposal,
presentation, originalRequest, caller)` in `revisionFragmentPreflight.ts`.
`caller` is a minimal structural read-only view of that exact existing upstream
loan: actual `ArticleDocumentTaskLease`, native document/anchor capture and
release. It is not a new issuer, context registry or membership verifier. The
host must supply the actual caller-held loan and preserve the original authorized
compare presentation/request association. The preflight always releases the
loan, including error and abort paths; its returned value cannot keep that task
alive for later execution.

The preflight owns input snapshots before native callbacks, regenerates the
original proposal using native captures and original UTF-8 source verification,
and joins the complete result to the supplied proposal. It then calls the real
existing `compareArticleRevisionSources` API using the same selectors/options/
budgets and the borrowed task's distinct read cancellation identity. The existing
server route re-enters ArticleWrite and authorized package/plan validation. No
injected permission boolean, cached admin summary, extension grant or invented
server validator is used.

The fresh read's complete base/compare package references and package digests,
permission scope, options, budget and metadata schema digests must equal the
original values. The server's new request/plan digest is preserved separately as
`readObservation`; it never replaces the original proposal plan. Package sealing
includes article identity, source coordinate, metadata and snapshots;
permission-scope hashing includes article/principal/site. Those are joins to a
real authorized API read, not client proof of permission. After the read, the
preflight rehashes the original owned bytes, captures native context/selection
again, checks task currentness and checks all original live inputs for drift.

The result is still `status: unexecuted`, the original immutable proposal and a
fresh read observation. There is no dispatcher, native transaction, dirty/
autosave/conflict result, action receipt, rollback command or authority lease.
Permission may change after this read; the result does not authorize a future
write. The actual host callback, accepted upstream source, original package/local
versus server-coordinate authority join, duplicate execution and canonical
transaction/receipt acceptance remain gates. Writer/runtime/inspector/history/
FsusUI/qualification files and the original 32-case source are unchanged.

Fifteen new static unit controls remain UNRUN and unlisted. Nine ordinary
`it` declarations plus literal `it.each` groups of 2 and 4 cover separate read
identity/exact bytes, real API rejection propagation, both package references,
permission/options/budget/schema drift, source revision, native selection,
request mutation, disposal, original request mismatch, released loan and proposal
byte tampering. Their mocked transport and controlled capture fixture grant no
permission/package/native acceptance. Together with the unchanged 32 historical
cases there are 47 statically authored cases, no runner discovery or execution.

Syntax inspection with actual TypeScript 6.0.3 reports zero parse diagnostics for
the two new files. Official style checks the new production module only and exits
0; the policy still excludes unit TS. Revision authority and whitespace checks
exit 0. Using the same scoped no-emit source-check setup as d21c, expanded with
the two new roots, reports the same 30 dependency diagnostics, zero in all four
owned source files, and exits 1. An initial direct tsconfig inspection without
the prior source check's real Vitest dependency path also reported 10 test module/
inference diagnostics (40 total); those are retained separately, not erased or
claimed as a full typecheck pass. No existing test entry/setup/guard/config was
changed. The old matrix identity/provenance FAIL and original evidence.json
remain at their original identities. New source prechecks, not unit/native
runtime execution, are the only new verification.

Source verification identity: the new preflight/15-control increment is
`c2d3d55b85db1762e09613d1e73797f06f28c8a3`, exact range
`10ce06e610c048bcbd3657043f46f3dc73c56e28..c2d3d55b85db1762e09613d1e73797f06f28c8a3`.
At that source, module style, revision authority, incremental change-contract and
diff checks each exit 0. Syntax inspection of both new files has zero diagnostics.
The expanded prior scoped TypeScript program exits 1 with 30 dependency
diagnostics and zero in either new file. This binds only those source checks;
32 old and 15 new cases remain UNRUN/unlisted. The d21c independent source review
covers the original proposal correction, not this new preflight source.

Subsequent coordinator review of upstream handoff 9595e4ed reports two P2 source
findings: abort-listener reentrancy can create a stale but unaborted loan, and
there is a duplicate import. The original Writer owner owns the repair; no exact
repair SHA has been supplied. This fragment consumer continues to use the real
loan's signal/currentness and `finally release`; it adds no cancellation owner,
secondary task registry or compensating native write. Upstream source remains
unaccepted, and every runtime/qualification hold remains in force. Await the
coordinator's exact upstream correction for another source-only interface check.

## 2026-10-11 original-record custody correction

Independent review of exact b30c8094 reports one conditional consumer P2:
changing the supplied original request's contextLineCount from 3 to 7 and the
presentation's expected optionsDigest to the digest of 7 could pass a new real
read matching that altered expected digest, while keeping the original proposal
unchanged. The original proposal did not include the expected plan receipt, so
a trusted-input assertion was not an enforced association.

The existing `createRevisionFragmentProposal` producer now seals the complete
owned original `planReceipt` using its existing
`calculateOpenArticleDocumentDigest` producer. The required
`comparePlanReceiptDigest` is part of the canonical unsigned proposal and thus
its existing contentDigest and deep-frozen output. The same receipt supplies the
selection's original planDigest, checked by the producer. This binds original
options/budget/permission/schema/cancellation/package/read coordinates to that
proposal record; it does not authenticate a server record or grant permission.
No alternate digest algorithm, custody registry or authorization owner was added.

The consumer now requires that sealed original receipt and its original
planDigest before any native capture or new API call. Its subsequent canonical
proposal regeneration still compares the complete proposal. Replacing both
request options and the expected receipt digest therefore fails
`compare_record_stale` before a new read, even if that new read would match the
substitution. The producer emits schema v2 for this required original-record
binding. Legacy v1 or unbound proposals are refused, never backfilled from a
caller-supplied presentation. The local source-stage schema has no persistence
or public wire migration; old evidence remains at its old source identities.

Five new authored source controls cover compensated expected options, budgets,
permission scope and metadata schema substitutions with an unchanged proposal,
and legacy/unbound proposal refusal. They assert no API call/capture, an unchanged
original proposal/plan/record digest, and finally release. The options control
uses the precise 3-to-7 input substitution from review. The existing positive
source control now checks the producer's receipt binding and v2 schema. Original
47 plus new 5 controls (52 statically authored cases) remain UNRUN and unlisted.
The output remains unexecuted; the actual API read, separate read observation,
loan release and all authority/native/runtime/acceptance holds are preserved.
The original Writer owner still owns the upstream loan P2 repair, and no new
upstream correction was consumed. The d21c source review does not cover this
new producer/consumer correction; return its exact increment for independent
source review. Original evidence.json and matrix/TypeScript failure identities
are not rebound or replaced by these new source checks.

## 2026-10-11 exact upstream cancellation fix selection

The coordinator supplied the original Writer owner's correction
`e6995b3bf8baf2722fe307ffa52edc7febd3dff4`, contained in PR4153 head
`c8087a02ca1ffa8d809382122aa69530d4bc51ef`. Both source identities were fetched;
Git ancestry confirms the head contains that correction. PR4153 remains draft/
open. Select **e6995b3b** as the pending source dependency correction for the loan,
not the entire c808 head or broad PR4153 history. Neither was merged, cherry-picked
or otherwise incorporated into this fragment branch. Independent source review
of the correction and a977 proposal association remains pending; selection is
not acceptance.

The exact correction changes three original-owner paths: document context task
cancellation, runtime binding imports, and original authoring lifecycle control
source. It adds cancellation-depth admission in the original document owner:
`beginTask` refuses registration during synchronous cancellation, superseding
cancellation checks that the original context still exists, and `cancelAll`
holds the admission barrier until its snapshot is canceled. It consolidates the
duplicate continuity import. No fragment-owned cancellation registry, dispatcher
or compensating write is required or added.

Read-only TypeScript source inspection confirms `ArticleEditorCallerBinding`,
`borrowCompareTask` and `ArticleDocumentTaskLease` have identical declaration/
method text in 4d3ee437, e6995b3b and c8087a02. The production consumer's structural
view therefore needs no source adaptation. The fixed runtime file's Git blob is
`30a37cf0b430e577b0f3edc8cca168a167cb2c75`; the fixed document owner's blob is
`04d25daab8bfba75181bcfddee6602e44bfcc49f`. Source parse diagnostics are zero for
those two files. This inspection neither invokes the loan nor proves cancellation
behavior or native acceptance.

Public dependency sources:
[original owner cancellation correction](https://github.com/Ozwasyd/FsusBlog/blob/e6995b3bf8baf2722fe307ffa52edc7febd3dff4/src/frontend/src/services/authoring/articleDocumentContext.ts),
[unchanged loan interface with import correction](https://github.com/Ozwasyd/FsusBlog/blob/e6995b3bf8baf2722fe307ffa52edc7febd3dff4/src/frontend/src/services/authoring/articleEditorRuntimeBinding.ts),
and [unrun upstream regression source](https://github.com/Ozwasyd/FsusBlog/blob/e6995b3bf8baf2722fe307ffa52edc7febd3dff4/tests/frontend/unit/authoring/articleEditorComposedLifecycleRegression.test.ts).
The exact a977 producer/consumer/regression source remains unchanged for its
independent reviewer; this is a documentation-only dependency selection. Our
52 controls remain UNRUN/unlisted, and all original source/authority/host/native/
runtime/acceptance holds remain. The upstream owner's reported 233 type failures
are not a fragment test result or a successful prerequisite; our original 30
dependency diagnostics and original matrix identity failure stay at their own
source identities.
