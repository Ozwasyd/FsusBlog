using System.Collections.Frozen;
using System.Collections.Immutable;
using System.Runtime.CompilerServices;

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
    RecoveryRequired,
    GroupReconciled
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

internal sealed record ArticleBulkPlanConfirmation(
    string ConfirmationIdentity,
    string PlanIdentity,
    string PlanDigest,
    string ActorAuthorityDigest,
    DateTimeOffset ConfirmedAtUtc,
    string ContentDigest);

internal sealed record ArticleBulkExecutionAuthoritySnapshot(
    string PolicyDigest,
    string PermissionPolicyDigest,
    string AuthorityReceiptDigest,
    string? ZeroWriteProofDigest);

/// <summary>
/// Production implementations reread current policy/permission authority and validate canonical
/// group transaction receipts. They must not derive facts from caller-supplied execution fields.
/// </summary>
internal interface IArticleBulkExecutionAuthority
{
    Task<ArticleBulkExecutionAuthoritySnapshot> ReadCurrentAsync(
        ArticleBulkPlan plan,
        CancellationToken cancellationToken);

    Task<ArticleBulkGroupRecoveryEvidence?> ReadGroupRecoveryAsync(
        ArticleBulkExecutionRequest request,
        ArticleBulkPlan plan,
        ArticleBulkJournalHead checkpoint,
        CancellationToken cancellationToken)
        => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(null);

    Task ValidateGroupOutcomeAsync(
        ArticleBulkPlan plan,
        ArticleBulkGroupCommitOutcome outcome,
        string? groupReceiptDigest,
        string? zeroWriteProofDigest,
        CancellationToken cancellationToken);
}

/// <summary>
/// Read-only canonical reconciliation of the original transaction identity. Known outcomes and
/// every business receipt must come from the owner; the framework never reruns a command or
/// derives preparation release, rollback, side effects or successful writes from journal absence.
/// </summary>
internal sealed record ArticleBulkGroupRecoveryEvidence(
    string ExecutionIdentityDigest,
    string PlanDigest,
    ArticleBulkGroupCommitOutcome Outcome,
    string? GroupReceiptDigest,
    string? ZeroWriteProofDigest,
    IAsyncEnumerable<ArticleBulkItemReceipt> ItemReceipts);


/// <summary>A separate append-only observation journal; the original unknown receipts are never replaced.</summary>
internal sealed record ArticleBulkReconciliationResult(
    string OriginalRequestDigest,
    string OriginalTerminalReceiptDigest,
    ArticleBulkExecutionRequest Request,
    ArticleBulkJournalHead Head,
    ArticleBulkAggregateReceipt? Receipt);

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
    string ConfirmationDigest,
    string AdmissionAuthorityReceiptDigest,
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
    string IdempotencyKeyDigest,
    string PlanDigest,
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
    ArticleBulkGroupCommitOutcome? GroupCommitOutcome,
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
        ArticleBulkJournalHead sealedHead,
        int maximumBatchSize,
        CancellationToken cancellationToken);

    IAsyncEnumerable<ArticleBulkItemReceipt> ReadItemReceiptsAsync(
        ArticleBulkJournalHead sealedHead,
        CancellationToken cancellationToken);
}

internal sealed record ArticleBulkAdmission(
    ArticleBulkExecutionRequest Request,
    ArticleBulkJournalHead Head,
    ArticleBulkJournalAppendReceipt? AppendReceipt,
    ArticleBulkAggregateReceipt? ExistingTerminalReceipt,
    bool IsExisting)
{
    internal ImmutableArray<ArticleBulkItemExecutionDecision> ItemDecisions { get; init; } = [];
}

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
    IArticleBulkExecutionAuthority executionAuthority,
    TimeProvider timeProvider)
{
    internal const int JournalReadBatchSize = 128;
    internal const int ReceiptChunkSize = 250;
    private const int MaximumActiveItems = 256;
    private const string ReconciliationPrefix = "canonical-reconciliation:";

    internal static bool IsGroupTerminalKind(ArticleBulkJournalEventKind kind) =>
        kind is ArticleBulkJournalEventKind.GroupCommitTerminal or ArticleBulkJournalEventKind.GroupReconciled;
    private readonly ConditionalWeakTable<ArticleBulkPlan, ArticleBulkPlanBinding> _planBindings = new();

    internal async Task<ArticleBulkAdmission> AdmitAsync(
        ArticleBulkPlan plan,
        ArticleBulkPlanConfirmation confirmation,
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
            || !IsBoundedOpaqueValue(idempotencyKey, 256)
            || idempotencyKey.StartsWith(ReconciliationPrefix, StringComparison.Ordinal))
        {
            throw new ArticleBulkContractException("article-bulk.execution-request-invalid");
        }
        planAuthority.ValidateIntegrity(plan);
        ValidateConfirmation(plan, confirmation);
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
            ConfirmationDigest = confirmation.ContentDigest,
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
            confirmation.ContentDigest,
            string.Empty,
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
        if (resolution.Kind != ArticleBulkIdempotencyKind.Missing)
        {
            return await BindExistingAdmissionAsync(
                resolution,
                identityDigest,
                idempotencyKey,
                plan,
                cancellationToken).ConfigureAwait(false);
        }

        planAuthority.ValidateForExecution(plan);
        ArticleBulkExecutionAuthoritySnapshot authoritySnapshot = await executionAuthority
            .ReadCurrentAsync(plan, cancellationToken).ConfigureAwait(false);
        ValidateExecutionAuthoritySnapshot(plan, authoritySnapshot);
        ImmutableArray<ArticleBulkItemExecutionDecision> itemDecisions = [];
        if (plan.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated)
        {
            itemDecisions = await planAuthority.ReadCurrentItemExecutionDecisionsAsync(plan, cancellationToken)
                .ConfigureAwait(false);
        }
        else
        {
            await planAuthority.ValidateCurrentArticlesForExecutionAsync(plan, cancellationToken).ConfigureAwait(false);
        }
        // Authority I/O can cross the expiry boundary after its initial clock check.
        planAuthority.ValidateForExecution(plan);
        request = request with
        {
            AdmissionAuthorityReceiptDigest = authoritySnapshot.AuthorityReceiptDigest,
            ContentDigest = string.Empty
        };
        request = request with
        {
            ContentDigest = ArticleBulkDigest.Of(request)
        };

        const ArticleBulkExecutionState InitialState = ArticleBulkExecutionState.Planned;
        string? zeroWriteProofDigest = plan.Executable ? null : authoritySnapshot.ZeroWriteProofDigest;
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
            ArticleBulkDigest.Of(idempotencyKey),
            plan.ContentDigest,
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
            null,
            string.Empty));
        ArticleBulkJournalAppendReceipt appendReceipt;
        try
        {
            appendReceipt = await journalAuthority
                .CreateAsync(idempotencyKey, request, firstEvent, head, cancellationToken).ConfigureAwait(false);
        }
        catch (ArticleBulkContractException exception)
            when (exception.Code == "article-bulk.idempotency-conflict")
        {
            ArticleBulkIdempotencyResolution concurrent = await journalAuthority
                .ResolveIdempotencyAsync(idempotencyKey, identityDigest, cancellationToken)
                .ConfigureAwait(false);
            return await BindExistingAdmissionAsync(
                concurrent,
                identityDigest,
                idempotencyKey,
                plan,
                cancellationToken).ConfigureAwait(false);
        }
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
                plan,
                ArticleBulkJournalEventKind.ExecutionTerminal,
                ArticleBulkExecutionState.Blocked,
                reasonCode: "preflight-blocked",
                groupOutcome: blockedReceipt.GroupCommitOutcome,
                zeroWriteProofDigest: zeroWriteProofDigest,
                aggregateReceipt: blockedReceipt,
                cancellationToken: cancellationToken).ConfigureAwait(false);
            immediateTerminalReceipt = blockedReceipt;
        }
        return new ArticleBulkAdmission(request, head, appendReceipt, immediateTerminalReceipt, false)
        {
            ItemDecisions = itemDecisions
        };
    }

    private async Task<ArticleBulkAdmission> BindExistingAdmissionAsync(
        ArticleBulkIdempotencyResolution resolution,
        string identityDigest,
        string idempotencyKey,
        ArticleBulkPlan plan,
        CancellationToken cancellationToken)
    {
        if (resolution.Kind == ArticleBulkIdempotencyKind.Conflict)
        {
            throw new ArticleBulkContractException("article-bulk.idempotency-conflict");
        }
        if (resolution.Kind is not (ArticleBulkIdempotencyKind.InProgress or ArticleBulkIdempotencyKind.Terminal))
        {
            throw new ArticleBulkContractException("article-bulk.journal-corrupt");
        }
        ArticleBulkExecutionRequest existingRequest = resolution.ExistingRequest
            ?? throw new ArticleBulkContractException("article-bulk.journal-corrupt");
        ArticleBulkJournalHead existing = resolution.Head
            ?? throw new ArticleBulkContractException("article-bulk.journal-corrupt");
        if (existingRequest.ContentDigest
            != ArticleBulkDigest.Of(existingRequest with
            {
                ContentDigest = string.Empty
            })
            || existingRequest.ExecutionIdentityDigest != identityDigest
            || existing.ExecutionIdentityDigest != identityDigest
            || existing.IdempotencyKeyDigest != ArticleBulkDigest.Of(idempotencyKey))
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

    internal async Task<(ArticleBulkJournalHead Head, ArticleBulkJournalAppendReceipt Receipt)> AppendAsync(
        ArticleBulkJournalHead current,
        ArticleBulkPlan plan,
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
        CancellationToken cancellationToken = default,
        ArticleBulkExecutionRequest? reconciliationRequest = null)
    {
        ArticleBulkPlanBinding planBinding = GetPlanBinding(plan);
        if (kind == ArticleBulkJournalEventKind.GroupReconciled)
        {
            if (reconciliationRequest is null)
            {
                throw new ArticleBulkContractException("article-bulk.reconciliation-scope-unbound");
            }
            ValidateReconciliationRequestShape(reconciliationRequest);
            ArticleBulkIdempotencyResolution scope = await journalAuthority.ResolveIdempotencyAsync(
                reconciliationRequest.IdempotencyKey, reconciliationRequest.ExecutionIdentityDigest, cancellationToken)
                .ConfigureAwait(false);
            ValidateReconciliationBinding(reconciliationRequest, scope);
            if (scope.Head!.ContentDigest != current.ContentDigest)
            {
                throw new ArticleBulkContractException("article-bulk.reconciliation-scope-unbound");
            }
        }
        if (current.PlanDigest != plan.ContentDigest || current.Strategy != plan.Strategy)
        {
            throw new ArticleBulkContractException("article-bulk.journal-plan-unbound");
        }
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
                || receipt.ContentDigest != ArticleBulkDigest.Of(receipt with
                {
                    ContentDigest = string.Empty
                })))
        {
            throw new ArticleBulkContractException("article-bulk.receipt-chunk-invalid");
        }
        ValidatePlanBoundPayload(
            plan,
            planBinding,
            kind,
            articleId,
            commandOwner,
            commandReceiptDigest,
            groupReceiptDigest,
            itemReceipts);
        ValidateEventPayload(
            kind,
            articleId,
            reasonCode,
            groupOutcome,
            groupReceiptDigest,
            zeroWriteProofDigest,
            aggregateReceipt,
            retryRequestDigest);
        ValidateItemAppendBinding(
            kind,
            articleId,
            commandOwner,
            commandReceiptDigest,
            itemReceipts,
            expectedItemStatus,
            nextItemStatus);
        ValidateTransition(
            current,
            kind,
            nextState,
            articleId,
            itemReceipts,
            groupOutcome,
            groupReceiptDigest,
            zeroWriteProofDigest,
            aggregateReceipt);
        if (IsGroupTerminalKind(kind))
        {
            await executionAuthority.ValidateGroupOutcomeAsync(
                plan,
                groupOutcome!.Value,
                groupReceiptDigest,
                zeroWriteProofDigest,
                cancellationToken).ConfigureAwait(false);
        }
        ImmutableArray<string> active = NextActiveSet(current.ActiveArticleIds, kind, articleId);
        var unsignedEvent = new ArticleBulkJournalEvent(
            current.AttemptId,
            current.EventCount,
            kind,
            nextState,
            timeProvider.GetUtcNow().ToUniversalTime(),
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
            GroupCommitTerminal = current.GroupCommitTerminal || IsGroupTerminalKind(kind),
            GroupCommitOutcome = IsGroupTerminalKind(kind)
                ? groupOutcome
                : current.GroupCommitOutcome,
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
        if (sealedHead.ContentDigest != ArticleBulkDigest.Of(sealedHead with
        {
            ContentDigest = string.Empty
        }))
        {
            throw new ArticleBulkContractException("article-bulk.journal-head-tampered");
        }
        long ordinal = 0;
        string previousDigest = string.Empty;
        ArticleBulkJournalHead? replay = null;
        await foreach (IReadOnlyList<ArticleBulkJournalEvent> batch in journalAuthority
            .ReadEventBatchesAsync(sealedHead, JournalReadBatchSize, cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (batch.Count is 0 or > JournalReadBatchSize)
            {
                throw new ArticleBulkContractException("article-bulk.journal-batch-invalid");
            }
            foreach (ArticleBulkJournalEvent journalEvent in batch)
            {
                if (journalEvent.Ordinal != ordinal || journalEvent.PreviousEventDigest != previousDigest
                    || journalEvent.ContentDigest != ArticleBulkDigest.Of(journalEvent with
                    {
                        ContentDigest = string.Empty
                    }))
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
                        GroupCommitOutcome = null,
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
            || replay.GroupCommitTerminal != sealedHead.GroupCommitTerminal
            || replay.GroupCommitOutcome != sealedHead.GroupCommitOutcome)
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
        planAuthority.ValidateIntegrity(plan);
        if (request.ContentDigest != ArticleBulkDigest.Of(request with
        {
            ContentDigest = string.Empty
        })
            || request.ExecutionIdentityDigest != sealedHead.ExecutionIdentityDigest
            || request.PlanDigest != plan.ContentDigest
            || request.RegistryDigest != plan.RegistryDigest
            || request.OperationId != plan.OperationId
            || request.Strategy != plan.Strategy
            || request.ParametersDigest != plan.ParametersDigest
            || request.FrozenSetDigest != plan.FrozenSetDigest
            || !IsContentDigest(request.ConfirmationDigest)
            || !IsContentDigest(request.AdmissionAuthorityReceiptDigest))
        {
            throw new ArticleBulkContractException("article-bulk.execution-request-tampered");
        }
        await VerifyJournalAsync(sealedHead, cancellationToken).ConfigureAwait(false);
        await foreach (IReadOnlyList<ArticleBulkJournalEvent> batch in journalAuthority
            .ReadEventBatchesAsync(sealedHead, JournalReadBatchSize, cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (batch.Any(static entry => entry.Kind == ArticleBulkJournalEventKind.GroupReconciled))
            {
                ValidateReconciliationRequestShape(request);
                if (sealedHead.GroupCommitStarted)
                {
                    throw new ArticleBulkContractException("article-bulk.reconciliation-scope-unbound");
                }
            }
        }
        ImmutableArray<(int Count, string Digest)> receiptBindings = await ReadReceiptBindingsAsync(
            sealedHead,
            cancellationToken).ConfigureAwait(false);

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
        ArticleBulkAggregateReceipt resealedAggregate = SealAggregateReceipt(aggregate with
        {
            ContentDigest = string.Empty
        });
        if (resealedAggregate.ContentDigest != aggregate.ContentDigest)
        {
            throw new ArticleBulkContractException("article-bulk.terminal-receipt-tampered");
        }

        var itemDigests = new HashSet<string>(StringComparer.Ordinal);
        var itemArticleIds = new HashSet<string>(StringComparer.Ordinal);
        FrozenDictionary<string, ArticleBulkPlanItem> eligiblePlanItems = plan.Items
            .Where(static item => item.Status == ArticleBulkPlanItemStatus.Eligible)
            .ToFrozenDictionary(static item => item.ArticleId, StringComparer.Ordinal);
        int succeeded = 0;
        int failed = 0;
        int cancelled = 0;
        int bindingIndex = 0;
        var boundReceiptDigests = new List<string>(ReceiptChunkSize);
        await foreach (ArticleBulkItemReceipt receipt in journalAuthority
            .ReadItemReceiptsAsync(sealedHead, cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            ValidateItemReceiptShape(receipt);
            if (receipt.ContentDigest != ArticleBulkDigest.Of(receipt with
            {
                ContentDigest = string.Empty
            })
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
            if (bindingIndex >= receiptBindings.Length)
            {
                throw new ArticleBulkContractException("article-bulk.journal-receipt-unbound");
            }
            boundReceiptDigests.Add(receipt.ContentDigest);
            (int expectedCount, string expectedDigest) = receiptBindings[bindingIndex];
            if (boundReceiptDigests.Count == expectedCount)
            {
                string actualDigest = expectedCount == 1
                    ? boundReceiptDigests[0]
                    : ArticleBulkDigest.Of(boundReceiptDigests.ToArray());
                if (actualDigest != expectedDigest)
                {
                    throw new ArticleBulkContractException("article-bulk.journal-receipt-unbound");
                }
                bindingIndex++;
                boundReceiptDigests.Clear();
            }
        }

        string[] aggregateDigests =
        [
            .. aggregate.ItemReceiptChunks
                .OrderBy(static chunk => chunk.Index)
                .SelectMany(static chunk => chunk.ItemReceiptDigests)
        ];
        if (bindingIndex != receiptBindings.Length || boundReceiptDigests.Count != 0
            || aggregateDigests.Length != itemDigests.Count
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
            || plan.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
                && aggregate.RetryEligible != (aggregate.TerminalState != ArticleBulkExecutionState.RecoveryRequired
                    && (failed > 0 || cancelled > sealedHead.AdmittedCount - succeeded - failed))
            || aggregate.TerminalState != sealedHead.State
            || aggregate.SucceededCount + aggregate.FailedCount + aggregate.CancelledCount
                != aggregate.EligibleCount)
        {
            throw new ArticleBulkContractException("article-bulk.aggregate-receipt-inexact");
        }
        ValidateStrategyOutcome(aggregate);
        if (plan.Strategy == ArticleBulkExecutionStrategy.AllOrNothing)
        {
            await VerifyAtomicOutcomeAsync(plan, sealedHead, aggregate, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<ImmutableArray<(int Count, string Digest)>> ReadReceiptBindingsAsync(
        ArticleBulkJournalHead sealedHead,
        CancellationToken cancellationToken)
    {
        var bindings = ImmutableArray.CreateBuilder<(int Count, string Digest)>();
        await foreach (IReadOnlyList<ArticleBulkJournalEvent> batch in journalAuthority
            .ReadEventBatchesAsync(sealedHead, JournalReadBatchSize, cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            foreach (ArticleBulkJournalEvent journalEvent in batch)
            {
                if (journalEvent.ReceiptCount == 0)
                {
                    continue;
                }
                if (journalEvent.ReceiptCount > ReceiptChunkSize
                    || !IsContentDigest(journalEvent.ItemReceiptDigest!))
                {
                    throw new ArticleBulkContractException("article-bulk.journal-receipt-unbound");
                }
                bindings.Add((journalEvent.ReceiptCount, journalEvent.ItemReceiptDigest!));
            }
        }
        return bindings.ToImmutable();
    }

    internal async Task<ArticleBulkJournalHead> ResumeAsync(
        ArticleBulkExecutionRequest request,
        ArticleBulkPlan plan,
        ArticleBulkJournalHead sealedHead,
        CancellationToken cancellationToken = default)
    {
        planAuthority.ValidateIntegrity(plan);
        if (request.ContentDigest != ArticleBulkDigest.Of(request with
        {
            ContentDigest = string.Empty
        })
            || request.PlanDigest != plan.ContentDigest
            || request.RegistryDigest != plan.RegistryDigest
            || request.FrozenSetDigest != plan.FrozenSetDigest
            || !IsContentDigest(request.ConfirmationDigest)
            || !IsContentDigest(request.AdmissionAuthorityReceiptDigest)
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
            if (plan.Strategy == ArticleBulkExecutionStrategy.AllOrNothing
                && resolution.TerminalReceipt?.GroupCommitOutcome == ArticleBulkGroupCommitOutcome.UnknownRecovery)
            {
                await ReconcileUnknownAsync(request, plan, sealedHead, resolution.TerminalReceipt, cancellationToken)
                    .ConfigureAwait(false);
            }
            return sealedHead;
        }
        if (resolution.Kind != ArticleBulkIdempotencyKind.InProgress)
        {
            throw new ArticleBulkContractException("article-bulk.resume-attempt-missing");
        }
        if (plan.Strategy == ArticleBulkExecutionStrategy.AllOrNothing)
        {
            ArticleBulkJournalHead resumed = await ResumeAtomicAsync(request, plan, sealedHead, cancellationToken)
                .ConfigureAwait(false);
            ArticleBulkIdempotencyResolution finalized = await journalAuthority.ResolveIdempotencyAsync(
                request.IdempotencyKey, request.ExecutionIdentityDigest, cancellationToken).ConfigureAwait(false);
            if (finalized.TerminalReceipt?.GroupCommitOutcome == ArticleBulkGroupCommitOutcome.UnknownRecovery)
            {
                await ReconcileUnknownAsync(request, plan, resumed, finalized.TerminalReceipt, cancellationToken)
                    .ConfigureAwait(false);
            }
            return resumed;
        }
        bool activeOutcomeUnknown = sealedHead.ActiveArticleIds.Length > 0;
        bool cancellationPending = sealedHead.State == ArticleBulkExecutionState.Cancelling
            && !sealedHead.GroupCommitStarted;
        bool recoveryFinalizationPending = sealedHead.State == ArticleBulkExecutionState.RecoveryRequired;
        bool executionFinalizationPending = sealedHead.State == ArticleBulkExecutionState.Executing;
        if (!activeOutcomeUnknown && !cancellationPending && !recoveryFinalizationPending && !executionFinalizationPending)
        {
            return sealedHead;
        }

        ArticleBulkJournalHead recoveryHead = sealedHead;
        ArticleBulkOperation operation = ArticleBulkOperationRegistry.Get(plan.OperationId);
        if (!recoveryFinalizationPending)
        {
            (recoveryHead, _) = await AppendAsync(
                recoveryHead,
                plan,
                ArticleBulkJournalEventKind.RecoveryRequired,
                ArticleBulkExecutionState.RecoveryRequired,
                reasonCode: "resume-finalization-started",
                cancellationToken: cancellationToken).ConfigureAwait(false);
        }
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
                    ArticleBulkDigest.Of(new
                    {
                        articleId,
                        Outcome = "unknown"
                    }),
                    [],
                    ArticleBulkDigest.Of(new
                    {
                        plan.ContentDigest,
                        articleId,
                        RequiresCanonicalReconciliation = true
                    }),
                    string.Empty));
                (recoveryHead, _) = await AppendAsync(
                    recoveryHead,
                    plan,
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

        var existingArticleIds = new HashSet<string>(StringComparer.Ordinal);
        var receiptDigests = ImmutableArray.CreateBuilder<string>();
        int succeeded = 0;
        int failed = 0;
        int cancelled = 0;
        bool unresolved = false;
        await foreach (ArticleBulkItemReceipt receipt in journalAuthority
            .ReadItemReceiptsAsync(recoveryHead, cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (receiptDigests.Count == 10_000 || !existingArticleIds.Add(receipt.ArticleId))
            {
                throw new ArticleBulkContractException("article-bulk.receipts-unbounded");
            }
            Accumulate(receipt);
        }

        ArticleBulkItemStatus missingStatus = ArticleBulkItemStatus.Cancelled;
        const string MissingReason = "not-admitted-before-attempt-stop";
        var missingChunk = new List<ArticleBulkItemReceipt>(ReceiptChunkSize);
        foreach (ArticleBulkPlanItem item in plan.Items)
        {
            if (item.Status != ArticleBulkPlanItemStatus.Eligible || existingArticleIds.Contains(item.ArticleId))
            {
                continue;
            }
            missingChunk.Add(CreateDecisionReceipt(
                request,
                plan,
                operation,
                item,
                missingStatus,
                MissingReason));
            if (missingChunk.Count == ReceiptChunkSize)
            {
                await FlushMissingChunkAsync().ConfigureAwait(false);
            }
        }
        await FlushMissingChunkAsync().ConfigureAwait(false);

        ArticleBulkExecutionState terminalState = unresolved
            ? ArticleBulkExecutionState.RecoveryRequired
            : succeeded > 0
                ? failed + cancelled > 0 ? ArticleBulkExecutionState.Partial : ArticleBulkExecutionState.Completed
                : failed > 0 ? ArticleBulkExecutionState.Failed : ArticleBulkExecutionState.Cancelled;
        ImmutableArray<ArticleBulkReceiptChunk> chunks = ChunkReceiptDigests(receiptDigests.ToImmutable());
        ArticleBulkAggregateReceipt aggregate = SealAggregateReceipt(new ArticleBulkAggregateReceipt(
            recoveryHead.AttemptId,
            request.ContentDigest,
            plan.ContentDigest,
            plan.RegistryDigest,
            plan.OperationId,
            plan.Strategy,
            plan.FrozenSetDigest,
            plan.Impact.SelectedCount,
            receiptDigests.Count,
            succeeded,
            failed,
            cancelled,
            terminalState,
            null,
            null,
            null,
            succeeded > 0 && failed + cancelled > 0,
            terminalState != ArticleBulkExecutionState.RecoveryRequired && failed + cancelled > 0,
            chunks,
            string.Empty));
        (recoveryHead, _) = await AppendAsync(
            recoveryHead,
            plan,
            ArticleBulkJournalEventKind.ExecutionTerminal,
            terminalState,
            groupOutcome: aggregate.GroupCommitOutcome,
            aggregateReceipt: aggregate,
            reasonCode: terminalState == ArticleBulkExecutionState.RecoveryRequired
                ? "recovery-required"
                : "cancelled-before-commit",
            cancellationToken: cancellationToken).ConfigureAwait(false);
        return recoveryHead;

        void Accumulate(ArticleBulkItemReceipt receipt)
        {
            receiptDigests.Add(receipt.ContentDigest);
            unresolved |= receipt.ExecutionStatus == ArticleBulkItemStatus.RecoveryRequired;
            succeeded += receipt.ExecutionStatus == ArticleBulkItemStatus.Succeeded ? 1 : 0;
            failed += receipt.ExecutionStatus is ArticleBulkItemStatus.Failed
                or ArticleBulkItemStatus.RecoveryRequired ? 1 : 0;
            cancelled += receipt.ExecutionStatus == ArticleBulkItemStatus.Cancelled ? 1 : 0;
        }

        async Task FlushMissingChunkAsync()
        {
            if (missingChunk.Count == 0)
            {
                return;
            }
            ArticleBulkItemReceipt[] sealedChunk = [.. missingChunk];
            (recoveryHead, _) = await AppendAsync(
                recoveryHead,
                plan,
                ArticleBulkJournalEventKind.ReceiptChunkRecorded,
                recoveryHead.State,
                receiptChunk: sealedChunk,
                reasonCode: MissingReason,
                cancellationToken: cancellationToken).ConfigureAwait(false);
            foreach (ArticleBulkItemReceipt receipt in sealedChunk)
            {
                existingArticleIds.Add(receipt.ArticleId);
                Accumulate(receipt);
            }
            missingChunk.Clear();
        }
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
                or ArticleBulkExecutionState.Cancelled)
            || !IsBoundedOpaqueValue(newAttemptId, 256)
            || newAttemptId == terminalHead.AttemptId
            || newExpectedRevisions.Count is < 1 or > 10_000
            || newExpectedRevisions.Any(static pair => !IsBoundedOpaqueValue(pair.Key, 256)
                || !IsBoundedOpaqueValue(pair.Value, 256)))
        {
            throw new ArticleBulkContractException("article-bulk.retry-not-eligible");
        }
        await VerifyExecutionAsync(request, plan, terminalHead, cancellationToken).ConfigureAwait(false);
        HashSet<string> admittedArticleIds = await ReadAdmittedArticleIdsAsync(terminalHead, cancellationToken)
            .ConfigureAwait(false);
        var failed = ImmutableArray.CreateBuilder<(string, string)>();
        await foreach (ArticleBulkItemReceipt receipt in journalAuthority
            .ReadItemReceiptsAsync(terminalHead, cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (receipt.ExecutionStatus != ArticleBulkItemStatus.Failed
                && !(receipt.ExecutionStatus == ArticleBulkItemStatus.Cancelled
                    && !admittedArticleIds.Contains(receipt.ArticleId)))
            {
                continue;
            }
            if (!newExpectedRevisions.TryGetValue(receipt.ArticleId, out string? newRevision))
            {
                continue;
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
        ArticleBulkRetryRequest retryRequest = unsigned with
        {
            ContentDigest = ArticleBulkDigest.Of(unsigned)
        };
        await EnsureRetryNotRequestedAsync(
            terminalHead,
            retryRequest.ContentDigest,
            cancellationToken).ConfigureAwait(false);
        (ArticleBulkJournalHead retryHead, ArticleBulkJournalAppendReceipt appendReceipt) = await AppendAsync(
            terminalHead,
            plan,
            ArticleBulkJournalEventKind.RetryRequested,
            terminalHead.State,
            retryRequestDigest: retryRequest.ContentDigest,
            reasonCode: "proved-failure-or-not-started-explicit-revision",
            cancellationToken: cancellationToken).ConfigureAwait(false);
        return new ArticleBulkRetryAdmission(retryRequest, retryHead, appendReceipt);
    }

    private async Task EnsureRetryNotRequestedAsync(
        ArticleBulkJournalHead terminalHead,
        string retryRequestDigest,
        CancellationToken cancellationToken)
    {
        await foreach (IReadOnlyList<ArticleBulkJournalEvent> batch in journalAuthority
            .ReadEventBatchesAsync(terminalHead, JournalReadBatchSize, cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            foreach (ArticleBulkJournalEvent journalEvent in batch)
            {
                if (journalEvent.Kind != ArticleBulkJournalEventKind.RetryRequested)
                {
                    continue;
                }
                throw new ArticleBulkContractException(
                    journalEvent.RetryRequestDigest == retryRequestDigest
                        ? "article-bulk.retry-already-requested"
                        : "article-bulk.retry-request-conflict");
            }
        }
    }

    private static void ValidatePlanBoundPayload(
        ArticleBulkPlan plan,
        ArticleBulkPlanBinding planBinding,
        ArticleBulkJournalEventKind kind,
        string? articleId,
        string? commandOwner,
        string? commandReceiptDigest,
        string? groupReceiptDigest,
        IReadOnlyList<ArticleBulkItemReceipt> itemReceipts)
    {
        ArticleBulkOperation operation = planBinding.Operation;
        bool itemEvent = kind is ArticleBulkJournalEventKind.ItemAdmitted
            or ArticleBulkJournalEventKind.ItemStarted
            or ArticleBulkJournalEventKind.ItemTerminal;
        if (itemEvent && (articleId is null
            || !planBinding.EligibleItems.TryGetValue(articleId, out _)))
        {
            throw new ArticleBulkContractException("article-bulk.journal-article-unbound");
        }

        bool commandBindingValid = kind switch
        {
            ArticleBulkJournalEventKind.ItemStarted or ArticleBulkJournalEventKind.GroupCommitStarted =>
                commandOwner == operation.CommandOwner && commandReceiptDigest is null,
            ArticleBulkJournalEventKind.ItemTerminal => commandOwner == operation.CommandOwner,
            ArticleBulkJournalEventKind.GroupCommitTerminal or ArticleBulkJournalEventKind.GroupReconciled => commandOwner == operation.CommandOwner
                && commandReceiptDigest == groupReceiptDigest,
            _ => commandOwner is null && commandReceiptDigest is null
        };
        if (!commandBindingValid)
        {
            throw new ArticleBulkContractException("article-bulk.journal-command-unbound");
        }

        foreach (ArticleBulkItemReceipt receipt in itemReceipts)
        {
            ValidateItemReceiptShape(receipt);
            planBinding.EligibleItems.TryGetValue(receipt.ArticleId, out ArticleBulkPlanItem? receiptPlanItem);
            if (receipt.ContentDigest != ArticleBulkDigest.Of(receipt with
            {
                ContentDigest = string.Empty
            })
                || receipt.PlanDigest != plan.ContentDigest
                || receipt.RegistryDigest != plan.RegistryDigest
                || receipt.OperationId != plan.OperationId
                || receiptPlanItem is null
                || receiptPlanItem.Status != ArticleBulkPlanItemStatus.Eligible
                || receipt.ExpectedRevision != receiptPlanItem.ExpectedRevision)
            {
                throw new ArticleBulkContractException("article-bulk.item-receipt-unbound");
            }
        }
    }

    private static void ValidateEventPayload(
        ArticleBulkJournalEventKind kind,
        string? articleId,
        string? reasonCode,
        ArticleBulkGroupCommitOutcome? groupOutcome,
        string? groupReceiptDigest,
        string? zeroWriteProofDigest,
        ArticleBulkAggregateReceipt? aggregateReceipt,
        string? retryRequestDigest)
    {
        bool articleBindingValid = kind is ArticleBulkJournalEventKind.ItemAdmitted
            or ArticleBulkJournalEventKind.ItemStarted or ArticleBulkJournalEventKind.ItemTerminal
            ? articleId is not null
            : articleId is null;
        bool terminalPayloadValid = kind switch
        {
            ArticleBulkJournalEventKind.GroupCommitTerminal or ArticleBulkJournalEventKind.GroupReconciled => groupOutcome is not null
                && aggregateReceipt is null && retryRequestDigest is null,
            ArticleBulkJournalEventKind.ExecutionTerminal => aggregateReceipt is not null
                && retryRequestDigest is null,
            ArticleBulkJournalEventKind.RetryRequested => groupOutcome is null
                && groupReceiptDigest is null && zeroWriteProofDigest is null
                && aggregateReceipt is null && IsContentDigest(retryRequestDigest),
            _ => groupOutcome is null && groupReceiptDigest is null
                && zeroWriteProofDigest is null && aggregateReceipt is null
                && retryRequestDigest is null
        };
        if (!articleBindingValid || !terminalPayloadValid
            || reasonCode is not null && !IsBoundedOpaqueValue(reasonCode, 256))
        {
            throw new ArticleBulkContractException("article-bulk.journal-payload-invalid");
        }
    }

    internal static ArticleBulkItemReceipt SealItemReceipt(ArticleBulkItemReceipt receipt)
    {
        ValidateItemReceiptShape(receipt);
        return receipt with
        {
            ContentDigest = ArticleBulkDigest.Of(receipt with
            {
                ContentDigest = string.Empty
            })
        };
    }

    private static void ValidateItemReceiptShape(ArticleBulkItemReceipt receipt)
    {
        if (receipt.SideEffects.IsDefault)
        {
            throw new ArticleBulkContractException("article-bulk.item-receipt-invalid");
        }
        ArticleBulkOperation operation = ArticleBulkOperationRegistry.Get(receipt.OperationId);
        string[] sideEffectOwners = [.. receipt.SideEffects.Select(static sideEffect => sideEffect.Owner)
            .Order(StringComparer.Ordinal)];
        bool sideEffectsValid = receipt.ExecutionStatus == ArticleBulkItemStatus.Succeeded
            ? sideEffectOwners.SequenceEqual(operation.SideEffectOwners)
            : sideEffectOwners.Distinct(StringComparer.Ordinal).Count() == sideEffectOwners.Length
                && sideEffectOwners.All(owner => operation.SideEffectOwners.Contains(owner, StringComparer.Ordinal));
        if (operation.CommandOwner != receipt.CanonicalCommandOwner
            || !IsBoundedOpaqueValue(receipt.AttemptId, 256)
            || !IsContentDigest(receipt.PlanDigest)
            || !IsContentDigest(receipt.RegistryDigest)
            || !IsBoundedOpaqueValue(receipt.ArticleId, 256)
            || !IsBoundedOpaqueValue(receipt.ExpectedRevision, 256)
            || receipt.ObservedRevision is not null && !IsBoundedOpaqueValue(receipt.ObservedRevision, 256)
            || receipt.NewRevision is not null && !IsBoundedOpaqueValue(receipt.NewRevision, 256)
            || !IsBoundedOpaqueValue(receipt.ReasonCode, 256)
            || receipt.PreflightStatus != ArticleBulkPlanItemStatus.Eligible
            || receipt.ExecutionStatus is not (ArticleBulkItemStatus.Succeeded
                or ArticleBulkItemStatus.Failed
                or ArticleBulkItemStatus.Cancelled
                or ArticleBulkItemStatus.RecoveryRequired)
            || !IsContentDigest(receipt.CanonicalCommandReceiptDigest)
            || !IsContentDigest(receipt.RetryIdentityDigest)
            || receipt.SideEffects.Length > operation.SideEffectOwners.Length
            || !sideEffectsValid
            || receipt.SideEffects.Any(static sideEffect => !IsBoundedOpaqueValue(sideEffect.Owner, 128))
            || receipt.SideEffects.Any(static sideEffect => !IsContentDigest(sideEffect.ReceiptDigest))
            || receipt.ExecutionStatus == ArticleBulkItemStatus.Succeeded
                && operation.MutatesBusinessState == string.IsNullOrWhiteSpace(receipt.NewRevision)
            || receipt.ExecutionStatus != ArticleBulkItemStatus.Succeeded && receipt.NewRevision is not null)
        {
            throw new ArticleBulkContractException("article-bulk.item-receipt-invalid");
        }
    }

    internal static ArticleBulkAggregateReceipt SealAggregateReceipt(ArticleBulkAggregateReceipt receipt)
    {
        if (receipt.ItemReceiptChunks.Length > 40
            || receipt.ItemReceiptChunks.Select(static chunk => chunk.Index)
                .SequenceEqual(Enumerable.Range(0, receipt.ItemReceiptChunks.Length)) is false
            || receipt.ItemReceiptChunks.Any(static chunk => chunk.ItemReceiptDigests.Length is 0 or > ReceiptChunkSize
                || chunk.ContentDigest != ArticleBulkDigest.Of(chunk with
                {
                    ContentDigest = string.Empty
                }))
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
        return receipt with
        {
            ContentDigest = ArticleBulkDigest.Of(receipt with
            {
                ContentDigest = string.Empty
            })
        };
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
                NoCanonicalCommandWasAdmitted = status == ArticleBulkItemStatus.Cancelled
                    && plan.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated,
                RequiresCanonicalReconciliation = status == ArticleBulkItemStatus.RecoveryRequired
            }),
            [],
            ArticleBulkDigest.Of(new
            {
                plan.ContentDigest,
                item.ArticleId,
                NotStarted = status == ArticleBulkItemStatus.Cancelled
            }),
            string.Empty));
    }

    private ArticleBulkPlanBinding GetPlanBinding(ArticleBulkPlan plan)
        => _planBindings.GetValue(plan, candidate =>
        {
            planAuthority.ValidateIntegrity(candidate);
            return new ArticleBulkPlanBinding(
                ArticleBulkOperationRegistry.Get(candidate.OperationId),
                candidate.Items
                    .Where(static item => item.Status == ArticleBulkPlanItemStatus.Eligible)
                    .ToFrozenDictionary(static item => item.ArticleId, StringComparer.Ordinal));
        });

    private static ImmutableArray<ArticleBulkReceiptChunk> ChunkReceiptDigests(
        ImmutableArray<string> receiptDigests)
    {
        var chunks = ImmutableArray.CreateBuilder<ArticleBulkReceiptChunk>();
        for (int offset = 0; offset < receiptDigests.Length; offset += ReceiptChunkSize)
        {
            ImmutableArray<string> digests = receiptDigests
                .Skip(offset)
                .Take(ReceiptChunkSize)
                .ToImmutableArray();
            var chunk = new ArticleBulkReceiptChunk(chunks.Count, digests, string.Empty);
            chunks.Add(chunk with
            {
                ContentDigest = ArticleBulkDigest.Of(chunk)
            });
        }
        return chunks.ToImmutable();
    }

    private static void ValidateAggregateReceipt(
        ArticleBulkAggregateReceipt receipt,
        ArticleBulkExecutionRequest request,
        ArticleBulkPlan plan)
    {
        if (receipt is null || receipt.ContentDigest
            != ArticleBulkDigest.Of(receipt with
            {
                ContentDigest = string.Empty
            })
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
                        && (receipt.TerminalState == ArticleBulkExecutionState.RecoveryRequired
                            ? !receipt.RetryEligible
                            : receipt.RetryEligible
                                ? receipt.FailedCount + receipt.CancelledCount > 0
                                : receipt.FailedCount == 0)
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
        string? groupReceiptDigest,
        string? zeroWriteProofDigest,
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
                    && next is ArticleBulkExecutionState.RecoveryRequired or ArticleBulkExecutionState.Cancelled
                        or ArticleBulkExecutionState.Completed or ArticleBulkExecutionState.Partial or ArticleBulkExecutionState.Failed,
            ArticleBulkExecutionStrategy.AllOrNothing =>
                current.State == ArticleBulkExecutionState.Planned && next == ArticleBulkExecutionState.Blocked
                || current.State == ArticleBulkExecutionState.Cancelling
                    && next == ArticleBulkExecutionState.Cancelled && !current.GroupCommitStarted
                || current.State == ArticleBulkExecutionState.Executing
                    && (next is ArticleBulkExecutionState.Completed or ArticleBulkExecutionState.Failed
                        || next == ArticleBulkExecutionState.Cancelled && !current.GroupCommitStarted)
                    && current.GroupCommitTerminal
                || current.State == ArticleBulkExecutionState.RecoveryRequired
                    && (next == ArticleBulkExecutionState.RecoveryRequired
                        || current.GroupCommitTerminal
                            && (next is ArticleBulkExecutionState.Completed or ArticleBulkExecutionState.Failed
                                or ArticleBulkExecutionState.Cancelled)),
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
                    or ArticleBulkExecutionState.RecoveryRequired
                && next == current.State && articleId is not null && itemReceipts.Count == 1,
            ArticleBulkJournalEventKind.CancelRequested => current.State is ArticleBulkExecutionState.Admitted or ArticleBulkExecutionState.Executing
                && !current.GroupCommitStarted && next == ArticleBulkExecutionState.Cancelling,
            ArticleBulkJournalEventKind.GroupCommitStarted => current.Strategy == ArticleBulkExecutionStrategy.AllOrNothing
                && current.State == ArticleBulkExecutionState.Executing && !current.GroupCommitStarted && next == current.State,
            ArticleBulkJournalEventKind.GroupCommitTerminal or ArticleBulkJournalEventKind.GroupReconciled => current.Strategy == ArticleBulkExecutionStrategy.AllOrNothing
                && current.State is ArticleBulkExecutionState.Executing or ArticleBulkExecutionState.RecoveryRequired
                && (kind == ArticleBulkJournalEventKind.GroupReconciled
                        && current.State == ArticleBulkExecutionState.RecoveryRequired && !current.GroupCommitStarted
                    || kind == ArticleBulkJournalEventKind.GroupCommitTerminal && (current.GroupCommitStarted
                    || groupOutcome is ArticleBulkGroupCommitOutcome.RejectedZeroWrite
                        or ArticleBulkGroupCommitOutcome.FailedZeroWrite
                    || current.State == ArticleBulkExecutionState.RecoveryRequired
                        && groupOutcome == ArticleBulkGroupCommitOutcome.UnknownRecovery))
                && (kind != ArticleBulkJournalEventKind.GroupReconciled
                    || groupOutcome != ArticleBulkGroupCommitOutcome.UnknownRecovery)
                && !current.GroupCommitTerminal
                && next == current.State && groupOutcome is not null
                && (groupOutcome switch
                {
                    ArticleBulkGroupCommitOutcome.Committed => groupReceiptDigest is not null
                        && IsContentDigest(groupReceiptDigest) && zeroWriteProofDigest is null,
                    ArticleBulkGroupCommitOutcome.RejectedZeroWrite or ArticleBulkGroupCommitOutcome.FailedZeroWrite =>
                        groupReceiptDigest is null && zeroWriteProofDigest is not null
                        && IsContentDigest(zeroWriteProofDigest),
                    ArticleBulkGroupCommitOutcome.UnknownRecovery => groupReceiptDigest is null
                        && zeroWriteProofDigest is null,
                    _ => false
                }),
            ArticleBulkJournalEventKind.ReceiptChunkRecorded => (current.Strategy == ArticleBulkExecutionStrategy.AllOrNothing
                    && ((current.State == ArticleBulkExecutionState.Executing && current.GroupCommitTerminal)
                        || (current.State == ArticleBulkExecutionState.Cancelling && !current.GroupCommitStarted)
                        || current.State == ArticleBulkExecutionState.RecoveryRequired)
                    && next == current.State && itemReceipts.Count is > 0 and <= ReceiptChunkSize)
                || (current.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
                    && (current.State is ArticleBulkExecutionState.Executing or ArticleBulkExecutionState.Cancelling
                        or ArticleBulkExecutionState.RecoveryRequired)
                    && next == current.State
                    && itemReceipts.Count is > 0 and <= ReceiptChunkSize
                    && itemReceipts.All(static receipt =>
                        receipt.ExecutionStatus == ArticleBulkItemStatus.Cancelled)),
            ArticleBulkJournalEventKind.RetryRequested => current.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
                && (current.State is ArticleBulkExecutionState.Partial or ArticleBulkExecutionState.Failed
                    or ArticleBulkExecutionState.Cancelled)
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
        if (legal && kind == ArticleBulkJournalEventKind.ExecutionTerminal
            && (groupOutcome != aggregateReceipt!.GroupCommitOutcome
                || groupReceiptDigest != aggregateReceipt.GroupReceiptDigest
                || zeroWriteProofDigest != aggregateReceipt.ZeroWriteProofDigest
                || current.Strategy == ArticleBulkExecutionStrategy.AllOrNothing && current.GroupCommitTerminal
                    && current.GroupCommitOutcome != aggregateReceipt.GroupCommitOutcome))
        {
            legal = false;
        }
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
                journalEvent.GroupCommitOutcome,
                journalEvent.GroupReceiptDigest,
                journalEvent.ZeroWriteProofDigest,
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
            journalEvent.GroupReceiptDigest,
            journalEvent.ZeroWriteProofDigest,
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
                || IsGroupTerminalKind(journalEvent.Kind),
            GroupCommitOutcome = IsGroupTerminalKind(journalEvent.Kind)
                ? journalEvent.GroupCommitOutcome
                : current.GroupCommitOutcome,
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
        journalEvent with
        {
            ContentDigest = ArticleBulkDigest.Of(journalEvent with
            {
                ContentDigest = string.Empty
            })
        };

    private static ArticleBulkJournalHead SealHead(ArticleBulkJournalHead head) =>
        head with
        {
            ContentDigest = ArticleBulkDigest.Of(head with
            {
                ContentDigest = string.Empty
            })
        };

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

    private static void ValidateConfirmation(
        ArticleBulkPlan plan,
        ArticleBulkPlanConfirmation confirmation)
    {
        if (!IsBoundedOpaqueValue(confirmation.ConfirmationIdentity, 256)
            || confirmation.PlanIdentity != plan.PlanIdentity
            || confirmation.PlanDigest != plan.ContentDigest
            || confirmation.ActorAuthorityDigest != plan.Actor.AuthorityDigest
            || confirmation.ConfirmedAtUtc.Offset != TimeSpan.Zero
            || confirmation.ConfirmedAtUtc < plan.CreatedAtUtc
            || confirmation.ConfirmedAtUtc >= plan.ExpiresAtUtc
            || confirmation.ContentDigest != ArticleBulkDigest.Of(confirmation with
            {
                ContentDigest = string.Empty
            }))
        {
            throw new ArticleBulkContractException("article-bulk.confirmation-invalid");
        }
    }

    private static void ValidateExecutionAuthoritySnapshot(
        ArticleBulkPlan plan,
        ArticleBulkExecutionAuthoritySnapshot snapshot)
    {
        bool requiresZeroWriteProof = !plan.Executable
            && plan.Strategy == ArticleBulkExecutionStrategy.AllOrNothing;
        if (snapshot.PolicyDigest != plan.PolicyDigest
            || snapshot.PermissionPolicyDigest != plan.PermissionPolicyDigest
            || !IsContentDigest(snapshot.AuthorityReceiptDigest)
            || requiresZeroWriteProof != IsContentDigest(snapshot.ZeroWriteProofDigest))
        {
            throw new ArticleBulkContractException("article-bulk.execution-authority-drift");
        }
    }

    private static bool IsBoundedOpaqueValue(string value, int maximumLength) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length <= maximumLength
        && value.All(static character => !char.IsControl(character));

    private static bool IsContentDigest(string? value) =>
        value is not null
        && value.Length == 71
        && value.StartsWith("sha256:", StringComparison.Ordinal)
        && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    private sealed record ArticleBulkPlanBinding(
        ArticleBulkOperation Operation,
        FrozenDictionary<string, ArticleBulkPlanItem> EligibleItems);
    internal async Task<ArticleBulkReconciliationResult?> ReadReconciliationAsync(
        ArticleBulkExecutionRequest originalRequest,
        ArticleBulkPlan plan,
        ArticleBulkJournalHead originalHead,
        CancellationToken cancellationToken = default)
    {
        await VerifyExecutionAsync(originalRequest, plan, originalHead, cancellationToken).ConfigureAwait(false);
        ArticleBulkIdempotencyResolution original = await journalAuthority.ResolveIdempotencyAsync(
            originalRequest.IdempotencyKey, originalRequest.ExecutionIdentityDigest, cancellationToken).ConfigureAwait(false);
        if (plan.Strategy != ArticleBulkExecutionStrategy.AllOrNothing
            || original.TerminalReceipt?.GroupCommitOutcome != ArticleBulkGroupCommitOutcome.UnknownRecovery)
        {
            return null;
        }
        ArticleBulkExecutionRequest request = ReconciliationRequest(originalRequest, original.TerminalReceipt);
        ArticleBulkIdempotencyResolution resolution = await journalAuthority.ResolveIdempotencyAsync(
            request.IdempotencyKey, request.ExecutionIdentityDigest, cancellationToken).ConfigureAwait(false);
        if (resolution.Kind == ArticleBulkIdempotencyKind.Missing)
        {
            return null;
        }
        ValidateReconciliationBinding(request, resolution);
        if (resolution.Kind == ArticleBulkIdempotencyKind.Terminal)
        {
            await VerifyExecutionAsync(request, plan, resolution.Head!, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            await VerifyJournalAsync(resolution.Head!, cancellationToken).ConfigureAwait(false);
        }
        return new ArticleBulkReconciliationResult(originalRequest.ContentDigest, original.TerminalReceipt.ContentDigest,
            request, resolution.Head!, resolution.TerminalReceipt);
    }

    private async Task ReconcileUnknownAsync(
        ArticleBulkExecutionRequest originalRequest,
        ArticleBulkPlan plan,
        ArticleBulkJournalHead originalHead,
        ArticleBulkAggregateReceipt originalTerminal,
        CancellationToken cancellationToken)
    {
        // Always read using the original identity/checkpoint, even after a sealed unknown terminal or restart.
        // This interface cannot prepare, commit, retry, query selection, or manufacture a zero-write conclusion.
        ArticleBulkGroupRecoveryEvidence? evidence = await executionAuthority.ReadGroupRecoveryAsync(
            originalRequest, plan, originalHead, cancellationToken).ConfigureAwait(false);
        if (evidence is null)
        {
            return;
        }
        bool proofShapeValid = evidence.Outcome switch
        {
            ArticleBulkGroupCommitOutcome.Committed => IsContentDigest(evidence.GroupReceiptDigest)
                && evidence.ZeroWriteProofDigest is null,
            ArticleBulkGroupCommitOutcome.RejectedZeroWrite or ArticleBulkGroupCommitOutcome.FailedZeroWrite =>
                evidence.GroupReceiptDigest is null && IsContentDigest(evidence.ZeroWriteProofDigest),
            ArticleBulkGroupCommitOutcome.UnknownRecovery => evidence.GroupReceiptDigest is null
                && evidence.ZeroWriteProofDigest is null,
            _ => false
        };
        if (evidence.ExecutionIdentityDigest != originalRequest.ExecutionIdentityDigest
            || evidence.PlanDigest != plan.ContentDigest || !proofShapeValid)
        {
            throw new ArticleBulkContractException("article-bulk.group-recovery-unbound");
        }
        if (evidence.Outcome == ArticleBulkGroupCommitOutcome.UnknownRecovery)
        {
            return;
        }
        await executionAuthority.ValidateGroupOutcomeAsync(plan, evidence.Outcome, evidence.GroupReceiptDigest,
            evidence.ZeroWriteProofDigest, cancellationToken).ConfigureAwait(false);
        ArticleBulkExecutionRequest request = ReconciliationRequest(originalRequest, originalTerminal);
        ArticleBulkIdempotencyResolution resolution = await journalAuthority.ResolveIdempotencyAsync(
            request.IdempotencyKey, request.ExecutionIdentityDigest, cancellationToken).ConfigureAwait(false);
        if (resolution.Kind == ArticleBulkIdempotencyKind.Missing)
        {
            ArticleBulkJournalEvent first = SealEvent(new ArticleBulkJournalEvent(request.AttemptId, 0,
                ArticleBulkJournalEventKind.Planned, ArticleBulkExecutionState.Planned, request.RequestedAtUtc,
                string.Empty, null, null, null, null, 0, 0, 0, 0, "canonical-reconciliation-observation",
                null, null, null, null, null, string.Empty));
            ArticleBulkJournalHead initial = SealHead(originalHead with
            {
                IdempotencyKeyDigest = ArticleBulkDigest.Of(request.IdempotencyKey),
                State = ArticleBulkExecutionState.Planned,
                EventCount = 1,
                LastEventDigest = first.ContentDigest,
                ActiveArticleIds = [],
                AdmittedCount = 0,
                SucceededCount = 0,
                FailedCount = 0,
                CancelledCount = 0,
                GroupCommitStarted = false,
                GroupCommitTerminal = false,
                GroupCommitOutcome = null,
                ContentDigest = string.Empty
            });
            try
            {
                ArticleBulkJournalAppendReceipt created = await journalAuthority.CreateAsync(request.IdempotencyKey,
                    request, first, initial, cancellationToken).ConfigureAwait(false);
                ValidateAppendReceipt(created, first, initial);
            }
            catch (ArticleBulkContractException exception) when (exception.Code == "article-bulk.idempotency-conflict")
            {
                // Concurrent observers share the same deterministic journal, never a fresh business attempt.
            }
            resolution = await journalAuthority.ResolveIdempotencyAsync(request.IdempotencyKey,
                request.ExecutionIdentityDigest, cancellationToken).ConfigureAwait(false);
        }
        ValidateReconciliationBinding(request, resolution);
        ArticleBulkJournalHead head = resolution.Head!;
        await VerifyJournalAsync(head, cancellationToken).ConfigureAwait(false);
        ArticleBulkJournalEvent? prior = await ReadGroupTerminalAsync(head, cancellationToken).ConfigureAwait(false);
        if (prior is not null && (prior.GroupCommitOutcome != evidence.Outcome
            || prior.GroupReceiptDigest != evidence.GroupReceiptDigest
            || prior.ZeroWriteProofDigest != evidence.ZeroWriteProofDigest))
        {
            throw new ArticleBulkContractException("article-bulk.group-recovery-unbound");
        }
        if (resolution.Kind == ArticleBulkIdempotencyKind.Terminal)
        {
            await VerifyExecutionAsync(request, plan, head, cancellationToken).ConfigureAwait(false);
            return;
        }
        if (head.State == ArticleBulkExecutionState.Planned)
        {
            (head, _) = await AppendAsync(head, plan, ArticleBulkJournalEventKind.Admitted,
                ArticleBulkExecutionState.Admitted, reasonCode: "read-only-canonical-observation",
                cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        if (head.State == ArticleBulkExecutionState.Admitted)
        {
            (head, _) = await AppendAsync(head, plan, ArticleBulkJournalEventKind.ExecutionStarted,
                ArticleBulkExecutionState.Executing, reasonCode: "read-only-canonical-observation",
                cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        await ResumeAtomicAsync(request, plan, head, cancellationToken, evidence, reconciliation: true).ConfigureAwait(false);
    }

    private static ArticleBulkExecutionRequest ReconciliationRequest(
        ArticleBulkExecutionRequest original,
        ArticleBulkAggregateReceipt terminal)
    {
        // Preserve the canonical transaction/attempt identity so owner receipts stay byte-for-byte unchanged.
        // The storage key and immutable request purpose distinguish this observation from business execution.
        string reference = ReconciliationPrefix + original.ContentDigest + "|" + terminal.ContentDigest;
        ArticleBulkExecutionRequest request = original with
        {
            IdempotencyKey = ReconciliationPrefix + ArticleBulkDigest.Of(reference),
            PlanReference = reference,
            ContentDigest = string.Empty
        };
        return request with
        {
            ContentDigest = ArticleBulkDigest.Of(request)
        };
    }

    internal static void ValidateReconciliationRequestShape(ArticleBulkExecutionRequest request)
    {
        string[] components = request.PlanReference.StartsWith(ReconciliationPrefix, StringComparison.Ordinal)
            ? request.PlanReference[ReconciliationPrefix.Length..].Split('|') : [];
        if (components.Length != 2 || !IsContentDigest(components[0]) || !IsContentDigest(components[1])
            || request.IdempotencyKey != ReconciliationPrefix + ArticleBulkDigest.Of(request.PlanReference)
            || request.ContentDigest != ArticleBulkDigest.Of(request with
            {
                ContentDigest = string.Empty
            }))
        {
            throw new ArticleBulkContractException("article-bulk.reconciliation-scope-unbound");
        }
    }

    private static void ValidateReconciliationBinding(
        ArticleBulkExecutionRequest expected,
        ArticleBulkIdempotencyResolution resolution)
    {
        if (resolution.Kind is not (ArticleBulkIdempotencyKind.InProgress or ArticleBulkIdempotencyKind.Terminal)
            || resolution.ExistingRequest?.ContentDigest != expected.ContentDigest
            || resolution.Head is null || resolution.Head.AttemptId != expected.AttemptId
            || resolution.Head.ExecutionIdentityDigest != expected.ExecutionIdentityDigest
            || resolution.Head.IdempotencyKeyDigest != ArticleBulkDigest.Of(expected.IdempotencyKey)
            || resolution.Head.GroupCommitStarted)
        {
            throw new ArticleBulkContractException("article-bulk.reconciliation-scope-unbound");
        }
    }

    private async Task<ArticleBulkJournalHead> ResumeAtomicAsync(
        ArticleBulkExecutionRequest request,
        ArticleBulkPlan plan,
        ArticleBulkJournalHead head,
        CancellationToken cancellationToken,
        ArticleBulkGroupRecoveryEvidence? suppliedEvidence = null,
        bool reconciliation = false)
    {
        if (head.State is ArticleBulkExecutionState.Planned or ArticleBulkExecutionState.Admitted)
        {
            return head;
        }
        ArticleBulkJournalEvent? group = await ReadGroupTerminalAsync(head, cancellationToken).ConfigureAwait(false);
        if (head.State != ArticleBulkExecutionState.RecoveryRequired)
        {
            (head, _) = await AppendAsync(head, plan, ArticleBulkJournalEventKind.RecoveryRequired,
                ArticleBulkExecutionState.RecoveryRequired, reasonCode: "atomic-evidence-finalization-pending",
                cancellationToken: cancellationToken).ConfigureAwait(false);
        }

        var existing = new Dictionary<string, ArticleBulkItemReceipt>(StringComparer.Ordinal);
        var digests = new List<string>(plan.Impact.EligibleCount);
        await foreach (ArticleBulkItemReceipt receipt in journalAuthority.ReadItemReceiptsAsync(head, cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (existing.Count == 10_000 || !existing.TryAdd(receipt.ArticleId, receipt))
            {
                throw new ArticleBulkContractException("article-bulk.receipts-unbounded");
            }
            digests.Add(receipt.ContentDigest);
        }

        ArticleBulkGroupRecoveryEvidence? evidence = suppliedEvidence;
        if (group is null || existing.Count < plan.Impact.EligibleCount)
        {
            // Absence of an adapter is unresolved evidence, never permission to execute again.
            evidence ??= await executionAuthority.ReadGroupRecoveryAsync(request, plan, head, cancellationToken)
                .ConfigureAwait(false);
            if (evidence is not null && (evidence.ExecutionIdentityDigest != request.ExecutionIdentityDigest
                    || evidence.PlanDigest != plan.ContentDigest
                    || group is not null && group.GroupCommitOutcome != ArticleBulkGroupCommitOutcome.UnknownRecovery
                        && (evidence.Outcome != group.GroupCommitOutcome
                        || evidence.GroupReceiptDigest != group.GroupReceiptDigest
                        || evidence.ZeroWriteProofDigest != group.ZeroWriteProofDigest)))
            {
                throw new ArticleBulkContractException("article-bulk.group-recovery-unbound");
            }
            // A sealed unknown marker is historical. Later known evidence belongs to a new observation journal.
            if (group?.GroupCommitOutcome == ArticleBulkGroupCommitOutcome.UnknownRecovery)
            {
                evidence = null;
            }
        }
        if (group is null)
        {
            ArticleBulkGroupCommitOutcome outcome = evidence?.Outcome ?? ArticleBulkGroupCommitOutcome.UnknownRecovery;
            (head, _) = await AppendAsync(head, plan, reconciliation
                    ? ArticleBulkJournalEventKind.GroupReconciled : ArticleBulkJournalEventKind.GroupCommitTerminal,
                head.State, commandOwner: ArticleBulkOperationRegistry.Get(plan.OperationId).CommandOwner,
                commandReceiptDigest: evidence?.GroupReceiptDigest, groupOutcome: outcome,
                groupReceiptDigest: evidence?.GroupReceiptDigest, zeroWriteProofDigest: evidence?.ZeroWriteProofDigest,
                reasonCode: outcome == ArticleBulkGroupCommitOutcome.UnknownRecovery
                    ? "preparation-or-command-conclusion-unproved" : "canonical-group-reconciled",
                cancellationToken: cancellationToken, reconciliationRequest: reconciliation ? request : null)
                .ConfigureAwait(false);
            group = await ReadGroupTerminalAsync(head, cancellationToken).ConfigureAwait(false)
                ?? throw new ArticleBulkContractException("article-bulk.group-recovery-unbound");
        }

        var chunk = new List<ArticleBulkItemReceipt>(ReceiptChunkSize);
        if (group.GroupCommitOutcome == ArticleBulkGroupCommitOutcome.UnknownRecovery)
        {
            foreach (ArticleBulkPlanItem item in plan.Items)
            {
                if (item.Status != ArticleBulkPlanItemStatus.Eligible || existing.ContainsKey(item.ArticleId))
                {
                    continue;
                }
                chunk.Add(CreateDecisionReceipt(request, plan, ArticleBulkOperationRegistry.Get(plan.OperationId),
                    item, ArticleBulkItemStatus.RecoveryRequired, "group-release-or-command-outcome-unknown"));
                if (chunk.Count == ReceiptChunkSize)
                {
                    await FlushAsync().ConfigureAwait(false);
                }
            }
        }
        else if (existing.Count < plan.Impact.EligibleCount)
        {
            if (evidence is null)
            {
                return head;
            }
            using IEnumerator<ArticleBulkPlanItem> expected = plan.Items
                .Where(static item => item.Status == ArticleBulkPlanItemStatus.Eligible).GetEnumerator();
            await foreach (ArticleBulkItemReceipt receipt in evidence.ItemReceipts
                .WithCancellation(cancellationToken).ConfigureAwait(false))
            {
                if (!expected.MoveNext() || expected.Current.ArticleId != receipt.ArticleId)
                {
                    throw new ArticleBulkContractException("article-bulk.group-recovery-items-inexact");
                }
                ValidateRecoveryItem(receipt, expected.Current);
                if (existing.TryGetValue(receipt.ArticleId, out ArticleBulkItemReceipt? prior))
                {
                    if (prior.ContentDigest != receipt.ContentDigest)
                    {
                        throw new ArticleBulkContractException("article-bulk.group-recovery-item-conflict");
                    }
                    continue;
                }
                chunk.Add(receipt);
                if (chunk.Count == ReceiptChunkSize)
                {
                    await FlushAsync().ConfigureAwait(false);
                }
            }
            if (expected.MoveNext())
            {
                throw new ArticleBulkContractException("article-bulk.group-recovery-items-incomplete");
            }
        }
        await FlushAsync().ConfigureAwait(false);
        foreach (ArticleBulkPlanItem item in plan.Items.Where(static item => item.Status == ArticleBulkPlanItemStatus.Eligible))
        {
            if (!existing.TryGetValue(item.ArticleId, out ArticleBulkItemReceipt? receipt))
            {
                throw new ArticleBulkContractException("article-bulk.group-recovery-items-incomplete");
            }
            ValidateRecoveryItem(receipt, item);
        }

        ArticleBulkExecutionState state = group.GroupCommitOutcome == ArticleBulkGroupCommitOutcome.UnknownRecovery
            ? ArticleBulkExecutionState.RecoveryRequired
            : group.GroupCommitOutcome == ArticleBulkGroupCommitOutcome.Committed
                ? ArticleBulkExecutionState.Completed
                : head.CancelledCount == plan.Impact.EligibleCount
                    ? ArticleBulkExecutionState.Cancelled : ArticleBulkExecutionState.Failed;
        ArticleBulkAggregateReceipt aggregate = ArticleBulkExecutorProtocol.Aggregate(request, plan, head,
            digests, state, group.GroupCommitOutcome, group.GroupReceiptDigest, group.ZeroWriteProofDigest);
        (head, _) = await AppendAsync(head, plan, ArticleBulkJournalEventKind.ExecutionTerminal, state,
            groupOutcome: group.GroupCommitOutcome, groupReceiptDigest: group.GroupReceiptDigest,
            zeroWriteProofDigest: group.ZeroWriteProofDigest, aggregateReceipt: aggregate,
            reasonCode: "sealed-group-evidence-finalized", cancellationToken: cancellationToken).ConfigureAwait(false);
        await VerifyExecutionAsync(request, plan, head, cancellationToken).ConfigureAwait(false);
        return head;

        void ValidateRecoveryItem(ArticleBulkItemReceipt receipt, ArticleBulkPlanItem item)
        {
            ValidateItemReceiptShape(receipt);
            bool outcomeMatches = group.GroupCommitOutcome switch
            {
                ArticleBulkGroupCommitOutcome.Committed => receipt.ExecutionStatus == ArticleBulkItemStatus.Succeeded,
                ArticleBulkGroupCommitOutcome.UnknownRecovery => receipt.ExecutionStatus == ArticleBulkItemStatus.RecoveryRequired,
                _ => receipt.ExecutionStatus is ArticleBulkItemStatus.Failed or ArticleBulkItemStatus.Cancelled
                    && receipt.SideEffects.IsEmpty
            };
            if (!outcomeMatches || receipt.AttemptId != request.AttemptId || receipt.PlanDigest != plan.ContentDigest
                || receipt.RegistryDigest != plan.RegistryDigest || receipt.OperationId != plan.OperationId
                || receipt.ExpectedRevision != item.ExpectedRevision
                || receipt.ContentDigest != ArticleBulkDigest.Of(receipt with
                {
                    ContentDigest = string.Empty
                }))
            {
                throw new ArticleBulkContractException("article-bulk.group-recovery-item-conflict");
            }
        }

        async Task FlushAsync()
        {
            if (chunk.Count == 0)
            {
                return;
            }
            (head, _) = await AppendAsync(head, plan, ArticleBulkJournalEventKind.ReceiptChunkRecorded, head.State,
                receiptChunk: chunk, reasonCode: "atomic-recovery-item-evidence",
                cancellationToken: cancellationToken).ConfigureAwait(false);
            foreach (ArticleBulkItemReceipt receipt in chunk)
            {
                existing.Add(receipt.ArticleId, receipt);
                digests.Add(receipt.ContentDigest);
            }
            chunk.Clear();
        }
    }

    private async Task<ArticleBulkJournalEvent?> ReadGroupTerminalAsync(
        ArticleBulkJournalHead head,
        CancellationToken cancellationToken)
    {
        ArticleBulkJournalEvent? result = null;
        await foreach (IReadOnlyList<ArticleBulkJournalEvent> batch in journalAuthority
            .ReadEventBatchesAsync(head, JournalReadBatchSize, cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            foreach (ArticleBulkJournalEvent journalEvent in batch)
            {
                if (!IsGroupTerminalKind(journalEvent.Kind))
                {
                    continue;
                }
                if (result is not null)
                {
                    throw new ArticleBulkContractException("article-bulk.group-recovery-unbound");
                }
                result = journalEvent;
            }
        }
        return result;
    }

    private async Task VerifyAtomicOutcomeAsync(
        ArticleBulkPlan plan,
        ArticleBulkJournalHead head,
        ArticleBulkAggregateReceipt aggregate,
        CancellationToken cancellationToken)
    {
        ArticleBulkJournalEvent? group = await ReadGroupTerminalAsync(head, cancellationToken).ConfigureAwait(false);
        if (aggregate.TerminalState != ArticleBulkExecutionState.Blocked
            && (group is null || aggregate.GroupCommitOutcome != group.GroupCommitOutcome
                || aggregate.GroupReceiptDigest != group.GroupReceiptDigest
                || aggregate.ZeroWriteProofDigest != group.ZeroWriteProofDigest))
        {
            throw new ArticleBulkContractException("article-bulk.group-recovery-unbound");
        }
        await executionAuthority.ValidateGroupOutcomeAsync(plan, aggregate.GroupCommitOutcome!.Value,
            aggregate.GroupReceiptDigest, aggregate.ZeroWriteProofDigest, cancellationToken).ConfigureAwait(false);
    }

    private async Task<HashSet<string>> ReadAdmittedArticleIdsAsync(
        ArticleBulkJournalHead head,
        CancellationToken cancellationToken)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        await foreach (IReadOnlyList<ArticleBulkJournalEvent> batch in journalAuthority
            .ReadEventBatchesAsync(head, JournalReadBatchSize, cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            foreach (ArticleBulkJournalEvent journalEvent in batch)
            {
                if (journalEvent.Kind == ArticleBulkJournalEventKind.ItemAdmitted)
                {
                    if (result.Count == 10_000 || !result.Add(journalEvent.ArticleId!))
                    {
                        throw new ArticleBulkContractException("article-bulk.admitted-items-inexact");
                    }
                }
            }
        }
        return result;
    }
}
