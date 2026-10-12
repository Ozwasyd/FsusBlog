# Original producer and caller terminal: source-only handoff

## Exact source

- Original Writer base: `9b954ae0ea65ada5a8916c5896951c20f030df10`.
- Parent supplied original cache: `f67f79e91a3f9742d5d4dc28ad7d1de727299fc6`; exact ten-path net intake commit `b78db54575e7f471979c1d041145c451b25c8d01` (all postimages checked).
- Owned implementation `5a8b9df7764ac791dad34261c716e90502437556`, compiler ordering repair `6b6289eb6d985af305615f03ad7bfa8a08abb91b`, unknown source future guard and final tested source `79da045da19a57b6a73ce4ec735d68120cd49d5f`.
- Minimal OWNED code/control net: `b78db54575e7f471979c1d041145c451b25c8d01..79da045da19a57b6a73ce4ec735d68120cd49d5f`, four original production files and two existing control files. No owned cache edits.
- Branch `codex/chain-2246-preack-runtime-intake`, draft https://github.com/Ozwasyd/FsusBlog/pull/4153, targets master. Latest fetched/verified master `9d72a1c93b297f719d8695a642cdfb1615cf1d51` not merged.
- Current #2246/#2250/#2284 bodies and #2250/#2284 comments re-read. No changed scope/criteria/prohibitions are claimed.

**The supplied cache is NOT SOURCE CLOSED.** Parent found a new P2: invalid `status:valid/resultRef:null` and whole-null vs unproduced sentinel could falsely settle/delete actual work. Its sole #2245 owner is repairing that unknown-custody path. This Writer source does not correct, approve or qualify the cache's P2.

## Actual producer endpoint

Original `ArticleFsusUiRenderProducer.render(request)` still returns its original result Promise contract. `startRender(request)` exposes the SAME original per-request work, idempotently for that exact request object. `getRequestWork(actualRequest)` returns it, and an equal-data copied request does not borrow it. A WeakMap of that original request's futures/errors holds no second body/projection/cache or authority. The only retained body-bearing map remains the original public FsusUI result map with its existing size limits.

`work.result` awaits the actual existing `renderRequest`: synchronous source read, public `renderMarkdownWithFsusRuntime`, projection and original result publication. Its real rejection handler performs any acquired local result-ref release before leaving the failure path. A release error or undeclared cleanup return remains in actual failure/ref custody, rather than being retried or settled. `work.terminal` awaits that exact result/failure cleanup future; it never substitutes cancellation, scope-stop, receipt, null result or finished metadata for a producer terminal.

A real synchronous reader failure before any public runtime call can end this producer's local request cleanup. A failed request after a successful canonical renderer return can likewise end its local request cleanup. Successful results stay owned by the original producer/cache; this endpoint does not release a transferred result or settle a document lease. Cache admission/late-result release remains #2245's own responsibility.

Unknowns are preserved:

- The source callback's declared return is a synchronous string. Null, a Promise or any other undeclared result is retained as `cleanupFailure.cause` with `article-fsusui-source-endpoint-missing`; no resource absence is inferred from no native call. A later Promise resolution is not a replacement source contract.
- Public FsusUI runtime errors may include a failed native free. Actual upstream `6a73ad6312091ca782f99393140efc8df0fb4fb6`, `vue/packages/wasm/markdown-runtime.ts`, awaits payload work with `free(ptr)` in finally, then converts thrown failures into `FsusResult` errors. The existing Blog bridge has no separate native failure-cleanup endpoint. This producer therefore rejects terminal with `article-fsusui-native-cleanup-unconfirmed` for an unsuccessful/unknown public runtime outcome, preserving its actual error cause. An error envelope, abort, resultRef:null or synthetic boolean cannot qualify native cleanup.
- This source analysis is not an SDK/native runtime receipt. All native qualification remains HOLD.

**Exact #2245 consumption request:** after its actual original `producer.render(request)` call, borrow `getRequestWork(theSameRequest)?.terminal` from this canonical producer. Await it for fulfilled AND rejected outcomes, in addition to the original admission and late-result release work. A missing endpoint or its actual rejection must retain the original pending lease/work/error, including bound fatal metadata with unknown native cleanup. Do not introduce a fallback Promise, second request/render, forced settle or second cache. The stable cache interface/consumer hook remains owned by #2245 and is not edited here.

## Same original work through continuity and compare

`ArticleEditorContinuityAdapter.startRefresh(binding,capture,restore)` starts the original cache once and returns `{renderWork, receipt, terminal}`. `terminal === renderWork.terminal`; `receipt` is the existing continuity response/restoration plan over `renderWork.receipt`. Original `refresh()` preserves its receipt-returning API by delegating to this same operation. `pendingRefreshWork` delegates the original cache's actual work. Cancellation/withdrawal/disposal or a planned/restored context does not settle any separate tool/native work.

The existing runtime binding now delegates `pendingRefreshWork`. Source-compare still invokes its original `runtime.autoRefresh()` and sole original threshold gate. Before awaiting the raced response, it retains actual original work references from that cache. It joins the returned receipt's exact original taskRef to those same objects, retaining `refreshWork.terminal` even if successful work has left the pending Set. It does not use array difference, call order, context copies or a second render to guess a future. `pendingRefreshWork` continues to expose actual pending/failed work on repeat, close or withdraw. Missing exact work is explicit invalid, never a fabricated settled future.

Only the render future is exposed here. Separate compare/tool/search, native restoration/focus/viewport and full-session factory obligations remain unqualified. Current SourceCompareSession has no application mounted constructor/caller in this tree; this source increment does not invent a product mount/Write owner. Original layout/product/mount owners must supply their exact real wiring and runtime evidence.

## Source controls and checks

Three appended controls remain **UNRUN**:

1. The original producer's actual synchronous reader throw exposes same-request cleanup terminal, rejects copied request borrowing, and demonstrates current #2245 failure-terminal consumption is still missing.
2. Original public constructor with an undeclared pending source Promise retains that exact future in failure custody and refuses to turn its later resolution into cleanup proof.
3. Actual public mounted continuity fixture borrows the same original cache operation/terminal; a prompt canceled continuity receipt leaves its original lease pending until real work runs. That drain does not acknowledge native restoration.

No original negative control is deleted or weakened. No test/list/discovery/collection/mount/browser/native/runtime/SDK/security/receipt/product qualification was run. No frozen matrix/index/threshold/authority/receipt refreshed. `91 pending / 79 null / fullGeometryVerified=false` remains unchanged.

Current run identity: `/workspace/.tmp/chain2246-render-terminal-caller`, official Node v24.16.0, locked TypeScript/Vue, real local FsusUI `6a73ad6312091ca782f99393140efc8df0fb4fb6`. Two existing canonical tooling overlays `69992a0769a896434028d2b16776423f31c6c7d0` only. Commands and exit codes in adjacent machine-readable files:

- 730 actual frontend files equal the verification tree; zero mismatch.
- Four original production paths strict-full style: exit 0, zero violations.
- Six owned production/control paths pure TS AST parse: exit 0, zero parse diagnostics, no candidate imports/execution.
- Complete application typecheck: exit 2, 221 existing diagnostics. Added 0/removed 0 normalized path/code/message diagnostics against source `de1f888a253d9c63ddc09dff0cb54b050fa1a394`; application remains RED.
- Initial style failure (ten getter/throw diagnostics) was corrected in original source, without rule/config/baseline changes. Initial application source `5a8b9df...` had two added ordering diagnostics (223 total); `6b6289eb...` corrected the deferred continuation. Both negative logs retained beside final logs.
- `git diff --check`: exit 0 before each owned source publication.
- Original cache source exactly matches supplied f67. Eight authority/threshold/index/Write/factory/resolver/composition postimages unchanged from 9b954; hashes in `source-ownership.json`.

## Remaining original owner handoffs and whole assignment

#2245 must supply its exact null/unknown P2 correction plus actual producer-terminal consumer hook; do not wait for its whole chain if those issue-level commits are ready. FsusUI must expose a real failed-native cleanup endpoint if opaque runtime failure is to settle. #2283 preview source-admission and actual assess/verify/identity/request futures remain separate WIP. #1975 upload/provider and File/session-loan terminal cleanup remain separate WIP. Borrowed search/tool/native restoration and actual product mount evidence remain separate WIP. No source-only adapter or previous receipt substitutes for those capabilities.

| Owned issue | Current acceptance status |
| --- | --- |
| #2246 | Open: native semantic anchors/scroll acceptance; this increment only exposes truthful producer work |
| #2250 | Open: continuity source increment; complete context/factory/lifecycle/native/remount/hydration gates pending |
| #2253 | Open: large-document/epoch/restoration controls UNRUN |
| #2256 | Open: previous synchronous input/commit source increment; actual provider/native/business/cleanup acceptance pending |
| #2280 | Open: migration/product prerequisites |
| #2282 | Open: actual Live and #2245 acceptance |
| #2284 | Open: same cache work preserved in original controller; actual application mounted caller, hosts/sync/native restoration and #2245 acceptance pending |
| #2286 | Open: user preference/#2280 prerequisites |
| #2287 | Open: native Focus/Typewriter/prerequisites |
| #1809 | Tracking only; required child evidence incomplete |

No complete-chain, eviction, successful full cleanup, factory/native admission or product acceptance claim. No issue closure, merge, auto-merge, deploy, master push or cross-chain conflict-resolution phase.
