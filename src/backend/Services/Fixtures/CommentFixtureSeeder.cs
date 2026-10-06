// fixture-catalog: producer comment-moderation
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

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
    CommentThreadFixtureCleanupReceipt CleanupReceipt,
    CommentModerationRuntimeLease RuntimeLease,
    CommentModerationRuntimeRestore RuntimeRestore);

/// <summary>
/// Aggregate cleanup result: the thread port's exact owned cleanup plus the
/// moderation port's independent post-cleanup observation over the same owned
/// identities.
/// </summary>
public sealed record CommentFixtureCleanupResult(
    string Schema,
    CommentFixturePortBinding Binding,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] IReadOnlyList<long> DeletedCommentIds,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] IReadOnlyList<long> StillPublicCommentIds,
    bool Exact,
    CommentFixtureCrossDomainSentinel? CrossDomainBefore,
    CommentFixtureCrossDomainSentinel? CrossDomainAfter,
    CommentModerationCleanupObservation ModerationObservation);

/// <summary>Canonical receipt bytes are checked against the complete sealed receipt, not self-reported flags.</summary>
public sealed record CommentFixtureSealedReference(JsonElement Receipt, string CanonicalBody);

public sealed record CommentFixtureVerificationRequest(
    string Schema,
    CommentFixturePlan Plan,
    CommentThreadFixtureCleanupReceipt CleanupReceipt,
    IReadOnlyDictionary<string, CommentThreadFixtureObservationIdentity> Roles,
    CommentFixtureSealedReference AuthReference,
    CommentFixtureSealedReference PublicReference,
    JsonElement VerifiedAuthReferences);

public sealed record CommentFixtureVerificationResult(
    string Schema,
    CommentFixturePortBinding Binding,
    IReadOnlyList<CommentThreadFixtureEntity> ThreadEntities,
    CommentModerationFixtureResult Moderation,
    string CacheGeneration,
    CommentFixtureCrossDomainSentinel CrossDomainBefore,
    CommentFixtureCrossDomainSentinel CrossDomainAfter,
    string AuthSourceReceiptDigest,
    string PublicSourceReceiptDigest);

public interface ICommentFixtureSeeder
{
    Task<CommentFixtureResult> PrepareAsync(
        CommentFixturePlan plan,
        CancellationToken cancellationToken = default);

    Task<CommentFixtureCleanupResult> CleanupAsync(
        CommentThreadFixtureCleanupReceipt receipt,
        CancellationToken cancellationToken = default);

    Task<CommentFixtureVerificationResult> VerifyAsync(
        CommentFixtureVerificationRequest request,
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
    IConfiguration configuration,
    TimeProvider timeProvider) : ICommentFixtureSeeder
{
    private static readonly System.Buffers.SearchValues<char> s_myChars = System.Buffers.SearchValues.Create("0123456789abcdef");
    private const string ProducerId = "comment-moderation";
    private const string ManualReviewFixtureRegion = RegionCodes.UnitedStates;
    private const string Strategy = "transaction-fixture";
    private const string PlanSchema = "fsusblog.comment-fixture-plan.v1";
    private const string CleanupSchema = "fsusblog.comment-thread-fixture-cleanup.v1";
    private const string CleanupResultSchema = "fsusblog.comment-fixture-cleanup-result.v1";
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
        CommentModerationRuntimeLease? runtimeLease = null;

        try
        {
            crossDomainBefore = await threads.ObserveCrossDomainAsync(
                articleId,
                [primary, secondary],
                admin,
                cancellationToken).ConfigureAwait(false);
            DateTime now = timeProvider.GetUtcNow().UtcDateTime;
            string cacheBefore = await ReadCommentCacheGenerationAsync(articleId, cancellationToken).ConfigureAwait(false);

            RegionModerationDecision global = moderation.ResolveRegion(
                Content(owner, "region-global"), articleId, primary, RegionCodes.Global, now);
            // The moderation port owns the leased region/model runtime state: it
            // snapshots the exact prior state under the same owner identity and
            // restores it through the lease on both success and failure paths.
            runtimeLease = moderation.AcquireRuntimeState(binding, ManualReviewFixtureRegion);
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
            string cacheAfter = await RequireAdvancedCacheGenerationAsync(articleId, cacheBefore, cancellationToken)
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

            CommentModerationRuntimeRestore runtimeRestore = moderation.RestoreRuntimeState(runtimeLease);
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
                cleanup,
                runtimeLease,
                runtimeRestore);
        }
        catch (Exception preparationError)
        {
            Exception? cleanupError = preparationError switch
            {
                CommentThreadFixtureRecoveryException threadFailure => threadFailure.CleanupError,
                CommentModerationRuntimeAcquisitionException runtimeFailure => runtimeFailure.CleanupError,
                _ => null
            };
            if (runtimeLease is not null)
            {
                try
                {
                    moderation.RestoreRuntimeState(runtimeLease);
                }
                catch (Exception restoreError)
                {
                    cleanupError = cleanupError is null
                        ? restoreError
                        : new AggregateException(cleanupError, restoreError);
                }
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
                preparationError is CommentModerationRuntimeAcquisitionException { InnerException: { } originalCause }
                    ? originalCause
                    : preparationError,
                recoveryReceipt,
                cleanupResult,
                cleanupError);
        }
    }

    public async Task<CommentFixtureCleanupResult> CleanupAsync(
        CommentThreadFixtureCleanupReceipt receipt,
        CancellationToken cancellationToken = default)
    {
        CommentThreadFixtureCleanupResult thread = await threads.CleanupAsync(
            receipt,
            cancellationToken).ConfigureAwait(false);
        CommentModerationCleanupObservation observation = await moderation.VerifyCleanupAsync(
            receipt.Binding,
            [.. receipt.OwnedComments.Keys.Order()],
            cancellationToken).ConfigureAwait(false);
        return new CommentFixtureCleanupResult(
            CleanupResultSchema,
            thread.Binding,
            thread.DeletedCommentIds,
            thread.StillPublicCommentIds,
            thread.Exact,
            thread.CrossDomainBefore,
            thread.CrossDomainAfter,
            observation);
    }

    /// <summary>Observe the exact prepared graph independently; never execute, drain, restore or repair it.</summary>
    public async Task<CommentFixtureVerificationResult> VerifyAsync(
        CommentFixtureVerificationRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();
        if (request.Roles is null
            || request.Roles.Any(item => string.IsNullOrWhiteSpace(item.Key)
                || item.Value is null || item.Value.CommentId <= 0)
            || request.CleanupReceipt?.OwnedComments is null
            || request.CleanupReceipt.OwnedComments.Any(item => item.Key <= 0
                || item.Value is null || item.Value.CommentId != item.Key))
            throw new InvalidOperationException("Comment verify owned role authority is invalid.");
        CommentFixturePlan plan = request.Plan;
        ValidatePlan(plan);
        CommentFixturePortBinding binding = PortBinding(plan, $"comment-fixture:{plan.Namespace}:{plan.RunId}");
        if (request.Schema != "fsusblog.comment-fixture-verification-request.v1"
            || !binding.IsValid()
            || request.CleanupReceipt.Schema != CleanupSchema
            || JsonSerializer.Serialize(request.CleanupReceipt.Binding) != JsonSerializer.Serialize(binding)
            || request.CleanupReceipt.CrossDomainBefore is null)
            throw new InvalidOperationException("Comment verify plan/cleanup owner binding is invalid.");

        JsonElement auth = ValidateSealedReference(request.AuthReference, "auth-session", plan);
        JsonElement content = ValidateSealedReference(request.PublicReference, "public-content", plan);
        if (!JsonElement.DeepEquals(auth.GetProperty("source"), content.GetProperty("source"))
            || ReceiptText(auth, "serviceGeneration") != ReceiptText(content, "serviceGeneration")
            || ReceiptText(auth, "fixtureCatalogDigest") != ReceiptText(content, "fixtureCatalogDigest"))
            throw new InvalidOperationException("Comment verify prerequisite execution identity differs.");
        RequireOwnedReference(auth, "admin", plan.IdentityReferences.AdminPrincipalId.ToString(CultureInfo.InvariantCulture), "admin");
        RequireOwnedReference(auth, "user", plan.IdentityReferences.PrimaryAccountId.ToString(CultureInfo.InvariantCulture), "primary-author");
        RequireOwnedReference(auth, "user", plan.IdentityReferences.SecondaryAccountId.ToString(CultureInfo.InvariantCulture), "secondary-author");
        RequireOwnedReference(content, "article", plan.ArticleReference.ArticleId.ToString(CultureInfo.InvariantCulture), role: null);
        ValidateVerifiedAuthReferences(request.VerifiedAuthReferences, auth, plan);

        int maxDepth = Math.Clamp(configuration.GetValue("CommentThreads:MaxDepth", CommentCommandService.DefaultMaxThreadDepth), 2, 256);
        string[] expectedRoles = new[] {
            "approved-root", "approved-reply", "approved-nested", "pending", "rejected", "spam", "edited",
            "deleted-root", "deleted-root-child", "deleted-reply-parent", "deleted-reply",
            "region-global", "region-manual-review", "depth-root"
        }.Concat(Enumerable.Range(1, maxDepth).Select(depth => $"depth-{depth.ToString(CultureInfo.InvariantCulture)}"))
            .Order(StringComparer.Ordinal).ToArray();
        if (!request.Roles.Keys.Order(StringComparer.Ordinal).SequenceEqual(expectedRoles, StringComparer.Ordinal)
            || request.Roles.Values.Select(item => item.CommentId).Distinct().Count() != expectedRoles.Length
            || !request.Roles.Values.Select(item => item.CommentId).Order()
                .SequenceEqual(request.CleanupReceipt.OwnedComments.Keys.Order()))
            throw new InvalidOperationException("Comment verify owned role graph is missing, extra or reused.");
        foreach ((string role, CommentThreadFixtureObservationIdentity identity) in request.Roles)
        {
            CommentThreadFixtureOwnedIdentity owned = request.CleanupReceipt.OwnedComments[identity.CommentId];
            string capability = role switch
            {
                "edited" => "comment.version.edited",
                "deleted-root" => "comment.delete.root",
                "pending" => "comment.moderation.pending",
                "region-manual-review" => "moderation.region-policy",
                "approved-nested" => "comment.thread.nested",
                "approved-reply" or "deleted-root-child" or "deleted-reply" => "comment.thread.reply",
                _ => role.StartsWith("depth-", StringComparison.Ordinal) ? "comment.thread.depth-boundary" : "comment.thread.root"
            };
            bool anonymous = role is "pending" or "region-manual-review";
            int? account = anonymous ? null : role is "approved-root" or "rejected" or "edited" or "deleted-reply-parent" or "approved-nested" or "deleted-root-child"
                || (role != "depth-root" && role.StartsWith("depth-", StringComparison.Ordinal)
                    && int.TryParse(role.AsSpan(6), out int depth) && depth % 2 == 0)
                ? plan.IdentityReferences.PrimaryAccountId : plan.IdentityReferences.SecondaryAccountId;
            if (owned.CommentId != identity.CommentId || owned.SemanticRole != role || owned.ArticleId != binding.ArticleId
                || owned.AccountId != identity.AccountId || owned.ActorMode != identity.ActorMode
                || owned.OperationPlanDigest != identity.OperationPlanDigest || identity.CapabilityId != capability
                || identity.AccountId != account || identity.ActorMode != (anonymous ? CommentAuthorModes.ZkAnonymous : CommentAuthorModes.Public))
                throw new InvalidOperationException("Comment verify role does not bind its exact owned source.");
        }
        CommentFixtureCrossDomainSentinel before = await threads.ObserveCrossDomainAsync(
            binding.ArticleId, [plan.IdentityReferences.PrimaryAccountId, plan.IdentityReferences.SecondaryAccountId],
            plan.IdentityReferences.AdminPrincipalId, cancellationToken).ConfigureAwait(false);
        if (!CommentThreadFixturePort.SameCrossDomainSentinel(before, request.CleanupReceipt.CrossDomainBefore))
            throw new InvalidOperationException("Comment verify prerequisite article/auth/admin/security state drifted.");

        IReadOnlyList<CommentThreadFixtureEntity> entities = await threads.ObserveCurrentAsync(
            new CommentThreadFixtureObservationPlan("fsusblog.comment-thread-fixture-observation.v1", binding, request.Roles),
            cancellationToken).ConfigureAwait(false);
        if (entities.Count != expectedRoles.Length || entities.Select(item => item.SemanticRole).Distinct().Count() != expectedRoles.Length
            || !entities.Select(item => item.SemanticRole).Order(StringComparer.Ordinal).SequenceEqual(expectedRoles, StringComparer.Ordinal))
            throw new InvalidOperationException("Comment verify service returned an inexact role graph.");
        foreach (CommentThreadFixtureEntity entity in entities)
        {
            CommentThreadFixtureObservationIdentity source = request.Roles[entity.SemanticRole];
            if (entity.CommentId != source.CommentId || entity.OperationPlanDigest != source.OperationPlanDigest
                || entity.CapabilityId != source.CapabilityId
                || !request.CleanupReceipt.OwnedComments.TryGetValue(entity.CommentId, out CommentThreadFixtureOwnedIdentity? owned)
                || JsonSerializer.Serialize(ToOwnedComments([entity])[entity.CommentId]) != JsonSerializer.Serialize(owned))
                throw new InvalidOperationException("Comment verify current version/content/delete/actor identity drifted.");
            RequireExactThreadRelation(entity, request.Roles);
        }
        CommentModerationFixturePlan readPlan = new(
            "fsusblog.comment-moderation-fixture-plan.v1", binding, plan.IdentityReferences.AdminPrincipalId,
            [
                Moderate("approved", "approved-root", request.Roles["approved-root"].CommentId, string.Empty, request.Roles["approved-root"].OperationPlanDigest),
                Moderate("pending", "pending", request.Roles["pending"].CommentId, string.Empty, request.Roles["pending"].OperationPlanDigest),
                Moderate("rejected", "rejected", request.Roles["rejected"].CommentId, "fixture_rejected", request.Roles["rejected"].OperationPlanDigest),
                Moderate("spam", "spam", request.Roles["spam"].CommentId, "fixture_spam", request.Roles["spam"].OperationPlanDigest, requireSignal: true),
                Region("comment.region.global", "approved", "region-global", request.Roles["region-global"].CommentId, request.Roles["region-global"].OperationPlanDigest),
                Region("comment.region.manual-review", "pending", "region-manual-review", request.Roles["region-manual-review"].CommentId, request.Roles["region-manual-review"].OperationPlanDigest)
            ])
        {
            AdminActorReferenceDigest = plan.IdentityReferences.AdminActorReferenceDigest
        };
        CommentModerationFixtureResult observedModeration = await moderation.ObserveCurrentAsync(readPlan, cancellationToken)
            .ConfigureAwait(false);
        string generation = await ReadCommentCacheGenerationAsync(binding.ArticleId, cancellationToken).ConfigureAwait(false);
        CommentFixtureCrossDomainSentinel after = await threads.ObserveCrossDomainAsync(
            binding.ArticleId, [plan.IdentityReferences.PrimaryAccountId, plan.IdentityReferences.SecondaryAccountId],
            plan.IdentityReferences.AdminPrincipalId, cancellationToken).ConfigureAwait(false);
        if (!CommentThreadFixturePort.SameCrossDomainSentinel(before, after))
            throw new InvalidOperationException("Comment verify crossed a prerequisite mutation boundary.");
        return new CommentFixtureVerificationResult("fsusblog.comment-fixture-verification-result.v1", binding,
            entities, observedModeration, generation, before, after,
            ReceiptText(auth, "producerReceiptDigest"), ReceiptText(content, "producerReceiptDigest"));
    }

    private static void RequireExactThreadRelation(CommentThreadFixtureEntity entity,
        IReadOnlyDictionary<string, CommentThreadFixtureObservationIdentity> roles)
    {
        string? parentRole = entity.SemanticRole switch
        {
            "approved-reply" => "approved-root",
            "approved-nested" => "approved-reply",
            "deleted-root-child" => "deleted-root",
            "deleted-reply" => "deleted-reply-parent",
            _ => null
        };
        int depth = parentRole == "approved-reply" ? 2 : parentRole is null ? 0 : 1;
        if (entity.SemanticRole.StartsWith("depth-", StringComparison.Ordinal) && entity.SemanticRole != "depth-root")
        {
            if (!int.TryParse(entity.SemanticRole.AsSpan(6), NumberStyles.None, CultureInfo.InvariantCulture, out depth) || depth <= 0)
                throw new InvalidOperationException("Comment verify depth role is invalid.");
            parentRole = depth == 1 ? "depth-root" : $"depth-{(depth - 1).ToString(CultureInfo.InvariantCulture)}";
        }
        long? parent = parentRole is null ? null : roles[parentRole].CommentId;
        long root = entity.SemanticRole.StartsWith("depth-", StringComparison.Ordinal) ? roles["depth-root"].CommentId
            : entity.SemanticRole is "approved-reply" or "approved-nested" ? roles["approved-root"].CommentId
            : entity.SemanticRole == "deleted-root-child" ? roles["deleted-root"].CommentId
            : entity.SemanticRole == "deleted-reply" ? roles["deleted-reply-parent"].CommentId : entity.CommentId;
        if (entity.ParentId != parent || entity.ReplyToCommentId != parent || entity.RootId != root || entity.Depth != depth)
            throw new InvalidOperationException("Comment verify parent/root/reply/depth relation drifted.");
    }

    private static JsonElement ValidateSealedReference(CommentFixtureSealedReference reference, string producerId, CommentFixturePlan plan)
    {
        JsonElement receipt = reference.Receipt;
        JsonObject unsigned = JsonNode.Parse(receipt.GetRawText())?.AsObject()
            ?? throw new InvalidOperationException("Comment verify prerequisite receipt is missing.");
        string digest = ReceiptText(receipt, "producerReceiptDigest");
        unsigned.Remove("producerReceiptDigest");
        using JsonDocument canonical = JsonDocument.Parse(reference.CanonicalBody);
        if (!JsonElement.DeepEquals(JsonSerializer.SerializeToElement(unsigned), canonical.RootElement)
            || digest != $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(reference.CanonicalBody))).ToLowerInvariant()}"
            || ReceiptText(receipt, "schema") != "fsusblog.fixture-producer-receipt.v1"
            || ReceiptText(receipt, "producerId") != producerId || ReceiptText(receipt, "strategy") != Strategy
            || ReceiptText(receipt, "runId") != plan.RunId || ReceiptText(receipt, "namespace") != plan.Namespace
            || ReceiptText(receipt, "profileId") != plan.ProfileId
            || ReceiptText(receipt, "expandedCapabilityDigest") != plan.CapabilityCatalogDigest
            || ReceiptText(receipt, "variantPlanDigest") != plan.VariantCatalogDigest
            || !IsDigest(ReceiptText(receipt, "serviceGeneration"))
            || !IsDigest(ReceiptText(receipt.GetProperty("source"), "worktreeFingerprint"))
            || ReceiptText(receipt.GetProperty("source"), "commit").Length != 40
            || !receipt.GetProperty("postconditionObservations").EnumerateArray().Any()
            || receipt.GetProperty("postconditionObservations").EnumerateArray().Any(item => !item.GetProperty("ok").GetBoolean()))
            throw new InvalidOperationException("Comment verify prerequisite receipt is unsealed, failed or cross-run/profile/source.");
        return receipt;
    }

    private static string ReceiptText(JsonElement element, string key)
        => element.GetProperty(key).GetString() ?? throw new InvalidOperationException("Comment verify receipt field is missing.");

    private static void ValidateVerifiedAuthReferences(JsonElement projection, JsonElement auth, CommentFixturePlan plan)
    {
        if (ReceiptText(projection, "schema") != "fsusblog.fixture-identity-references.v1"
            || !projection.GetProperty("verified").GetBoolean()
            || ReceiptText(projection, "ownerProducerId") != "auth-session"
            || ReceiptText(projection, "consumerProducerId") != ProducerId
            || ReceiptText(projection, "runId") != plan.RunId || ReceiptText(projection, "namespace") != plan.Namespace
            || ReceiptText(projection, "profileId") != plan.ProfileId
            || ReceiptText(projection, "sourceReceiptDigest") != ReceiptText(auth, "producerReceiptDigest")
            || !ValidReferenceDigest(projection))
            throw new InvalidOperationException("Comment verify auth projection is unsealed or cross-consumer.");
        JsonElement[] references = projection.GetProperty("references").EnumerateArray().ToArray();
        string[] expected = ["admin", "primary-author", "secondary-author"];
        if (references.Length != 3 || !references.Select(item => ReceiptText(item, "role")).Order(StringComparer.Ordinal).SequenceEqual(expected, StringComparer.Ordinal)
            || !references.Select(item => $"sha256:{ReceiptText(item, "prepareReferenceDigest")}").Order(StringComparer.Ordinal)
                .SequenceEqual(plan.IdentityReferences.AuthPrepareReferenceDigests, StringComparer.Ordinal))
            throw new InvalidOperationException("Comment verify auth projection roles/preparation references differ.");
        foreach (JsonElement reference in references)
        {
            string role = ReceiptText(reference, "role");
            string id = role == "admin" ? plan.IdentityReferences.AdminPrincipalId.ToString(CultureInfo.InvariantCulture)
                : (role == "primary-author" ? plan.IdentityReferences.PrimaryAccountId : plan.IdentityReferences.SecondaryAccountId).ToString(CultureInfo.InvariantCulture);
            if (ReceiptText(reference, "schema") != "fsusblog.fixture-identity-reference.v1" || !reference.GetProperty("verified").GetBoolean()
                || ReceiptText(reference, "ownerProducerId") != "auth-session" || ReceiptText(reference, "consumerProducerId") != ProducerId
                || ReceiptText(reference, "runId") != plan.RunId || ReceiptText(reference, "namespace") != plan.Namespace
                || ReceiptText(reference, "profileId") != plan.ProfileId || ReceiptText(reference, "publicId") != id
                || ReceiptText(reference, "semanticRole") != $"consumer.comment-moderation.{role}"
                || ReceiptText(reference, "capabilityId") != (role == "admin" ? "auth.admin.full-permission" : "auth.user.active")
                || $"sha256:{ReceiptText(reference, "producerResultDigest")}" != plan.IdentityReferences.AuthProducerResultDigest
                || ReceiptText(reference, "sourceReceiptDigest") != ReceiptText(auth, "producerReceiptDigest")
                || !ValidReferenceDigest(reference)
                || !auth.GetProperty("observations").GetProperty("database").GetProperty("entities").EnumerateArray()
                    .Any(item => ReceiptText(item, "id") == id && ReceiptText(item, "semanticRole") == ReceiptText(reference, "semanticRole")
                        && ReceiptText(item, "fixtureIdentity") == ReceiptText(reference, "fixtureIdentity")))
                throw new InvalidOperationException("Comment verify auth identity reference is not bound to its sealed owner.");
            if (role == "admin" && $"sha256:{ReceiptText(reference, "prepareReferenceDigest")}" != plan.IdentityReferences.AdminActorReferenceDigest)
                throw new InvalidOperationException("Comment verify admin actor reference differs.");
        }
    }

    private static bool ValidReferenceDigest(JsonElement value)
    {
        JsonObject body = JsonNode.Parse(value.GetRawText())!.AsObject();
        string digest = ReceiptText(value, "digest");
        body.Remove("digest");
        string json = body.ToJsonString(new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        return digest == Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json))).ToLowerInvariant();
    }

    private static void RequireOwnedReference(JsonElement receipt, string kind, string id, string? role)
    {
        JsonElement[] matches = receipt.GetProperty("observations").GetProperty("database").GetProperty("entities")
            .EnumerateArray().Where(item => ReceiptText(item, "kind") == kind && ReceiptText(item, "id") == id
                && item.TryGetProperty("owned", out JsonElement owned) && owned.GetBoolean()
                && (role is null || ReceiptText(item, "semanticRole") == $"consumer.comment-moderation.{role}"))
            .ToArray();
        if (matches.Length != 1 || !receipt.GetProperty("entityIdentities").EnumerateArray()
                .Any(item => ReceiptText(item, "kind") == kind && ReceiptText(item, "id") == id))
            throw new InvalidOperationException("Comment verify prerequisite is not an exact owned sealed reference.");
    }

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

    private async Task<string> ReadCommentCacheGenerationAsync(int articleId, CancellationToken cancellationToken)
        => await moderation.ReadCommentCacheGenerationAsync(articleId, cancellationToken)
            .ConfigureAwait(false) ?? "0";

    private async Task<string> RequireAdvancedCacheGenerationAsync(
        int articleId,
        string before,
        CancellationToken cancellationToken)
    {
        for (int attempt = 0; attempt < 60; attempt++)
        {
            string current = await ReadCommentCacheGenerationAsync(articleId, cancellationToken).ConfigureAwait(false);
            if (long.TryParse(current, CultureInfo.InvariantCulture, out long currentValue)
                && long.TryParse(before, CultureInfo.InvariantCulture, out long beforeValue)
                && currentValue > beforeValue)
                return current;
            await Task.Delay(TimeSpan.FromMilliseconds(500), cancellationToken).ConfigureAwait(false);
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
