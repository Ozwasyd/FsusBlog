using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Serializes and content-addresses closed Article Vault sync plans.</summary>
public static class ArticleVaultSyncPlanCodec
{
    public static byte[] Serialize(ArticleVaultSyncPlan plan)
    {
        ArticleVaultValidationResult validation = ArticleVaultSyncPlanVerifier.ValidateStructure(plan);
        if (!validation.IsValid)
        {
            throw new InvalidDataException(validation.ReasonCode);
        }

        return ArticleVaultManifestCodec.SerializeCanonical(plan);
    }

    public static ArticleVaultSyncPlan Deserialize(ReadOnlySpan<byte> utf8)
    {
        ArticleVaultSyncPlan plan;
        try
        {
            plan = ArticleVaultManifestCodec.DeserializeCanonical<ArticleVaultSyncPlan>(utf8)
                ?? throw new InvalidDataException("article_vault_plan_missing");
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("article_vault_plan_schema_invalid", exception);
        }

        ArticleVaultValidationResult validation = ArticleVaultSyncPlanVerifier.ValidateStructure(plan);
        if (!validation.IsValid)
        {
            throw new InvalidDataException(validation.ReasonCode);
        }

        return plan;
    }

    public static string ComputeContentSha256(ArticleVaultSyncPlan plan)
        => ArticleVaultManifestCodec.ComputeSha256(
            ArticleVaultManifestCodec.SerializeCanonical(plan with
            {
                ContentSha256 = string.Empty
            }));

    public static string ComputeContentSha256(ArticleVaultServerObservation observation)
        => ArticleVaultManifestCodec.ComputeSha256(
            ArticleVaultManifestCodec.SerializeCanonical(observation with
            {
                ContentSha256 = string.Empty
            }));
}

/// <summary>Builds the single deterministic pull, push, and sync three-way plan.</summary>
public static class ArticleVaultSyncPlanner
{
    public static ArticleVaultPlanBuildResult Build(ArticleVaultPlanRequest? request)
    {
        List<string> errors = [];
        if (request is null)
        {
            return Failed("article_vault_plan_request_missing");
        }

        if (request.CreatedAtUnixMs < 0 || request.ExpiresAtUnixMs <= request.CreatedAtUnixMs)
        {
            errors.Add("article_vault_plan_time_window_invalid");
        }

        ArticleVaultValidationResult rootValidation = ArticleVaultManifestValidator.Validate(request.RootManifest);
        if (!rootValidation.IsValid)
        {
            errors.Add(rootValidation.ReasonCode!);
        }

        if (request.ArticleManifests is null
            || request.ServerObservations is null
            || request.Groups is null)
        {
            errors.Add("article_vault_plan_input_missing");
            return new ArticleVaultPlanBuildResult(null, CanonicalErrors(errors));
        }

        Dictionary<string, ArticleVaultArticleManifest> articles = CollectArticles(request.ArticleManifests, errors);
        Dictionary<string, ArticleVaultServerObservation> observations = CollectObservations(
            request.ServerObservations,
            errors);
        IReadOnlyList<NormalizedGroup> groups = NormalizeGroups(request.Groups, errors);
        string[] selectedIdentities = groups
            .SelectMany(static group => group.PortableArticleIdentities)
            .Order(StringComparer.Ordinal)
            .ToArray();

        if (selectedIdentities.Length == 0)
        {
            errors.Add("article_vault_plan_article_set_empty");
        }

        if (selectedIdentities.Distinct(StringComparer.Ordinal).Count() != selectedIdentities.Length)
        {
            errors.Add("article_vault_plan_article_membership_ambiguous");
        }

        if (!selectedIdentities.SequenceEqual(articles.Keys.Order(StringComparer.Ordinal), StringComparer.Ordinal)
            || !selectedIdentities.SequenceEqual(observations.Keys.Order(StringComparer.Ordinal), StringComparer.Ordinal))
        {
            errors.Add("article_vault_plan_article_set_mismatch");
        }

        if (rootValidation.IsValid)
        {
            foreach (string portableIdentity in selectedIdentities.Distinct(StringComparer.Ordinal))
            {
                if (!articles.TryGetValue(portableIdentity, out ArticleVaultArticleManifest? article)
                    || !observations.TryGetValue(portableIdentity, out ArticleVaultServerObservation? observation))
                {
                    continue;
                }

                ArticleVaultValidationResult binding = ArticleVaultManifestValidator.ValidateBinding(
                    request.RootManifest,
                    article);
                if (!binding.IsValid)
                {
                    errors.Add(binding.ReasonCode!);
                    continue;
                }

                ArticleVaultValidationResult observationValidation = ArticleVaultSyncPlanRules.ValidateObservation(
                    article,
                    observation);
                if (!observationValidation.IsValid)
                {
                    errors.Add(observationValidation.ReasonCode!);
                }
            }
        }

        if (errors.Count > 0)
        {
            return new ArticleVaultPlanBuildResult(null, CanonicalErrors(errors));
        }

        string idempotencyKey = ArticleVaultSyncPlanRules.ComputeIdempotencyKey(
            request.RootManifest.ContentSha256,
            request.Direction,
            request.CreatedAtUnixMs,
            request.ExpiresAtUnixMs,
            request.CancellationRequested,
            groups,
            articles,
            observations);
        string planCandidateIdentity = $"plan-{idempotencyKey[..32]}";
        string resultCandidateIdentity = $"result-{idempotencyKey[..32]}";
        List<VaultSyncPlanConflict> conflicts = [];
        List<VaultSyncPlanGroup> planGroups = [];
        List<string> operationOrder = [];
        long sequence = 0;

        foreach (NormalizedGroup group in groups)
        {
            Dictionary<string, string> operationIdentities = [];
            Dictionary<string, (VaultArticleState State, VaultSyncDecision Decision, string? Conflict)> decisions = [];
            foreach (string portableIdentity in group.TopologicalOrder)
            {
                ArticleVaultArticleManifest article = articles[portableIdentity];
                ArticleVaultServerObservation observation = observations[portableIdentity];
                VaultArticleState state = ArticleVaultSyncPlanRules.DeriveObservedState(article, observation);
                (VaultSyncDecision decision, string? conflict) = ArticleVaultSyncPlanRules.Decide(
                    state,
                    request.Direction);
                decisions.Add(portableIdentity, (state, decision, conflict));
                operationIdentities.Add(
                    portableIdentity,
                    ArticleVaultSyncPlanRules.ComputeOperationIdentity(
                        idempotencyKey,
                        group.GroupIdentity,
                        portableIdentity,
                        decision));
                if (conflict is not null)
                {
                    conflicts.Add(new VaultSyncPlanConflict(group.GroupIdentity, portableIdentity, conflict));
                }
            }

            List<VaultSyncPlanItem> items = [];
            foreach (string portableIdentity in group.TopologicalOrder)
            {
                ArticleVaultArticleManifest article = articles[portableIdentity];
                ArticleVaultServerObservation observation = observations[portableIdentity];
                (VaultArticleState state, VaultSyncDecision decision, _) = decisions[portableIdentity];
                string[] dependencies = group.Dependencies
                    .Where(dependency => dependency.DependentPortableArticleIdentity == portableIdentity)
                    .Select(dependency => operationIdentities[dependency.PrerequisitePortableArticleIdentity])
                    .Order(StringComparer.Ordinal)
                    .ToArray();
                VaultArticleCoordinate server = observation.ServerCoordinate;
                items.Add(new VaultSyncPlanItem(
                    operationIdentities[portableIdentity],
                    sequence++,
                    group.GroupIdentity,
                    portableIdentity,
                    observation.ServerArticleIdentity,
                    state,
                    decision,
                    article.Coordinates.Base,
                    article.Coordinates.Local,
                    server,
                    new VaultSyncPlanPreconditions(
                        article.ContentSha256,
                        observation.ContentSha256,
                        server.ServerRevision,
                        server.PermissionSha256,
                        server.Lifecycle),
                    dependencies));
            }

            planGroups.Add(new VaultSyncPlanGroup(
                group.GroupIdentity,
                AllOrNothing: true,
                group.PortableArticleIdentities,
                group.Dependencies,
                items));
        }

        VaultSyncPlanStatus status;
        if (request.CancellationRequested)
        {
            status = VaultSyncPlanStatus.Cancelled;
        }
        else if (conflicts.Count > 0)
        {
            status = VaultSyncPlanStatus.Blocked;
        }
        else if (planGroups.SelectMany(static group => group.Items)
            .All(static item => item.Decision == VaultSyncDecision.NoOp))
        {
            status = VaultSyncPlanStatus.NoOp;
        }
        else
        {
            status = VaultSyncPlanStatus.Ready;
        }

        if (status is VaultSyncPlanStatus.Ready or VaultSyncPlanStatus.NoOp)
        {
            operationOrder.AddRange(planGroups
                .SelectMany(static group => group.Items)
                .OrderBy(static item => item.Sequence)
                .Select(static item => item.OperationIdentity));
        }

        ArticleVaultSyncPlan unsealed = new(
            ArticleVaultPlanSchemas.Plan,
            ArticleVaultPlanSchemas.Version,
            request.RootManifest.SiteIdentity,
            request.RootManifest.VaultIdentity,
            request.RootManifest.DeviceIdentity,
            request.Direction,
            request.CreatedAtUnixMs,
            request.ExpiresAtUnixMs,
            VaultSyncCancelPolicy.BeforeExecutionOnly,
            request.CancellationRequested,
            status,
            request.RootManifest.ContentSha256,
            planGroups,
            conflicts
                .OrderBy(static conflict => conflict.GroupIdentity, StringComparer.Ordinal)
                .ThenBy(static conflict => conflict.PortableArticleIdentity, StringComparer.Ordinal)
                .ThenBy(static conflict => conflict.ReasonCode, StringComparer.Ordinal)
                .ToArray(),
            operationOrder,
            idempotencyKey,
            planCandidateIdentity,
            resultCandidateIdentity,
            string.Empty);
        ArticleVaultSyncPlan plan = unsealed with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(unsealed)
        };
        ArticleVaultValidationResult planValidation = ArticleVaultSyncPlanVerifier.ValidateStructure(plan);
        return planValidation.IsValid
            ? new ArticleVaultPlanBuildResult(plan, [])
            : Failed(planValidation.ReasonCode!);
    }

    private static Dictionary<string, ArticleVaultArticleManifest> CollectArticles(
        IReadOnlyList<ArticleVaultArticleManifest> manifests,
        List<string> errors)
    {
        Dictionary<string, ArticleVaultArticleManifest> result = new(StringComparer.Ordinal);
        foreach (ArticleVaultArticleManifest? manifest in manifests)
        {
            ArticleVaultValidationResult validation = ArticleVaultManifestValidator.Validate(manifest);
            if (!validation.IsValid)
            {
                errors.Add(validation.ReasonCode!);
                continue;
            }

            if (!result.TryAdd(manifest!.PortableArticleIdentity, manifest))
            {
                errors.Add("article_vault_plan_duplicate_article");
            }
        }

        return result;
    }

    private static Dictionary<string, ArticleVaultServerObservation> CollectObservations(
        IReadOnlyList<ArticleVaultServerObservation> observations,
        List<string> errors)
    {
        Dictionary<string, ArticleVaultServerObservation> result = new(StringComparer.Ordinal);
        foreach (ArticleVaultServerObservation? observation in observations)
        {
            if (observation is null || !ArticleVaultManifestValidator.IsIdentity(observation.PortableArticleIdentity))
            {
                errors.Add("article_vault_server_observation_identity_invalid");
                continue;
            }

            if (!result.TryAdd(observation.PortableArticleIdentity, observation))
            {
                errors.Add("article_vault_plan_duplicate_server_observation");
            }
        }

        return result;
    }

    private static IReadOnlyList<NormalizedGroup> NormalizeGroups(
        IReadOnlyList<VaultPlanGroupRequest> groups,
        List<string> errors)
    {
        List<NormalizedGroup> result = [];
        HashSet<string> groupIdentities = new(StringComparer.Ordinal);
        foreach (VaultPlanGroupRequest? group in groups)
        {
            if (group is null
                || !ArticleVaultManifestValidator.IsIdentity(group.GroupIdentity)
                || group.PortableArticleIdentities is null
                || group.Dependencies is null)
            {
                errors.Add("article_vault_plan_group_invalid");
                continue;
            }

            if (!groupIdentities.Add(group.GroupIdentity))
            {
                errors.Add("article_vault_plan_duplicate_group");
                continue;
            }

            string[] members = group.PortableArticleIdentities.Order(StringComparer.Ordinal).ToArray();
            if (members.Length == 0
                || members.Any(static identity => !ArticleVaultManifestValidator.IsIdentity(identity))
                || members.Distinct(StringComparer.Ordinal).Count() != members.Length)
            {
                errors.Add("article_vault_plan_group_membership_invalid");
                continue;
            }

            VaultPlanDependency[] dependencies = group.Dependencies
                .OrderBy(static dependency => dependency.PrerequisitePortableArticleIdentity, StringComparer.Ordinal)
                .ThenBy(static dependency => dependency.DependentPortableArticleIdentity, StringComparer.Ordinal)
                .ToArray();
            HashSet<string> memberSet = new(members, StringComparer.Ordinal);
            HashSet<string> edgeSet = new(StringComparer.Ordinal);
            bool dependencyInvalid = false;
            foreach (VaultPlanDependency? dependency in dependencies)
            {
                if (dependency is null
                    || dependency.PrerequisitePortableArticleIdentity == dependency.DependentPortableArticleIdentity
                    || !memberSet.Contains(dependency.PrerequisitePortableArticleIdentity)
                    || !memberSet.Contains(dependency.DependentPortableArticleIdentity)
                    || !edgeSet.Add(
                        $"{dependency.PrerequisitePortableArticleIdentity}\0{dependency.DependentPortableArticleIdentity}"))
                {
                    dependencyInvalid = true;
                }
            }

            if (dependencyInvalid)
            {
                errors.Add("article_vault_plan_dependency_unresolved");
                continue;
            }

            string[]? topologicalOrder = TopologicalSort(members, dependencies);
            if (topologicalOrder is null)
            {
                errors.Add("article_vault_plan_dependency_cycle");
                continue;
            }

            result.Add(new NormalizedGroup(
                group.GroupIdentity,
                members,
                dependencies,
                topologicalOrder));
        }

        return result.OrderBy(static group => group.GroupIdentity, StringComparer.Ordinal).ToArray();
    }

    private static string[]? TopologicalSort(
        IReadOnlyList<string> members,
        IReadOnlyList<VaultPlanDependency> dependencies)
    {
        Dictionary<string, int> incoming = members.ToDictionary(static identity => identity, static _ => 0, StringComparer.Ordinal);
        Dictionary<string, List<string>> outgoing = members.ToDictionary(
            static identity => identity,
            static _ => new List<string>(),
            StringComparer.Ordinal);
        foreach (VaultPlanDependency dependency in dependencies)
        {
            incoming[dependency.DependentPortableArticleIdentity]++;
            outgoing[dependency.PrerequisitePortableArticleIdentity].Add(dependency.DependentPortableArticleIdentity);
        }

        SortedSet<string> ready = new(
            incoming.Where(static pair => pair.Value == 0).Select(static pair => pair.Key),
            StringComparer.Ordinal);
        List<string> order = [];
        while (ready.Count > 0)
        {
            string current = ready.Min!;
            ready.Remove(current);
            order.Add(current);
            foreach (string dependent in outgoing[current].Order(StringComparer.Ordinal))
            {
                incoming[dependent]--;
                if (incoming[dependent] == 0)
                {
                    ready.Add(dependent);
                }
            }
        }

        return order.Count == members.Count ? order.ToArray() : null;
    }

    private static ArticleVaultPlanBuildResult Failed(string error)
        => new(null, [error]);

    private static string[] CanonicalErrors(IEnumerable<string> errors)
        => errors.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();

    internal sealed record NormalizedGroup(
        string GroupIdentity,
        IReadOnlyList<string> PortableArticleIdentities,
        IReadOnlyList<VaultPlanDependency> Dependencies,
        IReadOnlyList<string> TopologicalOrder);
}

/// <summary>Independently validates plan structure and current-input preconditions.</summary>
public static class ArticleVaultSyncPlanVerifier
{
    public static ArticleVaultValidationResult ValidateStructure(ArticleVaultSyncPlan? plan)
    {
        if (plan is null)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_plan_missing");
        }

        if (plan.Schema != ArticleVaultPlanSchemas.Plan || plan.SchemaVersion != ArticleVaultPlanSchemas.Version)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_plan_schema_unknown");
        }

        if (!ArticleVaultManifestValidator.IsIdentity(plan.SiteIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(plan.VaultIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(plan.DeviceIdentity)
            || !Enum.IsDefined(plan.Direction)
            || !Enum.IsDefined(plan.Status)
            || plan.CreatedAtUnixMs < 0
            || plan.ExpiresAtUnixMs <= plan.CreatedAtUnixMs
            || plan.CancelPolicy != VaultSyncCancelPolicy.BeforeExecutionOnly
            || plan.Groups is null
            || plan.Groups.Count == 0
            || plan.Conflicts is null
            || plan.OperationOrder is null)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_plan_header_invalid");
        }

        if (!ArticleVaultManifestValidator.IsSha256(plan.RootManifestSha256)
            || !ArticleVaultManifestValidator.IsSha256(plan.IdempotencyKey)
            || plan.PlanCandidateIdentity != $"plan-{plan.IdempotencyKey[..32]}"
            || plan.ResultCandidateIdentity != $"result-{plan.IdempotencyKey[..32]}")
        {
            return ArticleVaultValidationResult.Invalid("article_vault_plan_identity_invalid");
        }

        string? previousGroup = null;
        long expectedSequence = 0;
        HashSet<string> articleIdentities = new(StringComparer.Ordinal);
        HashSet<string> operationIdentities = new(StringComparer.Ordinal);
        List<string> canonicalOperationOrder = [];
        Dictionary<string, VaultSyncPlanItem> itemsByArticle = new(StringComparer.Ordinal);
        foreach (VaultSyncPlanGroup? group in plan.Groups)
        {
            if (group is null
                || !group.AllOrNothing
                || !ArticleVaultManifestValidator.IsIdentity(group.GroupIdentity)
                || previousGroup is not null && string.CompareOrdinal(previousGroup, group.GroupIdentity) >= 0
                || group.PortableArticleIdentities is null
                || group.Dependencies is null
                || group.Items is null
                || !group.PortableArticleIdentities.SequenceEqual(
                    group.PortableArticleIdentities.Order(StringComparer.Ordinal),
                    StringComparer.Ordinal)
                || group.PortableArticleIdentities.Count == 0)
            {
                return ArticleVaultValidationResult.Invalid("article_vault_plan_group_invalid");
            }

            previousGroup = group.GroupIdentity;
            HashSet<string> groupMembers = new(group.PortableArticleIdentities, StringComparer.Ordinal);
            if (groupMembers.Count != group.PortableArticleIdentities.Count
                || group.Items.Count != groupMembers.Count
                || groupMembers.Any(identity => !articleIdentities.Add(identity)))
            {
                return ArticleVaultValidationResult.Invalid("article_vault_plan_article_membership_ambiguous");
            }

            string? previousEdge = null;
            foreach (VaultPlanDependency dependency in group.Dependencies)
            {
                string edge = $"{dependency.PrerequisitePortableArticleIdentity}\0{dependency.DependentPortableArticleIdentity}";
                if (dependency.PrerequisitePortableArticleIdentity == dependency.DependentPortableArticleIdentity
                    || !groupMembers.Contains(dependency.PrerequisitePortableArticleIdentity)
                    || !groupMembers.Contains(dependency.DependentPortableArticleIdentity)
                    || previousEdge is not null && string.CompareOrdinal(previousEdge, edge) >= 0)
                {
                    return ArticleVaultValidationResult.Invalid("article_vault_plan_dependency_invalid");
                }

                previousEdge = edge;
            }

            foreach (VaultSyncPlanItem item in group.Items)
            {
                if (item.GroupIdentity != group.GroupIdentity
                    || !groupMembers.Contains(item.PortableArticleIdentity)
                    || item.Sequence != expectedSequence++
                    || !operationIdentities.Add(item.OperationIdentity)
                    || !itemsByArticle.TryAdd(item.PortableArticleIdentity, item)
                    || item.Preconditions is null
                    || item.DependsOnOperationIdentities is null
                    || !ArticleVaultManifestValidator.IsSha256(item.Preconditions.ArticleManifestSha256)
                    || !ArticleVaultManifestValidator.IsSha256(item.Preconditions.ServerObservationSha256)
                    || !Enum.IsDefined(item.DerivedState)
                    || !Enum.IsDefined(item.Decision)
                    || !CoordinatesAreSealed(item.Base, item.Local, item.Server)
                    || item.Preconditions.ExpectedServerRevision != item.Server.ServerRevision
                    || item.Preconditions.ExpectedPermissionSha256 != item.Server.PermissionSha256
                    || item.Preconditions.ExpectedLifecycle != item.Server.Lifecycle
                    || item.OperationIdentity != ArticleVaultSyncPlanRules.ComputeOperationIdentity(
                        plan.IdempotencyKey,
                        item.GroupIdentity,
                        item.PortableArticleIdentity,
                        item.Decision))
                {
                    return ArticleVaultValidationResult.Invalid("article_vault_plan_item_invalid");
                }

                (VaultSyncDecision expectedDecision, _) = ArticleVaultSyncPlanRules.Decide(
                    item.DerivedState,
                    plan.Direction);
                if (item.Decision != expectedDecision)
                {
                    return ArticleVaultValidationResult.Invalid("article_vault_plan_decision_invalid");
                }

                canonicalOperationOrder.Add(item.OperationIdentity);
            }

            foreach (VaultSyncPlanItem item in group.Items)
            {
                string[] expectedDependencies = group.Dependencies
                    .Where(dependency => dependency.DependentPortableArticleIdentity == item.PortableArticleIdentity)
                    .Select(dependency => itemsByArticle[dependency.PrerequisitePortableArticleIdentity].OperationIdentity)
                    .Order(StringComparer.Ordinal)
                    .ToArray();
                if (!item.DependsOnOperationIdentities.SequenceEqual(expectedDependencies, StringComparer.Ordinal))
                {
                    return ArticleVaultValidationResult.Invalid("article_vault_plan_operation_order_invalid");
                }
            }
        }

        string? previousConflict = null;
        foreach (VaultSyncPlanConflict conflict in plan.Conflicts)
        {
            string identity = $"{conflict.GroupIdentity}\0{conflict.PortableArticleIdentity}\0{conflict.ReasonCode}";
            if (!itemsByArticle.TryGetValue(conflict.PortableArticleIdentity, out VaultSyncPlanItem? item)
                || item.GroupIdentity != conflict.GroupIdentity
                || item.Decision != VaultSyncDecision.Blocked
                || !ArticleVaultManifestValidator.IsReasonCode(conflict.ReasonCode)
                || previousConflict is not null && string.CompareOrdinal(previousConflict, identity) >= 0)
            {
                return ArticleVaultValidationResult.Invalid("article_vault_plan_conflict_invalid");
            }

            string? expectedConflict = ArticleVaultSyncPlanRules.Decide(item.DerivedState, plan.Direction).Conflict;
            if (conflict.ReasonCode != expectedConflict)
            {
                return ArticleVaultValidationResult.Invalid("article_vault_plan_conflict_invalid");
            }

            previousConflict = identity;
        }

        if (plan.Conflicts.Count != itemsByArticle.Values.Count(
            static item => item.Decision == VaultSyncDecision.Blocked))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_plan_conflict_invalid");
        }

        bool operationOrderAllowed = plan.Status is VaultSyncPlanStatus.Ready or VaultSyncPlanStatus.NoOp;
        if (operationOrderAllowed
            ? !plan.OperationOrder.SequenceEqual(canonicalOperationOrder, StringComparer.Ordinal)
            : plan.OperationOrder.Count != 0)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_plan_operation_order_invalid");
        }

        if (plan.CancellationRequested != (plan.Status == VaultSyncPlanStatus.Cancelled)
            || !plan.CancellationRequested && plan.Conflicts.Count > 0 != (plan.Status == VaultSyncPlanStatus.Blocked)
            || plan.Status == VaultSyncPlanStatus.Ready && itemsByArticle.Values.All(
                static item => item.Decision == VaultSyncDecision.NoOp)
            || plan.Status == VaultSyncPlanStatus.NoOp && itemsByArticle.Values.Any(
                static item => item.Decision != VaultSyncDecision.NoOp))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_plan_status_invalid");
        }

        string recomputedIdempotency = ArticleVaultSyncPlanRules.ComputeIdempotencyKey(plan);
        if (!ArticleVaultSyncPlanRules.FixedDigestEquals(plan.IdempotencyKey, recomputedIdempotency))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_plan_idempotency_mismatch");
        }

        if (!ArticleVaultManifestValidator.IsSha256(plan.ContentSha256)
            || !ArticleVaultSyncPlanRules.FixedDigestEquals(
                plan.ContentSha256,
                ArticleVaultSyncPlanCodec.ComputeContentSha256(plan)))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_plan_digest_mismatch");
        }

        return ArticleVaultValidationResult.Valid();
    }

    public static ArticleVaultValidationResult VerifyCurrent(
        ArticleVaultSyncPlan? plan,
        ArticleVaultRootManifest? root,
        IReadOnlyList<ArticleVaultArticleManifest>? articles,
        IReadOnlyList<ArticleVaultServerObservation>? observations,
        ArticleVaultPlanVerificationContext? context)
    {
        ArticleVaultValidationResult structure = ValidateStructure(plan);
        if (!structure.IsValid)
        {
            return structure;
        }

        if (context is null || !Enum.IsDefined(context.Direction) || context.NowUnixMs < 0)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_plan_verification_context_invalid");
        }

        if (context.Direction != plan!.Direction
            || context.CancellationRequested != plan.CancellationRequested)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_plan_policy_drift");
        }

        if (context.NowUnixMs > plan.ExpiresAtUnixMs)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_plan_expired");
        }

        ArticleVaultValidationResult rootValidation = ArticleVaultManifestValidator.Validate(root);
        if (!rootValidation.IsValid)
        {
            return rootValidation;
        }

        if (root!.SiteIdentity != plan.SiteIdentity
            || root.VaultIdentity != plan.VaultIdentity
            || root.DeviceIdentity != plan.DeviceIdentity
            || root.ContentSha256 != plan.RootManifestSha256)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_plan_root_drift");
        }

        if (articles is null || observations is null)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_plan_current_input_missing");
        }

        Dictionary<string, ArticleVaultArticleManifest> articleMap = new(StringComparer.Ordinal);
        foreach (ArticleVaultArticleManifest? article in articles)
        {
            if (article is null || !articleMap.TryAdd(article.PortableArticleIdentity, article))
            {
                return ArticleVaultValidationResult.Invalid("article_vault_plan_current_article_ambiguous");
            }
        }

        Dictionary<string, ArticleVaultServerObservation> observationMap = new(StringComparer.Ordinal);
        foreach (ArticleVaultServerObservation? observation in observations)
        {
            if (observation is null || !observationMap.TryAdd(observation.PortableArticleIdentity, observation))
            {
                return ArticleVaultValidationResult.Invalid("article_vault_plan_current_observation_ambiguous");
            }
        }

        string[] plannedIdentities = plan.Groups.SelectMany(static group => group.Items)
            .Select(static item => item.PortableArticleIdentity)
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (!plannedIdentities.SequenceEqual(articleMap.Keys.Order(StringComparer.Ordinal), StringComparer.Ordinal)
            || !plannedIdentities.SequenceEqual(observationMap.Keys.Order(StringComparer.Ordinal), StringComparer.Ordinal))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_plan_current_article_set_drift");
        }

        foreach (VaultSyncPlanItem item in plan.Groups.SelectMany(static group => group.Items))
        {
            ArticleVaultArticleManifest article = articleMap[item.PortableArticleIdentity];
            ArticleVaultServerObservation observation = observationMap[item.PortableArticleIdentity];
            ArticleVaultValidationResult binding = ArticleVaultManifestValidator.ValidateBinding(root, article);
            if (!binding.IsValid)
            {
                return binding;
            }

            ArticleVaultValidationResult observationValidation = ArticleVaultSyncPlanRules.ValidateObservation(
                article,
                observation);
            if (!observationValidation.IsValid)
            {
                return observationValidation;
            }

            if (article.ContentSha256 != item.Preconditions.ArticleManifestSha256
                || observation.ContentSha256 != item.Preconditions.ServerObservationSha256
                || article.Coordinates.Base != item.Base
                || article.Coordinates.Local != item.Local
                || observation.ServerCoordinate != item.Server)
            {
                return ArticleVaultValidationResult.Invalid("article_vault_plan_coordinate_drift");
            }

            VaultArticleState state = ArticleVaultSyncPlanRules.DeriveObservedState(article, observation);
            (VaultSyncDecision decision, string? conflict) = ArticleVaultSyncPlanRules.Decide(state, plan.Direction);
            if (state != item.DerivedState
                || decision != item.Decision
                || (conflict is not null) != plan.Conflicts.Any(candidate =>
                    candidate.GroupIdentity == item.GroupIdentity
                    && candidate.PortableArticleIdentity == item.PortableArticleIdentity
                    && candidate.ReasonCode == conflict))
            {
                return ArticleVaultValidationResult.Invalid("article_vault_plan_decision_drift");
            }
        }

        return ArticleVaultValidationResult.Valid();
    }

    private static bool CoordinatesAreSealed(params VaultArticleCoordinate?[] coordinates)
        => coordinates.All(coordinate => coordinate is not null
            && coordinate.Schema == ArticleVaultSchemas.Coordinate
            && coordinate.SchemaVersion == ArticleVaultSchemas.Version
            && ArticleVaultManifestValidator.IsSha256(coordinate.ContentSha256)
            && ArticleVaultSyncPlanRules.FixedDigestEquals(
                coordinate.ContentSha256,
                ArticleVaultManifestCodec.ComputeContentSha256(coordinate)));
}

internal static class ArticleVaultSyncPlanRules
{
    internal static ArticleVaultValidationResult ValidateObservation(
        ArticleVaultArticleManifest article,
        ArticleVaultServerObservation observation)
    {
        if (observation.Schema != ArticleVaultPlanSchemas.ServerObservation
            || observation.SchemaVersion != ArticleVaultPlanSchemas.Version)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_server_observation_schema_unknown");
        }

        if (observation.SiteIdentity != article.SiteIdentity
            || observation.VaultIdentity != article.VaultIdentity
            || observation.DeviceIdentity != article.DeviceIdentity
            || observation.PortableArticleIdentity != article.PortableArticleIdentity
            || observation.ServerArticleIdentity != article.ServerArticleIdentity)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_server_observation_binding_mismatch");
        }

        if (!ArticleVaultManifestValidator.IsSha256(observation.ContentSha256)
            || !FixedDigestEquals(
                observation.ContentSha256,
                ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_server_observation_digest_mismatch");
        }

        if (observation.ServerCoordinate is null)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_server_observation_coordinate_missing");
        }

        ArticleVaultArticleManifest observedArticle = article with
        {
            ServerArticleIdentity = observation.ServerArticleIdentity,
            Coordinates = article.Coordinates with
            {
                Server = observation.ServerCoordinate
            },
            ContentSha256 = string.Empty
        };
        observedArticle = observedArticle with
        {
            State = ArticleVaultStateMachine.Derive(observedArticle)
        };
        observedArticle = observedArticle with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(observedArticle)
        };
        return ArticleVaultManifestValidator.Validate(observedArticle);
    }

    internal static VaultArticleState DeriveObservedState(
        ArticleVaultArticleManifest article,
        ArticleVaultServerObservation observation)
        => ArticleVaultStateMachine.Derive(article with
        {
            ServerArticleIdentity = observation.ServerArticleIdentity,
            Coordinates = article.Coordinates with
            {
                Server = observation.ServerCoordinate
            }
        });

    internal static (VaultSyncDecision Decision, string? Conflict) Decide(
        VaultArticleState state,
        VaultSyncDirection direction)
        => (state, direction) switch
        {
            (VaultArticleState.Untracked, _) => (VaultSyncDecision.NoOp, null),
            (VaultArticleState.Clean, _) => (VaultSyncDecision.NoOp, null),
            (VaultArticleState.Synced, _) => (VaultSyncDecision.NoOp, null),
            (VaultArticleState.LocalModified, VaultSyncDirection.Push or VaultSyncDirection.Sync)
                => (VaultSyncDecision.PushUpdate, null),
            (VaultArticleState.LocalCreated, VaultSyncDirection.Push or VaultSyncDirection.Sync)
                => (VaultSyncDecision.PushCreate, null),
            (VaultArticleState.LocalDeleted, VaultSyncDirection.Push or VaultSyncDirection.Sync)
                => (VaultSyncDecision.PushDelete, null),
            (VaultArticleState.ServerModified, VaultSyncDirection.Pull or VaultSyncDirection.Sync)
                => (VaultSyncDecision.PullUpdate, null),
            (VaultArticleState.ServerCreated, VaultSyncDirection.Pull or VaultSyncDirection.Sync)
                => (VaultSyncDecision.PullCreate, null),
            (VaultArticleState.ServerDeleted, VaultSyncDirection.Pull or VaultSyncDirection.Sync)
                => (VaultSyncDecision.PullDelete, null),
            (VaultArticleState.LocalModified or VaultArticleState.LocalCreated or VaultArticleState.LocalDeleted,
                VaultSyncDirection.Pull) => (VaultSyncDecision.Blocked, "direction_rejects_local_change"),
            (VaultArticleState.ServerModified or VaultArticleState.ServerCreated or VaultArticleState.ServerDeleted,
                VaultSyncDirection.Push) => (VaultSyncDecision.Blocked, "direction_rejects_server_change"),
            (VaultArticleState.BothModified, _) => (VaultSyncDecision.Blocked, "both_modified"),
            (VaultArticleState.Conflicted, _) => (VaultSyncDecision.Blocked, "conflict_unresolved"),
            (VaultArticleState.Applying, _) => (VaultSyncDecision.Blocked, "operation_already_applying"),
            (VaultArticleState.Blocked, _) => (VaultSyncDecision.Blocked, "article_blocked"),
            _ => (VaultSyncDecision.Blocked, "state_not_plannable")
        };

    internal static string ComputeIdempotencyKey(
        string rootManifestSha256,
        VaultSyncDirection direction,
        long createdAtUnixMs,
        long expiresAtUnixMs,
        bool cancellationRequested,
        IReadOnlyList<ArticleVaultSyncPlanner.NormalizedGroup> groups,
        IReadOnlyDictionary<string, ArticleVaultArticleManifest> articles,
        IReadOnlyDictionary<string, ArticleVaultServerObservation> observations)
        => ArticleVaultManifestCodec.ComputeSha256(ArticleVaultManifestCodec.SerializeCanonical(new
        {
            schema = ArticleVaultPlanSchemas.Plan,
            schemaVersion = ArticleVaultPlanSchemas.Version,
            rootManifestSha256,
            direction,
            createdAtUnixMs,
            expiresAtUnixMs,
            cancelPolicy = VaultSyncCancelPolicy.BeforeExecutionOnly,
            cancellationRequested,
            groups = groups.Select(group => new
            {
                group.GroupIdentity,
                group.PortableArticleIdentities,
                group.Dependencies,
                articles = group.PortableArticleIdentities.Select(portableIdentity => new
                {
                    portableArticleIdentity = portableIdentity,
                    articleManifestSha256 = articles[portableIdentity].ContentSha256,
                    serverObservationSha256 = observations[portableIdentity].ContentSha256
                })
            })
        }));

    internal static string ComputeIdempotencyKey(ArticleVaultSyncPlan plan)
        => ArticleVaultManifestCodec.ComputeSha256(ArticleVaultManifestCodec.SerializeCanonical(new
        {
            schema = plan.Schema,
            schemaVersion = plan.SchemaVersion,
            rootManifestSha256 = plan.RootManifestSha256,
            direction = plan.Direction,
            createdAtUnixMs = plan.CreatedAtUnixMs,
            expiresAtUnixMs = plan.ExpiresAtUnixMs,
            cancelPolicy = plan.CancelPolicy,
            cancellationRequested = plan.CancellationRequested,
            groups = plan.Groups.Select(group => new
            {
                group.GroupIdentity,
                group.PortableArticleIdentities,
                group.Dependencies,
                articles = group.PortableArticleIdentities.Select(portableIdentity =>
                {
                    VaultSyncPlanItem item = group.Items.Single(candidate =>
                        candidate.PortableArticleIdentity == portableIdentity);
                    return new
                    {
                        portableArticleIdentity = portableIdentity,
                        articleManifestSha256 = item.Preconditions.ArticleManifestSha256,
                        serverObservationSha256 = item.Preconditions.ServerObservationSha256
                    };
                })
            })
        }));

    internal static string ComputeOperationIdentity(
        string idempotencyKey,
        string groupIdentity,
        string portableArticleIdentity,
        VaultSyncDecision decision)
    {
        string digest = ArticleVaultManifestCodec.ComputeSha256(ArticleVaultManifestCodec.SerializeCanonical(new
        {
            schema = "fsusblog.article-vault.sync-operation-identity.v1",
            idempotencyKey,
            groupIdentity,
            portableArticleIdentity,
            decision
        }));
        return $"operation-{digest[..32]}";
    }

    internal static bool FixedDigestEquals(string left, string right)
        => CryptographicOperations.FixedTimeEquals(Convert.FromHexString(left), Convert.FromHexString(right));
}
