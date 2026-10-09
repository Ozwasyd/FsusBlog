# Bounded Package candidate-review transport handoff

Sole central owner: `01a11963-efb0-7431-8fc4-3a54b35e7034`; issues #2406/#2418 under #3735.

Corrected implementation source: `4a353be288a519bd8e025377eb20ef6a2383ac87`.
Independent branch: `codex/package-candidate-review-wire-2406-2418-20261009`.
Base: `9d72a1c93b297f719d8695a642cdfb1615cf1d51`.
Canonical Shared release: `9d1f98d0279bb65c51140a762f7c0b9d75da1614`.
Supplier source/final: `d49a430828354760ec42463d98739babdbec9312` / `76f900f3266560af64e05f6936d4096f76577361`.

All seven assigned paths were absent at the checked base and canonical owner release. Exact necessary source paths were consumed without merging supplier history. `source-bindings.json` records all seven production/test hashes, 34 byte-exact consumed dependencies and canonical existing helper bindings. The canonical independent-module-release.json and handoff.md were read before implementation. No overlapping implementation in the seven paths was found.

## Corrected implementation

The inactive partial endpoint calls the original `ArticlePackageCandidateReviewReadService.ReadAsync(request, token)` through the existing canonical binary context/frame/result helpers. Authentication, canonical admin kind/positive ID/session and ArticleWrite are checked before binder, body or identity reader processing. Anonymous callers receive the original 401 ApiError; invalid admin/session/permission receives 403. Original context-drift and stale-plan refusals retain 409; other original reason codes retain their original 400 mapping. Unexpected failures use a fixed private-safe 500 message. Required auth namespace and canonical operationId `binary_post_author_article_packages_candidate_review` are explicit.

Caller cancellation and RequestAborted are linked. Cancellation is checked around actual reads and service work, and propagates without creating an IResult or writing a response. An unsignalled OperationCanceledException also propagates instead of being turned into an infrastructure response. Existing service/producer cancellation refusals stay unchanged; a cancelled linked token is rechecked before their outcomes can become public frames. The owned tests declare controls for identity refusal before unread bodies, 401/403/409, pre-cancellation, cancellation during either original identity observation, unsignalled cancellation and private-safe storage failure. These controls remain UNRUN.

Shared, TypeScript and native validators close every nested object: unknown/duplicate/missing fields, required nulls, wrong primitives, unsafe numeric spellings and noncanonical positive Int64 strings are refused. Original modes, portable article identities, lowercase digests, UTC intervals, target bijection/paging, context coordinates, original required-authority list and ExecuteDisabled=true remain validated. TS scalar patterns additionally reject trailing newline suffixes in digests, Int64 revisions, portable identities and UTC timestamps, matching Shared/native. Negative controls were added across the original projects.

The TS codec aliases the byte-exact original3663 host DTOs rather than maintaining another request/response model, and uses the canonical generated AEDS header-size constant. Request encoding remains payload-only; original AEDS framing and CRC retain ownership. Correlated decoding requires the original request and AbortSignal, checks requestId/mode/policy/timestamps/page/replay digest/context/update hints, and rejects cancellation before and after decoding. The original host/controller keep explicit completion identity and late-response handling; neither was edited. Browser checks confer no authority.

Finite profile: complete request frame 1048576 bytes including the canonical 16-byte header, including unknown-length bodies; decoded ZIP 524288 bytes; requestId 128 UTF-16 units; pageSize 50; requestedTargets 1000. A trailing byte is refused before typed service/reader work. Exact imported ZIP/planner ownership retains maxArticles 1000, maxFiles 1002, maxUncompressed 67108864 and compressionRatio 100. No new ZIP parser, planner, identity store, receipt, registry or execution API was added. Source ZIP, titles, actor/session/credentials/receipts and private scope lists are absent from the projection and public error text.

SiteIdentity declarations are byte-exact from `adc2e50070ffecbd1e003e7a051450c2dea6ff1f`, including InitializationRequired. Only the original typed service's Current state with exact configured approved scope and exact generation/mapping/scope revisions may bind. Canonical storage/lifecycle/scope review remains pending. Neither its alias nor route/read service/frame registry is active.

## Prerequisites and original ownership

The canonical Shared release binds supplier final `76f900f3266560af64e05f6936d4096f76577361`. Its DTO/read service/ISystemSiteIdentityReader and required original ZIP/planner/projection/manifest/property closure are consumed by exact source path. `source-bindings.json` is the complete file/blob/SHA-256 roster; no supplier execution credit is inherited.

Frontend review types are exact from final `820be8ea3c35debcbc9b486d04ab6be4b175098e`, matching controller `3335910dee5e67e446167ec3b3d875912a908709` and preserving original `0ea8b5246968602a570909c21104724b57e64a6d` authorship. Original host DTO source `src/frontend/src/api/types/articlePackageCandidateRead.ts` is imported byte-exact from original3663 `1525e2ad0ea56350f34a368c8f2107706d342759`. The read service, Shared DTO and frontend review type blobs match that prototype source exactly. Its published README and precise-wire-di-handoff at remote `d33a417865ec41b16d7470178288a5d78679f553` were read; its 32/backend and 70/frontend controls are compatibility context, not this wire qualification or real production I/O proof.

Original3663 retains read-service, frontend host, controller and component ownership. The old prototype source/test remain frozen and absent from this branch. `prototype-dependency-exclusion.json` gives the exact negative import list:

- `src/backend/Modules/Endpoints/AuthoringEndpoints.ArticlePackageCandidateRoutes.cs`
- `tests/backend/Unit/ArticlePackageCandidateReadEndpointTests.cs`

Both old/new partials define the same mapping and handler signatures. An unmounted old prototype still causes duplicate compiled definitions if imported beside this canonical new routes file. Import only required matching original3663 dependency paths; do not merge its entire history or apply its old root-3735-authoring-hook-proposal.patch. If the frozen files already exist in the central checkout, the sole original project owner must exclude them from compilation through the original projects. This module neither edits nor registers another owner's prototype/test.

## Unapplied central integration

`central-integration.patch` returns exact checked-base hunks for the sole owner: protocol source allocations 288/289; native payload admission/error; TS response roster/decoder registration; exactly one MapArticlePackageCandidateReviewRoutes call plus the original TryResolveRoute entry; conditional reader alias/read-service DI; coordinated ABI v4 -> v5 proposal across the eight current producer/consumer paths. Central production files were not edited.

`generated-enum-integration-proposal.patch` contains the five enum/frame/golden products rendered by the unmodified original generator's `renderAedsProtocolOutputs` against the proposal manifest, without writing central products. IDs 288/289 stay reserved and inactive. Golden orders 244/245 and native error 11 are checked-base proposals: reconcile other owner allocations (including 282..287), keep fixed frame IDs, and regenerate through `node tools/frontend/generate-aeds-protocol.mjs`. ABI v5 is a coordinated proposal, not a published or qualified runtime allocation; the sole owner must reconcile its current ABI and regenerate through the original pinned producer. No wasm artifact/receipt/build/package publication was produced here.

`central-endpoint-contract-proposal.json` preserves the original host contract entry, canonical operationId, typed request, utf8-json request encoding, success status 200 and ApiError refusal frame, with reserved inactive numeric IDs. Admit the original endpoint registry and regenerate compiled OpenAPI/documentation through the existing producer only after original execution and canonical reader gates. The current original CompiledRequestTypeObserver only recognizes its existing generic JSON reader and POD decoder calls; it does not recognize the new Shared closed validator/out-request signature. `central-compiled-request-observer-proposal.patch` returns the precise original-producer observer hunk to recognize that exact reader and actual out DTO as utf8-json. It is unapplied and requires its original owner admission/self-controls; a registry declaration alone is not compiled request observation. This is not an active public API contract.

The DI hunk is conditional: base SystemService does not implement the under-review canonical reader. Do not activate its alias until the actual canonical implementation, approved scope and lifecycle/revision review qualify. No default identity or initialization authority replaces this gate.

`original-native-project-proposal.patch` adds the test to original CMake with production DecodeFrame/CRC/article parser, original warnings/sanitizers and add_test. The sole owner must also register its exact target/support closure through config/testing/native-test-assets.json, tools/test/run-native-tests.mjs and original matrix/coverage admission. Current original profiles only select CRC smoke/fuzz. Native controls intentionally assert that inactive 288/289 remain FrameTypeUnsupported in production DecodeFrame. Adapt those specific controls to active valid-payload admission and malformed-payload refusal only when registration is authorized. No reduced compiler harness or alternate executor was used.

## Exact-source verification

`admission-observations.json` preserves every prior first failure, including the initial 55-second capture interruptions at `934211fa851a4a2d4353d60af0fe8daecaad096a`, dirty-evidence refusal at `54edafc83a2a9d7b245ecc67dea494745227b050`, and actual clean-candidate selection/preflight failures at `4c0ce525795367bb3c3c1f26e421cb11a7fe6a93`.

The original `node tools/run-test-matrix.mjs preflight` was rerun without an outer capture timeout at both corrected clean sources:

- `c0c6c312cfae9e18620f3ecf4b7046282dbb8409`: FAIL, exit 1, 100.885 seconds.
- `4a353be288a519bd8e025377eb20ef6a2383ac87`: FAIL, exit 1, 104.659 seconds.

Both report release-final static boundary rejection, independent release-final Node parser identity drift, and execution target authority owner/content/dependency closure mismatch: expected `sha256:142d04ffc89385fb9de39a0322902fdb2d1a7d5382c6cb688e74511808f940ea`, actual `sha256:e9d3a2cc7920a8a47b7fe03b7a8b83f1f19c0f857f2298e1db84f8ad6b3f9658`. Structured command/SHA/exit/timing/refusal records are published; the new raw logs stay local in /tmp and are not published. Older already-published evidence is preserved without modification.

Dependent compilation, SDK gate, managed discovery, Node/native/managed test bodies and isolated resource grants are UNRUN. Current source selectors are declared nonempty: 147 managed cases across five original-project classes (46 in the wire class), eight exact Node cases and one proposed native target. Counts are source declarations, not discovery or PASS credit. Hook/source hashes, canonical Node support closure and finite owned resource estimates/root cgroup observations are in `selectors-hooks-resources.json`; those observations are not an isolated producer grant. The original build-with-data-env.sh --info observation of SDK 10.0.401/runtime 10.0.12 is not the required original SDK admission gate.

Source/test whitespace, exact dependency hashes, unchanged central source checks and all four proposal patch-context checks PASS. A prior full-tree whitespace check flagged literal unified-patch blank context/raw-log terminal lines; its exact-source failure remains recorded, and reviewable patch/raw-log bytes are retained. These static checks do not qualify behavior. The final artifact-only delivery commit inherits no test qualification.

Remaining gates: original release-final parser/authority closure reconciliation; original setup/SDK/dependency and isolated resource admission; exact selector discovery/matching/hook checks before bodies; original native target/catalog/matrix registration; canonical SiteIdentity security/lifecycle/scope/revision/reader review; sole owner closed-pair/ABI/route/DI/generated contract admission; actual qualified positive/negative production transport and authenticated I/O cancellation. No real I/O, execution or production authority is claimed. Held receipt, replacement, cohort and native custody audits remain excluded. No PR/body/comment/label/ready/merge, migration, deployment, credentials or publication operations were performed; only ordinary independent source pushes are authorized.
