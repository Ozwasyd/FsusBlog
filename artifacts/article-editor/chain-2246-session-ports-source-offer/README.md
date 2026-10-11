# Historical source offer: Writer native ports and cancellation correction

Source WIP and coordination evidence only. No runtime or product acceptance.
Related to #2246, #2250, #1809 and the existing #2294 session owner.

- Writer/native ports: `7b407c3fef5a501b84b659892d7f2b7831c94f3d`.
- P2 correction for the original borrower: `e6995b3bf8baf2722fe307ffa52edc7febd3dff4`.
- Canonical prerequisite retention: `f8379a1b3401cb3cc7d56adfcad051c76fab49e3`.
- Supplied Blog owner source: `cb154e1001f4d45977e1529b6c72cc59d0d02049`, PR4210.
- Supplied public UI source: `8afe8523b35f296a0131951b55b7e466a7a0f486`, PR914.
- Original prior handoff head: `9595e4edabb482768fcc93c844f87301f55fc75d`.

The corrected source identities were fetched exactly. The earlier concatenated
PR-number/SHA strings were not truncated or guessed; their two exit128 fetches
remain historical failed intake attempts. No UI checkout, package alias, lock,
test configuration or held execution authority was replaced.

## Original borrower P2 correction

The independent review of runtime4d3ee437/final9595e4ed found two source issues:
synchronous abort-listener reentry could register a new loan outside the original
`cancelAll` snapshot before context changed, and the runtime duplicated its
continuity import. `e6995b3b` adds cancellation admission to the original
`ArticleDocumentContextAdapter`, not a new task registry or dispatcher.

`beginTask` rejects registration while cancellation is in progress. The same
guard covers producer superseding; a context change or disposal during the old
task's cancellation also rejects the outer start before creating a new task.
`cancelAll` releases its admission guard in `finally`. Existing genuine loans
are aborted and released through the original owner; refusing later reads is
not used as a substitute for cancellation. The duplicate import is consolidated.

Five new source controls cover source/draft/document/dispose transition reentry
and superseding reentry. All are NOT RUN. The original eight borrower controls
also remain NOT RUN. The author correction awaits independent source rereview.
The reviewer-reported original types baseline/candidate both have233 identical
FAIL diagnostics; that result belongs to the reviewed4d/9595 scope and is not a
typecheck of e699 or the new mounted ports. The older8f38 377 PASS and its
types227/style82,700/import5 FAIL remain separate historical evidence.

## Canonical session prerequisite retained without rewriting its owner

The three previously absent modules are exact blobs from cb154e100:

- `articleWorkspaceMountedEditorResolver.ts` supplies the original source ports
  and verifies the public native document state across reads.
- `fsusUiEditorSessionFactory.ts` consumes that actual mounted session and keeps
  all incomplete snapshot/resource admission guards.
- `articleWorkspaceEditorSessionComposition.ts` contains the one existing
  `installArticleWorkspaceEditorSessions(resolveMountedEditor)` entry.

No donor host, document registry, index, Writer, layout, upload, receipt, metadata,
fixture or checker was substituted. No sibling branch was merged or guessed.
The prerequisite source was supplied by the coordinator; its inherited acceptance
and invalid commit scopes are not imported as local gate passes.

## Actual Writer ports

`MarkdownTextEditor.getAuthoringSessionPort()` returns the original exposed native
object after checking real `dispatchTransaction` and `getSession` methods.
`MarkdownEditorAdapter` and `ArticleWriteEditor` forward that same object; no
session or method facade is created. Missing mounted APIs return null.

The original composable now accepts an optional third argument:

```ts
const bound = authoringEditorRuntime.bindEditor(port, options, readMountedEditor);
const source = bound.mountedSource;
```

`readMountedEditor` must read the actual currently mounted object. `mountedSource`
is null when no reader is supplied. With a reader, it implements the original
`ArticleWorkspaceMountedEditorSource` interface. Both ports belong to the actual
runtime binding returned by this call; after release or replacement they refuse
reads before invoking the mounted reader.

`readMountedEditor(editorSessionRef)` reads the existing original workspace
registry only for session association, checks its identity against the canonical
Document owner, and returns only the exact editor object passed to bindEditor.
It does not echo the requested registry entry, use routes, or build another mount
index. Unassociated, missing and replaced native objects are unavailable.

`readDocumentBinding(editorSessionRef)` reads the actual native
`getSession(...).inspectDocumentState()`, checks identity, epoch and native source
revision against the original context adapter, then rechecks the current owner,
mounted object, session and public state. Missing/changed observations are not
reconstructed from event caches. Real upstream exceptions are preserved.

`projectArticleWriterWorkspaceDocument(context)` copies article/draft/DocumentId,
epoch and actual draft revision from that owner. The workspace's existing string
source-reference vocabulary represents the native source ordinal as
`source-revision:<actual sourceRevision>`. This is a coordinate projection, not a
new DocumentId, epoch, snapshot, signature or permission grant. It does not replace
the still missing server-verifiable DocumentId binding reported in the prior offer.

Six new ordinary source controls use the real public editor method contract and
original registry/Document owner. They cover first observation, unassociated
session, release, missing/replaced objects, native revision drift and a same-byte
document switch. All are NOT RUN: no mount, runner collect/list or runtime launch
occurred. Their test fixture is not a product-ready session or a permission receipt.

## Precise unapplied layout handoff

The current writer target remains unchanged at blob
`bbd1ea3594c9cc9eb4c9a385c7dadc8cf4758f48`. Before the coordinator's new file split,
an uncommitted direct Write hunk had been prepared. It was retained privately as
withdrawn evidence and reversed; it is not offered as the current consumer patch.

`writer-consumer-unapplied.patch` is the minimal prepared current consumer hunk:
it uses canonical workspace identity/context instead of route-derived labels,
passes the actual generation-bound mounted reader, retains `bound.mountedSource`
alongside the existing binding, clears it on release/unmount, and exposes
`getArticleWorkspaceMountedEditorSource()` for the layout composition owner.
`git apply --check` passes against the recorded untouched target. This is an
unapplied source hunk; neither its application nor full layout compatibility is
claimed. The first patch-generation attempt failed a non-unique reset anchor;
the corrected attempt uses exact unique anchors and did not write the real target.

The current file split is explicit:

- Writer port/composable/wrapper owner: this #2246 chain.
- Write editor-panel/layout owner: `01a12bf3-5b8d-7153-be7b-e374d6ce1008`.
- AdminWorkspaceFrame and AccountRouteFrame: Rail owner `01a12c03-2c1a`.
- Session producer/resolver/factory owner: `01a12bdd-f38f-76b8-a611-1f44088f200e`.

The actual owners must integrate the consumer and call the one supplied installer
through their real mounted-view custody. This chain does not edit those three
host files or add a second installer. It also does not create a retained multi-view
mount owner: only the caller-held current native instance is read here.

The recovered4173 comment provides exact old blobs and12 mechanical child fixes.
Those import/brace/curly fixes already exist at this owner's original child blob
`b1d2805dd7084802a69e1ec6b39c837416f003dc`; they were not reapplied. Its two old
TaskEnvelope-to-void callbacks are also already fixed. Relation-test changes remain
with the shared owner. `typography-current-comparison.json` records the identities.

The six reported Writer API diagnostics use old blob
`64b0d962c4d1b072c2cc1591735519a4aa27c3ba` and its private `.fields.find(...)`.
Current untouched Write blob `bbd1ea359...` contains no `.fields` access: it uses
the original composable's public `validate(callback)` invalid-property capture
and `scrollToField`. No private Form field exposure, cast or stub is added. The
separate `historical-public-form-consumer-unapplied.patch` is supplied only for
the layout owner if its own Write still has that exact old handler; it requires
this original canonical composable and is not a patch for current Write.

Parser PR4221 exact `69992a0769a896434028d2b16776423f31c6c7d0` was read only,
not consumed. Its31-to23 style and246 type FAIL comparison binds old8545/UIe609
source. Those numbers do not describe this new Writer candidate or give it a pass.

## Open admission and verification limits

The current full factory still refuses snapshot capture because the complete
panel/renderer-restoration/draft/crash-journal owner join is absent. Installing or
holding a non-null source must not be described as editor ready. No installer was
called here. The old router's immediate fallback remains unchanged and unqualified;
proper factory/bootstrap admission is an existing-owner product gate. Workspace
entry revision refresh and retained mount lifetime must also follow their original
owners; stale entries/native remount revisions are refused rather than rebound.

Current checks are static only: TypeScript6.0.3/Node24.16 syntax inspection has
zero diagnostics in the three P2 files and the eight Writer-port files; SFC parsing
has zero errors. Git whitespace and unapplied-patch applicability exit0. A prepared
consumer syntax check is a source inspection, not execution of Write. Types/lint,
test/collect/list/mount, native/browser/server/security/database/receipt/business,
IME/race/performance/a11y/geometry/UX and runtime acceptance remain NOT RUN or HELD.
No validation rules, casts/stubs in production, thresholds, receipts or holds were
changed to make a green result.

All ten original assigned issues remain OPEN/unaccepted: execution #2246/#2250/
#2253/#2256/#2280/#2282/#2284/#2286/#2287 and tracking-only #1809. Preserve the prior
per-issue gates, #2245 sole-owner exact accepted commit/branch/evidence request,
91 pending,79 null and `fullGeometryVerified=false`. The server Document binding
design, parser-owner review and current strict-style/type verification remain
separate pending work. No issue
closure, merge, deployment or package publication occurred.
