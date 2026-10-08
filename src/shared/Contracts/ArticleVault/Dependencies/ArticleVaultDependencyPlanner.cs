using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

namespace FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

/// <summary>Actual per-article observations supplied by canonical adapters; no URL/path/DOM reconstruction is accepted.</summary>
public sealed record VaultDependencyPlanInput(
    PortableDependencyManifest Manifest,
    ReadOnlyMemory<byte> SourceBytes,
    IReadOnlyList<VaultDependencyNode> CurrentAuthorityNodes,
    string CurrentRelationSha256);

/// <summary>Returns a whole extension or one fail-closed blocker; there is no partial article admission.</summary>
public sealed record VaultDependencyPlanBuildResult(ArticleVaultDependencyPlan? Plan, string? ReasonCode);

/// <summary>Freezes dependency coordinates before the existing sync plan can reach a later writer.</summary>
public static class ArticleVaultDependencyPlanner
{
    public static VaultDependencyPlanBuildResult Build(
        ArticleVaultSyncPlan? syncPlan,
        ArticleVaultPlanRequest request,
        ArticleVaultPlanVerificationContext context,
        IReadOnlyList<VaultDependencyPlanInput>? inputs,
        ArticleEmbedResolutionBudgetLimits budgets,
        TimeProvider? timeProvider = null)
    {
        ArticleVaultValidationResult canonical = ArticleVaultSyncPlanVerifier.VerifyCurrent(syncPlan,
            request.RootManifest, request.ArticleManifests, request.ServerObservations, context);
        if (!canonical.IsValid)
        {
            return Failed(canonical.ReasonCode!);
        }
        if (syncPlan!.Status is VaultSyncPlanStatus.Blocked or VaultSyncPlanStatus.Cancelled)
        {
            return Failed("portable_dependency_sync_plan_blocked");
        }
        if (!ArticleEmbedAuthoringContractValidator.ValidateBudgets(budgets).IsValid || inputs is null)
        {
            return Failed("portable_dependency_inputs_or_budgets_invalid");
        }
        TimeProvider time = timeProvider ?? TimeProvider.System;
        long started = time.GetTimestamp();
        Dictionary<string, VaultDependencyPlanInput> inputMap = new(StringComparer.Ordinal);
        foreach (VaultDependencyPlanInput? input in inputs)
        {
            if (input?.Manifest?.Binding is null
                || !inputMap.TryAdd(input.Manifest.Binding.PortableArticleIdentity, input))
            {
                return Failed("portable_dependency_input_ambiguous");
            }
        }
        int itemCount = syncPlan.Groups.Sum(static group => group.Items.Count);
        if (itemCount != inputMap.Count)
        {
            return Failed("portable_dependency_membership_mismatch");
        }
        Dictionary<string, ArticleVaultArticleManifest> articles = request.ArticleManifests.ToDictionary(
            static article => article.PortableArticleIdentity, StringComparer.Ordinal);
        List<VaultDependencyPlanItem> items = [];
        long totalNodes = 0;
        long totalEdges = 0;
        long totalBytes = 0;
        foreach (VaultSyncPlanGroup group in syncPlan.Groups)
        {
            if (!group.AllOrNothing)
            {
                return Failed("portable_dependency_group_not_atomic");
            }
            foreach (VaultSyncPlanItem item in group.Items)
            {
                if (!inputMap.TryGetValue(item.PortableArticleIdentity, out VaultDependencyPlanInput? input))
                {
                    return Failed("portable_dependency_input_missing");
                }
                ArticleVaultValidationResult validation = PortableDependencyVerifier.VerifyCurrent(input.Manifest,
                    articles[item.PortableArticleIdentity], input.SourceBytes.Span, input.CurrentAuthorityNodes,
                    input.CurrentRelationSha256, budgets, time);
                if (!validation.IsValid)
                {
                    return Failed(validation.ReasonCode!);
                }
                if (input.Manifest.SourceSide != RequiredSide(item.Decision))
                {
                    return Failed("portable_dependency_source_side_mismatch");
                }
                VaultDependencyRight required = item.Decision switch
                {
                    VaultSyncDecision.PullCreate or VaultSyncDecision.PullUpdate => VaultDependencyRight.Read | VaultDependencyRight.Materialize,
                    VaultSyncDecision.PushCreate or VaultSyncDecision.PushUpdate => VaultDependencyRight.Read | VaultDependencyRight.Reference | VaultDependencyRight.Upload,
                    _ => VaultDependencyRight.Read
                };
                foreach (VaultDependencyNode node in input.Manifest.Nodes)
                {
                    VaultDependencyRight nodeRequired = node is VaultAssetDependency ? required : VaultDependencyRight.Read | VaultDependencyRight.Reference;
                    if ((node.Admission.RequiredRights & nodeRequired) != nodeRequired)
                    {
                        return Failed("portable_dependency_required_rights_missing");
                    }
                }
                totalNodes += input.Manifest.Nodes.Count;
                totalEdges += input.Manifest.Edges.Count;
                totalBytes += input.Manifest.Source.ByteLength;
                foreach (VaultDependencyNode node in input.Manifest.Nodes)
                {
                    totalBytes += node switch
                    {
                        VaultAssetDependency asset => asset.SizeBytes,
                        VaultFrozenEmbedDependency embed => embed.FrozenSourceByteLength,
                        _ => 0
                    };
                }
                if (totalNodes > budgets.MaxExpandedNodes || totalEdges > budgets.MaxAuthorityMessages
                    || totalBytes > budgets.MaxSourceBytes)
                {
                    return Failed("portable_dependency_size_exceeded");
                }
                if (time.GetElapsedTime(started).TotalMilliseconds > budgets.MaxElapsedMilliseconds)
                {
                    return Failed("portable_dependency_time_exceeded");
                }
                ArticleVaultValidationResult orderCheck = PortableDependencyVerifier.VerifyBudgets(input.Manifest, budgets, out IReadOnlyList<string> order, time);
                if (!orderCheck.IsValid)
                {
                    return Failed(orderCheck.ReasonCode!);
                }
                items.Add(new(item.OperationIdentity, group.GroupIdentity, item.PortableArticleIdentity,
                    PortableDependencyCodec.Deserialize(PortableDependencyCodec.Serialize(input.Manifest)), order));
            }
        }
        ArticleVaultDependencyPlan plan = new(PortableDependencySchemas.PlanExtension, PortableDependencySchemas.Version,
            syncPlan.ContentSha256, syncPlan.SiteIdentity, syncPlan.VaultIdentity, budgets,
            items.OrderBy(static item => item.OperationIdentity, StringComparer.Ordinal).ToArray(),
            syncPlan.OperationOrder.ToArray(), string.Empty);
        return new(plan with
        {
            ContentSha256 = PortableDependencyCodec.PlanDigest(plan)
        }, null);
    }

    /// <summary>Revalidates the canonical plan and all current authority facts, then independently compares the frozen extension.</summary>
    public static ArticleVaultValidationResult VerifyCurrent(
        ArticleVaultDependencyPlan? extension,
        ArticleVaultSyncPlan? syncPlan,
        ArticleVaultPlanRequest request,
        ArticleVaultPlanVerificationContext context,
        IReadOnlyList<VaultDependencyPlanInput> inputs,
        ArticleEmbedResolutionBudgetLimits budgets,
        TimeProvider? timeProvider = null)
    {
        if (extension is null || extension.Schema != PortableDependencySchemas.PlanExtension
            || extension.SchemaVersion != PortableDependencySchemas.Version || extension.Items is null
            || extension.OperationOrder is null || extension.Budgets != budgets)
        {
            return ArticleVaultValidationResult.Invalid("portable_dependency_extension_invalid");
        }
        VaultDependencyPlanBuildResult current = Build(syncPlan, request, context, inputs, budgets, timeProvider);
        if (current.Plan is null)
        {
            return ArticleVaultValidationResult.Invalid(current.ReasonCode!);
        }
        if (extension.ContentSha256 != PortableDependencyCodec.PlanDigest(extension)
            || extension.ContentSha256 != current.Plan.ContentSha256)
        {
            return ArticleVaultValidationResult.Invalid("portable_dependency_plan_tamper_or_drift");
        }
        return ArticleVaultValidationResult.Valid();
    }

    private static VaultDependencySourceSide RequiredSide(VaultSyncDecision decision)
        => decision switch
        {
            VaultSyncDecision.PullCreate or VaultSyncDecision.PullUpdate => VaultDependencySourceSide.Server,
            VaultSyncDecision.PushCreate or VaultSyncDecision.PushUpdate => VaultDependencySourceSide.Local,
            VaultSyncDecision.PullDelete or VaultSyncDecision.PushDelete => VaultDependencySourceSide.Base,
            _ => VaultDependencySourceSide.Local
        };

    private static VaultDependencyPlanBuildResult Failed(string reason) => new(null, reason);
}
