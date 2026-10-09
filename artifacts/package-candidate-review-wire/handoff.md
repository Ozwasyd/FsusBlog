# Bounded Package candidate-review transport handoff

Owner: `01a11963-efb0-7431-8fc4-3a54b35e7034`; issues #2406/#2418 under #3735.

Implementation source: `54edafc83a2a9d7b245ecc67dea494745227b050`.
Independent branch: `codex/package-candidate-review-wire-2406-2418-20261009`.
Base: `9d72a1c93b297f719d8695a642cdfb1615cf1d51`.
Canonical Shared release: `9d1f98d0279bb65c51140a762f7c0b9d75da1614`.
Supplier source/final: `d49a430828354760ec42463d98739babdbec9312` / `76f900f3266560af64e05f6936d4096f76577361`.

All seven assigned paths were absent at the checked base and checked canonical owner release. The necessary source closure was imported by exact path, without merging supplier history. `source-bindings.json` records every consumed blob and SHA-256 and all seven implementation hashes. The canonical release manifest and handoff were read before implementation. No overlapping implementation was found.

## Implemented behavior

The inactive partial endpoint contains the actual call to `ArticlePackageCandidateReviewReadService.ReadAsync(request, token)`. It uses the canonical binary request context, header and result helpers, preserves authenticated HttpContext ownership/session/ArticleWrite facts in the unchanged typed service, links request cancellation, preserves original refusal codes and uses fixed private-safe infrastructure errors. A trailing byte or an unknown-length body exceeding the complete frame limit is refused before the reader. Serialization is checked through the closed response validator and request/plan/context correlation before output.

Shared, TypeScript and native validators close every nested object, rejecting unknown/duplicate/missing fields, required nulls, wrong primitive types, unsafe numeric values and noncanonical positive Int64 strings. They validate original modes, portable article identities, digests, UTC intervals, target bijection, paging, context coordinates, the original authority list and `ExecuteDisabled=true`. Response correlation binds requestId, mode, policy, timestamps, page and replay plan/context; update target hints remain exact strings. Source ZIP, titles, credentials, receipts and private scope lists are absent from the projection and public failure text.

The finite profile remains: complete frame 1048576 bytes (including the 16-byte canonical header), decoded archive 524288 bytes, requestId 128 UTF-16 units, pageSize 50, requestedTargets 1000. The exact imported ZIP owner retains maxArticles 1000, maxFiles 1002, maxUncompressed 67108864 and compressionRatio 100. No new ZIP parser, planner, identity store, receipt, registry or execution API was introduced.

`SystemSiteIdentityContracts.cs` is consumed from `adc2e50070ffecbd1e003e7a051450c2dea6ff1f`, including InitializationRequired. Only the original typed read service's Current state with exact configured approved scope and exact generation/mapping/scope revisions can bind. Its canonical storage implementation remains under review. Neither its alias nor the route/read service/frame registry is active.

The frontend DTO file is byte-exact from `820be8ea3c35debcbc9b486d04ab6be4b175098e`, identical to controller source `3335910dee5e67e446167ec3b3d875912a908709`. The original component/controller were neither imported nor edited. Their explicit completion identity and AbortSignal handling remain owned by their authors. The new codec's correlated decoder checks cancellation before and after decoding; it does not replace the controller's late-completion guard or grant browser authority. It encodes a payload for the original frame writer, not a parallel transport.

## Central integration proposal (unapplied)

`central-integration.patch` returns exact base-relative hunks for the sole owner. `generated-enum-integration-proposal.patch` additionally contains the five exact enum/frame/golden products rendered by the unmodified original generator's exported `renderAedsProtocolOutputs` against the proposal manifest; central outputs were not written:

- Protocol source allocations 288/289, generated enum/frame outputs through the original `node tools/frontend/generate-aeds-protocol.mjs` producer, native payload admission and a new fixed native error code.
- TypeScript response roster/decoder registration.
- `MapArticlePackageCandidateReviewRoutes(group)` in AuthoringEndpoints.cs.
- Scoped canonical reader alias and typed read service in RuntimeDomainServiceCollectionExtensions.cs.
- Coordinated ABI v4 -> v5 proposal across the eight current source/consumer paths.

All three proposal patches were checked with `git apply --check`, not applied. Generated products are reviewable base proposals and must be regenerated against the owner's final manifest. Fixed IDs 288/289 remain reserved and inactive. Golden orders 244/245 are exact checked-base proposals: the owner must place them after its other allocations (including 282..287) and regenerate, rather than importing conflicting generated products. ABI v5 is a proposal for coordinated owner admission, not a published/qualified runtime or a claim that its number is still unallocated. Reconcile the current central ABI and regenerate production artifacts through the original pinned producer before activation. No wasm receipt, build, package or publication was produced here.

The DI hunk is conditional: the checked base SystemService does not implement the under-review canonical reader. Do not apply or activate that alias until the canonical SystemService/reader implementation, approved scope and lifecycle/revision review are complete. No default identity or initialization authority may replace this gate. Central route and DI files were not edited.

`original-native-project-proposal.patch` adds the test to the original CMake project with production DecodeFrame/CRC/article parser, original warnings/sanitizers and original add_test. The central owner must also admit its exact selector and support closure through config/testing/native-test-assets.json, tools/test/run-native-tests.mjs and the original matrix/coverage admission. The original profile currently selects only CRC smoke/fuzz; bypass compilation or a reduced harness is not acceptable. Current native controls intentionally assert that unregistered 288/289 are refused by production DecodeFrame. Once registration is authorized, adapt these specific controls to require valid payload admission and malformed payload refusal through the active production decoder.

Compile the original backend/OpenAPI and regenerate its contract documentation through the original producer only after admission and the canonical reader gate. This handoff documents an inactive proposal, not a new active public API contract.

## Verification evidence and pending gates

`admission-observations.json` and raw logs preserve the first actual attempts at exact source `934211fa851a4a2d4353d60af0fe8daecaad096a`:

- Original entry help: PASS, exit 0.
- Mandatory `node tools/run-test-matrix.mjs preflight`: interrupted by the capture's 55-second timeout, exit 124; no PASS credit.
- Original source-integration plan: FAIL, exit 1, independent release-final Node parser identity drift; applicable execution authority schema/source index/parser identity drift.
- Original backend plan: interrupted by the same 55-second capture deadline, exit 124; no PASS credit.

The first final-source plan at `54edafc83a2a9d7b245ecc67dea494745227b050` rejected uncommitted evidence files (exit 1). `final-source-selection-plan.json` records that exact reason.

The subsequent clean committed candidate `4c0ce525795367bb3c3c1f26e421cb11a7fe6a93` was checked through the original entry points, without any outer capture timeout. Production/source bytes are unchanged from implementation source 54edafc.

- `clean-source-selection-plan.json/.log`: FAIL, exit 1 after 4.517 seconds, independent release-final Node parser identity drift; applicable execution authority schema/source index/parser identity drift.
- `clean-mandatory-preflight.json/.log`: FAIL, exit 1 after 96.760 seconds, release-final static boundary rejected matrix parse. It reports the same Node parser identity drift and execution target authority owner/content/dependency closure mismatch: expected `sha256:142d04ffc89385fb9de39a0322902fdb2d1a7d5382c6cb688e74511808f940ea`, actual `sha256:e9d3a2cc7920a8a47b7fe03b7a8b83f1f19c0f857f2298e1db84f8ad6b3f9658`.

Dependent compilation/discovery/test bodies were stopped. The central owner must reconcile the original execution authority/source index/parser closure and admit the complete exact candidate; this branch does not edit those authority surfaces or route around the rejection. First failures remain preserved; no final delivery commit or later owner integration inherits test qualification from these attempts.

The original build-with-data-env.sh dotnet --info reported SDK 10.0.401/runtime 10.0.12. This is a read-only observation, not the required SDK gate. Managed discovery/build/bodies, Node bodies and native bodies are all UNRUN. No supplier test credit is inherited. `selectors-hooks-resources.json` declares nonempty exact source selectors (132 managed cases across five original-project classes, eight Node cases and one proposed native target), hook/source hashes and finite owned resource estimates/cgroup observations. These counts are source declarations, not discovered or executed counts. No execution grant/reservation was created.

Routine whitespace and unapplied patch-context checks PASS at the implementation source. They do not qualify behavior. Preserve all exact source-bound failures and stop dependent execution until mandatory preflight, applicable authority, original SDK gate, selector discovery/matching, hook checks and resource admission succeed. Held receipt, replacement, cohort and native custody audits remain excluded. No PR, comment, label, merge, deployment, migration, credentials or publication writes were performed.
