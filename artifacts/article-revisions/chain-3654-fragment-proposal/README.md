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

## Current source verification

All current results in `evidence.json` bind to source `24b351cee936e681a18016efe8925b334a547ce0`.

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
- Lifecycle capability: `systemctl is-system-running` exits 1 with `offline`.
  No durable canonical process owner or zero-members receipt was established.

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
Do not launch a direct Vitest process to bypass matrix admission, scheduler,
process containment, lifetime cleanup or FsusUI baseline requirements. The
canonical authority owner must supply reviewed parser/closure admission and the
original runtime must establish its lifecycle capability before test execution.

The master-targeted draft inherits ninety-three existing PR3828 paths; the new
source review is the two-file `d1f8a4e..24b351ce` increment plus this handoff.
Keep the inherited Vault/security/qualification holds. No source WIP or draft
review accepts #2275 or the chain; no merge, auto-merge, issue closure or deploy is
performed.
