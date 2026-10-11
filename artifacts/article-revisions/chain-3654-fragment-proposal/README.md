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
