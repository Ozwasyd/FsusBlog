# Original render terminal: WIP source handoff

This source increment is based on exact supplied Writer `9b954ae0ea65ada5a8916c5896951c20f030df10`. Its lease authority is the unchanged original `17c2e83ea1747baa1ca2f8de366ad7e249b2c23f`, including the real `lease.settle()`. Latest fetched origin/master is `9d72a1c93b297f719d8695a642cdfb1615cf1d51`, not merged. First source increment `119970e3392a998776973398069d28cd48830ed5` remains published; this follow-up additionally refuses an unusable cleanup reference. Exact checked code hashes and frozen blobs are in `source-evidence.json` and `source-parse.json`.

## Actual operation and custody

`ArticleRenderCache.startRefresh(): ArticleRenderRefreshWork` starts the same original task and renderer. `refresh()` remains the prompt public receipt API, and automatic threshold consumption still delegates to it. The operation exposes:

- `taskRef`: that original lease, never a replacement task.
- `receipt`: admission/cancellation response; a canceled response is not true terminal evidence.
- `terminal`: awaits the actual `producer.render` future plus original admission finalization and required synchronous result release. On successful cleanup or actual result transfer to the existing cache it calls that original lease's `settle()`.
- `resultRef`: the original result reference, without body or projection duplication.
- `cleanupFailure` / `producerFailure`: actual held errors/custody, outside serialized public receipts.

```ts
const work = cache.startRefresh();
const response = await work.receipt; // may precede the actual producer by any duration
await work.terminal;                // may reject; unresolved cleanup is not settled
```

Successful transfer keeps the existing last-valid result; terminal completion does not release its retained reference. Cancellation, newer generation, document withdrawal or `dispose()` do not clear real unfinished operations. The same cache's `pendingRefreshWork` contains its original promises/failed-reference custody only, with no second body cache, resource ledger, owner, asset inventory or index. Successful terminal completion removes that same work; failure remains retained. Cache thresholds, policy producer, render identity, receipt schema, Writer/index/authority and original FsusUI producer are unchanged.

Late release failures retain their actual reference, error and pending lease. Replacement release failure retains the old entry before pointer withdrawal. Cleanup callback reentry is rejected, and commit rechecks owner/context/identity after that actual callback. Failed release is not retried or converted to a successful drain. An unusable returned reference also leaves its cleanup obligation pending; no resource absence is inferred.

## Exact remaining original-owner capability gaps

A rejected `ArticleFsusUiRenderProducer.render(request)` returns neither a result reference nor an explicit failure/native cleanup endpoint. This increment therefore keeps `producerFailure` and the original pending lease. It does not infer that rejection means all native cleanup succeeded. Original producer owner #2246 must supply the actual per-request terminal/cleanup capability for this failure path, bound to the same request/lease; a metadata verification, abort acknowledgement, finished flag or synthetic success boolean is insufficient.

The existing `ArticleRenderProducer.release` contract is synchronous. If it returns an undeclared Promise/other value, this increment retains it in `cleanupFailure.cause`, rejects terminal completion and leaves the original obligation pending. It does not silently await/approve a replacement contract or manufacture missing native-lifetime proof. That original producer must expose any actual asynchronous cleanup capability before this path can settle. No forced settlement or successful eviction API is added.

`ArticleEditorContinuityAdapter.refresh` currently calls `cache.refresh()` and uses its raced response for restoration planning. Original #2246 continuity/runtime/source-compare callers must preserve/expose the SAME `startRefresh()` operation or delegate `pendingRefreshWork`, rather than start a second render to obtain a future. This endpoint settles only its original render lease. Separate tool/preview leases still require their own actual work, native restoration and cleanup before settlement; they cannot settle on a cache cancellation receipt. These canonical caller/producer files are not edited here.

#2283 generation's actual `assess/verify/createIdentity/requestPreview` futures and source-admission lease remain a separate open obligation. This render endpoint does not attest their terminal cleanup.

## Source controls and static checks

Nine appended controls are complete source and UNRUN/HOLD: normal render transfer, abort/dispose before late release, failed late release, repeated generations, rejected producer without cleanup endpoint, failed old-entry replacement, undeclared cleanup future, context change during release, and unusable cleanup reference. Existing original controls remain intact. No test/list/collection/mount/runtime/native/security/receipt qualification ran or was carried forward.

Static checks use actual local FsusUI source `6a73ad6312091ca782f99393140efc8df0fb4fb6`, Node v24.19.0 and the existing locked compiler/style toolchain. No package publication or SDK/native invocation occurs.

- Original strict-full style: exit0, one production file, zero violations (`style.txt`).
- Original complete application alias compiler: exit2, fixed-base221/current221 diagnostics, zero added/removed normalized path/code/message diagnostics and zero owned diagnostics (`type*.txt`, `type-delta.json`). Full application remains RED.
- Pure TypeScript AST parse of changed production/control source: exit0, zero parse diagnostics; candidate modules not imported (`source-parse.json`).
- `git diff --check`: exit0.

An initial dependency-directory symlink caused EISDIR in the original style wrapper. It was repaired by using a real ignored node_modules directory with borrowed installed packages; no checker/rule/baseline configuration was changed. Earlier static compiler defects were repaired before this source checkpoint. Initial attempt logs remain in `/workspace/.tmp/issue-2245-render-terminal`; no failure was recast as runtime acceptance.

All runtime/test/list/collection/mount/browser/native/SDK/security/receipt/custody/cohort/race qualification, migration/ProjectXML/Git replacement QA and denied artifacts remain HOLD. #2245/#2283 whole acceptance remains WIP. No content API write, PR update, issue closure, merge, deployment, master push or FsusUI package publication occurs.
