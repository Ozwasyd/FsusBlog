# Historical source handoff: mounted association, static checks and layout prerequisites

Coordination/source evidence only. The chain remains OPEN and no runtime or product
acceptance is claimed. Related to #2246, #2250 and tracking-only #1809.

Source corrections:

- `8177888765dfdd9bed132e29abfd4f0317d1c6fd` revalidates the original registry
  revision and tab/session/document association after the caller's mounted read,
  before any native `getSession` access. A real native-session negative control
  is written but NOT RUN. This new P2 correction awaits independent rereview.
- `5b6b905a9458caec2fde8c8046c7357fa75d71f5` removes nine real strict compiler
  parameter-property diagnostics in the existing surface/capability/cache owners
  using explicit fields and constructor assignments. Initialization and compiler
  settings are preserved; no cast, stub, threshold or rule relaxation is added.
- The coordinator reports that independent c808 review accepted the earlier
  cancellation-reentry and duplicate-import corrections. That source review is
  not runtime or issue acceptance.

## Actual original static checks

Both isolated source comparisons use public UI source
`8afe8523b35f296a0131951b55b7e466a7a0f486` and the two exact canonical parser/config
postimages from review-verified `69992a0769a896434028d2b16776423f31c6c7d0`.
They retain original includes, strictness, locks and style rules. The configuration
owner's two files are overlays for these checks, not edits on this owner's branch.
Official Node24.16.0, locked TS6.0.3 and actual Vue compiler dependencies are used.
The source's real `type-fest@4.41.0` development dependency was also restored from
an existing exact-version install; the earlier missing-dependency attempts are
retained separately and are not a clean baseline.

`node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application`:

- Exact `9595e4edabb482768fcc93c844f87301f55fc75d`: exit2,238 diagnostics.
- Corrected source `5b6b905a...`: exit2,229 diagnostics; nine removals, zero additions.

`node tools/frontend/check-frontend-style.mjs --mode strict-full --file ...`:

- 13 existing baseline paths: exit1,7 findings.
- 17 candidate paths (four source modules are absent at baseline): exit1,5 findings.
- Zero new findings after normalizing source coordinates. Two original duplicate
  import findings are removed; the new mounted-source indentation finding is fixed.
- The remaining three wrapper and two untouched Write findings arise from genuine
  missing `MarkdownAttachmentCaptureObservation` / `MarkdownAttachmentFileConsumer`
  exports in the supplied UI8afe graph. These are FAIL, not suppression or acceptance.
- Current Writer Write uses no private `fields` collection. The layout candidate
  below still does; its distinct diagnostics are not confused with this source.

See `actual-static-comparison.json` for exact commands, selected paths, exits,
source identities and removed diagnostics. Exact logs are retained under `logs/` in the portable evidence offer.
The pre-correction241/238 runs and initial EISDIR dependency-directory setup
failure remain in the portable evidence, with their original status.

## Minimal source offer against the actual layout candidate

Target: `f39140f8ecccd4cbe2193c1a2525b6bfb5b6c362`, including its actual Group
and supplied cb154 session composition. Layout owner is
`01a12bf3-5b8d-7153-be7b-e374d6ce1008`; this owner has not edited Write.vue.

`source-closure.json` enumerates34 complete canonical consumer source postimages
and their target/source blobs. `layout-f391-prerequisite-source-unapplied.patch`
contains those postimages without the entire PR4153 ancestor history. The only
retained-index change is an additive export of the original preview owner.
Seventeen actual Group/registry/session paths remain byte-identical to f391.

`layout-f391-writer-consumer-unapplied.patch` applies to the exact recorded Write
blob and adds its real binding lifetime, actual native reader, document projection,
attachment/transaction/selection/focus forwarding and caller-held source getter.
It also replaces private `fields.find` with the original public validation callback
invalid-property capture, public `scrollToField` and product-owned field roots.
The composable's existing `isFsusUiOk` handles FsusResult and refuses ok(false).
No fake Form fields, facade session, second mount store or installer is added.
Both patches have actual `git apply --check` exit0 on the untouched target.
The prepared Write source has zero SFC parse/compileScript errors; its application
lint/types/runtime are UNRUN because the hunk remains unapplied by its owner.

The enumerated offer is **not yet a complete runnable prerequisite**. Original
application compile of f391 with the same UI/config has262 diagnostics (exit2).
Projection of the34 real postimages has267 diagnostics (exit2). Shared contract
and UI failures remain actual blockers; nine owned constructor diagnostics found
in the first projection were repaired before the final offer. See
`layout-integration-limits.json` for the exact added/removed diagnostic messages.

Required original shared owners must provide exact usable increments for:

- `UploadAssetPreviewViewModel` and `UploadAssetFactsViewModel`.
- The genuine facts frame285, preview/facts route and security records, original
  decoder registrations and real backend handlers. No authorization or receipt is
  inferred from the source consumer.
- A complete exact intended UI06d SHA/evidence retaining both the public native
  attachment APIs and the public session inspect/getSession contracts. The short
  name was not guessed, fetched or silently substituted for8afe.

Affected shared paths: `src/frontend/src/contracts/binaryApi.ts`,
`src/frontend/src/composition/binaryDecoderRegistry.ts`,
`src/frontend/src/generated/fsusBinaryRoutes.ts`,
`src/frontend/wasm/web/protocol/frame.ts`,
`src/shared/Contracts/Validation/fsusblog.openapi.json`, and
`src/shared/Contracts/Validation/aeds-protocol.json`.
Their full reference snapshots are portable evidence only, not wholesale overwrite
instructions: copying this older graph would remove unrelated current contracts.
This task pauses those dependent integrations and does not perform the later
cross-chain conflict-resolution phase or hand-edit generated protocol outputs.

The supplied original factory still refuses full snapshots because panel,
renderer-restoration,draft/crash-journal owners are not joined. Holding a source
or installing its factory is not editor readiness. No installer call is added.
Server DocumentId issuer/binding remains the original documented product/backend
owner gap; local document coordinates, draft rows, CanvasId or digests are not
substituted for a server-authorized binding.

## Assignment accounting

| Issue | Current status and outstanding gate |
| --- | --- |
| #2246 | Public-map/anchor and real mounted-source work remains WIP; new association P2 source awaits review and actual anchor/scroll/native acceptance. |
| #2250 | Continuity/cancellation source remains WIP; needs accepted #2245 evidence, real host custody and complete snapshot/transition acceptance. |
| #2253 | Existing and new source controls are NOT RUN; large-document/epoch/restoration acceptance waits for #2246/#2250 and #2245. |
| #2256 | Original attachment adapters exist; current UI API join, genuine recovery and native/business acceptance remain blocked. |
| #2280 | Existing surface/preference source remains WIP; migration/product acceptance and prerequisite tracking evidence are open. |
| #2282 | Existing capability/fallback source has strict constructor syntax repaired; #2245 and Live session/runtime acceptance remain open. |
| #2284 | Original compare/borrowed capture source exists; actual host callback, #2245 and compare/runtime acceptance remain open. |
| #2286 | Existing independent preference source; current user-scoped preference acceptance remains open after #2280. |
| #2287 | Existing Focus/Typewriter source; current public native contract/runtime acceptance remains open. |
| #1809 | Tracking only; child evidence aggregation is incomplete, with no standalone implementation or closure. |

The sole #2245 owner must supply exact accepted issue output/commit/branch/evidence.
All ten issues remain OPEN/unaccepted; preserve91 pending,79 null and
`fullGeometryVerified=false`. Tests/list/collection/mount/native/browser/server/
security/database/receipt/business/IME/race/UX/performance/a11y/geometry remain
NOT RUN or HELD. No merge, issue closure, deployment or package publication.

At20:09:11UTC after a reported environment disconnect, actual reads and a
scoped checkpoint write succeeded in the original /workspace environment.
Uncommitted artifact differences and the pending source offer were checkpointed.
No alternate environment or credential change was used.
