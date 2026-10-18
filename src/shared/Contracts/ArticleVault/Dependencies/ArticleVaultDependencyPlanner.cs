using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

namespace FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

/// <summary>Actual per-article observations supplied by canonical adapters; no URL/path/DOM reconstruction is accepted.</summary>
public sealed record VaultDependencyPlanInput(
    PortableDependencyManifest Manifest,
    ReadOnlyMemory<byte> SourceBytes,
    IReadOnlyList<VaultDependencyNode> CurrentAuthorityNodes,
    IReadOnlyList<VaultDependencyEdge> CurrentAuthorityEdges,
    string CurrentRelationSha256);

/// <summary>Returns a whole extension or one fail-closed blocker; there is no partial article admission.</summary>
public sealed record VaultDependencyPlanBuildResult(ArticleVaultDependencyPlan? Plan, string? ReasonCode);

/// <summary>Freezes dependency coordinates before the existing sync plan can reach a later writer.</summary>
public static class ArticleVaultDependencyPlanner
{
    public static VaultDependencyPlanBuildResult Build(
        ArticleVaultSyncPlan? syncPlan,
        ArticleVaultPlanRequest? request,
        ArticleVaultPlanVerificationContext? context,
        IReadOnlyList<VaultDependencyPlanInput>? inputs,
        ArticleEmbedResolutionBudgetLimits budgets,
        TimeProvider? timeProvider = null)
    {
        if (request is null || context is null)
        {
            return Failed("portable_dependency_current_plan_input_missing");
        }
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
                || string.IsNullOrEmpty(input.Manifest.Binding.PortableArticleIdentity)
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
                    articles[item.PortableArticleIdentity], input.SourceBytes.Span, input.CurrentAuthorityNodes, input.CurrentAuthorityEdges,
                    input.CurrentRelationSha256, budgets, time, item.Server);
                if (!validation.IsValid)
                {
                    return Failed(validation.ReasonCode!);
                }
                if (input.Manifest.Coordinates.Base != item.Base || input.Manifest.Coordinates.Local != item.Local
                    || input.Manifest.Coordinates.Server != item.Server
                    || input.Manifest.SourceSide != RequiredSide(item.Decision))
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
                totalNodes += input.Manifest.Nodes.Count + 1L;
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
        plan = plan with
        {
            ContentSha256 = PortableDependencyCodec.PlanDigest(plan)
        };
        return time.GetElapsedTime(started).TotalMilliseconds > budgets.MaxElapsedMilliseconds
            ? Failed("portable_dependency_time_exceeded")
            : new(plan, null);
    }

    /// <summary>Checks an extension seal without establishing current server or dependency authorization.</summary>
    public static ArticleVaultValidationResult ValidateStructure(ArticleVaultDependencyPlan? extension)
    {
        if (extension is null || extension.Schema != PortableDependencySchemas.PlanExtension
            || extension.SchemaVersion != PortableDependencySchemas.Version || extension.Items is null
            || extension.OperationOrder is null || !ArticleEmbedAuthoringContractValidator.ValidateBudgets(extension.Budgets).IsValid
            || !ArticleEmbedContractDigest.IsSha256(extension.SyncPlanSha256)
            || extension.Items.Count > extension.Budgets.MaxExpandedNodes)
        {
            return ArticleVaultValidationResult.Invalid("portable_dependency_extension_invalid");
        }
        TimeProvider time = TimeProvider.System;
        long started = time.GetTimestamp();
        long totalNodes = 0;
        long totalEdges = 0;
        long totalBytes = 0;
        HashSet<string> operations = new(StringComparer.Ordinal);
        HashSet<string> articles = new(StringComparer.Ordinal);
        foreach (VaultDependencyPlanItem? item in extension.Items)
        {
            if (item is null || item.DependencyOrder is null || string.IsNullOrEmpty(item.OperationIdentity)
                || string.IsNullOrEmpty(item.GroupIdentity) || string.IsNullOrEmpty(item.PortableArticleIdentity)
                || !operations.Add(item.OperationIdentity) || !articles.Add(item.PortableArticleIdentity)
                || !PortableDependencyVerifier.ValidateStructure(item.Manifest).IsValid
                || item.Manifest.Binding.SiteIdentity != extension.SiteIdentity
                || item.Manifest.Binding.VaultIdentity != extension.VaultIdentity
                || item.Manifest.Binding.PortableArticleIdentity != item.PortableArticleIdentity)
            {
                return ArticleVaultValidationResult.Invalid("portable_dependency_extension_invalid");
            }
            ArticleVaultValidationResult graph = PortableDependencyVerifier.VerifyBudgets(item.Manifest, extension.Budgets, out IReadOnlyList<string> order);
            if (!graph.IsValid || !item.DependencyOrder.SequenceEqual(order, StringComparer.Ordinal))
            {
                return ArticleVaultValidationResult.Invalid("portable_dependency_extension_order_invalid");
            }
            totalNodes += item.Manifest.Nodes.Count + 1L;
            totalEdges += item.Manifest.Edges.Count;
            totalBytes += item.Manifest.Source.ByteLength + item.Manifest.Nodes.Sum(static node => node switch
            {
                VaultAssetDependency asset => asset.SizeBytes,
                VaultFrozenEmbedDependency embed => embed.FrozenSourceByteLength,
                _ => 0L
            });
            if (totalNodes > extension.Budgets.MaxExpandedNodes || totalEdges > extension.Budgets.MaxAuthorityMessages
                || totalBytes > extension.Budgets.MaxSourceBytes)
            {
                return ArticleVaultValidationResult.Invalid("portable_dependency_size_exceeded");
            }
        }
        if (extension.OperationOrder.Any(static operation => operation is null)
            || extension.OperationOrder.Count != operations.Count
            || !operations.SetEquals(extension.OperationOrder)
            || extension.ContentSha256 != PortableDependencyCodec.PlanDigest(extension)
            || time.GetElapsedTime(started).TotalMilliseconds > extension.Budgets.MaxElapsedMilliseconds)
        {
            return ArticleVaultValidationResult.Invalid("portable_dependency_plan_tamper_or_drift");
        }
        return ArticleVaultValidationResult.Valid();
    }

    /// <summary>Revalidates the canonical plan and all current authority facts, then independently compares the frozen extension.</summary>
    public static ArticleVaultValidationResult VerifyCurrent(
        ArticleVaultDependencyPlan? extension,
        ArticleVaultSyncPlan? syncPlan,
        ArticleVaultPlanRequest? request,
        ArticleVaultPlanVerificationContext? context,
        IReadOnlyList<VaultDependencyPlanInput> inputs,
        ArticleEmbedResolutionBudgetLimits budgets,
        TimeProvider? timeProvider = null)
    {
        ArticleVaultValidationResult structure = ValidateStructure(extension);
        if (!structure.IsValid)
        {
            return structure;
        }
        if (extension!.Budgets != budgets)
        {
            return ArticleVaultValidationResult.Invalid("portable_dependency_extension_budgets_drift");
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
