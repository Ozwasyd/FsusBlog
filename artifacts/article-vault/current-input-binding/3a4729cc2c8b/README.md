# Current input binding source delivery

Source and executable observations bind commit `3a4729cc2c8bf6a01830049d7bbcb734ee16ce06`. The later delivery-only commit does not change the runtime sources or acquire new runtime qualification. This bundle records observations, not a second canonical ledger, acceptance gate or cleanup receipt.

- [Portable source/method/run/hash handoff](handoff.json)
- [Exact DI hunk for sole owner3735](current-draft-3a4729-di-owner3735.patch)
- [Full draft PR body for the authorized monitor](pull-request-body.md)
- [All16 issue statuses](current-draft-issue-status-3a4729.md)
- [Exact positive run TRX](current-draft-3a4729-positive.trx):8/8,0skip
- [Exact combined run TRX](current-draft-3a4729-focused.trx):89/89,0skip

The original task-limited PostgreSQL fixture created one owned container per run. Both raw event files record create/start/kill/die/destroy for their own run label. Both remaining-container observations are empty. Raw TRX and Docker outputs are copied byte-for-byte; `handoff.json` binds their SHA256 values. Absolute paths inside raw TRX identify the actual execution environment and are not cross-container prerequisites. Large build/discovery logs remain local; their observed exit/counts and source binding are recorded in the handoff, without promoting them to product acceptance.

Canonical cleanup is at `src/backend/Services/Articles/ArticleAssetReferenceStore.cs:25` in the source commit. Its public member belongs to an internal type and is callable in the original backend assembly. It requires the original caller's open SQL transaction, invokes original sorted asset advisory locks with seed1779, verifies all candidate owners/existence, then forwards to the original private scheduler. A singleton FileService caller uses its original scope factory for the scoped DB, rather than injecting a scoped DB into the singleton or reentering its held session lock through an observer.

Within the actual owned-upload authorization and existing transaction, the minimal single-asset call is:

```csharp
var ledger = new ArticleAssetReferenceStore(db, timeProvider);
await ledger.ScheduleUnreferencedOwnedAssetsAsync(
    actualOwnerAdminPrincipalId, [assetId], cancellationToken);
```

The call reacquires the same transaction-scoped asset lock. No second transaction, SQL scheduler, queue or native deletion is added. Original24h grace, one queue row per AssetId, all-reference absence and LEAST deadline remain intact. Only real queue/state observed after the original commit can establish recorded cleanup; a successful Task or SchedulingRequired cannot do so.

The coordinator's cleanup observer prefix327f is not an exact dependency identity. No observer commit was guessed or consumed. Original cancellation fix acceptance is pending. DI/transport stays with3735; original cleanup worker owns its actual session/transaction scheduling composition. Do not apply the DI patch from this branch without the coordinating owner's integration decision.

GitHub content writes remain paused: no new PR, comment, label, issue change or merge was performed. The supplied PR body is a draft for the authorized monitor. The entire branch includes earlier source/supplied ancestors since the planning master, so its full master diff and sibling evidence still require the later coordinated conflict/review phase.
