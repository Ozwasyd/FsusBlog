using System.Collections.Frozen;
using System.Collections.Immutable;

namespace FsusBlog.Server.Services.Articles.Bulk;

internal sealed record ArticleBulkItemCommand(
    ArticleBulkExecutionRequest Request,
    ArticleBulkPlan Plan,
    ArticleBulkPlanItem Item,
    string ItemIdempotencyKey);

/// <summary>
/// A receipt-bearing canonical command or producer adapter. The owner must recheck permissions,
/// expected revisions and operation preconditions inside its independent transaction, and persist
/// the item idempotency key with its business mutation and side effects. No adapter is assumed.
/// </summary>
internal interface IArticleBulkPerItemCommandAuthority
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

    Task<ArticleBulkItemReceipt> ExecuteAsync(
        ArticleBulkItemCommand command,
        CancellationToken cancellationToken);
}

/// <summary>
/// Runs one frozen item at a time through its canonical owner and seals each terminal before
/// admitting the next item. Unknown command outcomes stop execution and use journal recovery;
/// they are never fabricated as rolled-back failures or retried automatically.
/// </summary>
internal sealed class ArticleBulkPerItemExecutor(
    ArticleBulkExecutionFramework framework,
    IArticleBulkJournalAuthority journalAuthority,
    IArticleBulkPerItemCommandAuthority commandAuthority)
{
    internal async Task<ArticleBulkExecutionResult> ExecuteAsync(
        ArticleBulkPlan plan,
        ArticleBulkExecutionInput input,
        CancellationToken stopAdmission = default)
    {
        ArticleBulkOperation operation = ArticleBulkOperationRegistry.Get(plan.OperationId);
        if (operation.Strategy != ArticleBulkExecutionStrategy.PerItemIsolated
            || plan.Strategy != operation.Strategy)
        {
            throw new ArticleBulkContractException("article-bulk.per-item-strategy-mismatch");
        }
        if (commandAuthority.CommandOwner != operation.CommandOwner
            || commandAuthority.RegistryDigest != plan.RegistryDigest
            || commandAuthority.OperationIds.IsDefaultOrEmpty
            || commandAuthority.OperationIds.Distinct(StringComparer.Ordinal).Count()
                != commandAuthority.OperationIds.Length
            || !commandAuthority.OperationIds.Contains(operation.Id, StringComparer.Ordinal)
            || commandAuthority.OperationIds.Any(id =>
                ArticleBulkOperationRegistry.Get(id).CommandOwner != operation.CommandOwner
                || ArticleBulkOperationRegistry.Get(id).Strategy != operation.Strategy))
        {
            throw new ArticleBulkContractException("article-bulk.canonical-adapter-unavailable");
        }

        // Cancellation stops new admissions. An already admitted canonical transaction and its
        // journal terminal retain their own boundary even if the caller stops waiting.
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

        if (admission.ItemDecisions.IsDefault || admission.ItemDecisions.Length != plan.Impact.SelectedCount
            || !admission.ItemDecisions.Select(static decision => decision.ArticleId)
                .SequenceEqual(plan.Items.Select(static item => item.ArticleId), StringComparer.Ordinal))
        {
            throw new ArticleBulkContractException("article-bulk.item-decision-set-inexact");
        }
        FrozenDictionary<string, ArticleBulkItemExecutionDecision> decisions = admission.ItemDecisions
            .ToFrozenDictionary(static decision => decision.ArticleId, StringComparer.Ordinal);
        ArticleBulkJournalHead head = await ArticleBulkExecutorProtocol.StartAsync(
            framework,
            plan,
            admission.Head,
            boundaryToken).ConfigureAwait(false);
        var itemDigests = new List<string>(plan.Impact.EligibleCount);
        var cancelledChunk = new List<ArticleBulkItemReceipt>(ArticleBulkExecutionFramework.ReceiptChunkSize);
        foreach (ArticleBulkPlanItem item in plan.Items)
        {
            if (item.Status != ArticleBulkPlanItemStatus.Eligible)
            {
                continue;
            }
            if (stopAdmission.IsCancellationRequested)
            {
                if (head.State != ArticleBulkExecutionState.Cancelling)
                {
                    (head, _) = await framework.AppendAsync(
                        head,
                        plan,
                        ArticleBulkJournalEventKind.CancelRequested,
                        ArticleBulkExecutionState.Cancelling,
                        reasonCode: "stop-admission",
                        cancellationToken: boundaryToken).ConfigureAwait(false);
                }
                cancelledChunk.Add(ArticleBulkExecutorProtocol.CancelledBeforeAdmission(admission.Request, plan, item));
                if (cancelledChunk.Count == ArticleBulkExecutionFramework.ReceiptChunkSize)
                {
                    await FlushCancelledAsync().ConfigureAwait(false);
                }
                continue;
            }

            (head, _) = await framework.AppendAsync(
                head,
                plan,
                ArticleBulkJournalEventKind.ItemAdmitted,
                head.State,
                articleId: item.ArticleId,
                nextItemStatus: ArticleBulkItemStatus.Admitted,
                cancellationToken: boundaryToken).ConfigureAwait(false);
            (head, _) = await framework.AppendAsync(
                head,
                plan,
                ArticleBulkJournalEventKind.ItemStarted,
                head.State,
                articleId: item.ArticleId,
                commandOwner: operation.CommandOwner,
                expectedItemStatus: ArticleBulkItemStatus.Admitted,
                nextItemStatus: ArticleBulkItemStatus.Executing,
                cancellationToken: boundaryToken).ConfigureAwait(false);
            var command = new ArticleBulkItemCommand(
                admission.Request,
                plan,
                item,
                ArticleBulkDigest.Of(new
                {
                    admission.Request.ExecutionIdentityDigest,
                    item.ArticleId,
                    item.ExpectedRevision
                }));
            ArticleBulkItemReceipt receipt;
            try
            {
                ArticleBulkItemExecutionDecision decision = decisions[item.ArticleId];
                receipt = decision.RejectionReasonCode is not null
                    ? ArticleBulkExecutorProtocol.RejectedBeforeCanonicalCommand(admission.Request, plan, item, decision)
                    : await commandAuthority.ExecuteAsync(command, boundaryToken).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // A command exception supplies no rollback proof. Recovery retains the active
                // item's unknown outcome and does not execute any more business commands.
                head = await framework.ResumeAsync(admission.Request, plan, head, boundaryToken).ConfigureAwait(false);
                ArticleBulkIdempotencyResolution recovery = await journalAuthority.ResolveIdempotencyAsync(
                    input.IdempotencyKey,
                    admission.Request.ExecutionIdentityDigest,
                    boundaryToken).ConfigureAwait(false);
                return new ArticleBulkExecutionResult(admission.Request, head, recovery.TerminalReceipt);
            }
            (head, _) = await framework.AppendAsync(
                head,
                plan,
                ArticleBulkJournalEventKind.ItemTerminal,
                head.State,
                articleId: item.ArticleId,
                commandOwner: operation.CommandOwner,
                commandReceiptDigest: receipt.CanonicalCommandReceiptDigest,
                itemReceipt: receipt,
                reasonCode: receipt.ReasonCode,
                expectedItemStatus: ArticleBulkItemStatus.Executing,
                nextItemStatus: receipt.ExecutionStatus,
                cancellationToken: boundaryToken).ConfigureAwait(false);
            itemDigests.Add(receipt.ContentDigest);
            if (receipt.ExecutionStatus == ArticleBulkItemStatus.RecoveryRequired)
            {
                (head, _) = await framework.AppendAsync(
                    head,
                    plan,
                    ArticleBulkJournalEventKind.RecoveryRequired,
                    ArticleBulkExecutionState.RecoveryRequired,
                    reasonCode: "canonical-outcome-unknown",
                    cancellationToken: boundaryToken).ConfigureAwait(false);
                head = await framework.ResumeAsync(admission.Request, plan, head, boundaryToken).ConfigureAwait(false);
                ArticleBulkIdempotencyResolution recovery = await journalAuthority.ResolveIdempotencyAsync(
                    input.IdempotencyKey,
                    admission.Request.ExecutionIdentityDigest,
                    boundaryToken).ConfigureAwait(false);
                return new ArticleBulkExecutionResult(admission.Request, head, recovery.TerminalReceipt);
            }
        }
        await FlushCancelledAsync().ConfigureAwait(false);

        ArticleBulkExecutionState state = head.SucceededCount > 0
            ? head.FailedCount + head.CancelledCount > 0
                ? ArticleBulkExecutionState.Partial
                : ArticleBulkExecutionState.Completed
            : head.FailedCount > 0 ? ArticleBulkExecutionState.Failed : ArticleBulkExecutionState.Cancelled;
        ArticleBulkAggregateReceipt aggregate = ArticleBulkExecutorProtocol.Aggregate(
            admission.Request,
            plan,
            head,
            itemDigests,
            state);
        (head, _) = await framework.AppendAsync(
            head,
            plan,
            ArticleBulkJournalEventKind.ExecutionTerminal,
            state,
            aggregateReceipt: aggregate,
            reasonCode: "item-terminals-sealed",
            cancellationToken: boundaryToken).ConfigureAwait(false);
        await framework.VerifyExecutionAsync(admission.Request, plan, head, boundaryToken).ConfigureAwait(false);
        return new ArticleBulkExecutionResult(admission.Request, head, aggregate);

        async Task FlushCancelledAsync()
        {
            if (cancelledChunk.Count == 0)
            {
                return;
            }
            (head, _) = await framework.AppendAsync(
                head,
                plan,
                ArticleBulkJournalEventKind.ReceiptChunkRecorded,
                head.State,
                receiptChunk: cancelledChunk,
                reasonCode: "not-executed-cancelled",
                cancellationToken: boundaryToken).ConfigureAwait(false);
            itemDigests.AddRange(cancelledChunk.Select(static receipt => receipt.ContentDigest));
            cancelledChunk.Clear();
        }
    }
}
