# Thrown source future P2: original producer source fix

## Bound source and scope

- Base/publication under review: `938371b5d4c1ba96e785ebd76c797a9cac3d3e21`, tested source `79da045da19a57b6a73ce4ec735d68120cd49d5f`.
- Corrected tested source: `3916a5ea219238d0ebb57a2e4a58dd61980fc867`.
- Only two code/control paths change: the original `articleFsusUiRenderProducer.ts` and its existing test file. Original cache, continuity, same-work source-compare, registry/authority/index/threshold, Write and three full-session factory/resolver/composition postimages remain exact; hashes in `source-ownership.json`.
- Branch `codex/chain-2246-preack-runtime-intake`, draft https://github.com/Ozwasyd/FsusBlog/pull/4153.
- Fresh origin/master `280415a1d7e874b00d4e761351c2167dbcd33c1e`; its delta from previously checked 9d72 contains only unrelated `ArticleCommentTreeNode.vue`. Not incorporated. #2246 current body/comments re-read; original acceptance and prohibitions preserved.

Parent independent review found a real source P2: `readSource` could throw a pending Promise (its callback's never return is legal), bypass the non-string return guard, and the old producer terminal could resolve after swallowing the result rejection. This checkpoint supersedes the previous artifact's claim that an ordinary external reader error can imply completed local cleanup. No old runtime/test receipt is carried forward.

**The current original cache has not consumed `getRequestWork(request).terminal`. This fix does not claim demonstrated cache lease loss.** #2245 cache terminal consumer and its null/unknown P2 remain its sole owner's separate WIP.

## Actual fix and exception provenance

A source throw now records its actual raw value in `source-cleanup-unconfirmed` failure custody before any observer. External ordinary Error, Promise, thenable, null/undefined, string/number/symbol and observer exception are not producer-terminal proof. The result Promise preserves the original thrown reason. Its terminal rejects the actual held failure even after the thrown future later ends; an undeclared endpoint is not reinterpreted as a cleanup contract.

Genuine Promise rejection is observed using its intrinsic `then`, not its arbitrary `catch` method. Arbitrary thenables/then getters are not assimilated or invoked. If instanceof/species/observer machinery itself throws, both the original endpoint/future and actual observation failure are retained in the same Error cause chain. No second cache, body copy, resource ledger, owner or authority is created.

Only an Error minted by the current request's private cancellation path is a known local failure. Exact object identity, not name/message/Error instanceof/null equality, distinguishes it from an external throw. Even that failure can end this producer-local terminal only after its actual result/failure cleanup chain has ended, with no held endpoint/release failure and no unconfirmed native outcome. It does not settle any document lease, scope, tool/native restoration or another request. A cancellation/finished flag by itself remains insufficient.

Source-callback return is followed by an actual signal recheck: successful synchronous source return during disposal reentry can end this request before native rendering starts. If disposal or the callback throws a future/error, its unknown obligation remains held even if the signal is already aborted. This distinction is not a global disposal/eviction or native cleanup qualification.

## All per-request external exception sites

| Actual site | Failure handling / precise acceptance limit |
| --- | --- |
| `readSource` throw | Always explicit unknown endpoint with original raw cause; ordinary Error is not a default successful cleanup capability |
| `readSource` undeclared return | Existing unknown return gate preserved; null/Promise/thenable/other invalid values retained, observer runs only after custody publication |
| Observer instanceof/native Promise species machinery | Actual observation failure and original raw endpoint retained together; original result rejection reason preserved; no thenable assimilation |
| `request`/signal/context/identity getter or digest/configuration access | Any thrown value outside a privately minted cancellation reaches original outer catch and is retained as unknown producer cleanup; runtime-not-started alone cannot resolve it |
| Public FsusUI runtime call/rejection/error envelope | Actual awaited native future remains required. Unconfirmed native outcomes reject terminal; generic external rejection remains held by raw cause, never default cleanup |
| Public projection, source identity resolver, recursive projection getters/freezing | Caught projection error now keeps explicit unknown endpoint even if a formal projection-failed result is returned; metadata failure cannot attest that endpoint's cleanup |
| Encoding/JSON/digest/validation/publication | Any external/getter exception remains unknown through original outer catch; acquired original result-ref cleanup is attempted, but does not magically settle its original unknown cause |
| Original result-ref release throws | Original actual ref/error retained; terminal rejects. No retry/force-drop |
| Release returns an undeclared future/value | Raw return and any observer failure retained as an undeclared cleanup endpoint. Later future resolution cannot replace the original synchronous release contract |
| Producer constructor; cache verification/resolve/release outside this request | No new successful lifetime qualification. Constructor/native/factory and original cache per-call terminal capabilities are outside this per-request fix and remain original-owner WIP |

## Source controls and static results

12 appended source cases (UNRUN) cover throwing a native Promise, thenable, poisoned then getter, Error carrying pending work, native observer/species failure, null, undefined, string, number, symbol, and disposal reentry returning source vs throwing a future. They use the original public constructor, original document/cache and actual pending Promises, not mocked terminal owners. Cases check original cause identity, rejection before/after real future completion, no then-getter assimilation, and actual unknown custody.

The prior ordinary-reader-Error control is strengthened to require an unconfirmed/rejected producer terminal. It is preserved, not removed or recast as a green cleanup receipt. Original returned-future, same-request/copy refusal, native failure, release failure and same-terminal controls remain intact. No test/list/discovery/collection or candidate runtime was executed.

Current run identity `/workspace/.tmp/chain2246-thrown-source-p2`; commands/exits/logs adjacent. Official Node v24.16.0, existing locked compiler/style tooling, real local FsusUI `6a73ad6312091ca782f99393140efc8df0fb4fb6`. Existing two canonical tooling overlays from `69992a0769a896434028d2b16776423f31c6c7d0` only; no casts/config/baseline/threshold/rule weakening.

- Actual frontend program: 730 files, zero mismatch.
- Changed production file strict-full style: exit 0, one file, zero violations.
- Two changed source/control files pure TS AST parse: exit 0, zero parse diagnostics; tests only parsed, not imported/run/collected.
- Complete application typecheck: exit 2, 221 existing diagnostics; added 0/removed 0 normalized path/code/message diagnostics against actual source 79da. Whole application remains RED.
- `git diff --check`: exit 0 before source publication.
- Runtime/test/list/mount/browser/native/SDK/security/receipt/product gates all HOLD; no passed/failed runtime case count inferred from source controls.

## Exact owner handoff and entire assignment

Notify #2245 original cache owner with exact source `3916a5ea219238d0ebb57a2e4a58dd61980fc867`, requiring only this two-path net from 938. API remains `getRequestWork(theSameActualRequest)?.terminal`; read it on BOTH success and rejection, preserve missing/rejected/unknown outcomes. No substituted settled Promise, synthetic success, forced eviction or second request/cache. Its actual terminal consumer and null/unknown P2 need exact independent commits/evidence from the parent. This request does not wait for #2245's entire chain.

FsusUI failed-native cleanup capability, #2283 preview source-admission/actual futures, #1975 attachment/upload/File-loan/error-cleanup, actual product mount/tool/search/native restoration and full-session/factory qualification remain separate WIP.

| Owned issue | Acceptance status |
| --- | --- |
| #2246 | Open: producer P2 source correction published; native anchors/scroll acceptance pending |
| #2250 | Open: same-terminal continuity source preserved; complete context/factory/lifetime/native gates pending |
| #2253 | Open: large-document/epoch/restoration controls UNRUN |
| #2256 | Open: original provider/native/business/actual cleanup acceptance pending |
| #2280 | Open: migration/product prerequisites |
| #2282 | Open: actual Live/#2245 acceptance |
| #2284 | Open: same-work source-compare source preserved; mounted caller/hosts/sync/native restoration/#2245 pending |
| #2286 | Open: user preferences/#2280 prerequisite acceptance |
| #2287 | Open: native Focus/Typewriter/prerequisites |
| #1809 | Tracking only: child evidence incomplete |

`91 pending / 79 null / fullGeometryVerified=false` unchanged. No source-closed assertion before independent re-review, no chain completion, no issue closure/merge/auto-merge/deploy/master push or cross-chain conflict-resolution phase.
