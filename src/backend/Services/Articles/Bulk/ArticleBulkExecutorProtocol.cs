using System.Collections.Immutable;

namespace FsusBlog.Server.Services.Articles.Bulk;

internal sealed record ArticleBulkExecutionInput(
    ArticleBulkPlanConfirmation Confirmation,
    string PlanReference,
    string AttemptId,
    string IdempotencyKey,
    ArticleBulkActor Actor,
    ArticleBulkSource Source,
    string PolicyDigest,
    string PermissionPolicyDigest);

internal sealed record ArticleBulkExecutionResult(
    ArticleBulkExecutionRequest Request,
    ArticleBulkJournalHead Head,
    ArticleBulkAggregateReceipt? Receipt);

/// <summary>
/// Builds compact result references from sealed item terminals. Business receipts must come from
/// the canonical command owner; this helper can only record a decision not to start an item.
/// </summary>
internal static class ArticleBulkExecutorProtocol
{
    internal static Task<ArticleBulkAdmission> AdmitAsync(
        ArticleBulkExecutionFramework framework,
        ArticleBulkPlan plan,
        ArticleBulkExecutionInput input,
        CancellationToken cancellationToken)
        => framework.AdmitAsync(
            plan,
            input.Confirmation,
            input.PlanReference,
            input.AttemptId,
            input.IdempotencyKey,
            input.Actor,
            input.Source,
            input.PolicyDigest,
            input.PermissionPolicyDigest,
            cancellationToken);

    internal static async Task<ArticleBulkJournalHead> StartAsync(
        ArticleBulkExecutionFramework framework,
        ArticleBulkPlan plan,
        ArticleBulkJournalHead head,
        CancellationToken cancellationToken)
    {
        (head, _) = await framework.AppendAsync(
            head,
            plan,
            ArticleBulkJournalEventKind.Admitted,
            ArticleBulkExecutionState.Admitted,
            cancellationToken: cancellationToken).ConfigureAwait(false);
        (head, _) = await framework.AppendAsync(
            head,
            plan,
            ArticleBulkJournalEventKind.ExecutionStarted,
            ArticleBulkExecutionState.Executing,
            cancellationToken: cancellationToken).ConfigureAwait(false);
        return head;
    }

    internal static ArticleBulkItemReceipt CancelledBeforeAdmission(
        ArticleBulkExecutionRequest request,
        ArticleBulkPlan plan,
        ArticleBulkPlanItem item)
        => ArticleBulkExecutionFramework.SealItemReceipt(new ArticleBulkItemReceipt(
            request.AttemptId,
            plan.ContentDigest,
            plan.RegistryDigest,
            plan.OperationId,
            item.ArticleId,
            item.ExpectedRevision!,
            null,
            null,
            item.Status,
            ArticleBulkItemStatus.Cancelled,
            "not-executed-cancelled",
            ArticleBulkOperationRegistry.Get(plan.OperationId).CommandOwner,
            ArticleBulkDigest.Of(new
            {
                request.AttemptId,
                plan.ContentDigest,
                item.ArticleId,
                NoCanonicalCommandWasAdmitted = true
            }),
            [],
            ArticleBulkDigest.Of(new
            {
                request.AttemptId,
                item.ArticleId,
                NotExecuted = true
            }),
            string.Empty));

    internal static ArticleBulkItemReceipt RejectedBeforeCanonicalCommand(
        ArticleBulkExecutionRequest request,
        ArticleBulkPlan plan,
        ArticleBulkPlanItem item,
        ArticleBulkItemExecutionDecision decision)
    {
        if (decision.PlanDigest != plan.ContentDigest || decision.ArticleId != item.ArticleId
            || decision.FrozenItemDigest != item.ContentDigest || decision.RejectionReasonCode is null
            || decision.ContentDigest != ArticleBulkDigest.Of(decision with
            {
                ContentDigest = string.Empty
            }))
        {
            throw new ArticleBulkContractException("article-bulk.item-decision-unbound");
        }
        return ArticleBulkExecutionFramework.SealItemReceipt(new ArticleBulkItemReceipt(
            request.AttemptId, plan.ContentDigest, plan.RegistryDigest, plan.OperationId, item.ArticleId,
            item.ExpectedRevision!, null, null, item.Status, ArticleBulkItemStatus.Failed,
            decision.RejectionReasonCode, ArticleBulkOperationRegistry.Get(plan.OperationId).CommandOwner,
            ArticleBulkDigest.Of(new
            {
                request.ExecutionIdentityDigest,
                decision.ContentDigest,
                DecisionKind = "pre-canonical-admission-rejected",
                NoCanonicalCommandWasAdmitted = true
            }), [], ArticleBulkDigest.Of(new
            {
                request.AttemptId,
                item.ArticleId,
                decision.ContentDigest
            }), string.Empty));
    }

    internal static ArticleBulkAggregateReceipt Aggregate(
        ArticleBulkExecutionRequest request,
        ArticleBulkPlan plan,
        ArticleBulkJournalHead head,
        IReadOnlyList<string> itemDigests,
        ArticleBulkExecutionState state,
        ArticleBulkGroupCommitOutcome? outcome = null,
        string? groupReceiptDigest = null,
        string? zeroWriteProofDigest = null)
    {
        var chunks = ImmutableArray.CreateBuilder<ArticleBulkReceiptChunk>();
        for (int offset = 0; offset < itemDigests.Count; offset += ArticleBulkExecutionFramework.ReceiptChunkSize)
        {
            var chunk = new ArticleBulkReceiptChunk(
                chunks.Count,
                [.. itemDigests.Skip(offset).Take(ArticleBulkExecutionFramework.ReceiptChunkSize)],
                string.Empty);
            chunks.Add(chunk with
            {
                ContentDigest = ArticleBulkDigest.Of(chunk)
            });
        }

        return ArticleBulkExecutionFramework.SealAggregateReceipt(new ArticleBulkAggregateReceipt(
            request.AttemptId,
            request.ContentDigest,
            plan.ContentDigest,
            plan.RegistryDigest,
            plan.OperationId,
            plan.Strategy,
            plan.FrozenSetDigest,
            plan.Impact.SelectedCount,
            plan.Impact.EligibleCount,
            head.SucceededCount,
            head.FailedCount,
            head.CancelledCount,
            state,
            outcome,
            groupReceiptDigest,
            zeroWriteProofDigest,
            plan.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
                && head.SucceededCount > 0 && head.FailedCount + head.CancelledCount > 0,
            plan.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
                && state != ArticleBulkExecutionState.RecoveryRequired
                && (head.FailedCount > 0 || plan.Impact.EligibleCount > head.AdmittedCount),
            chunks.ToImmutable(),
            string.Empty));
    }
}
