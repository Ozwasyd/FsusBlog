using System.Collections.Frozen;
using System.Collections.Immutable;

namespace FsusBlog.Server.Services.Articles.Bulk;

internal enum ArticleBulkExecutionState
{
    Planned,
    Admitted,
    Executing,
    Cancelling,
    Cancelled,
    Completed,
    Partial,
    Failed,
    Blocked,
    RecoveryRequired
}

internal enum ArticleBulkJournalEventKind
{
    Planned,
    Admitted,
    ExecutionStarted,
    ItemAdmitted,
    ItemStarted,
    ItemTerminal,
    CancelRequested,
    GroupCommitStarted,
    GroupCommitTerminal,
    ReceiptChunkRecorded,
    RetryRequested,
    ExecutionTerminal,
    RecoveryRequired
}

internal enum ArticleBulkItemStatus
{
    Admitted,
    Executing,
    Succeeded,
    Failed,
    Cancelled,
    RecoveryRequired
}

internal enum ArticleBulkGroupCommitOutcome
{
    Committed,
    RejectedZeroWrite,
    FailedZeroWrite,
    UnknownRecovery
}

internal sealed record ArticleBulkExecutionRequest(
    string AttemptId,
    string IdempotencyKey,
    string PlanReference,
    string PlanDigest,
    string RegistryDigest,
    string OperationId,
    ArticleBulkExecutionStrategy Strategy,
    string ParametersDigest,
    string FrozenSetDigest,
    ArticleBulkActor Actor,
    ArticleBulkSource Source,
    string PolicyDigest,
    string PermissionPolicyDigest,
    DateTimeOffset RequestedAtUtc,
    string ExecutionIdentityDigest,
    string ContentDigest);

internal sealed record ArticleBulkSideEffectReceipt(string Owner, string ReceiptDigest);

internal sealed record ArticleBulkItemReceipt(
    string AttemptId,
    string PlanDigest,
    string RegistryDigest,
    string OperationId,
    string ArticleId,
    string ExpectedRevision,
    string? ObservedRevision,
    string? NewRevision,
    ArticleBulkPlanItemStatus PreflightStatus,
    ArticleBulkItemStatus ExecutionStatus,
    string ReasonCode,
    string CanonicalCommandOwner,
    string CanonicalCommandReceiptDigest,
    ImmutableArray<ArticleBulkSideEffectReceipt> SideEffects,
    string RetryIdentityDigest,
    string ContentDigest);

internal sealed record ArticleBulkReceiptChunk(
    int Index,
    ImmutableArray<string> ItemReceiptDigests,
    string ContentDigest);

internal sealed record ArticleBulkAggregateReceipt(
    string AttemptId,
    string RequestDigest,
    string PlanDigest,
    string RegistryDigest,
    string OperationId,
    ArticleBulkExecutionStrategy Strategy,
    string FrozenSetDigest,
    int SelectedCount,
    int EligibleCount,
    int SucceededCount,
    int FailedCount,
    int CancelledCount,
    ArticleBulkExecutionState TerminalState,
    ArticleBulkGroupCommitOutcome? GroupCommitOutcome,
    string? GroupReceiptDigest,
    string? ZeroWriteProofDigest,
    bool Partial,
    bool RetryEligible,
    ImmutableArray<ArticleBulkReceiptChunk> ItemReceiptChunks,
    string ContentDigest);

internal sealed record ArticleBulkJournalEvent(
    string AttemptId,
    long Ordinal,
    ArticleBulkJournalEventKind Kind,
    ArticleBulkExecutionState ResultingState,
    DateTimeOffset AtUtc,
    string PreviousEventDigest,
    string? ArticleId,
    string? CanonicalCommandOwner,
    string? CanonicalCommandReceiptDigest,
    string? ItemReceiptDigest,
    int ReceiptCount,
    int SucceededDelta,
    int FailedDelta,
    int CancelledDelta,
    string? ReasonCode,
    ArticleBulkGroupCommitOutcome? GroupCommitOutcome,
    string? GroupReceiptDigest,
    string? ZeroWriteProofDigest,
    string? AggregateReceiptDigest,
    string? RetryRequestDigest,
    string ContentDigest);

internal sealed record ArticleBulkJournalHead(
    string AttemptId,
    string ExecutionIdentityDigest,
    ArticleBulkExecutionStrategy Strategy,
    ArticleBulkExecutionState State,
    long EventCount,
    string LastEventDigest,
    ImmutableArray<string> ActiveArticleIds,
    int AdmittedCount,
    int SucceededCount,
    int FailedCount,
    int CancelledCount,
    bool GroupCommitStarted,
    bool GroupCommitTerminal,
    string ContentDigest);

internal sealed record ArticleBulkJournalAppend(
    string ExpectedHeadDigest,
    ArticleBulkJournalEvent Event,
    ArticleBulkJournalHead NextHead,
    string? ArticleId,
    ArticleBulkItemStatus? ExpectedItemStatus,
    ArticleBulkItemStatus? NextItemStatus,
    ImmutableArray<ArticleBulkItemReceipt> ItemReceipts,
    ArticleBulkAggregateReceipt? AggregateReceipt);

internal sealed record ArticleBulkJournalAppendReceipt(
    string AttemptId,
    long Ordinal,
    string EventDigest,
    string HeadDigest,
    string AuthorityReceiptDigest);

internal enum ArticleBulkIdempotencyKind
{
    Missing,
    InProgress,
    Terminal,
    Conflict
}

internal sealed record ArticleBulkIdempotencyResolution(
    ArticleBulkIdempotencyKind Kind,
    ArticleBulkExecutionRequest? ExistingRequest,
    ArticleBulkJournalHead? Head,
    ArticleBulkAggregateReceipt? TerminalReceipt);

/// <summary>
/// The implementation must persist event, head, item CAS and receipts in one atomic commit.
/// It must reject stale heads and item overwrites and expose events in ordinal order.
/// </summary>
internal interface IArticleBulkJournalAuthority
{
    Task<ArticleBulkIdempotencyResolution> ResolveIdempotencyAsync(
        string idempotencyKey,
        string executionIdentityDigest,
        CancellationToken cancellationToken);

    Task<ArticleBulkJournalAppendReceipt> CreateAsync(
        string idempotencyKey,
        ArticleBulkExecutionRequest request,
        ArticleBulkJournalEvent firstEvent,
        ArticleBulkJournalHead firstHead,
        CancellationToken cancellationToken);

    Task<ArticleBulkJournalAppendReceipt> AppendAsync(
        ArticleBulkJournalAppend append,
        CancellationToken cancellationToken);

    IAsyncEnumerable<IReadOnlyList<ArticleBulkJournalEvent>> ReadEventBatchesAsync(
        string attemptId,
        int maximumBatchSize,
        CancellationToken cancellationToken);

    IAsyncEnumerable<ArticleBulkItemReceipt> ReadItemReceiptsAsync(
        string attemptId,
        CancellationToken cancellationToken);
}

internal sealed record ArticleBulkAdmission(
    ArticleBulkExecutionRequest Request,
    ArticleBulkJournalHead Head,
    ArticleBulkJournalAppendReceipt? AppendReceipt,
    ArticleBulkAggregateReceipt? ExistingTerminalReceipt,
    bool IsExisting);

internal sealed record ArticleBulkRetryRequest(
    string PreviousAttemptId,
    string NewAttemptId,
    string PlanDigest,
    ImmutableArray<(string ArticleId, string NewExpectedRevision)> FailedItems,
    string ContentDigest);

internal sealed record ArticleBulkRetryAdmission(
    ArticleBulkRetryRequest Request,
    ArticleBulkJournalHead Head,
    ArticleBulkJournalAppendReceipt AppendReceipt);

internal sealed class ArticleBulkExecutionFramework(
    ArticleBulkPlanAuthority planAuthority,
    IArticleBulkJournalAuthority journalAuthority,
    TimeProvider timeProvider)
{
    internal const int JournalReadBatchSize = 128;
    internal const int ReceiptChunkSize = 250;
    private const int MaximumActiveItems = 256;

    internal async Task<ArticleBulkAdmission> AdmitAsync(
        ArticleBulkPlan plan,
        string planReference,
        string attemptId,
        string idempotencyKey,
        ArticleBulkActor actor,
        ArticleBulkSource source,
        string policyDigest,
        string permissionPolicyDigest,
        CancellationToken cancellationToken = default)
    {
        if (!IsBoundedOpaqueValue(planReference, 1_024)
            || !IsBoundedOpaqueValue(attemptId, 256)
            || !IsBoundedOpaqueValue(idempotencyKey, 256))
        {
            throw new ArticleBulkContractException("article-bulk.execution-request-invalid");
        }
        planAuthority.ValidateForExecution(plan);
        if (actor != plan.Actor || source != plan.Source || policyDigest != plan.PolicyDigest
            || permissionPolicyDigest != plan.PermissionPolicyDigest)
        {
            throw new ArticleBulkContractException("article-bulk.execution-drift");
        }

        DateTimeOffset now = timeProvider.GetUtcNow().ToUniversalTime();
        var identity = new
        {
            plan.ContentDigest,
            plan.RegistryDigest,
            plan.OperationId,
            plan.Strategy,
            plan.ParametersDigest,
            plan.FrozenSetDigest,
            actor,
            source,
            policyDigest,
            permissionPolicyDigest
        };
        string identityDigest = ArticleBulkDigest.Of(identity);
        var unsignedRequest = new ArticleBulkExecutionRequest(
            attemptId,
            idempotencyKey,
            planReference,
            plan.ContentDigest,
            plan.RegistryDigest,
            plan.OperationId,
            plan.Strategy,
            plan.ParametersDigest,
            plan.FrozenSetDigest,
            actor,
            source,
            policyDigest,
            permissionPolicyDigest,
            now,
            identityDigest,
            string.Empty);
        ArticleBulkExecutionRequest request = unsignedRequest with
        {
            ContentDigest = ArticleBulkDigest.Of(unsignedRequest)
        };

        ArticleBulkIdempotencyResolution resolution = await journalAuthority
            .ResolveIdempotencyAsync(idempotencyKey, identityDigest, cancellationToken)
            .ConfigureAwait(false);
        if (resolution.Kind == ArticleBulkIdempotencyKind.Conflict)
        {
            throw new ArticleBulkContractException("article-bulk.idempotency-conflict");
        }
        if (resolution.Kind is ArticleBulkIdempotencyKind.InProgress or ArticleBulkIdempotencyKind.Terminal)
        {
            ArticleBulkExecutionRequest existingRequest = resolution.ExistingRequest
                ?? throw new ArticleBulkContractException("article-bulk.journal-corrupt");
            ArticleBulkJournalHead existing = resolution.Head
                ?? throw new ArticleBulkContractException("article-bulk.journal-corrupt");
            if (existingRequest.ContentDigest
                != ArticleBulkDigest.Of(existingRequest with { ContentDigest = string.Empty })
                || existingRequest.ExecutionIdentityDigest != identityDigest
                || existing.ExecutionIdentityDigest != identityDigest)
            {
                throw new ArticleBulkContractException("article-bulk.idempotency-tampered");
            }
            if (resolution.Kind == ArticleBulkIdempotencyKind.Terminal)
            {
                await VerifyExecutionAsync(existingRequest, plan, existing, cancellationToken).ConfigureAwait(false);
            }
            else
            {
                await VerifyJournalAsync(existing, cancellationToken).ConfigureAwait(false);
            }
            return new ArticleBulkAdmission(existingRequest, existing, null, resolution.TerminalReceipt, true);
        }

        // Freshness verification is intentionally after exact-idempotency resolution: an existing attempt
        // remains replayable, while a new executor cannot spawn from stale selection/preflight facts.
        await planAuthority.VerifyAsync(plan, cancellationToken).ConfigureAwait(false);

        const ArticleBulkExecutionState InitialState = ArticleBulkExecutionState.Planned;
        string? zeroWriteProofDigest = plan.Executable
            ? null
            : ArticleBulkDigest.Of(new { plan.ContentDigest, ZeroWrite = true });
        ArticleBulkJournalEvent firstEvent = SealEvent(new ArticleBulkJournalEvent(
            attemptId,
            0,
            ArticleBulkJournalEventKind.Planned,
            InitialState,
            now,
            string.Empty,
            null,
            null,
            null,
            null,
            0,
            0,
            0,
            0,
            plan.Executable ? "plan-executable" : "preflight-blocked-zero-write",
            null,
            null,
            zeroWriteProofDigest,
            null,
            null,
            string.Empty));
        ArticleBulkJournalHead head = SealHead(new ArticleBulkJournalHead(
            attemptId,
            identityDigest,
            plan.Strategy,
            InitialState,
            1,
            firstEvent.ContentDigest,
            [],
            0,
            0,
            0,
            0,
            false,
            false,
            string.Empty));
        ArticleBulkJournalAppendReceipt appendReceipt = await journalAuthority
            .CreateAsync(idempotencyKey, request, firstEvent, head, cancellationToken).ConfigureAwait(false);
        ValidateAppendReceipt(appendReceipt, firstEvent, head);
        ArticleBulkAggregateReceipt? immediateTerminalReceipt = null;
        if (!plan.Executable)
        {
            ArticleBulkAggregateReceipt blockedReceipt = SealAggregateReceipt(new ArticleBulkAggregateReceipt(
                attemptId,
                request.ContentDigest,
                plan.ContentDigest,
                plan.RegistryDigest,
                plan.OperationId,
                plan.Strategy,
                plan.FrozenSetDigest,
                plan.Impact.SelectedCount,
                0,
                0,
                0,
                0,
                ArticleBulkExecutionState.Blocked,
                plan.Strategy == ArticleBulkExecutionStrategy.AllOrNothing
                    ? ArticleBulkGroupCommitOutcome.RejectedZeroWrite
                    : null,
                null,
                zeroWriteProofDigest,
                false,
                false,
                [],
                string.Empty));
            (head, appendReceipt) = await AppendAsync(
                head,
                ArticleBulkJournalEventKind.ExecutionTerminal,
                ArticleBulkExecutionState.Blocked,
                reasonCode: "preflight-blocked",
                groupOutcome: blockedReceipt.GroupCommitOutcome,
                zeroWriteProofDigest: zeroWriteProofDigest,
                aggregateReceipt: blockedReceipt,
                cancellationToken: cancellationToken).ConfigureAwait(false);
            immediateTerminalReceipt = blockedReceipt;
        }
        return new ArticleBulkAdmission(request, head, appendReceipt, immediateTerminalReceipt, false);
    }

    internal async Task<(ArticleBulkJournalHead Head, ArticleBulkJournalAppendReceipt Receipt)> AppendAsync(
        ArticleBulkJournalHead current,
        ArticleBulkJournalEventKind kind,
        ArticleBulkExecutionState nextState,
        string? articleId = null,
        string? commandOwner = null,
        string? commandReceiptDigest = null,
        ArticleBulkItemReceipt? itemReceipt = null,
        IReadOnlyList<ArticleBulkItemReceipt>? receiptChunk = null,
        string? reasonCode = null,
        ArticleBulkGroupCommitOutcome? groupOutcome = null,
        string? groupReceiptDigest = null,
        string? zeroWriteProofDigest = null,
        ArticleBulkAggregateReceipt? aggregateReceipt = null,
        string? retryRequestDigest = null,
        ArticleBulkItemStatus? expectedItemStatus = null,
        ArticleBulkItemStatus? nextItemStatus = null,
        CancellationToken cancellationToken = default)
    {
        if (itemReceipt is not null && receiptChunk is not null)
        {
            throw new ArticleBulkContractException("article-bulk.receipt-chunk-invalid");
        }
        ImmutableArray<ArticleBulkItemReceipt> itemReceipts = itemReceipt is not null
            ? [itemReceipt]
            : receiptChunk is null ? [] : [.. receiptChunk];
        if (itemReceipts.Length > ReceiptChunkSize
            || itemReceipts.Select(static receipt => receipt.ArticleId).Distinct(StringComparer.Ordinal).Count()
                != itemReceipts.Length
            || itemReceipts.Any(receipt => receipt.AttemptId != current.AttemptId
                || receipt.ContentDigest != ArticleBulkDigest.Of(receipt with { ContentDigest = string.Empty })))
        {
            throw new ArticleBulkContractException("article-bulk.receipt-chunk-invalid");
        }
        ValidateItemAppendBinding(
            kind,
            articleId,
            commandOwner,
            commandReceiptDigest,
            itemReceipts,
            expectedItemStatus,
            nextItemStatus);
        ValidateTransition(current, kind, nextState, articleId, itemReceipts, groupOutcome, aggregateReceipt);
        ImmutableArray<string> active = NextActiveSet(current.ActiveArticleIds, kind, articleId);
        var unsignedEvent = new ArticleBulkJournalEvent(
            current.AttemptId,
            current.EventCount,
            kind,
            nextState,
            timeProvider.GetUtcNow(),
            current.LastEventDigest,
            articleId,
            commandOwner,
            commandReceiptDigest,
            itemReceipts.Length switch
            {
                0 => null,
                1 => itemReceipts[0].ContentDigest,
                _ => ArticleBulkDigest.Of(itemReceipts.Select(static receipt => receipt.ContentDigest).ToArray())
            },
            itemReceipts.Length,
            itemReceipts.Count(static receipt => receipt.ExecutionStatus == ArticleBulkItemStatus.Succeeded),
            itemReceipts.Count(static receipt => receipt.ExecutionStatus is ArticleBulkItemStatus.Failed
                or ArticleBulkItemStatus.RecoveryRequired),
            itemReceipts.Count(static receipt => receipt.ExecutionStatus == ArticleBulkItemStatus.Cancelled),
            reasonCode,
            groupOutcome,
            groupReceiptDigest,
            zeroWriteProofDigest,
            aggregateReceipt?.ContentDigest,
            retryRequestDigest,
            string.Empty);
        ArticleBulkJournalEvent journalEvent = SealEvent(unsignedEvent);
        ArticleBulkJournalHead nextHead = SealHead(current with
        {
            State = nextState,
            EventCount = current.EventCount + 1,
            LastEventDigest = journalEvent.ContentDigest,
            ActiveArticleIds = active,
            AdmittedCount = current.AdmittedCount + (kind == ArticleBulkJournalEventKind.ItemAdmitted ? 1 : 0),
            SucceededCount = current.SucceededCount + itemReceipts.Count(
                static receipt => receipt.ExecutionStatus == ArticleBulkItemStatus.Succeeded),
            FailedCount = current.FailedCount + itemReceipts.Count(
                static receipt => receipt.ExecutionStatus is ArticleBulkItemStatus.Failed
                    or ArticleBulkItemStatus.RecoveryRequired),
            CancelledCount = current.CancelledCount + itemReceipts.Count(
                static receipt => receipt.ExecutionStatus == ArticleBulkItemStatus.Cancelled),
            GroupCommitStarted = current.GroupCommitStarted || kind == ArticleBulkJournalEventKind.GroupCommitStarted,
            GroupCommitTerminal = current.GroupCommitTerminal || kind == ArticleBulkJournalEventKind.GroupCommitTerminal,
            ContentDigest = string.Empty
        });
        var append = new ArticleBulkJournalAppend(
            current.ContentDigest,
            journalEvent,
            nextHead,
            articleId,
            expectedItemStatus,
            nextItemStatus,
            itemReceipts,
            aggregateReceipt);
        ArticleBulkJournalAppendReceipt receipt = await journalAuthority.AppendAsync(append, cancellationToken)
            .ConfigureAwait(false);
        ValidateAppendReceipt(receipt, journalEvent, nextHead);
        return (nextHead, receipt);
    }

    internal async Task<ArticleBulkJournalHead> VerifyJournalAsync(
        ArticleBulkJournalHead sealedHead,
        CancellationToken cancellationToken = default)
    {
        if (sealedHead.ContentDigest != ArticleBulkDigest.Of(sealedHead with { ContentDigest = string.Empty }))
        {
            throw new ArticleBulkContractException("article-bulk.journal-head-tampered");
        }
        long ordinal = 0;
        string previousDigest = string.Empty;
        ArticleBulkJournalHead? replay = null;
        await foreach (IReadOnlyList<ArticleBulkJournalEvent> batch in journalAuthority
            .ReadEventBatchesAsync(sealedHead.AttemptId, JournalReadBatchSize, cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (batch.Count is 0 or > JournalReadBatchSize)
            {
                throw new ArticleBulkContractException("article-bulk.journal-batch-invalid");
            }
            foreach (ArticleBulkJournalEvent journalEvent in batch)
            {
                if (journalEvent.Ordinal != ordinal || journalEvent.PreviousEventDigest != previousDigest
                    || journalEvent.ContentDigest != ArticleBulkDigest.Of(journalEvent with { ContentDigest = string.Empty }))
                {
                    throw new ArticleBulkContractException("article-bulk.journal-tampered");
                }
                bool receiptDeltaValid = journalEvent.ReceiptCount >= 0
                    && journalEvent.ReceiptCount <= ReceiptChunkSize
                    && journalEvent.SucceededDelta >= 0 && journalEvent.FailedDelta >= 0
                    && journalEvent.CancelledDelta >= 0
                    && journalEvent.SucceededDelta + journalEvent.FailedDelta + journalEvent.CancelledDelta
                        == journalEvent.ReceiptCount;
                if (!receiptDeltaValid)
                {
                    throw new ArticleBulkContractException("article-bulk.journal-receipt-delta-tampered");
                }
                if (ordinal == 0)
                {
                    if (journalEvent.Kind != ArticleBulkJournalEventKind.Planned
                        || journalEvent.ResultingState != ArticleBulkExecutionState.Planned)
                    {
                        throw new ArticleBulkContractException("article-bulk.journal-transition-tampered");
                    }
                    replay = sealedHead with
                    {
                        State = journalEvent.ResultingState,
                        EventCount = 1,
                        LastEventDigest = journalEvent.ContentDigest,
                        ActiveArticleIds = [],
                        AdmittedCount = 0,
                        SucceededCount = 0,
                        FailedCount = 0,
                        CancelledCount = 0,
                        GroupCommitStarted = false,
                        GroupCommitTerminal = false,
                        ContentDigest = string.Empty
                    };
                }
                else
                {
                    ReplayTransition(replay!, journalEvent);
                    replay = AdvanceReplay(replay!, journalEvent);
                }
                previousDigest = journalEvent.ContentDigest;
                ordinal++;
            }
        }
        if (ordinal != sealedHead.EventCount || previousDigest != sealedHead.LastEventDigest)
        {
            throw new ArticleBulkContractException("article-bulk.journal-incomplete");
        }
        if (replay is null || replay.State != sealedHead.State
            || !replay.ActiveArticleIds.SequenceEqual(sealedHead.ActiveArticleIds)
            || replay.AdmittedCount != sealedHead.AdmittedCount
            || replay.SucceededCount != sealedHead.SucceededCount
            || replay.FailedCount != sealedHead.FailedCount
            || replay.CancelledCount != sealedHead.CancelledCount
            || replay.GroupCommitStarted != sealedHead.GroupCommitStarted
            || replay.GroupCommitTerminal != sealedHead.GroupCommitTerminal)
        {
            throw new ArticleBulkContractException("article-bulk.journal-head-mismatch");
        }
        return sealedHead;
    }

    internal async Task VerifyExecutionAsync(
        ArticleBulkExecutionRequest request,
        ArticleBulkPlan plan,
        ArticleBulkJournalHead sealedHead,
        CancellationToken cancellationToken = default)
    {
        if (request.ContentDigest != ArticleBulkDigest.Of(request with { ContentDigest = string.Empty })
            || request.ExecutionIdentityDigest != sealedHead.ExecutionIdentityDigest
            || request.PlanDigest != plan.ContentDigest
            || request.RegistryDigest != plan.RegistryDigest
            || request.OperationId != plan.OperationId
            || request.Strategy != plan.Strategy
            || request.ParametersDigest != plan.ParametersDigest
            || request.FrozenSetDigest != plan.FrozenSetDigest)
        {
            throw new ArticleBulkContractException("article-bulk.execution-request-tampered");
        }
        await VerifyJournalAsync(sealedHead, cancellationToken).ConfigureAwait(false);

        ArticleBulkIdempotencyResolution resolution = await journalAuthority.ResolveIdempotencyAsync(
            request.IdempotencyKey,
            request.ExecutionIdentityDigest,
            cancellationToken).ConfigureAwait(false);
        if (resolution.Kind != ArticleBulkIdempotencyKind.Terminal
            || resolution.ExistingRequest?.ContentDigest != request.ContentDigest
            || resolution.Head?.ContentDigest != sealedHead.ContentDigest)
        {
            throw new ArticleBulkContractException("article-bulk.terminal-receipt-unbound");
        }
        ArticleBulkAggregateReceipt aggregate = resolution.TerminalReceipt
            ?? throw new ArticleBulkContractException("article-bulk.terminal-receipt-unbound");
        ValidateAggregateReceipt(aggregate, request, plan);

        var itemDigests = new HashSet<string>(StringComparer.Ordinal);
        var itemArticleIds = new HashSet<string>(StringComparer.Ordinal);
        FrozenDictionary<string, ArticleBulkPlanItem> eligiblePlanItems = plan.Items
            .Where(static item => item.Status == ArticleBulkPlanItemStatus.Eligible)
            .ToFrozenDictionary(static item => item.ArticleId, StringComparer.Ordinal);
        int succeeded = 0;
        int failed = 0;
        int cancelled = 0;
        await foreach (ArticleBulkItemReceipt receipt in journalAuthority
            .ReadItemReceiptsAsync(sealedHead.AttemptId, cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (receipt.ContentDigest != ArticleBulkDigest.Of(receipt with { ContentDigest = string.Empty })
                || receipt.AttemptId != sealedHead.AttemptId
                || receipt.PlanDigest != plan.ContentDigest
                || receipt.RegistryDigest != plan.RegistryDigest
                || receipt.OperationId != plan.OperationId
                || !eligiblePlanItems.TryGetValue(receipt.ArticleId, out ArticleBulkPlanItem? planItem)
                || receipt.ExpectedRevision != planItem.ExpectedRevision
                || !itemDigests.Add(receipt.ContentDigest)
                || !itemArticleIds.Add(receipt.ArticleId))
            {
                throw new ArticleBulkContractException("article-bulk.item-receipt-tampered");
            }
            succeeded += receipt.ExecutionStatus == ArticleBulkItemStatus.Succeeded ? 1 : 0;
            failed += receipt.ExecutionStatus is ArticleBulkItemStatus.Failed
                or ArticleBulkItemStatus.RecoveryRequired ? 1 : 0;
            cancelled += receipt.ExecutionStatus == ArticleBulkItemStatus.Cancelled ? 1 : 0;
        }

        string[] aggregateDigests =
        [
            .. aggregate.ItemReceiptChunks
                .OrderBy(static chunk => chunk.Index)
                .SelectMany(static chunk => chunk.ItemReceiptDigests)
        ];
        if (aggregateDigests.Length != itemDigests.Count
            || aggregateDigests.Distinct(StringComparer.Ordinal).Count() != aggregateDigests.Length
            || aggregateDigests.Any(digest => !itemDigests.Contains(digest))
            || aggregate.SelectedCount != plan.Impact.SelectedCount
            || aggregate.EligibleCount != itemArticleIds.Count
            || (aggregate.TerminalState == ArticleBulkExecutionState.Blocked
                ? aggregate.EligibleCount != 0
                : aggregate.EligibleCount != plan.Impact.EligibleCount)
            || aggregate.SucceededCount != succeeded || aggregate.FailedCount != failed
            || aggregate.CancelledCount != cancelled
            || aggregate.SucceededCount != sealedHead.SucceededCount
            || aggregate.FailedCount != sealedHead.FailedCount
            || aggregate.CancelledCount != sealedHead.CancelledCount
            || (plan.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
                && (sealedHead.AdmittedCount > itemArticleIds.Count
                    || sealedHead.AdmittedCount < succeeded + failed))
            || aggregate.TerminalState != sealedHead.State
            || aggregate.SucceededCount + aggregate.FailedCount + aggregate.CancelledCount
                != aggregate.EligibleCount)
        {
            throw new ArticleBulkContractException("article-bulk.aggregate-receipt-inexact");
        }
        ValidateStrategyOutcome(aggregate);
    }

    internal async Task<ArticleBulkJournalHead> ResumeAsync(
        ArticleBulkExecutionRequest request,
        ArticleBulkPlan plan,
        ArticleBulkJournalHead sealedHead,
        CancellationToken cancellationToken = default)
    {
        if (request.ContentDigest != ArticleBulkDigest.Of(request with { ContentDigest = string.Empty })
            || request.PlanDigest != plan.ContentDigest
            || request.RegistryDigest != plan.RegistryDigest
            || request.FrozenSetDigest != plan.FrozenSetDigest
            || request.ExecutionIdentityDigest != sealedHead.ExecutionIdentityDigest)
        {
            throw new ArticleBulkContractException("article-bulk.resume-checkpoint-tampered");
        }
        await VerifyJournalAsync(sealedHead, cancellationToken).ConfigureAwait(false);
        ArticleBulkIdempotencyResolution resolution = await journalAuthority.ResolveIdempotencyAsync(
            request.IdempotencyKey,
            request.ExecutionIdentityDigest,
            cancellationToken).ConfigureAwait(false);
        if (resolution.ExistingRequest?.ContentDigest != request.ContentDigest
            || resolution.Head?.ContentDigest != sealedHead.ContentDigest)
        {
            throw new ArticleBulkContractException("article-bulk.resume-checkpoint-unbound");
        }
        if (resolution.Kind == ArticleBulkIdempotencyKind.Terminal)
        {
            await VerifyExecutionAsync(request, plan, sealedHead, cancellationToken).ConfigureAwait(false);
            return sealedHead;
        }
        if (resolution.Kind != ArticleBulkIdempotencyKind.InProgress)
        {
            throw new ArticleBulkContractException("article-bulk.resume-attempt-missing");
        }
        bool activeOutcomeUnknown = sealedHead.ActiveArticleIds.Length > 0;
        bool groupOutcomeUnknown = sealedHead.GroupCommitStarted && !sealedHead.GroupCommitTerminal;
        bool cancellationPending = sealedHead.State == ArticleBulkExecutionState.Cancelling
            && !sealedHead.GroupCommitStarted;
        if (!activeOutcomeUnknown && !groupOutcomeUnknown && !cancellationPending)
        {
            return sealedHead;
        }

        ArticleBulkJournalHead recoveryHead = sealedHead;
        ArticleBulkOperation operation = ArticleBulkOperationRegistry.Get(plan.OperationId);
        if (plan.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated)
        {
            foreach (string articleId in sealedHead.ActiveArticleIds)
            {
                ArticleBulkPlanItem item = plan.Items.Single(planItem => planItem.ArticleId == articleId);
                ArticleBulkItemReceipt recoveryReceipt = SealItemReceipt(new ArticleBulkItemReceipt(
                    sealedHead.AttemptId,
                    plan.ContentDigest,
                    plan.RegistryDigest,
                    plan.OperationId,
                    articleId,
                    item.ExpectedRevision!,
                    null,
                    null,
                    ArticleBulkPlanItemStatus.Eligible,
                    ArticleBulkItemStatus.RecoveryRequired,
                    "active-command-outcome-unknown",
                    operation.CommandOwner,
                    ArticleBulkDigest.Of(new { articleId, Outcome = "unknown" }),
                    [],
                    ArticleBulkDigest.Of(new { plan.ContentDigest, articleId, Retry = true }),
                    string.Empty));
                (recoveryHead, _) = await AppendAsync(
                    recoveryHead,
                    ArticleBulkJournalEventKind.ItemTerminal,
                    recoveryHead.State,
                    articleId: articleId,
                    commandOwner: operation.CommandOwner,
                    commandReceiptDigest: recoveryReceipt.CanonicalCommandReceiptDigest,
                    itemReceipt: recoveryReceipt,
                    reasonCode: "recovery-required",
                    expectedItemStatus: ArticleBulkItemStatus.Executing,
                    nextItemStatus: ArticleBulkItemStatus.RecoveryRequired,
                    cancellationToken: cancellationToken).ConfigureAwait(false);
            }
        }
        else if (groupOutcomeUnknown)
        {
            (recoveryHead, _) = await AppendAsync(
                recoveryHead,
                ArticleBulkJournalEventKind.GroupCommitTerminal,
                recoveryHead.State,
                groupOutcome: ArticleBulkGroupCommitOutcome.UnknownRecovery,
                reasonCode: "group-command-outcome-unknown",
                cancellationToken: cancellationToken).ConfigureAwait(false);
        }

        ImmutableArray<ArticleBulkItemReceipt> existingReceipts = await ReadReceiptsAsync(
            recoveryHead.AttemptId,
            cancellationToken).ConfigureAwait(false);
        var existingArticleIds = existingReceipts
            .Select(static receipt => receipt.ArticleId)
            .ToHashSet(StringComparer.Ordinal);
        ArticleBulkItemStatus missingStatus = groupOutcomeUnknown
            ? ArticleBulkItemStatus.RecoveryRequired
            : ArticleBulkItemStatus.Cancelled;
        string missingReason = groupOutcomeUnknown
            ? "group-command-outcome-unknown"
            : "not-admitted-before-attempt-stop";
        ArticleBulkItemReceipt[] missingReceipts =
        [
            .. plan.Items
                .Where(item => item.Status == ArticleBulkPlanItemStatus.Eligible
                    && !existingArticleIds.Contains(item.ArticleId))
                .Select(item => CreateDecisionReceipt(
                    request,
                    plan,
                    operation,
                    item,
                    missingStatus,
                    missingReason))
        ];
        for (int offset = 0; offset < missingReceipts.Length; offset += ReceiptChunkSize)
        {
            (recoveryHead, _) = await AppendAsync(
                recoveryHead,
                ArticleBulkJournalEventKind.ReceiptChunkRecorded,
                recoveryHead.State,
                receiptChunk: missingReceipts.Skip(offset).Take(ReceiptChunkSize).ToArray(),
                reasonCode: missingReason,
                cancellationToken: cancellationToken).ConfigureAwait(false);
        }

        ArticleBulkExecutionState terminalState = activeOutcomeUnknown || groupOutcomeUnknown
            ? ArticleBulkExecutionState.RecoveryRequired
            : ArticleBulkExecutionState.Cancelled;
        if (terminalState == ArticleBulkExecutionState.RecoveryRequired)
        {
            (recoveryHead, _) = await AppendAsync(
                recoveryHead,
                ArticleBulkJournalEventKind.RecoveryRequired,
                ArticleBulkExecutionState.RecoveryRequired,
                reasonCode: "canonical-command-outcome-required",
                cancellationToken: cancellationToken).ConfigureAwait(false);
        }

        ImmutableArray<ArticleBulkItemReceipt> receipts = await ReadReceiptsAsync(
            recoveryHead.AttemptId,
            cancellationToken).ConfigureAwait(false);
        ImmutableArray<ArticleBulkReceiptChunk> chunks = ChunkReceiptDigests(receipts);
        string? cancelZeroWriteProof = terminalState == ArticleBulkExecutionState.Cancelled
            && plan.Strategy == ArticleBulkExecutionStrategy.AllOrNothing
            ? ArticleBulkDigest.Of(new { plan.ContentDigest, CancelledBeforeCommit = true })
            : null;
        ArticleBulkAggregateReceipt aggregate = SealAggregateReceipt(new ArticleBulkAggregateReceipt(
            recoveryHead.AttemptId,
            request.ContentDigest,
            plan.ContentDigest,
            plan.RegistryDigest,
            plan.OperationId,
            plan.Strategy,
            plan.FrozenSetDigest,
            plan.Impact.SelectedCount,
            receipts.Length,
            receipts.Count(static receipt => receipt.ExecutionStatus == ArticleBulkItemStatus.Succeeded),
            receipts.Count(static receipt => receipt.ExecutionStatus is ArticleBulkItemStatus.Failed
                or ArticleBulkItemStatus.RecoveryRequired),
            receipts.Count(static receipt => receipt.ExecutionStatus == ArticleBulkItemStatus.Cancelled),
            terminalState,
            plan.Strategy == ArticleBulkExecutionStrategy.AllOrNothing
                ? groupOutcomeUnknown
                    ? ArticleBulkGroupCommitOutcome.UnknownRecovery
                    : ArticleBulkGroupCommitOutcome.RejectedZeroWrite
                : null,
            null,
            cancelZeroWriteProof,
            receipts.Any(static receipt => receipt.ExecutionStatus == ArticleBulkItemStatus.Succeeded)
                && receipts.Any(static receipt => receipt.ExecutionStatus is not ArticleBulkItemStatus.Succeeded),
            plan.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
                && receipts.Any(static receipt => receipt.ExecutionStatus is ArticleBulkItemStatus.Failed
                    or ArticleBulkItemStatus.RecoveryRequired),
            chunks,
            string.Empty));
        (recoveryHead, _) = await AppendAsync(
            recoveryHead,
            ArticleBulkJournalEventKind.ExecutionTerminal,
            terminalState,
            groupOutcome: aggregate.GroupCommitOutcome,
            zeroWriteProofDigest: cancelZeroWriteProof,
            aggregateReceipt: aggregate,
            reasonCode: terminalState == ArticleBulkExecutionState.RecoveryRequired
                ? "recovery-required"
                : "cancelled-before-commit",
            cancellationToken: cancellationToken).ConfigureAwait(false);
        return recoveryHead;
    }

    internal async Task<ArticleBulkRetryAdmission> CreateRetryAsync(
        ArticleBulkExecutionRequest request,
        ArticleBulkPlan plan,
        ArticleBulkJournalHead terminalHead,
        string newAttemptId,
        IReadOnlyDictionary<string, string> newExpectedRevisions,
        CancellationToken cancellationToken = default)
    {
        if (plan.Strategy != ArticleBulkExecutionStrategy.PerItemIsolated
            || terminalHead.State is not (ArticleBulkExecutionState.Partial
                or ArticleBulkExecutionState.Failed
                or ArticleBulkExecutionState.RecoveryRequired))
        {
            throw new ArticleBulkContractException("article-bulk.retry-not-eligible");
        }
        await VerifyExecutionAsync(request, plan, terminalHead, cancellationToken).ConfigureAwait(false);
        var failed = ImmutableArray.CreateBuilder<(string, string)>();
        await foreach (ArticleBulkItemReceipt receipt in journalAuthority
            .ReadItemReceiptsAsync(terminalHead.AttemptId, cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (receipt.ExecutionStatus is not (ArticleBulkItemStatus.Failed or ArticleBulkItemStatus.RecoveryRequired))
            {
                continue;
            }
            if (!newExpectedRevisions.TryGetValue(receipt.ArticleId, out string? newRevision)
                || string.IsNullOrWhiteSpace(newRevision))
            {
                throw new ArticleBulkContractException("article-bulk.retry-revision-required");
            }
            failed.Add((receipt.ArticleId, newRevision));
        }
        if (failed.Count == 0 || failed.Count != newExpectedRevisions.Count)
        {
            throw new ArticleBulkContractException("article-bulk.retry-set-expanded");
        }
        var unsigned = new ArticleBulkRetryRequest(
            terminalHead.AttemptId,
            newAttemptId,
            plan.ContentDigest,
            failed.ToImmutable(),
            string.Empty);
        ArticleBulkRetryRequest retryRequest = unsigned with { ContentDigest = ArticleBulkDigest.Of(unsigned) };
        (ArticleBulkJournalHead retryHead, ArticleBulkJournalAppendReceipt appendReceipt) = await AppendAsync(
            terminalHead,
            ArticleBulkJournalEventKind.RetryRequested,
            terminalHead.State,
            retryRequestDigest: retryRequest.ContentDigest,
            reasonCode: "failed-items-explicit-revision",
            cancellationToken: cancellationToken).ConfigureAwait(false);
        return new ArticleBulkRetryAdmission(retryRequest, retryHead, appendReceipt);
    }

    internal static ArticleBulkItemReceipt SealItemReceipt(ArticleBulkItemReceipt receipt)
    {
        ArticleBulkOperation operation = ArticleBulkOperationRegistry.Get(receipt.OperationId);
        string[] sideEffectOwners = [.. receipt.SideEffects.Select(static sideEffect => sideEffect.Owner)
            .Order(StringComparer.Ordinal)];
        bool sideEffectsValid = receipt.ExecutionStatus == ArticleBulkItemStatus.Succeeded
            ? sideEffectOwners.SequenceEqual(operation.SideEffectOwners)
            : sideEffectOwners.All(owner => operation.SideEffectOwners.Contains(owner, StringComparer.Ordinal));
        if (operation.CommandOwner != receipt.CanonicalCommandOwner
            || string.IsNullOrWhiteSpace(receipt.ArticleId)
            || string.IsNullOrWhiteSpace(receipt.ExpectedRevision)
            || receipt.PreflightStatus != ArticleBulkPlanItemStatus.Eligible
            || receipt.ExecutionStatus is not (ArticleBulkItemStatus.Succeeded
                or ArticleBulkItemStatus.Failed
                or ArticleBulkItemStatus.Cancelled
                or ArticleBulkItemStatus.RecoveryRequired)
            || !IsContentDigest(receipt.CanonicalCommandReceiptDigest)
            || !IsContentDigest(receipt.RetryIdentityDigest)
            || !sideEffectsValid
            || receipt.SideEffects.Any(static sideEffect => !IsContentDigest(sideEffect.ReceiptDigest))
            || receipt.ExecutionStatus == ArticleBulkItemStatus.Succeeded
                && operation.MutatesBusinessState == string.IsNullOrWhiteSpace(receipt.NewRevision)
            || receipt.ExecutionStatus != ArticleBulkItemStatus.Succeeded && receipt.NewRevision is not null)
        {
            throw new ArticleBulkContractException("article-bulk.item-receipt-invalid");
        }
        return receipt with { ContentDigest = ArticleBulkDigest.Of(receipt with { ContentDigest = string.Empty }) };
    }

    internal static ArticleBulkAggregateReceipt SealAggregateReceipt(ArticleBulkAggregateReceipt receipt)
    {
        if (receipt.ItemReceiptChunks.Length > 40
            || receipt.ItemReceiptChunks.Select(static chunk => chunk.Index)
                .SequenceEqual(Enumerable.Range(0, receipt.ItemReceiptChunks.Length)) is false
            || receipt.ItemReceiptChunks.Any(static chunk => chunk.ItemReceiptDigests.Length is 0 or > ReceiptChunkSize
                || chunk.ContentDigest != ArticleBulkDigest.Of(chunk with { ContentDigest = string.Empty }))
            || receipt.SelectedCount is < 0 or > 10_000
            || receipt.EligibleCount is < 0 or > 10_000
            || receipt.EligibleCount > receipt.SelectedCount
            || receipt.SucceededCount < 0 || receipt.FailedCount < 0 || receipt.CancelledCount < 0
            || !IsContentDigest(receipt.RequestDigest)
            || !IsContentDigest(receipt.PlanDigest)
            || !IsContentDigest(receipt.RegistryDigest)
            || !IsContentDigest(receipt.FrozenSetDigest)
            || receipt.GroupReceiptDigest is not null && !IsContentDigest(receipt.GroupReceiptDigest)
            || receipt.ZeroWriteProofDigest is not null && !IsContentDigest(receipt.ZeroWriteProofDigest)
            || receipt.ItemReceiptChunks.Any(static chunk =>
                chunk.ItemReceiptDigests.Any(static digest => !IsContentDigest(digest)))
            || receipt.SucceededCount + receipt.FailedCount + receipt.CancelledCount != receipt.EligibleCount)
        {
            throw new ArticleBulkContractException("article-bulk.aggregate-unbounded");
        }
        ValidateStrategyOutcome(receipt);
        return receipt with { ContentDigest = ArticleBulkDigest.Of(receipt with { ContentDigest = string.Empty }) };
    }

    private static ArticleBulkItemReceipt CreateDecisionReceipt(
        ArticleBulkExecutionRequest request,
        ArticleBulkPlan plan,
        ArticleBulkOperation operation,
        ArticleBulkPlanItem item,
        ArticleBulkItemStatus status,
        string reasonCode)
    {
        if (status is not (ArticleBulkItemStatus.Cancelled or ArticleBulkItemStatus.RecoveryRequired))
        {
            throw new ArticleBulkContractException("article-bulk.decision-receipt-status-invalid");
        }
        return SealItemReceipt(new ArticleBulkItemReceipt(
            request.AttemptId,
            plan.ContentDigest,
            plan.RegistryDigest,
            plan.OperationId,
            item.ArticleId,
            item.ExpectedRevision!,
            null,
            null,
            ArticleBulkPlanItemStatus.Eligible,
            status,
            reasonCode,
            operation.CommandOwner,
            ArticleBulkDigest.Of(new
            {
                request.AttemptId,
                plan.ContentDigest,
                item.ArticleId,
                Status = status,
                NoCanonicalCommandWasAdmitted = true
            }),
            [],
            ArticleBulkDigest.Of(new { plan.ContentDigest, item.ArticleId, Retry = status == ArticleBulkItemStatus.RecoveryRequired }),
            string.Empty));
    }

    private async Task<ImmutableArray<ArticleBulkItemReceipt>> ReadReceiptsAsync(
        string attemptId,
        CancellationToken cancellationToken)
    {
        var receipts = ImmutableArray.CreateBuilder<ArticleBulkItemReceipt>();
        await foreach (ArticleBulkItemReceipt receipt in journalAuthority
            .ReadItemReceiptsAsync(attemptId, cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (receipts.Count == 10_000)
            {
                throw new ArticleBulkContractException("article-bulk.receipts-unbounded");
            }
            receipts.Add(receipt);
        }
        return receipts.ToImmutable();
    }

    private static ImmutableArray<ArticleBulkReceiptChunk> ChunkReceiptDigests(
        ImmutableArray<ArticleBulkItemReceipt> receipts)
    {
        var chunks = ImmutableArray.CreateBuilder<ArticleBulkReceiptChunk>();
        for (int offset = 0; offset < receipts.Length; offset += ReceiptChunkSize)
        {
            ImmutableArray<string> digests = receipts
                .Skip(offset)
                .Take(ReceiptChunkSize)
                .Select(static receipt => receipt.ContentDigest)
                .ToImmutableArray();
            var chunk = new ArticleBulkReceiptChunk(chunks.Count, digests, string.Empty);
            chunks.Add(chunk with { ContentDigest = ArticleBulkDigest.Of(chunk) });
        }
        return chunks.ToImmutable();
    }

    private static void ValidateAggregateReceipt(
        ArticleBulkAggregateReceipt receipt,
        ArticleBulkExecutionRequest request,
        ArticleBulkPlan plan)
    {
        if (receipt is null || receipt.ContentDigest
            != ArticleBulkDigest.Of(receipt with { ContentDigest = string.Empty })
            || receipt.AttemptId != request.AttemptId || receipt.RequestDigest != request.ContentDigest
            || receipt.PlanDigest != plan.ContentDigest || receipt.RegistryDigest != plan.RegistryDigest
            || receipt.OperationId != plan.OperationId || receipt.Strategy != plan.Strategy
            || receipt.FrozenSetDigest != plan.FrozenSetDigest)
        {
            throw new ArticleBulkContractException("article-bulk.terminal-receipt-tampered");
        }
    }

    private static void ValidateStrategyOutcome(ArticleBulkAggregateReceipt receipt)
    {
        bool valid = receipt.Strategy switch
        {
            ArticleBulkExecutionStrategy.PerItemIsolated => receipt.GroupCommitOutcome is null
                && receipt.GroupReceiptDigest is null
                && (receipt.TerminalState == ArticleBulkExecutionState.Blocked
                    ? receipt.ZeroWriteProofDigest is not null && receipt.EligibleCount == 0
                    : receipt.ZeroWriteProofDigest is null
                        && receipt.Partial == (receipt.SucceededCount > 0
                            && receipt.FailedCount + receipt.CancelledCount > 0)
                        && receipt.RetryEligible == (receipt.FailedCount > 0)
                        && receipt.TerminalState switch
                        {
                            ArticleBulkExecutionState.Completed => receipt.SucceededCount == receipt.EligibleCount,
                            ArticleBulkExecutionState.Partial => receipt.SucceededCount > 0
                                && receipt.FailedCount + receipt.CancelledCount > 0,
                            ArticleBulkExecutionState.Failed => receipt.SucceededCount == 0
                                && receipt.FailedCount > 0,
                            ArticleBulkExecutionState.Cancelled => receipt.SucceededCount == 0
                                && receipt.FailedCount == 0 && receipt.CancelledCount > 0,
                            ArticleBulkExecutionState.RecoveryRequired => receipt.FailedCount > 0,
                            _ => false
                        }),
            ArticleBulkExecutionStrategy.AllOrNothing => !receipt.Partial && !receipt.RetryEligible
                && receipt.GroupCommitOutcome is not null
                && (receipt.GroupCommitOutcome == ArticleBulkGroupCommitOutcome.UnknownRecovery
                    ? receipt.TerminalState == ArticleBulkExecutionState.RecoveryRequired
                        && receipt.SucceededCount == 0 && receipt.FailedCount == receipt.EligibleCount
                        && receipt.CancelledCount == 0
                        && receipt.GroupReceiptDigest is null && receipt.ZeroWriteProofDigest is null
                    : receipt.GroupCommitOutcome == ArticleBulkGroupCommitOutcome.Committed
                    ? receipt.TerminalState == ArticleBulkExecutionState.Completed
                        && receipt.SucceededCount == receipt.EligibleCount
                        && receipt.GroupReceiptDigest is not null && receipt.ZeroWriteProofDigest is null
                    : (receipt.TerminalState is ArticleBulkExecutionState.Failed
                        or ArticleBulkExecutionState.Cancelled or ArticleBulkExecutionState.Blocked)
                        && receipt.SucceededCount == 0 && receipt.GroupReceiptDigest is null
                        && receipt.ZeroWriteProofDigest is not null),
            _ => false
        };
        if (!valid)
        {
            throw new ArticleBulkContractException("article-bulk.aggregate-strategy-invalid");
        }
    }

    private static void ValidateTransition(
        ArticleBulkJournalHead current,
        ArticleBulkJournalEventKind kind,
        ArticleBulkExecutionState next,
        string? articleId,
        IReadOnlyList<ArticleBulkItemReceipt> itemReceipts,
        ArticleBulkGroupCommitOutcome? groupOutcome,
        ArticleBulkAggregateReceipt? aggregateReceipt)
    {
        if (kind == ArticleBulkJournalEventKind.CancelRequested
            && current.Strategy == ArticleBulkExecutionStrategy.AllOrNothing
            && current.GroupCommitStarted)
        {
            throw new ArticleBulkContractException("article-bulk.cancel-too-late");
        }

        bool hasNoActiveItems = current.ActiveArticleIds.Length == 0;
        bool terminalStrategyValid = current.Strategy switch
        {
            ArticleBulkExecutionStrategy.PerItemIsolated =>
                current.State == ArticleBulkExecutionState.Planned && next == ArticleBulkExecutionState.Blocked
                || (current.State is ArticleBulkExecutionState.Executing or ArticleBulkExecutionState.Cancelling)
                    && (next is ArticleBulkExecutionState.Completed or ArticleBulkExecutionState.Partial
                        or ArticleBulkExecutionState.Failed or ArticleBulkExecutionState.Cancelled)
                || current.State == ArticleBulkExecutionState.RecoveryRequired
                    && next == ArticleBulkExecutionState.RecoveryRequired,
            ArticleBulkExecutionStrategy.AllOrNothing =>
                current.State == ArticleBulkExecutionState.Planned && next == ArticleBulkExecutionState.Blocked
                || current.State == ArticleBulkExecutionState.Cancelling
                    && next == ArticleBulkExecutionState.Cancelled && !current.GroupCommitStarted
                || current.State == ArticleBulkExecutionState.Executing
                    && (next is ArticleBulkExecutionState.Completed or ArticleBulkExecutionState.Failed)
                    && current.GroupCommitTerminal
                || current.State == ArticleBulkExecutionState.RecoveryRequired
                    && next == ArticleBulkExecutionState.RecoveryRequired,
            _ => false
        };
        bool legal = kind switch
        {
            ArticleBulkJournalEventKind.Admitted => current.State == ArticleBulkExecutionState.Planned
                && next == ArticleBulkExecutionState.Admitted,
            ArticleBulkJournalEventKind.ExecutionStarted => current.State == ArticleBulkExecutionState.Admitted
                && next == ArticleBulkExecutionState.Executing,
            ArticleBulkJournalEventKind.ItemAdmitted => current.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
                && current.State == ArticleBulkExecutionState.Executing && next == current.State && articleId is not null,
            ArticleBulkJournalEventKind.ItemStarted => current.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
                && current.State == ArticleBulkExecutionState.Executing && next == current.State && articleId is not null,
            ArticleBulkJournalEventKind.ItemTerminal => current.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
                && current.State is ArticleBulkExecutionState.Executing or ArticleBulkExecutionState.Cancelling
                && next == current.State && articleId is not null && itemReceipts.Count == 1,
            ArticleBulkJournalEventKind.CancelRequested => current.State is ArticleBulkExecutionState.Admitted or ArticleBulkExecutionState.Executing
                && !current.GroupCommitStarted && next == ArticleBulkExecutionState.Cancelling,
            ArticleBulkJournalEventKind.GroupCommitStarted => current.Strategy == ArticleBulkExecutionStrategy.AllOrNothing
                && current.State == ArticleBulkExecutionState.Executing && !current.GroupCommitStarted && next == current.State,
            ArticleBulkJournalEventKind.GroupCommitTerminal => current.Strategy == ArticleBulkExecutionStrategy.AllOrNothing
                && current.State == ArticleBulkExecutionState.Executing && current.GroupCommitStarted && !current.GroupCommitTerminal
                && next == current.State && groupOutcome is not null,
            ArticleBulkJournalEventKind.ReceiptChunkRecorded => (current.Strategy == ArticleBulkExecutionStrategy.AllOrNothing
                    && ((current.State == ArticleBulkExecutionState.Executing && current.GroupCommitTerminal)
                        || (current.State == ArticleBulkExecutionState.Cancelling && !current.GroupCommitStarted))
                    && next == current.State && itemReceipts.Count is > 0 and <= ReceiptChunkSize)
                || (current.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
                    && (current.State is ArticleBulkExecutionState.Executing or ArticleBulkExecutionState.Cancelling)
                    && next == current.State
                    && itemReceipts.Count is > 0 and <= ReceiptChunkSize
                    && itemReceipts.All(static receipt =>
                        receipt.ExecutionStatus == ArticleBulkItemStatus.Cancelled)),
            ArticleBulkJournalEventKind.RetryRequested => current.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
                && (current.State is ArticleBulkExecutionState.Partial or ArticleBulkExecutionState.Failed
                    or ArticleBulkExecutionState.RecoveryRequired)
                && next == current.State,
            ArticleBulkJournalEventKind.ExecutionTerminal => (next is ArticleBulkExecutionState.Completed
                or ArticleBulkExecutionState.Partial or ArticleBulkExecutionState.Failed
                or ArticleBulkExecutionState.Cancelled or ArticleBulkExecutionState.Blocked
                or ArticleBulkExecutionState.RecoveryRequired)
                && aggregateReceipt is not null && hasNoActiveItems && terminalStrategyValid,
            ArticleBulkJournalEventKind.RecoveryRequired => (current.State is ArticleBulkExecutionState.Executing
                or ArticleBulkExecutionState.Cancelling) && next == ArticleBulkExecutionState.RecoveryRequired,
            _ => false
        };
        if (!legal || current.ActiveArticleIds.Length > MaximumActiveItems)
        {
            throw new ArticleBulkContractException("article-bulk.transition-invalid");
        }
    }

    private static void ValidateItemAppendBinding(
        ArticleBulkJournalEventKind kind,
        string? articleId,
        string? commandOwner,
        string? commandReceiptDigest,
        IReadOnlyList<ArticleBulkItemReceipt> itemReceipts,
        ArticleBulkItemStatus? expectedItemStatus,
        ArticleBulkItemStatus? nextItemStatus)
    {
        bool valid = kind switch
        {
            ArticleBulkJournalEventKind.ItemAdmitted => articleId is not null
                && itemReceipts.Count == 0
                && expectedItemStatus is null
                && nextItemStatus == ArticleBulkItemStatus.Admitted,
            ArticleBulkJournalEventKind.ItemStarted => articleId is not null
                && itemReceipts.Count == 0
                && expectedItemStatus == ArticleBulkItemStatus.Admitted
                && nextItemStatus == ArticleBulkItemStatus.Executing,
            ArticleBulkJournalEventKind.ItemTerminal => itemReceipts.Count == 1
                && itemReceipts[0].ArticleId == articleId
                && itemReceipts[0].CanonicalCommandOwner == commandOwner
                && itemReceipts[0].CanonicalCommandReceiptDigest == commandReceiptDigest
                && expectedItemStatus == ArticleBulkItemStatus.Executing
                && nextItemStatus == itemReceipts[0].ExecutionStatus
                && (nextItemStatus is ArticleBulkItemStatus.Succeeded
                    or ArticleBulkItemStatus.Failed
                    or ArticleBulkItemStatus.Cancelled
                    or ArticleBulkItemStatus.RecoveryRequired),
            ArticleBulkJournalEventKind.ReceiptChunkRecorded => articleId is null
                && commandOwner is null
                && commandReceiptDigest is null
                && itemReceipts.Count is > 0 and <= ReceiptChunkSize
                && expectedItemStatus is null
                && nextItemStatus is null,
            _ => itemReceipts.Count == 0
                && expectedItemStatus is null
                && nextItemStatus is null
        };
        if (!valid)
        {
            throw new ArticleBulkContractException("article-bulk.item-journal-binding-invalid");
        }
    }

    private static void ReplayTransition(ArticleBulkJournalHead current, ArticleBulkJournalEvent journalEvent)
    {
        // Receipt bodies are read separately; event-bound digests are sufficient for transition replay.
        ArticleBulkItemStatus replayStatus = journalEvent.SucceededDelta > 0
            ? ArticleBulkItemStatus.Succeeded
            : journalEvent.CancelledDelta > 0
                ? ArticleBulkItemStatus.Cancelled
                : journalEvent.FailedDelta > 0
                    ? ArticleBulkItemStatus.RecoveryRequired
                    : ArticleBulkItemStatus.Failed;
        ArticleBulkItemReceipt replayReceipt = new(
                current.AttemptId,
                string.Empty,
                string.Empty,
                "category.add",
                journalEvent.ArticleId!,
                "replay",
                null,
                null,
                ArticleBulkPlanItemStatus.Eligible,
                replayStatus,
                journalEvent.ReasonCode ?? "failed",
                journalEvent.CanonicalCommandOwner ?? string.Empty,
                journalEvent.CanonicalCommandReceiptDigest ?? string.Empty,
                [],
                string.Empty,
                journalEvent.ItemReceiptDigest ?? string.Empty);
        IReadOnlyList<ArticleBulkItemReceipt> itemReceipts = journalEvent.Kind switch
        {
            ArticleBulkJournalEventKind.ItemTerminal => [replayReceipt],
            ArticleBulkJournalEventKind.ReceiptChunkRecorded => Enumerable.Range(0, journalEvent.ReceiptCount)
                .Select(index => replayReceipt with { ArticleId = $"replay-{index}" })
                .ToArray(),
            _ => []
        };
        ArticleBulkAggregateReceipt? aggregate = journalEvent.Kind == ArticleBulkJournalEventKind.ExecutionTerminal
            ? new ArticleBulkAggregateReceipt(
                current.AttemptId,
                string.Empty,
                string.Empty,
                string.Empty,
                string.Empty,
                current.Strategy,
                string.Empty,
                0,
                0,
                0,
                0,
                0,
                journalEvent.ResultingState,
                null,
                null,
                null,
                false,
                false,
                [],
                journalEvent.AggregateReceiptDigest ?? string.Empty)
            : null;
        ValidateTransition(
            current,
            journalEvent.Kind,
            journalEvent.ResultingState,
            journalEvent.ArticleId,
            itemReceipts,
            journalEvent.GroupCommitOutcome,
            aggregate);
    }

    private static ArticleBulkJournalHead AdvanceReplay(
        ArticleBulkJournalHead current,
        ArticleBulkJournalEvent journalEvent)
    {
        ImmutableArray<string> active = NextActiveSet(
            current.ActiveArticleIds,
            journalEvent.Kind,
            journalEvent.ArticleId);
        return current with
        {
            State = journalEvent.ResultingState,
            EventCount = current.EventCount + 1,
            LastEventDigest = journalEvent.ContentDigest,
            ActiveArticleIds = active,
            AdmittedCount = current.AdmittedCount
                + (journalEvent.Kind == ArticleBulkJournalEventKind.ItemAdmitted ? 1 : 0),
            SucceededCount = current.SucceededCount + journalEvent.SucceededDelta,
            FailedCount = current.FailedCount + journalEvent.FailedDelta,
            CancelledCount = current.CancelledCount + journalEvent.CancelledDelta,
            GroupCommitStarted = current.GroupCommitStarted
                || journalEvent.Kind == ArticleBulkJournalEventKind.GroupCommitStarted,
            GroupCommitTerminal = current.GroupCommitTerminal
                || journalEvent.Kind == ArticleBulkJournalEventKind.GroupCommitTerminal,
            ContentDigest = string.Empty
        };
    }

    private static ImmutableArray<string> NextActiveSet(
        ImmutableArray<string> current,
        ArticleBulkJournalEventKind kind,
        string? articleId)
    {
        if (kind == ArticleBulkJournalEventKind.ItemStarted)
        {
            if (current.Contains(articleId!, StringComparer.Ordinal) || current.Length == MaximumActiveItems)
            {
                throw new ArticleBulkContractException("article-bulk.item-overwrite");
            }
            return current.Add(articleId!);
        }
        if (kind == ArticleBulkJournalEventKind.ItemTerminal)
        {
            if (!current.Contains(articleId!, StringComparer.Ordinal))
            {
                throw new ArticleBulkContractException("article-bulk.item-not-active");
            }
            return current.Remove(articleId!);
        }
        return current;
    }

    private static ArticleBulkJournalEvent SealEvent(ArticleBulkJournalEvent journalEvent) =>
        journalEvent with { ContentDigest = ArticleBulkDigest.Of(journalEvent with { ContentDigest = string.Empty }) };

    private static ArticleBulkJournalHead SealHead(ArticleBulkJournalHead head) =>
        head with { ContentDigest = ArticleBulkDigest.Of(head with { ContentDigest = string.Empty }) };

    private static void ValidateAppendReceipt(
        ArticleBulkJournalAppendReceipt receipt,
        ArticleBulkJournalEvent journalEvent,
        ArticleBulkJournalHead head)
    {
        if (receipt.AttemptId != journalEvent.AttemptId || receipt.Ordinal != journalEvent.Ordinal
            || receipt.EventDigest != journalEvent.ContentDigest || receipt.HeadDigest != head.ContentDigest
            || !IsContentDigest(receipt.AuthorityReceiptDigest))
        {
            throw new ArticleBulkContractException("article-bulk.journal-authority-receipt-invalid");
        }
    }

    private static bool IsBoundedOpaqueValue(string value, int maximumLength) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length <= maximumLength
        && value.All(static character => !char.IsControl(character));

    private static bool IsContentDigest(string value) =>
        value.Length == 71
        && value.StartsWith("sha256:", StringComparison.Ordinal)
        && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;
}
