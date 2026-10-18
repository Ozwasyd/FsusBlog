# Canonical projector connection: precise missing contract

Inspected published candidate `5a62ba29959c0b116c71a49fd4bfa2d805116d19`. Latest fetched origin/master `9d72a1c93b297f719d8695a642cdfb1615cf1d51`; not incorporated. The projector is byte-identical in both (SHA256 `01109f9199aa0e7484684a9d464b3c2ed5115192e0b3730c995493b499e4cd02`). All existing P01/P02/P05/Auto/P06 issue bodies and comments were reread; their current state is OPEN. This report is a source inspection, not runtime or stage acceptance.

## Seven files changed in the preceding source increment

- `docs/architecture/repository-layout.md`
- `src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs`
- `src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs`
- `src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadMetrics.cs`
- `src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadSnapshot.HostOwnership.cs`
- `src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadStore.HostOwnership.cs`
- `tests/backend/Unit/OwnedPublicHotReadSnapshotTests.cs`

## Existing original path and typed interfaces

`IPublicHotArtifactProjector.BuildInitialSnapshotAsync(CancellationToken ct)` (PublicHotArtifactProjector.cs:31/134) calls `BuildSnapshotAsync(IEnumerable<KeyValuePair<string, PublicHtmlArtifact>> existingHtml, CancellationToken ct)` (137), then `BuildSnapshotCoreAsync(existingHtml, ct)` (147). It builds FrozenDictionary<int,PublicBinaryArtifact>, FrozenDictionary<PublicListKey,PublicBinaryArtifact>, category/tag artifacts and the original visibility publication evidence. `BuildArticleFramesAsync` (497) / `MaterializeVisibilityCheckedArticleFrames` (519), `BuildListFramesAsync` (614), `BuildCategoryFrameAsync` (1406), `BuildTagFrameAsync` (1438) and `EncodeFrame` (1470) call the original array writer/factory. Delta, view and taxonomy reconstruction also call original snapshot constructors. The source has no actual host source/lease, memory content/location mapping, controller, canonical ledger or shared hold policy input.

The existing typed destination is `PublicHotReadBinaryArtifactFactory.FromHostReadLease(IMemoryHostReadLease, AedsFrameType, string, long, PublicHotReadOptions)` (PublicHotReadMetrics.cs:528), followed by `PublicHotReadSnapshot.WithHostReadLeases(IReadOnlyList<IMemoryHostReadLease>, int maximumHolds)` (PublicHotReadSnapshot.HostOwnership.cs:21). It consumes real supplied exclusive disposal custody after binding validation and remains identity-only. These calls cannot receive the existing arrays as owning leases.

The actual backing interfaces already exist: `IMemoryHostViewSource.TryAcquireHostView(MemoryLocationToken)` returns `MemoryOperationResult<IMemoryHostReadLease>`; `IMemoryHostReadLease` supplies `MemoryContentIdentity Content`, `MemoryLocationToken Location`, `ReadOnlyMemory<byte> Memory`, disposal custody. `IMemoryMaterializer.MaterializeAsync(MemoryContentIdentity, MemoryLocationToken, CancellationToken)` is the explicit asynchronous non-host path. The managed and arena owners return genuine allocation/block location; projector must not create substitute location/role IDs.

`MemoryCapabilityController.Select(exclusiveGroup, admissions)` (324) returns a selection token; `TryReserveOperation(selection, admission, governor, charges)` (335) checks actual policy/runtime/governor/admission facts and admits the operation. Neither produces content identity or host bytes. RuntimeInfrastructureServiceCollectionExtensions.cs:408 registers the canonical projector, but production Bootstrap has none of these memory services or typed inputs. The existing configuration contract has no memory policy binding. Existing PublicHotReadOptions residency/artifact count limits do not provide the missing ownership metadata/hold contract.

## Ownership and missing inputs

The ordinary projector adapter and canonical representation connection remain this root's retained P06/P07 integration. No released module owns this projector, and all six local task worktrees have no pending projector edits. This local observation does not certify every external coordinator session. No conflicting write is attempted because essential inputs are absent independently of any writer lock.

The materialization owner must supply stable canonical public frame bytes and actual memory Blob/Generation/Representation identity, source/location and exclusive read-lease custody. Article ID, DB revision/publication coordinates, version timestamp or hash alone cannot establish those memory identities. ManagedMemoryBacking.TryCreate needs actual ledger/payload-operation domains, content, residency revision, device epoch, capacity and holdLimit; NativeMemoryArenaBuilder additionally needs its actual frozen arena policy. Real source owners generate and retain physical allocation/block identity. Public eligibility/currentness remains the original projector/publication authority.

This root also owns the missing P01/P02/P03 contract work (#3445/#3446/#3447), rather than another prerequisite root. The existing P01 fixture/measurement/acceptance-manifest authority must freeze numerical rules, P02 configuration contract must define revision/units/zero/omission semantics, and P03 canonical ledger must provide real topology/domains/charge admission. Required policy inputs are: positive maximumHolds scoped across roots/immutable clones/current-last-good-sticky overlap and concurrent consumers; bounded lease/representation/clone/consumer roster; conservative metadata capacity/headroom for arrays/HashSets/index/snapshot/gates/hold objects; actual byte/operation domains, finite charge vector, reservation/conversion owner, final-group/consumer release lifetime, exhaustion behavior and reload/drain behavior. Existing ledger entryLimit/eventCapacity only bounds ledger metadata. No measured/frozen authoritative values or producer of that snapshot ownership policy was found; fixture counts 1/2/3/8 cannot become defaults. Exact CLR header/layout or unrelated existing budgets cannot be repurposed into fabricated physical charges.

## Result

The missing ordinary call is precise: once admitted authoritative representation leases and policy are genuinely supplied to original BuildSnapshotCoreAsync/materialization helpers, use the existing FromHostReadLease + WithHostReadLeases transfer while retaining original visibility/publication checks and rejection cleanup. Delta/view/taxonomy paths also need actual source-owned transfer for unchanged/new representations. Currently these inputs are absent, so a disconnected overload or array wrapper would not connect the original production path. The dependent connection remains **BlockedMissingAuthenticInputsAndFrozenPolicy**. No product source was changed or qualified, no Auto enabled, and no new IDs/statuses/budgets invented.

The successful 29-case preflight/TRX remains at 00e5f1a0b9c7de2a4c2b04a4e2ea9d0b6ea7846b. Previous 21-case and 14-case results retain their original commits. No tests were rerun for this source inspection; no held native/lease race/alias/TOCTOU/custody/receipt/full SOURCE audits were invoked. All 23 issue rows/237 criteria remain NotAccepted in the previous complete checkpoint.
