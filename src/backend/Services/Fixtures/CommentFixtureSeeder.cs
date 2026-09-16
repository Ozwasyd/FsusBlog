// fixture-catalog: producer comment-moderation
using System.Globalization;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Services.Fixtures;

public sealed record CommentFixtureIdentityReferences(
    int PrimaryAccountId,
    int SecondaryAccountId,
    long AdminPrincipalId,
    string AuthProducerResultDigest,
    IReadOnlyList<string> AuthPrepareReferenceDigests)
{
    // Narrow #1713 reference for the admin actor consumed by moderation; the
    // moderation port must not mint or elevate an admin identity.
    public string AdminActorReferenceDigest { get; init; } = string.Empty;
}

public sealed record CommentFixtureArticleReference(
    int ArticleId,
    string PublicContentProducerResultDigest,
    string ArticleProjectionDigest);

public sealed record CommentFixturePlan(
    string Schema,
    string ProducerId,
    string Strategy,
    string RunId,
    string Namespace,
    string TestSession,
    string ProfileId,
    IReadOnlyList<string> Capabilities,
    CommentFixtureIdentityReferences IdentityReferences,
    CommentFixtureArticleReference ArticleReference,
    string InventoryDigest,
    string CapabilityCatalogDigest,
    string VariantCatalogDigest,
    string TemporalContextDigest,
    string ProducerPlanDigest,
    string PlanDigest);

public sealed record CommentFixtureCapabilityProof(
    string CapabilityId,
    string Status,
    string Thread,
    string Moderation,
    string PublicReadModel,
    string AdminReadModel,
    string Queue,
    string CacheOutbox);

public sealed record CommentFixtureResult(
    string ProducerId,
    string Strategy,
    string PlanDigest,
    string InventoryDigest,
    string CapabilityCatalogDigest,
    string VariantCatalogDigest,
    string TemporalContextDigest,
    string ProducerPlanDigest,
    IReadOnlyList<CommentFixtureCapabilityProof> CapabilityProofs,
    IReadOnlyList<CommentThreadFixtureEntity> ThreadEntities,
    IReadOnlyList<CommentFixtureZkAuthorityEvidence> ZkAuthorityEvidence,
    CommentModerationFixtureResult Moderation,
    IReadOnlyDictionary<string, string> NegativeResults,
    string CacheGenerationBefore,
    string CacheGenerationAfter,
    CommentFixtureCrossDomainSentinel CrossDomainBefore,
    CommentFixtureCrossDomainSentinel CrossDomainAfterPrepare,
    CommentThreadFixtureCleanupReceipt CleanupReceipt);

public interface ICommentFixtureSeeder
{
    Task<CommentFixtureResult> PrepareAsync(
        CommentFixturePlan plan,
        CancellationToken cancellationToken = default);

    Task<CommentThreadFixtureCleanupResult> CleanupAsync(
        CommentThreadFixtureCleanupReceipt receipt,
        CancellationToken cancellationToken = default);
}

public sealed class CommentFixturePreparationException(
    string message,
    Exception originalError,
    CommentThreadFixtureCleanupReceipt recoveryReceipt,
    CommentThreadFixtureCleanupResult? cleanupResult,
    Exception? cleanupError)
    : Exception(message, originalError)
{
    public CommentThreadFixtureCleanupReceipt RecoveryReceipt { get; } = recoveryReceipt;
    public CommentThreadFixtureCleanupResult? CleanupResult { get; } = cleanupResult;
    public Exception? CleanupError { get; } = cleanupError;
    public bool WasCanceled
    {
        get;
    } = originalError is OperationCanceledException
        || originalError is CommentThreadFixtureRecoveryException { InnerException: OperationCanceledException };
}

/// <summary>
/// Unique comment transaction-fixture producer. It only composes the two typed
/// ports and consumes verified article/auth references supplied by the DAG.
/// </summary>
public sealed class CommentFixtureSeeder(
    ICommentThreadFixturePort threads,
    ICommentModerationFixturePort moderation,
    IModerationRuntimeStateService runtimeState,
    CommentFixtureCacheProbe cacheProbe,
    IConfiguration configuration) : ICommentFixtureSeeder
{
    private static readonly System.Buffers.SearchValues<char> s_myChars = System.Buffers.SearchValues.Create("0123456789abcdef");
    private const string ProducerId = "comment-moderation";
    private const string ManualReviewFixtureRegion = RegionCodes.UnitedStates;
    private const string Strategy = "transaction-fixture";
    private const string PlanSchema = "fsusblog.comment-fixture-plan.v1";
    private const string CleanupSchema = "fsusblog.comment-thread-fixture-cleanup.v1";
    private static readonly string[] s_expectedCapabilities =
    [
        "comment.moderation-matrix",
        "comment.threaded",
        "moderation.policy-matrix"
    ];

    public async Task<CommentFixtureResult> PrepareAsync(
        CommentFixturePlan plan,
        CancellationToken cancellationToken = default)
    {
        ValidatePlan(plan);
        string owner = $"comment-fixture:{plan.Namespace}:{plan.RunId}";
        CommentFixturePortBinding binding = PortBinding(plan, owner);
        int articleId = plan.ArticleReference.ArticleId;
        int primary = plan.IdentityReferences.PrimaryAccountId;
        int secondary = plan.IdentityReferences.SecondaryAccountId;
        long admin = plan.IdentityReferences.AdminPrincipalId;
        var latest = new Dictionary<string, CommentThreadFixtureEntity>(StringComparer.Ordinal);
        var zkAuthorityEvidence = new List<CommentFixtureZkAuthorityEvidence>();
        CommentFixtureCrossDomainSentinel? crossDomainBefore = null;
        string? manualReviewRegionPriorState = null;

        try
        {
            crossDomainBefore = await threads.ObserveCrossDomainAsync(
                articleId,
                [primary, secondary],
                admin,
                cancellationToken).ConfigureAwait(false);
            DateTime now = DateTime.UtcNow;
            string cacheIdentity = $"article:{articleId.ToString(CultureInfo.InvariantCulture)}";
            string cacheBefore = await ReadCacheGenerationAsync(cacheIdentity, cancellationToken).ConfigureAwait(false);

            RegionModerationDecision global = moderation.ResolveRegion(
                Content(owner, "region-global"), articleId, primary, RegionCodes.Global, now);
            manualReviewRegionPriorState = runtimeState.GetRegionState(ManualReviewFixtureRegion);
            Result<ModerationRuntimeSnapshot> manualReviewState = runtimeState.SetRegionState(
                ManualReviewFixtureRegion,
                ModerationRegionStates.ManualReviewOnly,
                $"comment fixture manual-review matrix {plan.RunId}",
                now.AddMinutes(15),
                null,
                owner);
            if (!manualReviewState.IsSuccess)
                throw new InvalidOperationException("Comment fixture could not enable the manual-review-only region runtime state.");
            Result<ModerationRuntimeSnapshot> modelState = runtimeState.SetModelRuntime(
                enabled: true,
                provider: null,
                modelProfile: null,
                thresholdProfile: null,
                reason: $"comment fixture anti-spam model runtime {plan.RunId}",
                changedBy: owner);
            if (!modelState.IsSuccess)
                throw new InvalidOperationException($"Comment fixture could not enable the anti-spam model runtime: {modelState.Error.Message}.");
            RegionModerationDecision manual = ResolveManualReviewRegion(owner, articleId, secondary, now);
            if (!global.CanPublish || !manual.CanPublish || !manual.RequiresManualReview
                || StringComparer.OrdinalIgnoreCase.Equals(global.SubmitRegion, manual.SubmitRegion))
                throw new InvalidOperationException("Current production region policy cannot prepare the required publishable manual-review matrix.");

            CommentThreadFixtureResult roots = await threads.ExecuteAsync(ThreadPlan(binding,
            [
                Create("approved-root", primary, manual),
            CreateAnonymous("pending", articleId, manual),
            Create("rejected", primary, manual),
            Create("spam", secondary, manual),
            Create("edited", primary, global),
            Create("deleted-root", secondary, global),
            Create("deleted-reply-parent", primary, global),
            Create("region-global", secondary, global),
            CreateAnonymous("region-manual-review", articleId, manual),
            Create("depth-root", secondary, global)
            ]), cancellationToken).ConfigureAwait(false);
            Merge(latest, zkAuthorityEvidence, roots);

            foreach (string role in new[] { "deleted-root", "deleted-reply-parent", "depth-root", "approved-root" })
                await ApproveAsync(binding, admin, latest[role].CommentId, role, cancellationToken).ConfigureAwait(false);

            CommentThreadFixtureResult firstRelations = await threads.ExecuteAsync(ThreadPlan(binding,
            [
                Create("approved-reply", secondary, global, latest["approved-root"].CommentId),
            Create("deleted-root-child", primary, global, latest["deleted-root"].CommentId),
            Create("deleted-reply", secondary, global, latest["deleted-reply-parent"].CommentId)
            ]), cancellationToken).ConfigureAwait(false);
            Merge(latest, zkAuthorityEvidence, firstRelations);
            foreach (string role in new[] { "approved-reply", "deleted-root-child", "deleted-reply" })
                await ApproveAsync(binding, admin, latest[role].CommentId, role, cancellationToken).ConfigureAwait(false);

            CommentThreadFixtureResult nested = await threads.ExecuteAsync(ThreadPlan(binding,
            [
                Create("approved-nested", primary, global, latest["approved-reply"].CommentId)
            ]), cancellationToken).ConfigureAwait(false);
            Merge(latest, zkAuthorityEvidence, nested);
            await ApproveAsync(binding, admin, latest["approved-nested"].CommentId, "approved-nested", cancellationToken).ConfigureAwait(false);

            int maxDepth = Math.Clamp(configuration.GetValue("CommentThreads:MaxDepth", CommentCommandService.DefaultMaxThreadDepth), 2, 256);
            long depthParent = latest["depth-root"].CommentId;
            for (int depth = 1; depth <= maxDepth; depth++)
            {
                string role = $"depth-{depth.ToString(CultureInfo.InvariantCulture)}";
                CommentThreadFixtureResult depthResult = await threads.ExecuteAsync(ThreadPlan(binding,
                [
                    Create(role, depth % 2 == 0 ? primary : secondary, global, depthParent)
                ]), cancellationToken).ConfigureAwait(false);
                Merge(latest, zkAuthorityEvidence, depthResult);
                depthParent = latest[role].CommentId;
                await ApproveAsync(binding, admin, depthParent, role, cancellationToken).ConfigureAwait(false);
            }
            CommentThreadFixtureResult overrun = await threads.ExecuteAsync(ThreadPlan(binding,
            [
                Create("depth-overrun-negative", primary, global, depthParent) with
            {
                Operation = CommentThreadFixtureOperations.RejectDepthOverrun,
                ExpectedFailureCode = "comment_thread_depth_limit"
            }
            ]), cancellationToken).ConfigureAwait(false);
            if (overrun.NegativeResults.GetValueOrDefault("depth-overrun-negative") != "comment_thread_depth_limit")
                throw new InvalidOperationException("Depth overrun negative plan has no exact production rejection.");

            CommentThreadFixtureResult mutations = await threads.ExecuteAsync(ThreadPlan(binding,
            [
                new("comment.version.edited", "edited", CommentThreadFixtureOperations.Edit,
                CommentAuthorModes.Public, primary, Content(owner, "edited-current"), ExistingCommentId: latest["edited"].CommentId),
            new("comment.delete.root", "deleted-root", CommentThreadFixtureOperations.SoftDelete,
                CommentAuthorModes.Public, secondary, string.Empty, ExistingCommentId: latest["deleted-root"].CommentId),
            new("comment.delete.reply", "deleted-reply", CommentThreadFixtureOperations.SoftDelete,
                CommentAuthorModes.Public, secondary, string.Empty, ExistingCommentId: latest["deleted-reply"].CommentId)
            ]), cancellationToken).ConfigureAwait(false);
            Merge(latest, zkAuthorityEvidence, mutations);

            var moderationOperations = new[]
            {
            Moderate("approved", "approved-root", latest["approved-root"].CommentId, string.Empty,
                latest["approved-root"].OperationPlanDigest),
            Moderate("pending", "pending", latest["pending"].CommentId, string.Empty,
                latest["pending"].OperationPlanDigest),
            Moderate("rejected", "rejected", latest["rejected"].CommentId, "fixture_rejected",
                latest["rejected"].OperationPlanDigest),
            Moderate("spam", "spam", latest["spam"].CommentId, "fixture_spam",
                latest["spam"].OperationPlanDigest, requireSignal: true),
            Region("comment.region.global", "approved", "region-global", latest["region-global"].CommentId,
                latest["region-global"].OperationPlanDigest),
            Region("comment.region.manual-review", "pending", "region-manual-review", latest["region-manual-review"].CommentId,
                latest["region-manual-review"].OperationPlanDigest)
        };
            CommentModerationFixtureResult moderationResult = await moderation.ExecuteAsync(
                new CommentModerationFixturePlan(
                    "fsusblog.comment-moderation-fixture-plan.v1",
                    binding,
                    admin,
                    moderationOperations)
                {
                    AdminActorReferenceDigest = plan.IdentityReferences.AdminActorReferenceDigest
                },
                cancellationToken).ConfigureAwait(false);

            IReadOnlyList<CommentThreadFixtureEntity> entities = await threads.ObserveCurrentAsync(
                new CommentThreadFixtureObservationPlan(
                    "fsusblog.comment-thread-fixture-observation.v1",
                    binding,
                    latest.ToDictionary(
                        item => item.Key,
                        item => new CommentThreadFixtureObservationIdentity(
                        item.Value.CommentId,
                        item.Value.AccountId,
                        item.Value.ActorMode,
                        item.Value.OperationPlanDigest,
                        item.Value.CapabilityId),
                        StringComparer.Ordinal)),
                cancellationToken).ConfigureAwait(false);
            if (entities.Select(item => item.CommentId).Distinct().Count() != entities.Count)
                throw new InvalidOperationException("Comment fixture reused an identity across semantic states.");
            CommentFixtureCrossDomainSentinel crossDomainAfterPrepare = await threads.ObserveCrossDomainAsync(
                articleId,
                [primary, secondary],
                admin,
                cancellationToken).ConfigureAwait(false);
            if (!CommentThreadFixturePort.SameCrossDomainSentinel(crossDomainBefore, crossDomainAfterPrepare))
                throw new InvalidOperationException("Comment fixture prepare changed non-owned article, auth, admin, or security facts.");
            var cleanup = new CommentThreadFixtureCleanupReceipt(
                CleanupSchema,
                binding,
                ToOwnedComments(entities),
                crossDomainBefore);
            string cacheAfter = await RequireAdvancedCacheGenerationAsync(cacheIdentity, cacheBefore, cancellationToken)
                .ConfigureAwait(false);
            var proofs = plan.Capabilities.Select(capability => new CommentFixtureCapabilityProof(
                capability,
                "verified",
                "exact",
                "exact",
                "exact",
                "exact",
                "exact",
                "exact")).ToArray();

            runtimeState.SetRegionState(
                ManualReviewFixtureRegion,
                manualReviewRegionPriorState ?? ModerationRegionStates.Enabled,
                $"comment fixture restore {plan.RunId}",
                null,
                null,
                owner);
            return new CommentFixtureResult(
                ProducerId,
                Strategy,
                plan.PlanDigest,
                plan.InventoryDigest,
                plan.CapabilityCatalogDigest,
                plan.VariantCatalogDigest,
                plan.TemporalContextDigest,
                plan.ProducerPlanDigest,
                proofs,
                entities,
                zkAuthorityEvidence,
                moderationResult,
                overrun.NegativeResults,
                cacheBefore,
                cacheAfter,
                crossDomainBefore,
                crossDomainAfterPrepare,
                cleanup);
        }
        catch (Exception preparationError)
        {
            if (manualReviewRegionPriorState is not null)
            {
                runtimeState.SetRegionState(
                    ManualReviewFixtureRegion,
                    manualReviewRegionPriorState,
                    $"comment fixture restore {plan.RunId}",
                    null,
                    null,
                    owner);
            }
            var owned = new Dictionary<long, CommentThreadFixtureOwnedIdentity>();
            foreach ((long id, CommentThreadFixtureOwnedIdentity identity) in ToOwnedComments(latest.Values))
                owned[id] = identity;
            if (preparationError is CommentThreadFixtureRecoveryException threadRecovery)
            {
                foreach ((long id, CommentThreadFixtureOwnedIdentity identity) in threadRecovery.RecoveryReceipt.OwnedComments)
                    owned[id] = identity;
            }
            var recoveryReceipt = new CommentThreadFixtureCleanupReceipt(
                CleanupSchema,
                binding,
                owned,
                crossDomainBefore);
            CommentThreadFixtureCleanupResult? cleanupResult = null;
            Exception? cleanupError = (preparationError as CommentThreadFixtureRecoveryException)?.CleanupError;
            if (owned.Count > 0)
            {
                try
                {
                    cleanupResult = await threads.CleanupAsync(recoveryReceipt, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception error)
                {
                    cleanupError = cleanupError is null
                        ? error
                        : new AggregateException(cleanupError, error);
                }
            }
            throw new CommentFixturePreparationException(
                cleanupError is null
                    ? "Comment fixture prepare failed; exact owned compensation completed."
                    : "Comment fixture prepare failed and exact owned compensation was incomplete.",
                preparationError,
                recoveryReceipt,
                cleanupResult,
                cleanupError);
        }
    }

    public Task<CommentThreadFixtureCleanupResult> CleanupAsync(
        CommentThreadFixtureCleanupReceipt receipt,
        CancellationToken cancellationToken = default)
        => threads.CleanupAsync(receipt, cancellationToken);

    private RegionModerationDecision ResolveManualReviewRegion(
        string owner,
        int articleId,
        int accountId,
        DateTime submittedAtUtc)
    {
        foreach (string region in new[] {
            RegionCodes.MainlandChina,
            RegionCodes.EuropeanUnion,
            RegionCodes.Germany,
            RegionCodes.Singapore,
            RegionCodes.UnitedStates,
            RegionCodes.Unknown
        })
        {
            RegionModerationDecision decision = moderation.ResolveRegion(
                Content(owner, $"region-review-{region}"), articleId, accountId, region, submittedAtUtc);
            if (decision.CanPublish && decision.RequiresManualReview && !decision.HideUntilReviewed)
                return decision;
        }
        throw new InvalidOperationException("No current production region policy produced the required manual-review state.");
    }

    private Task ApproveAsync(
        CommentFixturePortBinding binding,
        long admin,
        long commentId,
        string role,
        CancellationToken cancellationToken)
        => moderation.TransitionAsync(binding, admin, Moderate("approved", role, commentId, string.Empty), cancellationToken);

    private static CommentFixturePortBinding PortBinding(CommentFixturePlan source, string owner)
        => new(
            source.RunId,
            source.Namespace,
            source.TestSession,
            owner,
            source.ProfileId,
            source.Capabilities,
            source.ArticleReference.ArticleId,
            source.IdentityReferences.AuthProducerResultDigest,
            source.IdentityReferences.AuthPrepareReferenceDigests,
            source.ArticleReference.PublicContentProducerResultDigest,
            source.ArticleReference.ArticleProjectionDigest,
            source.InventoryDigest,
            source.CapabilityCatalogDigest,
            source.VariantCatalogDigest,
            source.TemporalContextDigest,
            source.ProducerPlanDigest,
            source.PlanDigest);

    private static IReadOnlyDictionary<long, CommentThreadFixtureOwnedIdentity> ToOwnedComments(
        IEnumerable<CommentThreadFixtureEntity> entities)
        => entities.ToDictionary(
            item => item.CommentId,
            item => new CommentThreadFixtureOwnedIdentity(
                item.CommentId,
                item.ArticleId,
                item.SemanticRole,
                item.ActorMode,
                item.AccountId,
                item.ContentDigest,
                item.CurrentVersion,
                item.IsDeleted,
                item.OperationPlanDigest));

    private static CommentThreadFixturePlan ThreadPlan(
        CommentFixturePortBinding binding,
        IReadOnlyList<CommentThreadFixtureOperation> operations)
        => new(
            "fsusblog.comment-thread-fixture-plan.v1",
            binding,
            operations);

    private static CommentThreadFixtureOperation Create(
        string role,
        int accountId,
        RegionModerationDecision region,
        long? parentId = null)
        => new(
            CapabilityForRole(role, parentId),
            role,
            CommentThreadFixtureOperations.Create,
            CommentAuthorModes.Public,
            accountId,
            $"Fixture comment {role}",
            ParentCommentId: parentId,
            RegionDecision: region);

    internal static string CapabilityForRole(string role, long? parentId)
    {
        if (string.IsNullOrWhiteSpace(role))
            throw new ArgumentException("Comment fixture role is required.", nameof(role));
        if (role.StartsWith("depth-", StringComparison.Ordinal))
            return "comment.thread.depth-boundary";
        if (parentId is null)
            return "comment.thread.root";
        return role.Contains("nested", StringComparison.Ordinal)
            ? "comment.thread.nested"
            : "comment.thread.reply";
    }

    private static CommentThreadFixtureOperation CreateAnonymous(
        string role,
        int articleId,
        RegionModerationDecision region)
        => new(
            role.StartsWith("region-", StringComparison.Ordinal)
                ? "moderation.region-policy"
                : "comment.moderation.pending",
            role,
            CommentThreadFixtureOperations.Create,
            CommentAuthorModes.ZkAnonymous,
            null,
            $"Fixture comment {role}",
            AnonymousScope: AnonymousCommentScopePolicy.CreateTopLevelScope(articleId),
            DisplayLanguage: "en",
            RegionDecision: region);

    private static CommentModerationFixtureOperation Moderate(
        string status,
        string role,
        long id,
        string reason,
        string commentReferenceDigest = "",
        bool requireSignal = false)
        => new(
            $"comment.moderation.{status}",
            role,
            id,
            status,
            reason,
            RequireRegionEvidence: true,
            RequireSignalEvidence: requireSignal)
        {
            CommentReferenceDigest = commentReferenceDigest,
            ReasonId = status switch
            {
                "approved" => "approved-none",
                "pending" => "pending-none",
                "rejected" => "rejected-fixture",
                "spam" => "spam-fixture",
                _ => string.Empty
            },
            SignalStateId = requireSignal ? "verified" : null
        };

    private static CommentModerationFixtureOperation Region(
        string capabilityId,
        string status,
        string role,
        long id,
        string commentReferenceDigest)
        => new(
            capabilityId,
            role,
            id,
            status,
            string.Empty,
            RequireRegionEvidence: true,
            RequireSignalEvidence: false)
        {
            CommentReferenceDigest = commentReferenceDigest,
            ReasonId = status == "approved" ? "approved-none" : "pending-none",
            RegionStateId = capabilityId.EndsWith("global", StringComparison.Ordinal)
                ? "global"
                : "manual-review"
        };

    private static string Content(string owner, string role) => $"Fixture comment {owner} {role}";

    private async Task<string> ReadCacheGenerationAsync(string identity, CancellationToken cancellationToken)
        => await cacheProbe.ReadCursorGenerationAsync(identity, cancellationToken)
            .ConfigureAwait(false) ?? "0";

    private async Task<string> RequireAdvancedCacheGenerationAsync(
        string identity,
        string before,
        CancellationToken cancellationToken)
    {
        for (int attempt = 0; attempt < 20; attempt++)
        {
            string current = await ReadCacheGenerationAsync(identity, cancellationToken).ConfigureAwait(false);
            if (long.TryParse(current, CultureInfo.InvariantCulture, out long currentValue)
                && long.TryParse(before, CultureInfo.InvariantCulture, out long beforeValue)
                && currentValue > beforeValue)
                return current;
            await Task.Delay(TimeSpan.FromMilliseconds(100), cancellationToken).ConfigureAwait(false);
        }
        throw new InvalidOperationException("Comment cache generation did not advance through the production outbox path.");
    }

    private static void Merge(
        IDictionary<string, CommentThreadFixtureEntity> target,
        ICollection<CommentFixtureZkAuthorityEvidence> evidence,
        CommentThreadFixtureResult result)
    {
        foreach (CommentThreadFixtureEntity entity in result.Entities)
        {
            // A deleted reply keeps its thread identity: comment.delete.reply is an
            // operation-level capability proven by the deleted revision, while the
            // entity itself is still classified by its position in the thread.
            if (entity.CapabilityId == "comment.delete.reply" && target.ContainsKey(entity.SemanticRole))
                continue;
            target[entity.SemanticRole] = entity;
        }
        foreach (CommentFixtureZkAuthorityEvidence item in result.ZkAuthorityEvidence)
            evidence.Add(item);
    }

    private static void ValidatePlan(CommentFixturePlan plan)
    {
        if (plan.Schema != PlanSchema || plan.ProducerId != ProducerId || plan.Strategy != Strategy
            || string.IsNullOrWhiteSpace(plan.RunId) || string.IsNullOrWhiteSpace(plan.Namespace)
            || !HttpTestSessionKeyScope.IsValidSessionId(plan.TestSession)
            || string.IsNullOrWhiteSpace(plan.ProfileId) || plan.ArticleReference.ArticleId <= 0
            || plan.IdentityReferences.PrimaryAccountId <= 0 || plan.IdentityReferences.SecondaryAccountId <= 0
            || plan.IdentityReferences.PrimaryAccountId == plan.IdentityReferences.SecondaryAccountId
            || plan.IdentityReferences.AdminPrincipalId <= 0
            || !IsDigest(plan.IdentityReferences.AdminActorReferenceDigest)
            || !plan.IdentityReferences.AuthPrepareReferenceDigests.Contains(
                plan.IdentityReferences.AdminActorReferenceDigest,
                StringComparer.Ordinal)
            || !plan.Capabilities.Order(StringComparer.Ordinal).SequenceEqual(s_expectedCapabilities, StringComparer.Ordinal)
            || !IsDigest(plan.InventoryDigest) || !IsDigest(plan.CapabilityCatalogDigest)
            || !IsDigest(plan.VariantCatalogDigest) || !IsDigest(plan.TemporalContextDigest)
            || !IsDigest(plan.ProducerPlanDigest) || !IsDigest(plan.PlanDigest)
            || !IsDigest(plan.IdentityReferences.AuthProducerResultDigest)
            || plan.IdentityReferences.AuthPrepareReferenceDigests.Count != 3
            || !IsDigest(plan.ArticleReference.PublicContentProducerResultDigest)
            || !IsDigest(plan.ArticleReference.ArticleProjectionDigest))
            throw new InvalidOperationException("Comment fixture plan is incomplete or stale.");
    }

    private static bool IsDigest(string value) => value.StartsWith("sha256:", StringComparison.Ordinal)
        && value.Length == 71 && value.AsSpan(7).IndexOfAnyExcept(s_myChars) < 0;
}
