using System.Collections.Immutable;

namespace FsusBlog.Server.Services.Articles.Bulk;

internal sealed record ArticleBulkAtomicCommand(
    ArticleBulkExecutionRequest Request,
    ArticleBulkPlan Plan,
    string GroupIdempotencyKey);

internal sealed record ArticleBulkAtomicOutcome(
    ArticleBulkGroupCommitOutcome Outcome,
    string ReasonCode,
    string? GroupReceiptDigest,
    string? ZeroWriteProofDigest,
    IAsyncEnumerable<ArticleBulkItemReceipt> ItemReceipts,
    bool CancelledBeforeCommit = false);

internal sealed record ArticleBulkAtomicPreparation(
    IArticleBulkAtomicPreparedCommand? Prepared,
    ArticleBulkAtomicOutcome? Rejection);

/// <summary>
/// A canonical whole-set transaction reservation. Commit is one business transaction, including
/// side-effect obligations and idempotency persistence. Abort must release preparation and return
/// independently verifiable authority snapshots proving zero business writes. Dispose releases
/// resources; it is not evidence of rollback. Unknown outcomes must never be reported as zero writes.
/// </summary>
internal interface IArticleBulkAtomicPreparedCommand : IAsyncDisposable
{
    string PreparationReceiptDigest
    {
        get;
    }

    Task<ArticleBulkAtomicOutcome> CommitAsync(CancellationToken cancellationToken);
    Task<ArticleBulkAtomicOutcome> AbortAsync(CancellationToken cancellationToken);
}

/// <summary>
/// The canonical lifecycle or schedule owner's atomic adapter. Preparation must lock and recheck
/// the exact frozen revisions, permissions and side-effect feasibility without visible mutations.
/// Cancellation returns a proved rejection after release; an exception supplies no zero-write proof.
/// Unsupported operations or budgets are rejected before PrepareAsync is invoked.
/// </summary>
internal interface IArticleBulkAtomicCommandAuthority
{
    string CommandOwner
    {
        get;
    }
    ImmutableArray<string> OperationIds
    {
        get;
    }
    string RegistryDigest
    {
        get;
    }
    int MaximumAtomicItems
    {
        get;
    }

    Task<ArticleBulkAtomicPreparation> PrepareAsync(
        ArticleBulkAtomicCommand command,
        CancellationToken cancellationToken);
}

/// <summary>
/// Executes a frozen set through one canonical prepare/commit owner. It never chunks business
/// commits, compensates, or falls back to single-article commands. Only receipts are paged.
/// </summary>
internal sealed class ArticleBulkAtomicExecutor(
    ArticleBulkExecutionFramework framework,
    IArticleBulkJournalAuthority journalAuthority,
    IArticleBulkAtomicCommandAuthority commandAuthority)
{
    internal async Task<ArticleBulkExecutionResult> ExecuteAsync(
        ArticleBulkPlan plan,
        ArticleBulkExecutionInput input,
        CancellationToken stopPreparation = default)
    {
        ArticleBulkOperation operation = ArticleBulkOperationRegistry.Get(plan.OperationId);
        if (operation.Strategy != ArticleBulkExecutionStrategy.AllOrNothing || plan.Strategy != operation.Strategy)
        {
            throw new ArticleBulkContractException("article-bulk.atomic-strategy-mismatch");
        }
        if (commandAuthority.CommandOwner != operation.CommandOwner
            || commandAuthority.RegistryDigest != plan.RegistryDigest
            || commandAuthority.OperationIds.IsDefaultOrEmpty
            || commandAuthority.OperationIds.Distinct(StringComparer.Ordinal).Count()
                != commandAuthority.OperationIds.Length
            || !commandAuthority.OperationIds.Contains(operation.Id, StringComparer.Ordinal)
            || commandAuthority.OperationIds.Any(id =>
                ArticleBulkOperationRegistry.Get(id).CommandOwner != operation.CommandOwner
                || ArticleBulkOperationRegistry.Get(id).Strategy != operation.Strategy)
            || commandAuthority.MaximumAtomicItems <= 0)
        {
            throw new ArticleBulkContractException("article-bulk.blocked-atomicity-unsupported");
        }
        if (plan.Impact.SelectedCount > commandAuthority.MaximumAtomicItems)
        {
            throw new ArticleBulkContractException("article-bulk.atomic-size-blocked");
        }

        using var boundary = new CancellationTokenSource();
        CancellationToken boundaryToken = boundary.Token;
        ArticleBulkAdmission admission = await ArticleBulkExecutorProtocol.AdmitAsync(
            framework,
            plan,
            input,
            boundaryToken).ConfigureAwait(false);
        if (admission.IsExisting || admission.ExistingTerminalReceipt is not null)
        {
            return new ArticleBulkExecutionResult(admission.Request, admission.Head, admission.ExistingTerminalReceipt);
        }
        ArticleBulkJournalHead head = await ArticleBulkExecutorProtocol.StartAsync(
            framework,
            plan,
            admission.Head,
            boundaryToken).ConfigureAwait(false);
        var command = new ArticleBulkAtomicCommand(
            admission.Request,
            plan,
            ArticleBulkDigest.Of(new
            {
                admission.Request.ExecutionIdentityDigest,
                WholeFrozenSet = plan.FrozenSetDigest
            }));
        ArticleBulkAtomicPreparation preparation;
        try
        {
            preparation = await commandAuthority.PrepareAsync(command, stopPreparation).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Without a released preparation and authority proof, even cancellation cannot be
            // labelled zero-written. The integration owner must resolve this journal explicitly.
            (head, _) = await framework.AppendAsync(
                head,
                plan,
                ArticleBulkJournalEventKind.RecoveryRequired,
                ArticleBulkExecutionState.RecoveryRequired,
                reasonCode: "prepare-release-unproved",
                cancellationToken: boundaryToken).ConfigureAwait(false);
            return new ArticleBulkExecutionResult(admission.Request, head, null);
        }
        if ((preparation.Prepared is null) == (preparation.Rejection is null))
        {
            throw new ArticleBulkContractException("article-bulk.atomic-preparation-invalid");
        }

        ArticleBulkAtomicOutcome outcome;
        if (preparation.Prepared is null)
        {
            outcome = preparation.Rejection!;
            ValidateRejectedPreparation(outcome);
        }
        else
        {
            await using IArticleBulkAtomicPreparedCommand prepared = preparation.Prepared;
            if (!IsDigest(prepared.PreparationReceiptDigest))
            {
                throw new ArticleBulkContractException("article-bulk.atomic-preparation-unbound");
            }
            if (stopPreparation.IsCancellationRequested)
            {
                outcome = await prepared.AbortAsync(boundaryToken).ConfigureAwait(false);
                ValidateRejectedPreparation(outcome);
            }
            else
            {
                (head, _) = await framework.AppendAsync(
                    head,
                    plan,
                    ArticleBulkJournalEventKind.GroupCommitStarted,
                    head.State,
                    commandOwner: operation.CommandOwner,
                    reasonCode: prepared.PreparationReceiptDigest,
                    cancellationToken: boundaryToken).ConfigureAwait(false);
                try
                {
                    outcome = await prepared.CommitAsync(boundaryToken).ConfigureAwait(false);
                }
                catch (Exception)
                {
                    head = await framework.ResumeAsync(admission.Request, plan, head, boundaryToken).ConfigureAwait(false);
                    ArticleBulkIdempotencyResolution recovery = await journalAuthority.ResolveIdempotencyAsync(
                        input.IdempotencyKey,
                        admission.Request.ExecutionIdentityDigest,
                        boundaryToken).ConfigureAwait(false);
                    return new ArticleBulkExecutionResult(admission.Request, head, recovery.TerminalReceipt);
                }
            }
        }

        if (outcome.Outcome == ArticleBulkGroupCommitOutcome.UnknownRecovery)
        {
            head = await framework.ResumeAsync(admission.Request, plan, head, boundaryToken).ConfigureAwait(false);
            ArticleBulkIdempotencyResolution recovery = await journalAuthority.ResolveIdempotencyAsync(
                input.IdempotencyKey,
                admission.Request.ExecutionIdentityDigest,
                boundaryToken).ConfigureAwait(false);
            return new ArticleBulkExecutionResult(admission.Request, head, recovery.TerminalReceipt);
        }
        if (outcome.CancelledBeforeCommit && (head.GroupCommitStarted
                || outcome.Outcome == ArticleBulkGroupCommitOutcome.Committed))
        {
            throw new ArticleBulkContractException("article-bulk.cancel-too-late");
        }
        (head, _) = await framework.AppendAsync(
            head,
            plan,
            ArticleBulkJournalEventKind.GroupCommitTerminal,
            head.State,
            commandOwner: operation.CommandOwner,
            commandReceiptDigest: outcome.GroupReceiptDigest,
            reasonCode: outcome.ReasonCode,
            groupOutcome: outcome.Outcome,
            groupReceiptDigest: outcome.GroupReceiptDigest,
            zeroWriteProofDigest: outcome.ZeroWriteProofDigest,
            cancellationToken: boundaryToken).ConfigureAwait(false);

        var itemDigests = new List<string>(plan.Impact.EligibleCount);
        var chunk = new List<ArticleBulkItemReceipt>(ArticleBulkExecutionFramework.ReceiptChunkSize);
        using IEnumerator<ArticleBulkPlanItem> expected = plan.Items
            .Where(static item => item.Status == ArticleBulkPlanItemStatus.Eligible).GetEnumerator();
        await foreach (ArticleBulkItemReceipt receipt in outcome.ItemReceipts
            .WithCancellation(boundaryToken).ConfigureAwait(false))
        {
            if (!expected.MoveNext() || expected.Current.ArticleId != receipt.ArticleId
                || receipt.ExecutionStatus != (outcome.Outcome == ArticleBulkGroupCommitOutcome.Committed
                    ? ArticleBulkItemStatus.Succeeded
                    : outcome.CancelledBeforeCommit ? ArticleBulkItemStatus.Cancelled : ArticleBulkItemStatus.Failed)
                || outcome.Outcome != ArticleBulkGroupCommitOutcome.Committed && !receipt.SideEffects.IsEmpty)
            {
                throw new ArticleBulkContractException("article-bulk.atomic-item-outcome-inexact");
            }
            chunk.Add(receipt);
            if (chunk.Count == ArticleBulkExecutionFramework.ReceiptChunkSize)
            {
                await FlushAsync().ConfigureAwait(false);
            }
        }
        if (expected.MoveNext())
        {
            throw new ArticleBulkContractException("article-bulk.atomic-item-outcome-incomplete");
        }
        await FlushAsync().ConfigureAwait(false);

        ArticleBulkExecutionState state = outcome.Outcome == ArticleBulkGroupCommitOutcome.Committed
            ? ArticleBulkExecutionState.Completed
            : outcome.CancelledBeforeCommit ? ArticleBulkExecutionState.Cancelled : ArticleBulkExecutionState.Failed;
        ArticleBulkAggregateReceipt aggregate = ArticleBulkExecutorProtocol.Aggregate(
            admission.Request,
            plan,
            head,
            itemDigests,
            state,
            outcome.Outcome,
            outcome.GroupReceiptDigest,
            outcome.ZeroWriteProofDigest);
        (head, _) = await framework.AppendAsync(
            head,
            plan,
            ArticleBulkJournalEventKind.ExecutionTerminal,
            state,
            groupOutcome: outcome.Outcome,
            groupReceiptDigest: outcome.GroupReceiptDigest,
            zeroWriteProofDigest: outcome.ZeroWriteProofDigest,
            aggregateReceipt: aggregate,
            reasonCode: outcome.ReasonCode,
            cancellationToken: boundaryToken).ConfigureAwait(false);
        await framework.VerifyExecutionAsync(admission.Request, plan, head, boundaryToken).ConfigureAwait(false);
        return new ArticleBulkExecutionResult(admission.Request, head, aggregate);

        async Task FlushAsync()
        {
            if (chunk.Count == 0)
            {
                return;
            }
            (head, _) = await framework.AppendAsync(
                head,
                plan,
                ArticleBulkJournalEventKind.ReceiptChunkRecorded,
                head.State,
                receiptChunk: chunk,
                reasonCode: outcome.ReasonCode,
                cancellationToken: boundaryToken).ConfigureAwait(false);
            itemDigests.AddRange(chunk.Select(static receipt => receipt.ContentDigest));
            chunk.Clear();
        }
    }

    private static void ValidateRejectedPreparation(ArticleBulkAtomicOutcome outcome)
    {
        if (outcome.Outcome is not (ArticleBulkGroupCommitOutcome.RejectedZeroWrite
                or ArticleBulkGroupCommitOutcome.FailedZeroWrite)
            || !IsDigest(outcome.ZeroWriteProofDigest) || outcome.GroupReceiptDigest is not null)
        {
            throw new ArticleBulkContractException("article-bulk.prepare-zero-write-unproved");
        }
    }

    private static bool IsDigest(string? value)
        => value is { Length: 71 } && value.StartsWith("sha256:", StringComparison.Ordinal)
            && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;
}
