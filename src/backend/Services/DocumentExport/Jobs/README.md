# Durable document export jobs

This domain is the single job persistence, result custody and retention owner for
the existing [document export contracts](../DocumentExportContracts.cs). It does
not register providers, build frozen input, launch another sandbox or qualify
physical execution. Source handoff does not imply issue completion.

## Integration

`IDocumentExportJobs` is the authenticated API/UI boundary. Supply
`DocumentExportJobActor` from the canonical session and site context, never from
the request body. `IDocumentExportJobAuthorization` must check the existing live
session, exact configured `SiteScope` and article-coordinate permission for each
operation. No default authorizer exists. `UserId` binds the current endpoint's
`AdminPrincipalId`; `SessionId` comes from `GetAdminSessionId`, not anonymous
account/session claims. `SiteScope` is the existing authority's
`SITE_BASEURL.Trim().TrimEnd('/')` value, compared ordinally. Received identities
are validated rather than silently normalized, hashed or mapped to a number.

## Site identity version handoff

The original #2423 numeric `SiteId` was an implementation choice, not an external
site configuration requirement. This separate contract handoff replaces it with
`string SiteScope` in frozen input, task, sandbox plan/receipt, job actor/output,
quota scope and stored grants. Closed deserialization rejects an old `siteId`
member, even if a sender also supplies `siteScope`. Old schemas and protected v1
job state are refused; there is no compatibility alias or automatic migration.
No production state is read, migrated or deleted by this change.

| Surface | Next version | Consumer / canonical owner work |
| --- | --- | --- |
| Frozen input | v4 | #2423 retains the canonical frozen embed plan/dependencies and complete projection bytes; materializer qualification remains blocked |
| Task / provider result | v3 | Bind the v4 input content digest; no additional task/result fields or compatibility aliases |
| Renderer request / response | v3 | #2427 renderer/tool wrapper must bind the new frozen identity without parsing Markdown twice |
| Sandbox plan / attempt receipt | v2 | #2425 shared producer/validators use exact scope; original budgets and cleanup facts stay unchanged |
| Job snapshot / output / protected state | v2 | #2434 migrates its service/repository guards and tests to string scope, preserving custody and quotas |
| Authenticated API / browser / Shared AEDS | explicit aligned schemas | #2436 freezes scope from the existing authority and updates actual C#/POD/native/TS codecs together |
| DOCX / PDF / EPUB evidence | catalog v3 result | #2430 / #2429 / #2432 update consumer fixtures and retained receipt bindings; formats stay inactive |

The Jobs service consumes the exact string scope for admission, worker claims,
output/grant binding, idempotency, quotas and session revocation. It reuses
`DocumentExportContractValidator.RequireOwnerScope` and ordinal scope comparisons;
there is no private scope parser or alias. The existing protected-state v2 purpose
and closed canonical serializer reject prior numeric/v1 state without rewriting
its bytes, erasing owned objects or resetting grants. API consumers must use this
same contract and cannot add a numeric alias or suppress a consumer error. The
frozen earlier review candidate remains on its original branch with its original
wire identity. Compilation and original runtime/product acceptance are separate
gates; the controlled job tests do not qualify physical execution.

The shared worker handoff is
`IAuthorRecentArticleHistoryWorkerPermissionProjectionProvider.ResolveForSessionAsync`.
Its implementation reuses the existing SQL authority and accepts the authenticated
server's captured administrator/session and exact site scope without constructing
an HTTP context. The job owner must still supply its authorization adapter and
prove frozen coordinates, revisions and resource custody; this permission port
alone cannot qualify a job or a download.

## Frozen embed input handoff

The separate frozen-input v4 handoff adds the required `FrozenEmbeds` member.
A null member represents the canonical producer's no-embed case; an omitted
member or v3 input is rejected. The frozen-input builder must use the existing
FsusUI parser to establish completeness. This contract does not parse Markdown
or establish that a null slot is authoritative.

A non-null slot persists `ExpectedPlanDigest` from the authorized stored plan,
the original publication plan and relation derivation, and one complete retained
projection per original `ArticleEmbedDependencyReceipt`, in the original order.
`ArticleEmbedFrozenDependencyProjection.Project` is consumed byte-for-byte from
the supplied upstream source at `1194ee45037862aa30803650ec2a622700631224`.
The slot keeps the existing bare lowercase embed digests and receipt schemas.
It creates no second dependency receipt or publication authority. All four formats
share this same frozen input; task input/content digests seal the full slot.

The validator refuses partial/reference-only retention, different plans,
coordinates, projection identities, content digests and byte seals. Sealing owns
all plan/derivation lists and retained byte arrays, so later caller mutation or
current-target changes cannot replace stored content. Markdown plus retained
projection bytes share the 32 MiB input ceiling. The separate `ByteDigest` covers
opaque retained bytes using the existing document-export byte digest; it does not
redefine the renderer-owned projection `ContentDigest` or prove codec authority.

The actual retained-payload API/codec, independent projection verification and
numeric article-coordinate to portable host identity binding are still required
from the canonical owners. Until that materializer is connected, task validation
refuses a non-null embed slot with
`document-export-frozen-embed-materializer-unavailable`, before provider execution.
Structural input validation therefore does not qualify rendering, retention,
publication permission or target access. No fallback or format activation exists.
Imports must re-resolve targets through the existing authoring pipeline and current
permission authority; export receipts cannot be reused as import permission. The
import owner must prove that behavior at its own actual import boundary.

The earlier SiteScope v3 consumer handoff remains on its published branch. This
v4 source increment requires an explicit consumer handoff; no protected state is
migrated and no old payload is silently upgraded. Removing this increment before
activation is the rollback condition; retained v4 payloads require their exact
v4 consumer and must never be rewritten into v3.

## Shared attempt resources

`IDocumentExportAttemptJobProvider` is the explicit resource consumer port. After
claiming the worker, the job owner calls `CreateAttemptResources` once with the
same execution task/input and its `TimeProvider`, then passes that exact instance
to `ExportAsync` and `VerifyAsync`. Check `RequireCompleted` again at publication
boundaries alongside the existing deadline/cancellation checks. An adapter without
this port must be refused for aggregate qualification, not silently delegated to
the old per-stage methods. The original job owner must wire this additional port;
its SiteScope source migration alone does not provide aggregate accounting.

The canonical renderer and the final sandbox stage use the resource-aware
overloads with that same instance. Stages cannot overlap, repeat the same role,
reset after failure, or start after publication sealing. The sole sandbox tightens
CPU, wall, file count, input/output and log budgets to the remaining allowance,
using its real cgroup observations and mutable-file snapshots. HTML also charges
its actual composed output length. First failures and physical cleanup refusal
remain authoritative; this object produces no independent cleanup receipt.

Mutable-file bytes retain the original aggregate envelope of output plus both
logs; `MaxFileBytes` remains the per-file limit. Accounting sums each completed
stage's observed high-water marks. It does not measure transient creation/deletion
between observations or total kernel read/write traffic, nor host managed CPU.
Those physical qualification limits remain open. Plans/receipts keep their current
versions and identities; providers and the independent verifier still need all
original current-candidate native evidence. PDF/DOCX/EPUB remain inactive.

Construct `DocumentExportJobService` with the existing `ReleaseStorageLayout`,
shared `IDataProtectionProvider`, the exact permission adapter and `TimeProvider`.
The existing integration owner registers this service and schedules its internal
`ExecuteAsync` and `CleanupAsync` methods. Providers implement
`IDocumentExportJobProvider` by calling their canonical sandbox and independent
format verifier. `VerifyAsync` must verify the actual bytes, complete original
plan/receipt, pinned tool/build and cleanup facts; returning after a hash-only
check is invalid. The service refuses execution when the canonical registry says
`ImplementationAvailable=false`. Activation belongs to the existing registry
owner. A job may be admitted for any canonical format while capability is blocked.

The dedicated authenticated download route accepts an opaque grant in a protected
POST body/header. It must reject `Range`, apply every returned header, suppress
body for HEAD, disable logging of grant transport and bypass public/static/SPA
fallbacks. Grant creation/redemption preserve the existing AEDS v2, unified error,
PoW and `X-Fsus-*` authorities; this module adds no HTTP or JSON side route. Map
`DocumentExportJobDeniedException` uniformly to the existing privacy-safe denial.

## Lifecycle and custody

Admission validates canonical digests before sealing an owned input copy. A
bounded, Data Protection encrypted state snapshot stores the frozen bytes and
exact coordinate; execution never resolves latest source. Owner/site/idempotency
key deduplicates identical requests even when a transport request/task ID changes.
Different input/provider/profile identities under the same key are refused.

An exclusive cross-process file lock serializes claims and transitions. The
worker claim is persisted before invocation. Cancellation is durable and polled
into an operation-owned token; the commit rechecks claim, status, expiry and live
permission. The object cleanup obligation is flushed before publication. Actual
output length/digest and canonical result binding are rechecked after the format
verifier. Successful frozen source is removed from the current state snapshot.

After the worker claim, one monotonic attempt wall deadline uses the canonical
provider's original wall budget. Its cancellation token spans export, all nested
provider stages, independent verification and commit. Boundary checks refuse a
late result even when a provider ignores cancellation. The deadline's cancellation
is distinguished from caller and durable stop requests; an observed sandbox
budget/execution failure and its original receipt remain unchanged. Expiration
does not synthesize a cleanup receipt or authorize interrupted-worker recovery.
The explicit shared attempt-resource port adds cumulative observed CPU/file/I/O
accounting, but its job/format wiring and physical qualification remain required;
individual stage receipts and this wall deadline do not establish that acceptance.

Objects use the existing `PrivateAssetAnchoredFileSystem` under
`ReleaseStorageLayout.Paths.PrivateAssetRoot/document-export/objects`; staging
uses its original `UploadCommitRoot` and unnamed temporary-file protocol.
Opaque object identity plus content digest determines the key. User titles,
filenames and task IDs never determine paths. Equal digests have distinct object
and authorization/retention records. This is private custody rather than a public
asset or article-reference ledger. Download filenames are fixed `export.ext` from
the existing closed provider registry, so there is no user-derived header value.

Grants store only a digest of the 256-bit opaque token, bound to owner/site/session,
task/output, five-minute expiry and single use. HEAD verifies bytes without
consumption; GET consumes durably before returning a bounded byte snapshot.
Download/cleanup serialize their byte-read or unlink decision under the same lock.
Delivery may finish from its already-authorized byte snapshot after a later
delete. Logout/site switch revoke the old session's grants and retain the output
until explicit deletion or TTL. Delete/cancel revoke first and persist cleanup
obligation before unlink; failures remain `CleanupRequired` and visible in usage.
Internal audit contains only opaque IDs/digests, sizes, fixed policy/reasons and
timestamps, never source, paths, session IDs or plaintext tokens.

Failed/unverified execution retains its worker claim and exact canonical sandbox
failure receipt when provided. It requires `IDocumentExportJobRecovery` to consult
the original execution authority and explicitly prove quiescence before releasing
that claim. No timeout/PID-only inference or silent replay exists. Cancellation
and expiry survive recovery. The first completed attempt failure is retained.
An explicitly requested retry is diagnostic, at most three total attempts, uses
the same frozen input and can never publish a downloadable success.

`DocumentExportJobPolicy` bounds jobs, grants, input bytes, object bytes and
owner/site/total output quotas. Results expire no later than provider TTL or the
24-hour job TTL. Cleanup removes source/output bytes and retains bounded
source-free tombstones for another 24 hours; idempotency reuse is denied during
that window. Repeated cleanup is idempotent. Audit delivery events are bounded;
once the allowance is spent, further grants/HEAD requests refuse.

## Verification and remaining boundaries

[DocumentExportJobServiceTests](../../../../../tests/backend/Unit/DocumentExportJobServiceTests.cs)
uses explicit controlled provider/permission/recovery adapters. It checks real
local persistence, output bytes, grants, deletion and restart behavior, but its
fixture receipts are deliberately unqualified. These tests do not qualify a
format, systemd sandbox, runtime cleanup or production storage deployment.

The repository scheduler and source-bound local CI remain authoritative. Missing
or failed gates are retained; direct locked restore/build and focused tests are
WIP diagnostics only. No remote CI is dispatched.

The mutable encrypted state/lock files use restrictive Linux modes, ancestor-link
refusal, canonical path guards, flushed writes, atomic replacement and the
existing anchored directory-sync owner. Their open/replace coordination still
uses paths; a hostile writer with the same filesystem identity could race those
checks. No production qualification is claimed for that boundary. The existing
anchored owner already protects output object reads/commits/deletes. The module
fails closed outside Linux until a private ACL/locking adapter is available.
The current test-platform authority recognizes only `Platform=Unix`, which also
selects macOS. These storage tests require a canonical Linux-specific selection
handoff before macOS CI can accept them; they must not silently skip or broaden
the production platform guard. This is an unresolved test integration boundary.
The canonical live identity/site adapter, provider verifier adapters, interrupted
execution recovery adapter, dispatcher/HTTP registration, background health/drain
integration and exact-candidate CI must be supplied and independently verified
before activation. Rollback disables those integration registrations; it must
retain the private sealed store and run its cleanup/recovery obligations rather
than deleting unknown or still-owned files.
