# Original producer terminal work: source-only checkpoint

- Implemented/tested source: `de1f888a253d9c63ddc09dff0cb54b050fa1a394`.
- Parent source: `468dd2dbb08e0ad98a522dd683cc26ed1139a9fe` (the bounded full-draft three-P2 scope was independently SOURCE CLOSED).
- Fresh origin/master fetch/readback: `9d72a1c93b297f719d8695a642cdfb1615cf1d51`; not incorporated into this isolated source checkpoint.
- Branch: `codex/chain-2246-preack-runtime-intake`; draft PR: https://github.com/Ozwasyd/FsusBlog/pull/4153.
- Current #2256 issue body and comments re-read. This change remains within its intent/context/transaction boundary; no upload, asset grant, caption logic or native parser is introduced.

## Implemented terminal notifications

The original `ArticleAttachmentContextAdapter` now calls the stable original lease `settle()` after successful synchronous input transfer in `commitCreated`, after successful native accepted-input transfer in `admitAcceptedCapture`, and after the synchronous public commit attestation completes `record` and `observeTransaction` in `complete`. These are their existing leases; no second task/owner/store is created. Input leases are logically canceled before settlement; the accepted commit lease is already logically terminal. The new provider lease and its predecessor are not settled by these operations.

If dispatch, transfer, binding, File release, recording or map observation throws before its successful endpoint, the obligation stays pending. Existing cancel/rebase/metadata-completion/dispose behavior does not attest to the actual provider future or native cleanup.

Three new source controls (UNRUN) use the original adapter and actual public editor fixtures: normal input/commit settlement preserves the provider predecessor; cancellation/disposal preserves the provider obligation; native accepted capture settles input only. The existing interrupted-dispatch control additionally asserts its input remains pending. No successful test/runtime receipt is claimed.

## Actual task/future endpoints and handoffs

| Actual path | Existing work and endpoint | Current settlement/accounting | Next required source/API from the canonical owner |
| --- | --- | --- | --- |
| Writer draft-save, recovery-refresh, recovery operation, asset-refresh, rollback | Five original `beginTask` paths await their actual request/operation; original `finally` cleanup then `complete`/`settle` | Implemented in prior published Writer source; abort/scope stop alone never settles | Runtime verification remains HOLD; no new implementation in this checkpoint |
| Writer helper tasks: init/submit/taxonomy/prepublish/AI/assets/revision refresh/compare | `useAbortableTask.run` awaits the provided actual executor; original `finally` settles after its cleanup | Original helper already implemented; caller promise is not independently qualified as native cleanup | Original nested producers must expose any work not represented by their returned Promise; no fake terminal default |
| Explicit attachment input transfer | Original public dispatch, source/map consumption, pending-handle construction, transaction observation | Normal transfer now settles only original input leases | Interrupted cleanup stays pending; controls UNRUN |
| Native accepted input transfer | Original native capture/File loan, original pending-handle construction, logical input cancellation | Normal transfer now settles only original input lease | Provider owns remaining File/native/service obligations |
| Attachment public commit attestation | Original success dispatch, binding, anchor capture, predecessor cancellation, new commit lease accept, File release, abort publication, receipt and map observation | Successful endpoint now settles only the original commit-attestation lease | Provider predecessor remains pending; metadata callback is not provider-terminal proof |
| Attachment provider and rebase/retry predecessors | `createPending`/`observeTransaction`/`retry` create actual provider leases. `complete` accepts metadata; `finish` cancels/releases synchronous File refs | Remain pending; actual provider future unavailable at this API, cancellation alone insufficient | #1975/upload-business canonical owner must connect the exact attempt/handle to actual service future plus File/session-loan and terminal callback cleanup. Need real ended/pending/failure capability, not a synthetic boolean |
| Actual Writer image upload | Original `useImageUploadFlow` delegates the original document registry lease. Its executor awaits `executeUpload`, `runtime.uploadFile`, session-ready, private `onFileUploaded` loan (`borrow.withSession` -> `provider.observe`), `onSuccess`, executor File cleanup | Helper settles that awaited executor lease; root's transport outcome bookkeeping is separate from provider/business/native acceptance | #1975 original source `f12179dc88053b6a186a640af773d1e3aa1a7537`: generic `onError` runs outside `uploadTask.run`; require actual error-callback terminal cleanup to remain inside that original lease obligation. Do not issue a duplicate Writer task |
| Original render cache (#2245) | `articleRenderCache.refresh` creates a real task. `produced` awaits `producer.render` and late-result release; public refresh races it against abort | No original producer `settle` exists. Race result cannot attest terminal work; outstanding ref remains | #2245 must notify settlement from the same actual produced future AFTER late-result release and all required cleanup; preserve release rejection/unfinished obligations. Supply exact commit/evidence per issue |
| Preview authority refresh (#2283) | Original `Promise.all` of current reads races abort; refresh `finally` removes controller/listener | Writer `previewTask` has no registry/lease, only a local controller. There is no Writer helper lease to settle here | Authority original source `637ffd278a12eb6836bb6d549a76262fed46c4c5`: expose actual read-work terminal/cleanup if retained-resource accounting needs it; do not treat raced refresh Promise as terminal |
| Original preview source admission/generation | `admission.begin` borrows original runtime preview lease. Generation races actual `assess`, `verify`, `createIdentity`, `requestPreview` Promises against cancellation; `accept`/`dispose` are logical admission endpoints | Original admission has no actual work-terminal notification. On abort, the underlying future may still be pending | Supplied original preview composition `9b4d90773384373e005e788e76184bb10b5823dc` through #2245, consumed `774a1d87088b9b165a33282248c1b3333acd9a3f`: canonical preview owner must retain the same admission lease and real outstanding work/cleanup to settle once all are truly terminal, including failed/aborted/repeated generations |
| Borrowed compare/search and source-compare tool | `borrowCompareTask`, `beginToolTask`, `ArticleEditorSearchRuntime.beginTask` return actual leases. Capture/projection/close/dispose do not supply producer future. Source-compare refresh awaits cache's raced refresh | No true terminal capability; retain pending on release/withdraw/invalidation | Parent must identify original caller producer and supply exact terminal Promise/native cleanup capability; #2245 must first expose real cache work endpoint. Writer must not manufacture a replacement caller/factory or settle on withdraw |
| Live capability | `ArticleLiveCapabilitySession.begin/commit` consumes a typed public result; actual application native producer/callback terminal integration is absent in current source | Result acceptance/cancel alone does not prove native producer cleanup; lease remains pending | Actual public FsusUI producer/caller must provide terminal/native-lifetime evidence on the original lease. No private capability producer, parser or fake native receipt |

## Verification and acceptance limits

Run identity: `/workspace/.tmp/chain2246-producer-terminal`; machine-readable commands, exits and logs are beside this file.

- Actual frontend program equality: 730 files, zero mismatch; two existing canonical tooling overlays from `69992a0769a896434028d2b16776423f31c6c7d0` only.
- Public FsusUI source: `6a73ad6312091ca782f99393140efc8df0fb4fb6`; official Node v24.16.0, existing locked TypeScript/Vue.
- Strict style of changed production adapter: exit 0, zero violations.
- Application typecheck: exit 2, 221 diagnostics. Against tested source `28362e479592da830d7f067bf70c0fdd45cd20ce`, added 0/removed 0 normalized path/code/message diagnostics. This is a failed application typecheck with no introduced diagnostic delta, not a green build.
- Three edited files pure TypeScript AST parse: exit 0, zero parse diagnostics. Candidate modules were not executed.
- `git diff --check`: exit 0 before source publication.
- Unit/integration/runtime/test-list/collection/mount/browser/native/SDK/security/product verification: NOT RUN/HOLD. No baseline, matrix, receipt or governance gate refreshed or weakened.
- Producer `17c2e83ea1747baa1ca2f8de366ad7e249b2c23f`, snapshot owner `1df8314c8000130448d798e7bf5d38f50e7f1ecd`, Outline owner `e49fac435748c09ce2fca603008ac120a9b7c4f1`, Write.vue/layout and three original full-session factory/resolver/composition files are unchanged.

## Whole-assignment status

| Issue | Status / remaining gate |
| --- | --- |
| #2246 | Open: native anchors/scroll acceptance pending; this source checkpoint only adds truthful synchronous task terminal accounting |
| #2250 | Open: full context/multi-owner/factory/lifecycle and native/remount/hydration gates pending |
| #2253 | Open: large-document/epoch/restoration controls UNRUN |
| #2256 | Source increment published; provider/native completion, actual future cleanup, business authority and runtime acceptance pending |
| #2280 | Open: migration/product prerequisites pending |
| #2282 | Open: actual Live and #2245 prerequisite acceptance pending |
| #2284 | Open: real hosts/synchronized scroll/runtime and cache terminal handoff pending |
| #2286 | Open: user preferences/#2280 product prerequisites pending |
| #2287 | Open: real Focus/Typewriter native and prerequisite acceptance pending |
| #1809 | Tracking only; required child evidence incomplete, no independent implementation or closure |

No chain completion, closed issue, merge, auto-merge, deploy or master push. `91 pending / 79 null / fullGeometryVerified=false` remains unchanged. Source-only partial settlement does not qualify full retained eviction or successful cleanup.
