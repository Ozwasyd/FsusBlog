using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

public interface IArticleVaultSyncPlanExecutor
{
    Task<ArticleVaultExecutionResult> ExecuteAsync(
        string planReference,
        string planSha256,
        CancellationToken cancellationToken = default);
}

public sealed class ArticleVaultSyncPlanExecutor(
    IArticleVaultExecutionStore store,
    IArticleVaultCurrentObservationAuthority observationAuthority,
    IArticleVaultCanonicalGroupWriter writer,
    TimeProvider timeProvider) : IArticleVaultSyncPlanExecutor
{
    public async Task<ArticleVaultExecutionResult> ExecuteAsync(
        string planReference,
        string planSha256,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(planReference)
            || !IsDigest(planSha256))
        {
            throw new ArticleVaultExecutionRejectedException("article_vault_execution_reference_invalid");
        }

        ArticleVaultSealedExecutionBundle bundle = await store
            .LoadSealedAsync(planReference, planSha256, CancellationToken.None)
            .ConfigureAwait(false)
            ?? throw new ArticleVaultExecutionRejectedException("article_vault_execution_bundle_not_found");
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        if (bundle.PlanReference != planReference
            || !ArticleVaultExecutionIntegrity.FixedDigestEquals(bundle.PlanSha256, planSha256))
        {
            throw new ArticleVaultExecutionRejectedException("article_vault_execution_reference_drift");
        }

        ArticleVaultExecutionResult? existing = await store
            .LoadResultAsync(bundle.Plan.ResultCandidateIdentity, CancellationToken.None)
            .ConfigureAwait(false);
        if (existing is not null)
        {
            ArticleVaultExecutionIntegrity.VerifyResult(bundle, existing);
            return existing;
        }

        long nowUnixMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        if (cancellationToken.IsCancellationRequested
            || bundle.Plan.CancellationRequested
            || bundle.Plan.Status == VaultSyncPlanStatus.Cancelled)
        {
            return await SaveTerminalAsync(bundle, [], ArticleVaultExecutionOutcome.Cancelled,
                "article_vault_execution_cancelled", nowUnixMs, CancellationToken.None).ConfigureAwait(false);
        }
        if (nowUnixMs > bundle.Plan.ExpiresAtUnixMs)
        {
            return await SaveTerminalAsync(bundle, [], ArticleVaultExecutionOutcome.Failed,
                "article_vault_plan_expired", nowUnixMs, CancellationToken.None).ConfigureAwait(false);
        }
        if (bundle.Plan.Status == VaultSyncPlanStatus.Blocked)
        {
            return await SaveTerminalAsync(bundle, [], ArticleVaultExecutionOutcome.Failed,
                "article_vault_plan_blocked", nowUnixMs, CancellationToken.None).ConfigureAwait(false);
        }

        var receipts = new List<ArticleVaultGroupResultReceipt>(bundle.Plan.Groups.Count);
        foreach (VaultSyncPlanGroup group in bundle.Plan.Groups)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                return await SaveTerminalAsync(bundle, receipts, ArticleVaultExecutionOutcome.Cancelled,
                    "article_vault_execution_cancelled", timeProvider.GetUtcNow().ToUnixTimeMilliseconds(),
                    CancellationToken.None).ConfigureAwait(false);
            }
            if (timeProvider.GetUtcNow().ToUnixTimeMilliseconds() > bundle.Plan.ExpiresAtUnixMs)
            {
                return await SaveTerminalAsync(bundle, receipts, ArticleVaultExecutionOutcome.Failed,
                    "article_vault_plan_expired", timeProvider.GetUtcNow().ToUnixTimeMilliseconds(),
                    CancellationToken.None).ConfigureAwait(false);
            }

            string groupIdempotency = ArticleVaultExecutionIntegrity.ComputeGroupIdempotency(bundle.Plan, group);
            ArticleVaultGroupResultReceipt? groupReceipt;
            try
            {
                groupReceipt = await store.LoadGroupResultAsync(
                    bundle.Plan.SiteIdentity,
                    bundle.Plan.VaultIdentity,
                    bundle.PlanSha256,
                    group.GroupIdentity,
                    groupIdempotency,
                    cancellationToken).ConfigureAwait(false);
                if (groupReceipt is null)
                {
                    IReadOnlyList<ArticleVaultCurrentArticleObservation> observations = await observationAuthority
                        .ObserveGroupAsync(bundle, group, cancellationToken)
                        .ConfigureAwait(false);
                    if (cancellationToken.IsCancellationRequested)
                    {
                        return await SaveTerminalAsync(bundle, receipts, ArticleVaultExecutionOutcome.Cancelled,
                            "article_vault_execution_cancelled", timeProvider.GetUtcNow().ToUnixTimeMilliseconds(),
                            CancellationToken.None).ConfigureAwait(false);
                    }
                    if (timeProvider.GetUtcNow().ToUnixTimeMilliseconds() > bundle.Plan.ExpiresAtUnixMs)
                    {
                        return await SaveTerminalAsync(bundle, receipts, ArticleVaultExecutionOutcome.Failed,
                            "article_vault_plan_expired", timeProvider.GetUtcNow().ToUnixTimeMilliseconds(),
                            CancellationToken.None).ConfigureAwait(false);
                    }
                    ValidateCurrentObservations(group, observations);
                    groupReceipt = await writer.ExecuteGroupAsync(
                        bundle,
                        group,
                        observations,
                        cancellationToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return await SaveTerminalAsync(bundle, receipts, ArticleVaultExecutionOutcome.Cancelled,
                    "article_vault_execution_cancelled", timeProvider.GetUtcNow().ToUnixTimeMilliseconds(),
                    CancellationToken.None).ConfigureAwait(false);
            }

            ArticleVaultExecutionIntegrity.VerifyGroupReceipt(bundle, group, groupReceipt);
            receipts.Add(groupReceipt);
            if (!groupReceipt.Committed)
            {
                return await SaveTerminalAsync(bundle, receipts, ArticleVaultExecutionOutcome.Failed,
                    groupReceipt.ReasonCode ?? "article_vault_group_failed",
                    timeProvider.GetUtcNow().ToUnixTimeMilliseconds(), CancellationToken.None).ConfigureAwait(false);
            }
        }

        ArticleVaultExecutionOutcome outcome = receipts
            .SelectMany(static receipt => receipt.Operations)
            .Any(static operation => operation.Outcome == ArticleVaultOperationOutcome.Executed)
                ? ArticleVaultExecutionOutcome.Completed
                : ArticleVaultExecutionOutcome.NoOp;
        return await SaveTerminalAsync(bundle, receipts, outcome, null,
            timeProvider.GetUtcNow().ToUnixTimeMilliseconds(), CancellationToken.None).ConfigureAwait(false);
    }

    internal static void ValidateCurrentObservations(
        VaultSyncPlanGroup group,
        IReadOnlyList<ArticleVaultCurrentArticleObservation> observations)
    {
        if (observations.Count != group.Items.Count)
        {
            throw new ArticleVaultExecutionRejectedException("article_vault_current_observation_incomplete");
        }

        for (int index = 0; index < group.Items.Count; index++)
        {
            VaultSyncPlanItem item = group.Items[index];
            ArticleVaultCurrentArticleObservation observation = observations[index];
            if (observation.PortableArticleIdentity != item.PortableArticleIdentity
                || observation.ServerArticleIdentity != item.ServerArticleIdentity
                || observation.ServerRevision != item.Preconditions.ExpectedServerRevision
                || observation.Lifecycle != item.Preconditions.ExpectedLifecycle
                || !observation.Permitted
                || observation.PermissionSha256 != item.Preconditions.ExpectedPermissionSha256
                || observation.DependencySha256 != item.Server.DependencySha256
                || observation.ContentSha256 != item.Preconditions.ServerObservationSha256
                || !IsDigest(observation.PublicationBoundarySha256)
                || !IsDigest(observation.RightsBoundarySha256))
            {
                throw new ArticleVaultExecutionRejectedException("article_vault_current_observation_drift");
            }
        }
    }

    private static bool IsDigest(string? value)
        => value is { Length: 64 }
            && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private async Task<ArticleVaultExecutionResult> SaveTerminalAsync(
        ArticleVaultSealedExecutionBundle bundle,
        IReadOnlyList<ArticleVaultGroupResultReceipt> groups,
        ArticleVaultExecutionOutcome outcome,
        string? reasonCode,
        long completedAtUnixMs,
        CancellationToken cancellationToken)
    {
        var unsigned = new ArticleVaultExecutionResult(
            ArticleVaultExecutionSchemas.Result,
            ArticleVaultExecutionSchemas.Version,
            bundle.Plan.ResultCandidateIdentity,
            bundle.Plan.SiteIdentity,
            bundle.Plan.VaultIdentity,
            bundle.PlanReference,
            bundle.PlanSha256,
            bundle.Plan.IdempotencyKey,
            outcome,
            groups,
            reasonCode,
            completedAtUnixMs,
            string.Empty);
        ArticleVaultExecutionResult result = unsigned with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealResult(unsigned)
        };
        ArticleVaultExecutionIntegrity.VerifyResult(bundle, result);
        await store.SaveResultAsync(result, cancellationToken).ConfigureAwait(false);
        ArticleVaultExecutionResult persisted = await store
            .LoadResultAsync(result.ResultReference, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new ArticleVaultExecutionRejectedException("article_vault_execution_result_missing");
        ArticleVaultExecutionIntegrity.VerifyResult(bundle, persisted);
        if (!ArticleVaultExecutionIntegrity.AreTerminalResultsEquivalent(result, persisted))
        {
            throw new ArticleVaultExecutionRejectedException("article_vault_execution_result_conflict");
        }
        return persisted;
    }
}
