using System.Collections.Frozen;
using System.Collections.Immutable;
using System.Text.Json;

namespace FsusBlog.Server.Services.Articles.Bulk;

internal enum ArticleBulkSelectionKind
{
    Explicit,
    CurrentPage,
    SavedView,
    Query
}

internal sealed record ArticleBulkSelection(
    ArticleBulkSelectionKind Kind,
    ImmutableArray<string> ArticleIds,
    string? AuthorityId,
    string IdentityDigest);

internal sealed record ArticleBulkActor(string UserId, string SiteId, string AuthorityDigest);

internal sealed record ArticleBulkSource(string Commit, string BuildDigest);

internal sealed record ArticleBulkPlanRequest(
    string PlanIdentity,
    string? ReplanOfPlanDigest,
    string OperationId,
    IReadOnlyDictionary<string, JsonElement> Parameters,
    ArticleBulkSelection Selection,
    ArticleBulkActor Actor,
    ArticleBulkSource Source,
    string PolicyDigest,
    string PermissionPolicyDigest,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset ExpiresAtUtc);

internal sealed record ArticleBulkSelectionResolution(
    string AuthorityDigest,
    string ResolutionDigest,
    IAsyncEnumerable<string> OrderedArticleIds);

internal sealed record ArticleBulkArticleObservation(
    string ArticleId,
    bool Exists,
    string? SiteId,
    string? Revision,
    string? Lifecycle,
    bool Permitted,
    bool Applicable,
    string? PermissionDigest,
    string? StateDigest,
    ImmutableArray<string> DependencyDigests);

internal interface IArticleBulkSelectionAuthority
{
    Task<ArticleBulkSelectionResolution> ResolveAsync(
        ArticleBulkSelection selection,
        ArticleBulkActor actor,
        CancellationToken cancellationToken);
}

internal interface IArticleBulkPreflightAuthority
{
    IAsyncEnumerable<ArticleBulkArticleObservation> ObserveAsync(
        IReadOnlyList<string> orderedArticleIds,
        ArticleBulkOperation operation,
        IReadOnlyDictionary<string, object> normalizedParameters,
        ArticleBulkActor actor,
        CancellationToken cancellationToken);
}

internal enum ArticleBulkPlanItemStatus
{
    Eligible,
    Blocked
}

internal sealed record ArticleBulkPlanItem(
    string ArticleId,
    ArticleBulkPlanItemStatus Status,
    string ReasonCode,
    string? ExpectedRevision,
    string? Lifecycle,
    string? PermissionDigest,
    string? StateDigest,
    ImmutableArray<string> DependencyDigests,
    string ProposedChangeDigest,
    string ContentDigest);

internal sealed record ArticleBulkPlanItemChunk(
    int Index,
    ImmutableArray<ArticleBulkPlanItem> Items,
    string ContentDigest);

internal sealed record ArticleBulkImpactFacts(
    int SelectedCount,
    int EligibleCount,
    int BlockedCount,
    int EstimatedBatches,
    bool RequiresZeroWrite,
    ImmutableArray<string> SideEffectOwners,
    ImmutableArray<string> WarningCodes,
    ImmutableArray<string> ErrorCodes);

internal sealed record ArticleBulkPlan(
    string Schema,
    string PlanIdentity,
    string? ReplanOfPlanDigest,
    string OperationId,
    int OperationVersion,
    string RegistryDigest,
    ArticleBulkExecutionStrategy Strategy,
    FrozenDictionary<string, object> NormalizedParameters,
    string ParametersDigest,
    ArticleBulkSelection Selection,
    string SelectionAuthorityDigest,
    string SelectionResolutionDigest,
    string FrozenSetDigest,
    ArticleBulkActor Actor,
    ArticleBulkSource Source,
    string PolicyDigest,
    string PermissionPolicyDigest,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset ExpiresAtUtc,
    bool Executable,
    ImmutableArray<ArticleBulkPlanItemChunk> ItemChunks,
    ArticleBulkImpactFacts Impact,
    string ContentDigest)
{
    internal const string CurrentSchema = "fsusblog.article-bulk.plan.v2";

    internal IEnumerable<ArticleBulkPlanItem> Items => ItemChunks.SelectMany(static chunk => chunk.Items);
}

internal sealed class ArticleBulkPlanAuthority(
    IArticleBulkSelectionAuthority selectionAuthority,
    IArticleBulkPreflightAuthority preflightAuthority,
    TimeProvider timeProvider)
{
    private const int ItemChunkSize = 250;
    private const int MaximumItems = 10_000;

    internal async Task<ArticleBulkPlan> CreateAsync(
        ArticleBulkPlanRequest request,
        CancellationToken cancellationToken = default)
    {
        if (request.ReplanOfPlanDigest is not null)
        {
            throw new ArticleBulkContractException("article-bulk.replan-parent-unexpected");
        }

        return await CreateCoreAsync(request, requireReplanParent: false, cancellationToken).ConfigureAwait(false);
    }

    private async Task<ArticleBulkPlan> CreateCoreAsync(
        ArticleBulkPlanRequest request,
        bool requireReplanParent,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        ValidateRequest(request);
        if (requireReplanParent != (request.ReplanOfPlanDigest is not null))
        {
            throw new ArticleBulkContractException("article-bulk.replan-parent-invalid");
        }
        ArticleBulkOperationRegistry.Validate(ArticleBulkOperationRegistry.Current);
        ArticleBulkOperation operation = ArticleBulkOperationRegistry.Get(request.OperationId);
        FrozenDictionary<string, object> parameters =
            ArticleBulkOperationRegistry.NormalizeParameters(operation.Id, request.Parameters);

        ArticleBulkSelectionResolution resolution = await selectionAuthority
            .ResolveAsync(request.Selection, request.Actor, cancellationToken)
            .ConfigureAwait(false);
        if (!IsDigest(resolution.AuthorityDigest) || !IsDigest(resolution.ResolutionDigest))
        {
            throw new ArticleBulkContractException("article-bulk.selection-receipt-invalid");
        }
        ImmutableArray<string> articleIds = await FreezeSelectionAsync(
            request.Selection,
            resolution,
            cancellationToken).ConfigureAwait(false);

        var items = ImmutableArray.CreateBuilder<ArticleBulkPlanItem>(articleIds.Length);
        int observed = 0;
        await foreach (ArticleBulkArticleObservation observation in preflightAuthority
            .ObserveAsync(articleIds, operation, parameters, request.Actor, cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (observed >= articleIds.Length || observation.ArticleId != articleIds[observed])
            {
                throw new ArticleBulkContractException("article-bulk.article-order-drift");
            }
            items.Add(SealItem(observation, operation, parameters, request.Actor));
            observed++;
        }
        if (observed != articleIds.Length)
        {
            throw new ArticleBulkContractException("article-bulk.preflight-incomplete");
        }

        ImmutableArray<ArticleBulkPlanItemChunk> chunks = Chunk(items.MoveToImmutable());
        int eligible = chunks.Sum(static chunk => chunk.Items.Count(static item => item.Status == ArticleBulkPlanItemStatus.Eligible));
        int blocked = articleIds.Length - eligible;
        bool requiresZeroWrite = operation.Strategy == ArticleBulkExecutionStrategy.AllOrNothing;
        bool executable = operation.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
            ? eligible > 0
            : blocked == 0;
        var impact = new ArticleBulkImpactFacts(
            articleIds.Length,
            eligible,
            blocked,
            (eligible + ItemChunkSize - 1) / ItemChunkSize,
            requiresZeroWrite,
            operation.SideEffectOwners,
            blocked > 0 && operation.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
                ? ["article-bulk.partial-plan"]
                : [],
            blocked > 0 && operation.Strategy == ArticleBulkExecutionStrategy.AllOrNothing
                ? ["article-bulk.atomic-preflight-blocked"]
                : []);
        string parametersDigest = ArticleBulkDigest.Of(parameters.OrderBy(static pair => pair.Key));
        string frozenSetDigest = ArticleBulkDigest.Of(articleIds);
        var unsigned = new ArticleBulkPlan(
            ArticleBulkPlan.CurrentSchema,
            request.PlanIdentity,
            request.ReplanOfPlanDigest,
            operation.Id,
            operation.Version,
            ArticleBulkOperationRegistry.Current.ContentDigest,
            operation.Strategy,
            parameters,
            parametersDigest,
            request.Selection,
            resolution.AuthorityDigest,
            resolution.ResolutionDigest,
            frozenSetDigest,
            request.Actor,
            request.Source,
            request.PolicyDigest,
            request.PermissionPolicyDigest,
            request.CreatedAtUtc,
            request.ExpiresAtUtc,
            executable,
            chunks,
            impact,
            string.Empty);
        return unsigned with
        {
            ContentDigest = DigestPlan(unsigned)
        };
    }

    internal async Task<ArticleBulkPlan> ReplanAsync(
        ArticleBulkPlan previousPlan,
        ArticleBulkPlanRequest request,
        CancellationToken cancellationToken = default)
    {
        ValidateIntegrity(previousPlan);
        if (request.ReplanOfPlanDigest != previousPlan.ContentDigest
            || request.PlanIdentity == previousPlan.PlanIdentity)
        {
            throw new ArticleBulkContractException("article-bulk.replan-identity-invalid");
        }

        return await CreateCoreAsync(request, requireReplanParent: true, cancellationToken).ConfigureAwait(false);
    }

    internal ArticleBulkPlanConfirmation RecordExplicitConfirmation(
        ArticleBulkPlan plan,
        string confirmationIdentity,
        DateTimeOffset confirmedAtUtc)
    {
        ValidateForExecution(plan);
        if (!IsBoundedOpaqueValue(confirmationIdentity, 256)
            || confirmedAtUtc.Offset != TimeSpan.Zero
            || confirmedAtUtc < plan.CreatedAtUtc
            || confirmedAtUtc >= plan.ExpiresAtUtc)
        {
            throw new ArticleBulkContractException("article-bulk.confirmation-invalid");
        }

        var unsigned = new ArticleBulkPlanConfirmation(
            confirmationIdentity,
            plan.PlanIdentity,
            plan.ContentDigest,
            plan.Actor.AuthorityDigest,
            confirmedAtUtc,
            string.Empty);
        return unsigned with
        {
            ContentDigest = ArticleBulkDigest.Of(unsigned)
        };
    }

    internal async Task VerifyAsync(
        ArticleBulkPlan plan,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ValidateForExecution(plan);

        var request = new ArticleBulkPlanRequest(
            plan.PlanIdentity,
            plan.ReplanOfPlanDigest,
            plan.OperationId,
            ToJsonParameters(plan.NormalizedParameters),
            plan.Selection,
            plan.Actor,
            plan.Source,
            plan.PolicyDigest,
            plan.PermissionPolicyDigest,
            plan.CreatedAtUtc,
            plan.ExpiresAtUtc);
        ArticleBulkPlan recomputed = await CreateCoreAsync(
            request,
            requireReplanParent: plan.ReplanOfPlanDigest is not null,
            cancellationToken).ConfigureAwait(false);
        if (recomputed.ContentDigest != plan.ContentDigest)
        {
            throw new ArticleBulkContractException("article-bulk.plan-drift");
        }
    }

    internal void ValidateForExecution(ArticleBulkPlan plan)
    {
        ValidateIntegrity(plan);
        DateTimeOffset now = timeProvider.GetUtcNow();
        if (now >= plan.ExpiresAtUtc)
        {
            throw new ArticleBulkContractException("article-bulk.plan-expired");
        }
    }

    internal async Task ValidateCurrentArticlesForExecutionAsync(
        ArticleBulkPlan plan,
        CancellationToken cancellationToken = default)
    {
        ValidateForExecution(plan);
        ArticleBulkOperation operation = ArticleBulkOperationRegistry.Get(plan.OperationId);
        ArticleBulkPlanItem[] expected = [.. plan.Items];
        int observed = 0;
        await foreach (ArticleBulkArticleObservation observation in preflightAuthority
            .ObserveAsync(
                expected.Select(static item => item.ArticleId).ToArray(),
                operation,
                plan.NormalizedParameters,
                plan.Actor,
                cancellationToken)
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (observed >= expected.Length || observation.ArticleId != expected[observed].ArticleId)
            {
                throw new ArticleBulkContractException("article-bulk.execution-article-order-drift");
            }

            ArticleBulkPlanItem current = SealItem(observation, operation, plan.NormalizedParameters, plan.Actor);
            if (current.ContentDigest != expected[observed].ContentDigest)
            {
                throw new ArticleBulkContractException("article-bulk.execution-article-drift");
            }
            observed++;
        }

        if (observed != expected.Length)
        {
            throw new ArticleBulkContractException("article-bulk.execution-preflight-incomplete");
        }
    }

    internal void ValidateIntegrity(ArticleBulkPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        if (plan.NormalizedParameters is null
            || plan.ItemChunks.IsDefault
            || plan.Selection.ArticleIds.IsDefault
            || plan.Impact.SideEffectOwners.IsDefault
            || plan.Impact.WarningCodes.IsDefault
            || plan.Impact.ErrorCodes.IsDefault)
        {
            throw new ArticleBulkContractException("article-bulk.plan-tampered");
        }
        ArticleBulkOperation operation;
        FrozenDictionary<string, object> normalizedParameters;
        try
        {
            operation = ArticleBulkOperationRegistry.Get(plan.OperationId);
            normalizedParameters = ArticleBulkOperationRegistry.NormalizeParameters(
                plan.OperationId,
                ToJsonParameters(plan.NormalizedParameters));
            ValidateRequest(new ArticleBulkPlanRequest(
                plan.PlanIdentity,
                plan.ReplanOfPlanDigest,
                plan.OperationId,
                ToJsonParameters(plan.NormalizedParameters),
                plan.Selection,
                plan.Actor,
                plan.Source,
                plan.PolicyDigest,
                plan.PermissionPolicyDigest,
                plan.CreatedAtUtc,
                plan.ExpiresAtUtc));
        }
        catch (ArticleBulkContractException)
        {
            throw new ArticleBulkContractException("article-bulk.plan-tampered");
        }

        int selected = plan.Items.Count();
        int eligible = plan.Items.Count(static item => item.Status == ArticleBulkPlanItemStatus.Eligible);
        int blocked = selected - eligible;
        ImmutableArray<string> expectedWarnings = blocked > 0
            && operation.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
            ? ["article-bulk.partial-plan"]
            : [];
        ImmutableArray<string> expectedErrors = blocked > 0
            && operation.Strategy == ArticleBulkExecutionStrategy.AllOrNothing
            ? ["article-bulk.atomic-preflight-blocked"]
            : [];
        bool expectedExecutable = operation.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
            ? eligible > 0
            : blocked == 0;
        if (plan.Schema != ArticleBulkPlan.CurrentSchema
            || !IsBoundedOpaqueValue(plan.PlanIdentity, 256)
            || plan.ReplanOfPlanDigest is not null && !IsDigest(plan.ReplanOfPlanDigest)
            || plan.RegistryDigest != ArticleBulkOperationRegistry.Current.ContentDigest
            || plan.OperationVersion != operation.Version
            || plan.Strategy != operation.Strategy
            || !IsDigest(plan.SelectionAuthorityDigest)
            || !IsDigest(plan.SelectionResolutionDigest)
            || plan.ParametersDigest != ArticleBulkDigest.Of(normalizedParameters.OrderBy(static pair => pair.Key))
            || plan.ContentDigest != DigestPlan(plan with
            {
                ContentDigest = string.Empty
            })
            || selected > MaximumItems
            || plan.FrozenSetDigest != ArticleBulkDigest.Of(plan.Items.Select(static item => item.ArticleId).ToArray())
            || plan.Items.Select(static item => item.ArticleId).Distinct(StringComparer.Ordinal).Count() != selected
            || plan.ItemChunks.Where((chunk, index) => chunk.Index != index
                || chunk.Items.Length is < 1 or > ItemChunkSize
                || chunk.ContentDigest != ArticleBulkDigest.Of(chunk.Items)).Any()
            || plan.Items.Any(static item => item.ContentDigest
                != ArticleBulkDigest.Of(item with
                {
                    ContentDigest = string.Empty
                }))
            || plan.Items.Any(static item => !IsBoundedOpaqueValue(item.ArticleId, 256)
                || !Enum.IsDefined(item.Status)
                || !IsBoundedOpaqueValue(item.ReasonCode, 128)
                || item.ExpectedRevision is not null && !IsBoundedOpaqueValue(item.ExpectedRevision, 256)
                || item.Lifecycle is not null && !IsBoundedOpaqueValue(item.Lifecycle, 64)
                || item.PermissionDigest is not null && !IsDigest(item.PermissionDigest)
                || item.StateDigest is not null && !IsDigest(item.StateDigest)
                || item.Status == ArticleBulkPlanItemStatus.Eligible
                    && (!IsDigest(item.PermissionDigest) || !IsDigest(item.StateDigest))
                || item.DependencyDigests.IsDefault
                || item.DependencyDigests.Length > 64
                || item.DependencyDigests.Any(static digest => !IsDigest(digest))
                || !IsDigest(item.ProposedChangeDigest))
            || plan.Executable != expectedExecutable
            || plan.Impact.SelectedCount != selected
            || plan.Impact.EligibleCount != eligible
            || plan.Impact.BlockedCount != blocked
            || plan.Impact.EstimatedBatches != (eligible + ItemChunkSize - 1) / ItemChunkSize
            || plan.Impact.RequiresZeroWrite != (operation.Strategy == ArticleBulkExecutionStrategy.AllOrNothing)
            || !plan.Impact.SideEffectOwners.SequenceEqual(operation.SideEffectOwners)
            || !plan.Impact.WarningCodes.SequenceEqual(expectedWarnings)
            || !plan.Impact.ErrorCodes.SequenceEqual(expectedErrors))
        {
            throw new ArticleBulkContractException("article-bulk.plan-tampered");
        }
    }

    private static async Task<ImmutableArray<string>> FreezeSelectionAsync(
        ArticleBulkSelection selection,
        ArticleBulkSelectionResolution resolution,
        CancellationToken cancellationToken)
    {
        var ids = ImmutableArray.CreateBuilder<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        await foreach (string articleId in resolution.OrderedArticleIds
            .WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (!IsBoundedOpaqueValue(articleId, 256) || !seen.Add(articleId) || ids.Count == MaximumItems)
            {
                throw new ArticleBulkContractException("article-bulk.selection-invalid");
            }
            ids.Add(articleId);
        }

        ImmutableArray<string> frozen = ids.ToImmutable();
        if ((selection.Kind is ArticleBulkSelectionKind.Explicit or ArticleBulkSelectionKind.CurrentPage)
            && !selection.ArticleIds.SequenceEqual(frozen))
        {
            throw new ArticleBulkContractException("article-bulk.selection-drift");
        }
        return frozen;
    }

    private static ArticleBulkPlanItem SealItem(
        ArticleBulkArticleObservation observation,
        ArticleBulkOperation operation,
        IReadOnlyDictionary<string, object> parameters,
        ArticleBulkActor actor)
    {
        if (!IsBoundedOpaqueValue(observation.ArticleId, 256)
            || observation.Revision is not null && !IsBoundedOpaqueValue(observation.Revision, 256)
            || observation.Lifecycle is not null && !IsBoundedOpaqueValue(observation.Lifecycle, 64)
            || observation.PermissionDigest is not null && !IsDigest(observation.PermissionDigest)
            || observation.StateDigest is not null && !IsDigest(observation.StateDigest)
            || observation.DependencyDigests.IsDefault
            || observation.DependencyDigests.Length > 64
            || observation.DependencyDigests.Any(static digest => !IsDigest(digest)))
        {
            throw new ArticleBulkContractException("article-bulk.preflight-observation-invalid");
        }
        string reason;
        bool eligible;
        if (!observation.Exists || !observation.Permitted || observation.SiteId != actor.SiteId)
        {
            // Do not distinguish absence, cross-site identity, or permission denial in the persisted plan.
            reason = "article-inaccessible";
            eligible = false;
        }
        else if (string.IsNullOrWhiteSpace(observation.Revision)
            || string.IsNullOrWhiteSpace(observation.Lifecycle)
            || !operation.ExpectedArticleStates.Contains(observation.Lifecycle, StringComparer.Ordinal))
        {
            reason = "article-state-blocked";
            eligible = false;
        }
        else if (!observation.Applicable)
        {
            reason = "operation-not-applicable";
            eligible = false;
        }
        else
        {
            if (!IsDigest(observation.PermissionDigest) || !IsDigest(observation.StateDigest))
            {
                throw new ArticleBulkContractException("article-bulk.preflight-observation-invalid");
            }
            reason = "eligible";
            eligible = true;
        }

        var unsigned = new ArticleBulkPlanItem(
            observation.ArticleId,
            eligible ? ArticleBulkPlanItemStatus.Eligible : ArticleBulkPlanItemStatus.Blocked,
            reason,
            eligible ? observation.Revision : null,
            eligible ? observation.Lifecycle : null,
            eligible ? observation.PermissionDigest : null,
            eligible ? observation.StateDigest : null,
            eligible ? observation.DependencyDigests.Order(StringComparer.Ordinal).ToImmutableArray() : [],
            ArticleBulkDigest.Of(new
            {
                operation.Id,
                Parameters = parameters.OrderBy(static pair => pair.Key),
                observation.ArticleId,
                // Even a digest must not distinguish a denied identity from an absent one.
                StateDigest = reason == "article-inaccessible" ? null : observation.StateDigest
            }),
            string.Empty);
        return unsigned with
        {
            ContentDigest = ArticleBulkDigest.Of(unsigned with
            {
                ContentDigest = string.Empty
            })
        };
    }

    private static ImmutableArray<ArticleBulkPlanItemChunk> Chunk(ImmutableArray<ArticleBulkPlanItem> items)
    {
        var chunks = ImmutableArray.CreateBuilder<ArticleBulkPlanItemChunk>((items.Length + ItemChunkSize - 1) / ItemChunkSize);
        for (int offset = 0; offset < items.Length; offset += ItemChunkSize)
        {
            ImmutableArray<ArticleBulkPlanItem> slice = items.Skip(offset).Take(ItemChunkSize).ToImmutableArray();
            chunks.Add(new ArticleBulkPlanItemChunk(chunks.Count, slice, ArticleBulkDigest.Of(slice)));
        }
        return chunks.MoveToImmutable();
    }

    private static void ValidateRequest(ArticleBulkPlanRequest request)
    {
        if (request.CreatedAtUtc.Offset != TimeSpan.Zero || request.ExpiresAtUtc.Offset != TimeSpan.Zero
            || request.ExpiresAtUtc <= request.CreatedAtUtc || request.ExpiresAtUtc <= s_timeProviderStaticGuard)
        {
            throw new ArticleBulkContractException("article-bulk.plan-expiry-invalid");
        }
        if (!IsBoundedOpaqueValue(request.PlanIdentity, 256)
            || request.ReplanOfPlanDigest is not null && !IsDigest(request.ReplanOfPlanDigest)
            || !Enum.IsDefined(request.Selection.Kind)
            || request.Selection.ArticleIds.Length > MaximumItems
            || request.Selection.ArticleIds.Distinct(StringComparer.Ordinal).Count() != request.Selection.ArticleIds.Length
            || request.Selection.ArticleIds.Any(static articleId => !IsBoundedOpaqueValue(articleId, 256))
            || !IsDigest(request.Selection.IdentityDigest)
            || (request.Selection.Kind is ArticleBulkSelectionKind.Explicit or ArticleBulkSelectionKind.CurrentPage
                && request.Selection.AuthorityId is not null)
            || (request.Selection.Kind is ArticleBulkSelectionKind.SavedView or ArticleBulkSelectionKind.Query
                && (!IsBoundedOpaqueValue(request.Selection.AuthorityId, 256)
                    || request.Selection.ArticleIds.Length != 0))
            || !IsBoundedOpaqueValue(request.Actor.UserId, 256)
            || !IsBoundedOpaqueValue(request.Actor.SiteId, 256)
            || !IsDigest(request.Actor.AuthorityDigest) || !IsDigest(request.Source.BuildDigest)
            || !IsDigest(request.PolicyDigest) || !IsDigest(request.PermissionPolicyDigest)
            || request.Source.Commit.Length != 40 || request.Source.Commit.Any(static value => !char.IsAsciiHexDigitLower(value)))
        {
            throw new ArticleBulkContractException("article-bulk.plan-request-invalid");
        }
    }

    // Keeps request validation pure. Current expiry is enforced at execution admission time.
    private static readonly DateTimeOffset s_timeProviderStaticGuard = DateTimeOffset.UnixEpoch;

    private static bool IsDigest(string? value) =>
        value is not null && value.Length == 71 && value.StartsWith("sha256:", StringComparison.Ordinal)
        && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    private static bool IsBoundedOpaqueValue(string? value, int maximumLength) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length <= maximumLength
        && value.All(static character => !char.IsControl(character));

    private static string DigestPlan(ArticleBulkPlan plan) => ArticleBulkDigest.Of(new
    {
        plan.Schema,
        plan.PlanIdentity,
        plan.ReplanOfPlanDigest,
        plan.OperationId,
        plan.OperationVersion,
        plan.RegistryDigest,
        plan.Strategy,
        NormalizedParameters = plan.NormalizedParameters
            .OrderBy(static pair => pair.Key, StringComparer.Ordinal)
            .Select(static pair => new { pair.Key, pair.Value })
            .ToArray(),
        plan.ParametersDigest,
        plan.Selection,
        plan.SelectionAuthorityDigest,
        plan.SelectionResolutionDigest,
        plan.FrozenSetDigest,
        plan.Actor,
        plan.Source,
        plan.PolicyDigest,
        plan.PermissionPolicyDigest,
        plan.CreatedAtUtc,
        plan.ExpiresAtUtc,
        plan.Executable,
        plan.ItemChunks,
        plan.Impact
    });

    private static FrozenDictionary<string, JsonElement> ToJsonParameters(IReadOnlyDictionary<string, object> parameters)
    {
        var result = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach ((string key, object value) in parameters)
        {
            result[key] = JsonSerializer.SerializeToElement(value);
        }
        return result.ToFrozenDictionary(StringComparer.Ordinal);
    }
}
