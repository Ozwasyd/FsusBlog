// fixture-catalog: producer comment-moderation
// fixture-catalog: port comment-thread-lifecycle
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures;

public static class CommentThreadFixtureOperations
{
    public const string Create = "create";
    public const string Edit = "edit";
    public const string SoftDelete = "soft-delete";
    public const string RejectDepthOverrun = "reject-depth-overrun";
}

public sealed record CommentFixturePortBinding(
    string RunId,
    string Namespace,
    string TestSession,
    string Owner,
    string ProfileId,
    IReadOnlyList<string> Capabilities,
    int ArticleId,
    string AuthProducerResultDigest,
    IReadOnlyList<string> AuthPrepareReferenceDigests,
    string PublicContentProducerResultDigest,
    string ArticleProjectionDigest,
    string InventoryDigest,
    string CapabilityCatalogDigest,
    string VariantCatalogDigest,
    string TemporalContextDigest,
    string ProducerPlanDigest,
    string PlanDigest)
{
    internal bool IsValid()
        => !string.IsNullOrWhiteSpace(RunId)
            && !string.IsNullOrWhiteSpace(Namespace)
            && HttpTestSessionKeyScope.IsValidSessionId(TestSession)
            && !string.IsNullOrWhiteSpace(Owner)
            && !string.IsNullOrWhiteSpace(ProfileId)
            && Capabilities.Count > 0
            && Capabilities.Order(StringComparer.Ordinal).SequenceEqual(Capabilities, StringComparer.Ordinal)
            && Capabilities.Distinct(StringComparer.Ordinal).Count() == Capabilities.Count
            && ArticleId > 0
            && AuthPrepareReferenceDigests.Count == 3
            && AuthPrepareReferenceDigests.Order(StringComparer.Ordinal)
                .SequenceEqual(AuthPrepareReferenceDigests, StringComparer.Ordinal)
            && AuthPrepareReferenceDigests.Distinct(StringComparer.Ordinal).Count() == AuthPrepareReferenceDigests.Count
            && IsDigest(AuthProducerResultDigest)
            && AuthPrepareReferenceDigests.All(IsDigest)
            && IsDigest(PublicContentProducerResultDigest)
            && IsDigest(ArticleProjectionDigest)
            && IsDigest(InventoryDigest)
            && IsDigest(CapabilityCatalogDigest)
            && IsDigest(VariantCatalogDigest)
            && IsDigest(TemporalContextDigest)
            && IsDigest(ProducerPlanDigest)
            && IsDigest(PlanDigest);

    private static bool IsDigest(string value) => value.StartsWith("sha256:", StringComparison.Ordinal)
        && value.Length == 71 && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;
}

public sealed record CommentThreadFixtureOperation(
    string CapabilityId,
    string SemanticRole,
    string Operation,
    string ActorMode,
    int? AccountId,
    string Content,
    string? ParentRole = null,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] long? ParentCommentId = null,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] long? ExistingCommentId = null,
    string? ExpectedFailureCode = null,
    string? AnonymousScope = null,
    string? DisplayLanguage = null,
    RegionModerationDecision? RegionDecision = null);

public sealed record CommentThreadFixturePlan(
    string Schema,
    CommentFixturePortBinding Binding,
    IReadOnlyList<CommentThreadFixtureOperation> Operations);

public sealed record CommentThreadFixtureEntity(
    string SemanticRole,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] long CommentId,
    int ArticleId,
    string ActorMode,
    int? AccountId,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] long RootId,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] long? ParentId,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] long? ReplyToCommentId,
    int Depth,
    int CurrentVersion,
    bool IsDeleted,
    string ModerationStatus,
    string ContentDigest,
    IReadOnlyList<CommentRevisionResult> History,
    bool PubliclyVisible,
    IReadOnlyList<string> OutboxEventIds,
    string OperationPlanDigest,
    string CapabilityId,
    IReadOnlyList<string> AuditEventIds,
    string CacheIdentity,
    string CacheGeneration);

public sealed record CommentThreadFixtureResult(
    string Schema,
    CommentFixturePortBinding Binding,
    IReadOnlyList<CommentThreadFixtureEntity> Entities,
    IReadOnlyDictionary<string, string> NegativeResults,
    IReadOnlyList<CommentFixtureZkAuthorityEvidence> ZkAuthorityEvidence);

public sealed record CommentThreadFixtureObservationIdentity(
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] long CommentId,
    int? AccountId,
    string ActorMode,
    string OperationPlanDigest,
    string CapabilityId);

public sealed record CommentThreadFixtureObservationPlan(
    string Schema,
    CommentFixturePortBinding Binding,
    IReadOnlyDictionary<string, CommentThreadFixtureObservationIdentity> Roles);

public sealed record CommentThreadFixtureOwnedIdentity(
    // long snowflake ids exceed JS Number precision; carry the id as a string on the wire
    [property: JsonNumberHandling(JsonNumberHandling.WriteAsString | JsonNumberHandling.AllowReadingFromString)] long CommentId,
    int ArticleId,
    string SemanticRole,
    string ActorMode,
    int? AccountId,
    string ContentDigest,
    int CurrentVersion,
    bool IsDeleted,
    string OperationPlanDigest);

public sealed record CommentFixtureCrossDomainSentinel(
    string Schema,
    int ArticleId,
    IReadOnlyList<int> AccountIds,
    long AdminPrincipalId,
    string ArticleDigest,
    string AuthDigest,
    string AdminDigest,
    string SecurityDigest);

public sealed record CommentThreadFixtureCleanupReceipt(
    string Schema,
    CommentFixturePortBinding Binding,
    IReadOnlyDictionary<long, CommentThreadFixtureOwnedIdentity> OwnedComments,
    CommentFixtureCrossDomainSentinel? CrossDomainBefore = null);

public sealed record CommentThreadFixtureCleanupResult(
    string Schema,
    CommentFixturePortBinding Binding,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] IReadOnlyList<long> DeletedCommentIds,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] IReadOnlyList<long> StillPublicCommentIds,
    bool Exact,
    CommentFixtureCrossDomainSentinel? CrossDomainBefore = null,
    CommentFixtureCrossDomainSentinel? CrossDomainAfter = null);

public sealed class CommentThreadFixtureRecoveryException(
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
}

public interface ICommentThreadFixturePort
{
    Task<CommentFixtureMutationResult> ExecuteMutationAsync(
        CommentFixtureMutationPlan plan,
        CancellationToken cancellationToken = default);

    Task<CommentFixtureDeliveryObservation> ObserveDeliveryAsync(
        CommentFixtureMutationResult authority,
        CancellationToken cancellationToken = default);

    Task<CommentThreadFixtureResult> ExecuteAsync(
        CommentThreadFixturePlan plan,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<CommentThreadFixtureEntity>> ObserveCurrentAsync(
        CommentThreadFixtureObservationPlan plan,
        CancellationToken cancellationToken = default);

    Task<CommentFixtureCrossDomainSentinel> ObserveCrossDomainAsync(
        int articleId,
        IReadOnlyList<int> accountIds,
        long adminPrincipalId,
        CancellationToken cancellationToken = default);

    Task<CommentThreadFixtureCleanupResult> CleanupAsync(
        CommentThreadFixtureCleanupReceipt receipt,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Test-only typed composition port. All mutations delegate to the production
/// comment command and author-management services; the database is read only.
/// </summary>
public sealed partial class CommentThreadFixturePort(
    ICommentEndpointService comments,
    ICommentAnonymousFixtureProvider anonymousComments,
    ICommentAnonymousFixtureCapabilityVault anonymousCapabilities,
    ICommentAnonymousFixtureOperationLedger anonymousOperations,
    ICommentAuthorManagementService authorManagement,
    ICommentManagementCapabilityService managementCapabilities,
    ICommentQueryService publicQueries,
    ICommentGovernanceService governance,
    CommentFixtureCacheProbe cacheProbe,
    ISqlSugarClient db,
    IAuthoringModerationCommands moderationCommands,
    TimeProvider timeProvider,
    IAuthoringModerationQueue moderationQueue,
    IMessageQueryService messageQueries) : ICommentThreadFixturePort
{
    private const string PlanSchema = "fsusblog.comment-thread-fixture-plan.v1";
    private const string ResultSchema = "fsusblog.comment-thread-fixture-result.v1";
    private const string ObservationSchema = "fsusblog.comment-thread-fixture-observation.v1";
    private const string CleanupSchema = "fsusblog.comment-thread-fixture-cleanup.v1";
    private static readonly IReadOnlySet<string> s_allowedCapabilities = new HashSet<string>(StringComparer.Ordinal)
    {
        "comment.delete.reply",
        "comment.delete.root",
        "comment.moderation.pending",
        "comment.thread.depth-boundary",
        "comment.thread.nested",
        "comment.thread.reply",
        "comment.thread.root",
        "comment.version.edited",
        "moderation.region-policy"
    };

    public async Task<CommentThreadFixtureResult> ExecuteAsync(
        CommentThreadFixturePlan plan,
        CancellationToken cancellationToken = default)
    {
        ValidatePlan(plan);
        var roles = new Dictionary<string, FixtureIdentity>(StringComparer.Ordinal);
        var negativeResults = new Dictionary<string, string>(StringComparer.Ordinal);
        var zkAuthorityEvidence = new List<CommentFixtureZkAuthorityEvidence>();

        try
        {
            foreach (CommentThreadFixtureOperation operation in plan.Operations)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (operation.Operation is CommentThreadFixtureOperations.Edit or CommentThreadFixtureOperations.SoftDelete
                    && !roles.ContainsKey(operation.SemanticRole))
                {
                    if (operation.ExistingCommentId is not > 0)
                        throw new InvalidOperationException($"Existing comment identity is missing for {operation.SemanticRole}.");
                    roles.Add(operation.SemanticRole, new FixtureIdentity(
                        operation.ExistingCommentId.Value,
                        operation.AccountId,
                        operation.ActorMode,
                        OperationPlanDigest(plan.Binding, operation),
                        operation.CapabilityId));
                }
                switch (operation.Operation)
                {
                    case CommentThreadFixtureOperations.Create:
                    case CommentThreadFixtureOperations.RejectDepthOverrun:
                        (CommentCreateResult created, CommentFixtureZkAuthorityEvidence? evidence) = await CreateAsync(
                                plan,
                                operation,
                                roles,
                                cancellationToken)
                            .ConfigureAwait(false);
                        if (operation.Operation == CommentThreadFixtureOperations.RejectDepthOverrun)
                        {
                            string expected = operation.ExpectedFailureCode ?? "comment_thread_depth_limit";
                            if (created.Created || !StringComparer.Ordinal.Equals(created.FailureCode, expected))
                                throw new InvalidOperationException($"Depth overrun {operation.SemanticRole} was not rejected by production policy.");
                            negativeResults.Add(operation.SemanticRole, created.FailureCode ?? "unknown");
                            break;
                        }
                        if (!created.Created || created.CommentId <= 0)
                            throw new InvalidOperationException($"Production comment creation failed for {operation.SemanticRole}: {created.FailureCode ?? "unknown"}.");
                        roles.Add(operation.SemanticRole, new FixtureIdentity(
                            created.CommentId,
                            operation.AccountId,
                            operation.ActorMode,
                            evidence is null
                                ? OperationPlanDigest(plan.Binding, operation)
                                : NormalizeDigest(evidence.OperationPlanDigest),
                            operation.CapabilityId));
                        if (evidence is not null)
                            zkAuthorityEvidence.Add(evidence);
                        break;

                    case CommentThreadFixtureOperations.Edit:
                        await EditAsync(plan, operation, RequireRole(roles, operation.SemanticRole), cancellationToken)
                            .ConfigureAwait(false);
                        break;

                    case CommentThreadFixtureOperations.SoftDelete:
                        await SoftDeleteAsync(plan, operation, RequireRole(roles, operation.SemanticRole), cancellationToken)
                            .ConfigureAwait(false);
                        break;

                    default:
                        throw new InvalidOperationException($"Unknown comment thread fixture operation {operation.Operation}.");
                }
            }
        }
        catch (Exception originalError)
        {
            throw await BuildRecoveryExceptionAsync(plan.Binding, roles, originalError).ConfigureAwait(false);
        }

        List<CommentThreadFixtureEntity> entities;
        try
        {
            entities = await ObserveAsync(plan.Binding, roles, cancellationToken).ConfigureAwait(false);
            if (entities.Count != roles.Count)
                throw new InvalidOperationException("Comment thread fixture observation is partial.");
        }
        catch (Exception originalError)
        {
            throw await BuildRecoveryExceptionAsync(plan.Binding, roles, originalError).ConfigureAwait(false);
        }

        return new CommentThreadFixtureResult(
            ResultSchema,
            plan.Binding,
            entities,
            negativeResults,
            zkAuthorityEvidence);
    }

    public async Task<IReadOnlyList<CommentThreadFixtureEntity>> ObserveCurrentAsync(
        CommentThreadFixtureObservationPlan plan,
        CancellationToken cancellationToken = default)
    {
        if (plan.Schema != ObservationSchema || !plan.Binding.IsValid() || plan.Roles.Count == 0
            || plan.Roles.Any(item => string.IsNullOrWhiteSpace(item.Key)
                || item.Value.CommentId <= 0
                || item.Value.ActorMode is not (CommentAuthorModes.Public or CommentAuthorModes.ZkAnonymous)
                || (item.Value.ActorMode == CommentAuthorModes.Public
                    ? item.Value.AccountId is not > 0
                    : item.Value.AccountId is not null)
                || !IsDigest(item.Value.OperationPlanDigest)
                || !IsAllowedCapability(item.Value.CapabilityId))
            || plan.Roles.Values.Select(item => item.CommentId).Distinct().Count() != plan.Roles.Count)
            throw new InvalidOperationException("Comment thread observation plan is invalid.");

        long[] ids = plan.Roles.Values.Select(item => item.CommentId).Order().ToArray();
        List<Comment> rows = await db.Queryable<Comment>()
            .Where(item => ids.Contains(item.Id))
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (rows.Count != ids.Length)
            throw new InvalidOperationException("Comment thread observation plan contains a missing identity.");
        var identities = plan.Roles.ToDictionary(
            item => item.Key,
                item => new FixtureIdentity(
                item.Value.CommentId,
                item.Value.AccountId,
                item.Value.ActorMode,
                item.Value.OperationPlanDigest,
                item.Value.CapabilityId),
            StringComparer.Ordinal);
        return await ObserveAsync(plan.Binding, identities, cancellationToken).ConfigureAwait(false);
    }

    public async Task<CommentFixtureCrossDomainSentinel> ObserveCrossDomainAsync(
        int articleId,
        IReadOnlyList<int> accountIds,
        long adminPrincipalId,
        CancellationToken cancellationToken = default)
    {
        int[] usersToObserve = accountIds.Distinct().Order().ToArray();
        if (articleId <= 0 || adminPrincipalId <= 0 || usersToObserve.Length == 0)
            throw new InvalidOperationException("Comment cross-domain sentinel identity is invalid.");

        List<Article> articles = await db.Queryable<Article>()
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        Article? article = articles.SingleOrDefault(item => item.Id == articleId);
        List<User> allUsers = await db.Queryable<User>()
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        List<User> users = allUsers
            .Where(item => usersToObserve.Contains(item.Id))
            .ToList();
        List<AdminPrincipal> admins = await db.Queryable<AdminPrincipal>()
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        AdminPrincipal? admin = admins.SingleOrDefault(item => item.Id == adminPrincipalId);
        List<SecurityRiskEvent> securityEvents = await db.Queryable<SecurityRiskEvent>()
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (article is null || users.Count != usersToObserve.Length || admin is null)
            throw new InvalidOperationException("Comment cross-domain sentinel cannot resolve the exact input facts.");

        return new CommentFixtureCrossDomainSentinel(
            "fsusblog.comment-fixture-cross-domain-sentinel.v1",
            articleId,
            usersToObserve,
            adminPrincipalId,
            Digest(JsonSerializer.Serialize(articles)),
            Digest(JsonSerializer.Serialize(allUsers)),
            Digest(JsonSerializer.Serialize(admins)),
            Digest(JsonSerializer.Serialize(securityEvents)));
    }

    public Task<CommentThreadFixtureCleanupResult> CleanupAsync(
        CommentThreadFixtureCleanupReceipt receipt,
        CancellationToken cancellationToken = default)
        => CleanupCoreAsync(receipt, requireCrossDomain: true, cancellationToken: cancellationToken);

    private async Task<CommentThreadFixtureCleanupResult> CleanupCoreAsync(
        CommentThreadFixtureCleanupReceipt receipt,
        bool requireCrossDomain,
        CancellationToken cancellationToken)
    {
        if (receipt.Schema != CleanupSchema || !receipt.Binding.IsValid()
            || receipt.OwnedComments.Count == 0
            || receipt.OwnedComments.Any(item => item.Key != item.Value.CommentId
                || item.Value.ArticleId != receipt.Binding.ArticleId
                || string.IsNullOrWhiteSpace(item.Value.SemanticRole)
                || item.Value.ActorMode is not (CommentAuthorModes.Public or CommentAuthorModes.ZkAnonymous)
                || (item.Value.ActorMode == CommentAuthorModes.Public
                    ? item.Value.AccountId is not > 0
                    : item.Value.AccountId is not null)
                || !IsDigest(item.Value.ContentDigest)
                || item.Value.CurrentVersion <= 0
                || !IsDigest(item.Value.OperationPlanDigest))
            || receipt.OwnedComments.Values.Select(item => item.SemanticRole).Distinct(StringComparer.Ordinal).Count()
                != receipt.OwnedComments.Count
            || receipt.OwnedComments.Values.Select(item => item.OperationPlanDigest).Distinct(StringComparer.Ordinal).Count()
                != receipt.OwnedComments.Count
            || requireCrossDomain && receipt.CrossDomainBefore is null
            || receipt.CrossDomainBefore is not null && !IsValidCrossDomainSentinel(receipt.CrossDomainBefore, receipt.Binding.ArticleId))
            throw new InvalidOperationException("Comment thread cleanup receipt is invalid.");

        List<Comment> owned = await db.Queryable<Comment>()
            .Where(item => receipt.OwnedComments.Keys.Contains(item.Id))
            .OrderBy(item => item.Depth, OrderByType.Desc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (owned.Count != receipt.OwnedComments.Count)
            throw new InvalidOperationException("Comment thread cleanup receipt contains missing identities.");
        foreach (Comment row in owned)
        {
            CommentThreadFixtureOwnedIdentity expected = receipt.OwnedComments[row.Id];
            bool validVersion = row.IsDeleted
                ? expected.IsDeleted
                    ? row.CurrentVersion == expected.CurrentVersion
                    : row.CurrentVersion == expected.CurrentVersion + 1
                : !expected.IsDeleted && row.CurrentVersion == expected.CurrentVersion;
            if (row.ArticleId != expected.ArticleId
                || row.UserId != expected.AccountId
                || !StringComparer.Ordinal.Equals(row.AuthorMode, expected.ActorMode)
                || !StringComparer.Ordinal.Equals(Digest(row.Content), expected.ContentDigest)
                || !validVersion)
                throw new InvalidOperationException($"Comment {row.Id} actor is not owned by the cleanup receipt.");
            if (expected.ActorMode == CommentAuthorModes.Public
                && (expected.AccountId is not > 0
                    || row.ClientMutationAccountId != expected.AccountId
                    || !StringComparer.Ordinal.Equals(
                        row.ClientMutationId,
                        DeterministicMutationId(receipt.Binding.Owner, expected.SemanticRole))))
                throw new InvalidOperationException($"Public comment {row.Id} is not owned by the cleanup receipt.");
            if (row.IsDeleted)
            {
                // Already-deleted owned rows only need their custody artifacts
                // dropped; re-cleanup must stay idempotent and must not require
                // durable capability references that a previous pass removed.
                if (expected.ActorMode == CommentAuthorModes.ZkAnonymous)
                {
                    anonymousCapabilities.Remove(receipt.Binding.Owner, receipt.Binding.TestSession, row.Id);
                    await anonymousOperations.RemoveAsync(RawDigest(expected.OperationPlanDigest), CancellationToken.None)
                        .ConfigureAwait(false);
                }
                continue;
            }
            string? anonymousSecret = expected.ActorMode == CommentAuthorModes.ZkAnonymous
                ? await RequireAnonymousCapabilityAsync(receipt.Binding, expected, cancellationToken).ConfigureAwait(false)
                : null;
            if (expected.AccountId is > 0)
            {
                await RequireAccountMutationAsync(row.Id, expected.AccountId.Value, CommentManagementPurposes.Delete,
                    (challenge, version) => authorManagement.DeleteAsAccountAsync(row.Id, expected.AccountId.Value, challenge, cancellationToken),
                    cancellationToken).ConfigureAwait(false);
                continue;
            }
            string secret = anonymousSecret
                ?? throw new InvalidOperationException("Anonymous cleanup capability is unavailable.");
            await RequireAnonymousDeleteAsync(row, secret, cancellationToken).ConfigureAwait(false);
            anonymousCapabilities.Remove(receipt.Binding.Owner, receipt.Binding.TestSession, row.Id);
            await anonymousOperations.RemoveAsync(RawDigest(expected.OperationPlanDigest), CancellationToken.None)
                .ConfigureAwait(false);
        }

        List<Comment> finalRows = await db.Queryable<Comment>()
            .Where(item => receipt.OwnedComments.Keys.Contains(item.Id))
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (finalRows.Count != receipt.OwnedComments.Count || finalRows.Any(item => !item.IsDeleted))
            throw new InvalidOperationException("Comment fixture cleanup did not soft-delete the exact owned identity set.");
        var stillPublic = new List<long>();
        foreach (Comment row in finalRows)
        {
            CommentPermalinkContextDto projection = await publicQueries.GetPermalinkContextAsync(row.ArticleId, row.Id)
                .ConfigureAwait(false);
            if (projection.Status == "found")
                stillPublic.Add(row.Id);
        }
        if (stillPublic.Count > 0)
            throw new InvalidOperationException("Comment fixture cleanup left an owned comment in the public read model.");
        CommentFixtureCrossDomainSentinel? crossDomainAfter = null;
        if (receipt.CrossDomainBefore is not null)
        {
            crossDomainAfter = await ObserveCrossDomainAsync(
                receipt.CrossDomainBefore.ArticleId,
                receipt.CrossDomainBefore.AccountIds,
                receipt.CrossDomainBefore.AdminPrincipalId,
                cancellationToken).ConfigureAwait(false);
            if (!SameCrossDomainSentinel(receipt.CrossDomainBefore, crossDomainAfter))
                throw new InvalidOperationException("Comment fixture cleanup changed non-owned article, auth, admin, or security facts.");
        }
        return new CommentThreadFixtureCleanupResult(
            "fsusblog.comment-thread-fixture-cleanup-result.v1",
            receipt.Binding,
            [.. finalRows.Select(item => item.Id)],
            stillPublic,
            true,
            receipt.CrossDomainBefore,
            crossDomainAfter);
    }

    private async Task<CommentThreadFixtureCleanupReceipt> BuildCleanupReceiptAsync(
        CommentFixturePortBinding binding,
        IReadOnlyDictionary<string, FixtureIdentity> identities,
        CancellationToken cancellationToken)
    {
        if (identities.Count == 0)
            return new CommentThreadFixtureCleanupReceipt(
                CleanupSchema,
                binding,
                new Dictionary<long, CommentThreadFixtureOwnedIdentity>());
        long[] ids = identities.Values.Select(item => item.CommentId).Distinct().ToArray();
        List<Comment> rows = await db.Queryable<Comment>()
            .Where(item => ids.Contains(item.Id))
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (rows.Count != ids.Length)
            throw new InvalidOperationException("Comment recovery receipt cannot resolve the exact partial identity set.");
        IReadOnlyDictionary<long, Comment> byId = rows.ToDictionary(item => item.Id);
        return new CommentThreadFixtureCleanupReceipt(
            CleanupSchema,
            binding,
            identities.ToDictionary(
                item => item.Value.CommentId,
                item =>
                {
                    Comment row = byId[item.Value.CommentId];
                    if (row.ArticleId != binding.ArticleId
                        || row.UserId != item.Value.AccountId
                        || row.AuthorMode != item.Value.ActorMode
                        || item.Value.ActorMode == CommentAuthorModes.Public
                            && (row.ClientMutationAccountId != item.Value.AccountId
                                || !StringComparer.Ordinal.Equals(
                                    row.ClientMutationId,
                                    DeterministicMutationId(binding.Owner, item.Key))))
                        throw new InvalidOperationException("Comment recovery receipt contains a cross-plan identity.");
                    return new CommentThreadFixtureOwnedIdentity(
                        row.Id,
                        row.ArticleId,
                        item.Key,
                        row.AuthorMode,
                        row.UserId,
                        Digest(row.Content),
                        row.CurrentVersion,
                        row.IsDeleted,
                        item.Value.OperationPlanDigest);
                }));
    }

    private async Task<CommentThreadFixtureRecoveryException> BuildRecoveryExceptionAsync(
        CommentFixturePortBinding binding,
        IReadOnlyDictionary<string, FixtureIdentity> identities,
        Exception originalError)
    {
        CommentThreadFixtureCleanupReceipt recoveryReceipt;
        CommentThreadFixtureCleanupResult? cleanupResult = null;
        Exception? cleanupError = null;
        try
        {
            recoveryReceipt = await BuildCleanupReceiptAsync(binding, identities, CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch (Exception error)
        {
            recoveryReceipt = new CommentThreadFixtureCleanupReceipt(
                CleanupSchema,
                binding,
                new Dictionary<long, CommentThreadFixtureOwnedIdentity>());
            cleanupError = error;
        }
        if (cleanupError is null && recoveryReceipt.OwnedComments.Count > 0)
        {
            try
            {
                cleanupResult = await CleanupCoreAsync(
                    recoveryReceipt,
                    requireCrossDomain: false,
                    cancellationToken: CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                cleanupError = error;
            }
        }
        return new CommentThreadFixtureRecoveryException(
            cleanupError is null
                ? "Comment thread fixture execution failed; exact owned compensation completed."
                : "Comment thread fixture execution failed and exact owned compensation was incomplete.",
            originalError,
            recoveryReceipt,
            cleanupResult,
            cleanupError);
    }

    private async Task<(CommentCreateResult Comment, CommentFixtureZkAuthorityEvidence? Evidence)> CreateAsync(
        CommentThreadFixturePlan plan,
        CommentThreadFixtureOperation operation,
        IReadOnlyDictionary<string, FixtureIdentity> roles,
        CancellationToken cancellationToken)
    {
        FixtureIdentity? parent = operation.ParentRole is null ? null : RequireRole(roles, operation.ParentRole);
        if (parent is not null && operation.ParentCommentId is > 0 && parent.CommentId != operation.ParentCommentId)
            throw new InvalidOperationException($"Comment role {operation.SemanticRole} has conflicting parent identities.");
        long? resolvedParentId = parent?.CommentId ?? operation.ParentCommentId;
        string? parentId = resolvedParentId?.ToString(CultureInfo.InvariantCulture);
        Comment? parentRow = parent is null ? null : await db.Queryable<Comment>()
            .Where(item => item.Id == parent.CommentId)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        parentRow ??= resolvedParentId is null ? null : await db.Queryable<Comment>()
            .Where(item => item.Id == resolvedParentId.Value)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        if (resolvedParentId is not null && parentRow is null)
            throw new InvalidOperationException($"Comment role {operation.SemanticRole} references a missing parent comment.");
        if (parentRow is not null && parentRow.ArticleId != plan.Binding.ArticleId)
            throw new InvalidOperationException($"Comment role {operation.SemanticRole} references a parent from another article.");
        string? rootId = parentRow is null ? null : (parentRow.RootId ?? parentRow.Id).ToString(CultureInfo.InvariantCulture);

        if (operation.ActorMode == CommentAuthorModes.Public)
        {
            if (operation.AccountId is not > 0)
                throw new InvalidOperationException($"Public role {operation.SemanticRole} requires an account reference.");
            var request = new CommentCreateV2RequestCoreModel(
                plan.Binding.ArticleId,
                operation.Content,
                parentId,
                rootId,
                parentId,
                null,
                CommentAuthorModes.Public,
                true,
                null,
                operation.DisplayLanguage,
                null,
                []);
            CommentCreateResult created = await comments.CreateAttributablePublicCommentResultAsync(
                new AccountPrincipalContext(operation.AccountId.Value, null),
                request,
                DeterministicMutationId(plan.Binding.Owner, operation.SemanticRole),
                operation.RegionDecision)
                .ConfigureAwait(false);
            return (created, null);
        }

        if (operation.ActorMode == CommentAuthorModes.ZkAnonymous)
        {
            if (string.IsNullOrWhiteSpace(operation.AnonymousScope)
                || string.IsNullOrWhiteSpace(operation.DisplayLanguage))
                throw new InvalidOperationException($"zk_anonymous role {operation.SemanticRole} requires its canonical scope and display language.");
            CommentAnonymousFixtureCreateResult created = await anonymousComments.CreateAsync(
                new CommentAnonymousFixtureCreateRequest(
                    plan.Binding.Owner,
                    plan.Binding.TestSession,
                    plan.Binding.PlanDigest,
                    operation.SemanticRole,
                    plan.Binding.ArticleId,
                    operation.Content,
                    parentId,
                    rootId,
                    parentId,
                    operation.AnonymousScope,
                    operation.DisplayLanguage,
                    operation.RegionDecision),
                cancellationToken).ConfigureAwait(false);
            return (created.Comment, created.AuthorityEvidence);
        }

        throw new InvalidOperationException($"Actor mode {operation.ActorMode} is not canonical.");
    }

    private async Task EditAsync(
        CommentThreadFixturePlan plan,
        CommentThreadFixtureOperation operation,
        FixtureIdentity identity,
        CancellationToken cancellationToken)
    {
        Comment row = await RequireCommentAsync(identity.CommentId, cancellationToken).ConfigureAwait(false);
        RequireOwnedMutation(row, plan.Binding, operation, identity);
        if (row.Content == operation.Content && row.CurrentVersion > 1)
            return;
        if (operation.ActorMode == CommentAuthorModes.Public && identity.AccountId is > 0)
        {
            await RequireAccountMutationAsync(row.Id, identity.AccountId.Value, CommentManagementPurposes.Edit,
                (challenge, version) => authorManagement.EditAsAccountAsync(
                    row.Id,
                    identity.AccountId.Value,
                    new CommentEditRequest(version, operation.Content, challenge),
                    cancellationToken),
                cancellationToken).ConfigureAwait(false);
            return;
        }
        if (operation.ActorMode == CommentAuthorModes.ZkAnonymous)
        {
            string secret = RequireAnonymousCapability(plan.Binding.Owner, plan.Binding.TestSession, identity.CommentId);
            CommentManagementChallengeResult challenge = await RequireAnonymousChallengeAsync(
                row.Id, secret, CommentManagementPurposes.Edit, cancellationToken).ConfigureAwait(false);
            CommentAuthorMutationResult result = await authorManagement.EditAsAnonymousAsync(
                row.Id,
                secret,
                new CommentEditRequest(challenge.CurrentVersion, operation.Content, challenge.Challenge!),
                cancellationToken).ConfigureAwait(false);
            RequireMutation(result, operation.SemanticRole);
            return;
        }
        throw new InvalidOperationException($"Role {operation.SemanticRole} has no owned edit authority.");
    }

    private async Task SoftDeleteAsync(
        CommentThreadFixturePlan plan,
        CommentThreadFixtureOperation operation,
        FixtureIdentity identity,
        CancellationToken cancellationToken)
    {
        Comment row = await RequireCommentAsync(identity.CommentId, cancellationToken).ConfigureAwait(false);
        RequireOwnedMutation(row, plan.Binding, operation, identity);
        if (row.IsDeleted)
            return;
        if (operation.ActorMode == CommentAuthorModes.Public && identity.AccountId is > 0)
        {
            await RequireAccountMutationAsync(row.Id, identity.AccountId.Value, CommentManagementPurposes.Delete,
                (challenge, _) => authorManagement.DeleteAsAccountAsync(row.Id, identity.AccountId.Value, challenge, cancellationToken),
                cancellationToken).ConfigureAwait(false);
            return;
        }
        if (operation.ActorMode == CommentAuthorModes.ZkAnonymous)
        {
            string secret = RequireAnonymousCapability(plan.Binding.Owner, plan.Binding.TestSession, identity.CommentId);
            CommentManagementChallengeResult challenge = await RequireAnonymousChallengeAsync(
                row.Id, secret, CommentManagementPurposes.Delete, cancellationToken).ConfigureAwait(false);
            CommentAuthorMutationResult result = await authorManagement.DeleteAsAnonymousAsync(
                row.Id, secret, challenge.Challenge!, cancellationToken).ConfigureAwait(false);
            RequireMutation(result, operation.SemanticRole);
            return;
        }
        throw new InvalidOperationException($"Role {operation.SemanticRole} has no owned delete authority.");
    }

    private async Task<List<CommentThreadFixtureEntity>> ObserveAsync(
        CommentFixturePortBinding binding,
        IReadOnlyDictionary<string, FixtureIdentity> roles,
        CancellationToken cancellationToken)
    {
        int articleId = binding.ArticleId;
        long[] ids = roles.Values.Select(item => item.CommentId).Order().ToArray();
        List<Comment> rows = await db.Queryable<Comment>()
            .Where(item => ids.Contains(item.Id))
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        var byId = rows.ToDictionary(item => item.Id);
        var entities = new List<CommentThreadFixtureEntity>(roles.Count);
        foreach ((string role, FixtureIdentity identity) in roles.OrderBy(item => item.Key, StringComparer.Ordinal))
        {
            if (!byId.TryGetValue(identity.CommentId, out Comment? row)
                || row.ArticleId != articleId
                || row.UserId != identity.AccountId
                || !StringComparer.Ordinal.Equals(row.AuthorMode, identity.ActorMode))
                throw new InvalidOperationException($"Comment role {role} does not match its owned article/actor reference.");
            if (identity.ActorMode == CommentAuthorModes.Public
                && (!StringComparer.Ordinal.Equals(
                        row.ClientMutationId,
                        DeterministicMutationId(binding.Owner, role))
                    || row.ClientMutationAccountId != identity.AccountId))
                throw new InvalidOperationException($"Public comment role {role} is not owned by the fixture mutation identity.");
            if (identity.ActorMode == CommentAuthorModes.ZkAnonymous)
                await RequireAnonymousOwnershipAsync(binding, role, identity, row, cancellationToken)
                    .ConfigureAwait(false);
            if (!IsCapabilityShape(identity.CapabilityId, role, row))
                throw new InvalidOperationException($"Comment role {role} does not match its capability shape.");
            IReadOnlyList<CommentRevisionResult> history = await authorManagement.ReadRevisionsAsAdminAsync(row.Id, cancellationToken)
                .ConfigureAwait(false);
            if (!HasExactRevisionHistory(row, history, identity.CapabilityId))
                throw new InvalidOperationException($"Comment role {role} has incomplete revision history.");
            CommentPermalinkContextDto publicProjection = await publicQueries.GetPermalinkContextAsync(articleId, row.Id)
                .ConfigureAwait(false);
            List<CommentMutationOutboxEvent> outbox = await db.Queryable<CommentMutationOutboxEvent>()
                .Where(item => item.CommentId == row.Id)
                .OrderBy(item => item.Id, OrderByType.Asc)
                .ToListAsync(cancellationToken).ConfigureAwait(false);
            if (outbox.Count == 0
                || outbox.Select(item => item.EventId).Distinct(StringComparer.Ordinal).Count() != outbox.Count
                || outbox.Any(item => !Guid.TryParse(item.EventId, out _)
                    || item.ArticleId != articleId
                    || item.RootId != (row.RootId ?? row.Id)
                    || item.ParentId != row.ParentId
                    || item.Status is not (CommentMutationOutboxStatus.Pending
                        or CommentMutationOutboxStatus.Processing
                        or CommentMutationOutboxStatus.Processed
                        or CommentMutationOutboxStatus.Failed
                        or CommentMutationOutboxStatus.Poison)))
                throw new InvalidOperationException($"Comment role {role} has incomplete outbox evidence.");
            CommentModerationTimelineResult? timeline = await governance.ReadTimelineAsync(row.Id, cancellationToken)
                .ConfigureAwait(false);
            if (timeline is null || !CommentFixtureTimelineVerifier.IsConsistent(timeline, row.Id, row.ModerationStatus))
                throw new InvalidOperationException(
                    $"Comment role {role} has incomplete moderation audit evidence (comment={row.Id}, events={timeline?.Events.Count.ToString(CultureInfo.InvariantCulture) ?? "null"}, consistent={timeline?.Consistent.ToString() ?? "null"}, projected={timeline?.ProjectedStatus.ToString() ?? "null"}, current={row.ModerationStatus}).");
            string cacheIdentity = $"article:{articleId.ToString(CultureInfo.InvariantCulture)}";
            string cacheGeneration = await RequireReadableCacheGenerationAsync(cacheIdentity, cancellationToken)
                .ConfigureAwait(false);
            if (!IsCacheGeneration(cacheGeneration))
                throw new InvalidOperationException($"Comment role {role} has no readable cache generation.");
            entities.Add(new CommentThreadFixtureEntity(
                role,
                row.Id,
                row.ArticleId,
                row.AuthorMode,
                row.UserId,
                row.RootId ?? row.Id,
                row.ParentId,
                row.ReplyToCommentId,
                row.Depth,
                row.CurrentVersion,
                row.IsDeleted,
                row.ModerationStatus.ToString().ToLowerInvariant(),
                Digest(row.Content),
                history,
                publicProjection.Status == "found",
                outbox.Select(item => item.EventId).ToArray(),
                identity.OperationPlanDigest,
                identity.CapabilityId,
                timeline.Events.Select(item => item.Id.ToString(CultureInfo.InvariantCulture)).ToArray(),
                cacheIdentity,
                cacheGeneration));
        }
        return entities;
    }

    private static void RequireOwnedMutation(
        Comment row,
        CommentFixturePortBinding binding,
        CommentThreadFixtureOperation operation,
        FixtureIdentity identity)
    {
        if (row.ArticleId != binding.ArticleId
            || !StringComparer.Ordinal.Equals(row.AuthorMode, identity.ActorMode)
            || row.UserId != identity.AccountId
            || !StringComparer.Ordinal.Equals(operation.ActorMode, identity.ActorMode))
            throw new InvalidOperationException($"Comment {row.Id} is not owned by {operation.SemanticRole}.");

        if (identity.ActorMode == CommentAuthorModes.Public
            && (identity.AccountId is not > 0
                || row.ClientMutationAccountId != identity.AccountId
                || !StringComparer.Ordinal.Equals(
                    row.ClientMutationId,
                    DeterministicMutationId(binding.Owner, operation.SemanticRole))))
            throw new InvalidOperationException($"Public comment {row.Id} is not owned by the fixture mutation identity.");

        if (identity.ActorMode == CommentAuthorModes.ZkAnonymous
            && string.IsNullOrWhiteSpace(row.ManagementCapabilityHash))
            throw new InvalidOperationException($"Anonymous comment {row.Id} has no production management capability.");
    }

    private async Task RequireAnonymousOwnershipAsync(
        CommentFixturePortBinding binding,
        string role,
        FixtureIdentity identity,
        Comment row,
        CancellationToken cancellationToken,
        string? initialContent = null,
        bool restoreCapabilityCustody = true)
    {
        string? custodySecret = anonymousCapabilities.TryGet(
            binding.Owner,
            binding.TestSession,
            row.Id,
            out string storedSecret)
            ? storedSecret
            : null;
        if (string.IsNullOrWhiteSpace(row.ManagementCapabilityHash)
            || custodySecret is not null
                && !managementCapabilities.VerifyCapability(custodySecret, row.ManagementCapabilityHash))
            throw new InvalidOperationException($"Anonymous comment role {role} has invalid production capability custody.");
        CommentAnonymousFixtureOperationReference? reference = await anonymousOperations.ReadAsync(
                RawDigest(identity.OperationPlanDigest),
                cancellationToken)
            .ConfigureAwait(false);
        var expected = new CommentThreadFixtureOwnedIdentity(
            row.Id,
            row.ArticleId,
            role,
            row.AuthorMode,
            row.UserId,
            Digest(row.Content),
            row.CurrentVersion,
            row.IsDeleted,
            identity.OperationPlanDigest);
        if (!IsExactAnonymousOperationReference(reference, binding, expected)
            || !StringComparer.Ordinal.Equals(reference!.ContentDigest, AnonymousContentDigest(initialContent ?? row.Content))
            || !managementCapabilities.VerifyCapability(reference.ManagementSecret, row.ManagementCapabilityHash!)
            || reference.ParentId != row.ParentId?.ToString(CultureInfo.InvariantCulture)
            || (reference.RootId ?? reference.CommentId.ToString(CultureInfo.InvariantCulture))
                != (row.RootId ?? row.Id).ToString(CultureInfo.InvariantCulture)
            || reference.ReplyToCommentId != row.ReplyToCommentId?.ToString(CultureInfo.InvariantCulture))
            throw new InvalidOperationException($"Anonymous comment role {role} is not owned by the fixture operation reference.");
        if (custodySecret is not null
            && !CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(custodySecret),
                Encoding.UTF8.GetBytes(reference.ManagementSecret)))
            throw new InvalidOperationException($"Anonymous comment role {role} has conflicting capability custody.");
        if (custodySecret is null && restoreCapabilityCustody)
            anonymousCapabilities.Store(binding.Owner, binding.TestSession, row.Id, reference.ManagementSecret);
    }

    private async Task RequireAccountMutationAsync(
        long commentId,
        int accountId,
        string purpose,
        Func<string, int, Task<CommentAuthorMutationResult>> mutate,
        CancellationToken cancellationToken)
    {
        CommentManagementChallengeResult challenge = await authorManagement.IssueAccountChallengeAsync(
            commentId, accountId, purpose, cancellationToken).ConfigureAwait(false);
        if (!challenge.Issued || string.IsNullOrWhiteSpace(challenge.Challenge))
            throw new InvalidOperationException($"Production comment challenge failed: {challenge.FailureCode ?? "unknown"}.");
        RequireMutation(await mutate(challenge.Challenge, challenge.CurrentVersion).ConfigureAwait(false), commentId.ToString(CultureInfo.InvariantCulture));
    }

    private async Task<CommentManagementChallengeResult> RequireAnonymousChallengeAsync(
        long commentId,
        string secret,
        string purpose,
        CancellationToken cancellationToken)
    {
        CommentManagementChallengeResult result = await managementCapabilities.IssueChallengeAsync(
            commentId, secret, purpose, cancellationToken).ConfigureAwait(false);
        return result.Issued ? result : throw new InvalidOperationException("Anonymous challenge must be supplied by the production capability service.");
    }

    private static void RequireMutation(CommentAuthorMutationResult result, string role)
    {
        if (!result.Success)
            throw new InvalidOperationException($"Production comment mutation failed for {role}: {result.Code}.");
    }

    private static bool HasExactRevisionHistory(
        Comment row,
        IReadOnlyList<CommentRevisionResult> history,
        string capabilityId)
    {
        int[] versions = history.Select(item => item.Version).Order().ToArray();
        if (history.Count == 0
            || history.Any(item => item.Version <= 0
                || string.IsNullOrWhiteSpace(item.Content)
                || string.IsNullOrWhiteSpace(item.Operation)
                || !StringComparer.Ordinal.Equals(item.ActorMode, row.AuthorMode)
                || item.Operation is not (CommentRevisionOperations.Created
                    or CommentRevisionOperations.Edited
                    or CommentRevisionOperations.Deleted)
                || !StringComparer.Ordinal.Equals(item.ContentSha256, ContentSha256(item.Content)))
            || history.Select(item => item.Version).Distinct().Count() != history.Count
            || !versions.SequenceEqual(Enumerable.Range(1, row.CurrentVersion))
            || history.Max(item => item.Version) != row.CurrentVersion
            || history.Count(item => item.Operation == CommentRevisionOperations.Created) != 1
            || history.Count(item => item.Version == 1
                && item.Operation == CommentRevisionOperations.Created) != 1
            || !row.IsDeleted && history.Any(item => item.Operation == CommentRevisionOperations.Deleted)
            || row.IsDeleted && history.Count(item => item.Operation == CommentRevisionOperations.Deleted) != 1)
            return false;

        CommentRevisionResult? current = history.SingleOrDefault(item => item.Version == row.CurrentVersion);
        if (current is null
            || !StringComparer.Ordinal.Equals(current.Content, row.Content)
            || !StringComparer.Ordinal.Equals(current.ContentSha256, ContentSha256(row.Content)))
            return false;

        if (capabilityId == "comment.version.edited"
            && (row.CurrentVersion < 2
                || current.Operation != CommentRevisionOperations.Edited
                || !history.Any(item => item.Operation == CommentRevisionOperations.Edited)))
            return false;
        if (capabilityId is "comment.delete.root" or "comment.delete.reply"
            && (!row.IsDeleted
                || current.Operation != CommentRevisionOperations.Deleted
                || !history.Any(item => item.Operation == CommentRevisionOperations.Deleted)))
            return false;
        if (row.IsDeleted && current.Operation != CommentRevisionOperations.Deleted)
            return false;
        return true;
    }

    private static bool IsCapabilityShape(string capabilityId, string role, Comment row)
        => capabilityId switch
        {
            "comment.thread.root" => row.ParentId is null
                && row.RootId is null
                && row.ReplyToCommentId is null
                && row.Depth == 0,
            "comment.thread.reply" => row.ParentId is > 0
                && row.RootId is > 0
                && row.ReplyToCommentId == row.ParentId
                && row.Depth >= 1,
            "comment.thread.nested" => row.ParentId is > 0
                && row.RootId is > 0
                && row.ReplyToCommentId == row.ParentId
                && row.Depth >= 2,
            "comment.thread.depth-boundary" => IsDepthBoundaryRole(role, row),
            "comment.delete.root" => row.IsDeleted && row.ParentId is null,
            "comment.delete.reply" => row.IsDeleted && row.ParentId is > 0,
            _ => true
        };

    private static bool IsDepthBoundaryRole(string role, Comment row)
    {
        if (role == "depth-root")
            return row.ParentId is null && row.RootId is null && row.Depth == 0;
        return role.StartsWith("depth-", StringComparison.Ordinal)
            && int.TryParse(role[6..], NumberStyles.None, CultureInfo.InvariantCulture, out int expectedDepth)
            && expectedDepth > 0
            && row.ParentId is > 0
            && row.RootId is > 0
            && row.ReplyToCommentId == row.ParentId
            && row.Depth == expectedDepth;
    }

    private static string ContentSha256(string content)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(content)));

    private static string AnonymousContentDigest(string content)
        => Convert.ToHexStringLower(SHA256.HashData(
            Encoding.UTF8.GetBytes($"fsusblog.comment-fixture-zk.v1\0content\0{content}")));

    private static bool IsCacheGeneration(string value)
        => ulong.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out _);

    private async Task<string> RequireReadableCacheGenerationAsync(string identity, CancellationToken cancellationToken)
    {
        // The cursor generation is produced by the background comment-mutation
        // outbox dispatcher (default poll ~1s). A cold backend can take several
        // seconds to claim and process the first events, so the wait window is
        // intentionally wider than one poll cycle.
        for (int attempt = 0; attempt < 60; attempt++)
        {
            string generation = await cacheProbe.ReadCursorGenerationAsync(identity, cancellationToken)
                .ConfigureAwait(false) ?? string.Empty;
            if (IsCacheGeneration(generation))
                return generation;
            await Task.Delay(TimeSpan.FromMilliseconds(500), cancellationToken).ConfigureAwait(false);
        }
        return string.Empty;
    }

    private async Task<Comment> RequireCommentAsync(long id, CancellationToken cancellationToken)
        => await db.Queryable<Comment>().Where(item => item.Id == id).FirstAsync(cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Comment {id} is missing.");

    private static FixtureIdentity RequireRole(IReadOnlyDictionary<string, FixtureIdentity> roles, string role)
        => roles.TryGetValue(role, out FixtureIdentity? identity)
            ? identity
            : throw new InvalidOperationException($"Comment semantic role {role} is not prepared.");

    private static void ValidatePlan(CommentThreadFixturePlan plan)
    {
        if (plan.Schema != PlanSchema || !plan.Binding.IsValid() || plan.Operations.Count == 0)
            throw new InvalidOperationException("Comment thread fixture plan is invalid.");

        var createdRoles = new HashSet<string>(StringComparer.Ordinal);
        var mutationRoles = new HashSet<string>(StringComparer.Ordinal);
        foreach (CommentThreadFixtureOperation operation in plan.Operations)
        {
            if (string.IsNullOrWhiteSpace(operation.SemanticRole)
                || !IsAllowedCapability(operation.CapabilityId)
                || operation.ActorMode is not (CommentAuthorModes.Public or CommentAuthorModes.ZkAnonymous)
                || operation.Operation is not (CommentThreadFixtureOperations.Create
                    or CommentThreadFixtureOperations.Edit
                    or CommentThreadFixtureOperations.SoftDelete
                    or CommentThreadFixtureOperations.RejectDepthOverrun)
                || operation.ParentRole is not null && string.IsNullOrWhiteSpace(operation.ParentRole)
                || operation.ParentRole is not null && operation.ParentCommentId is not null
                || operation.ParentCommentId is <= 0
                || operation.ExistingCommentId is <= 0)
                throw new InvalidOperationException("Comment thread fixture operation is invalid.");

            bool isCreate = operation.Operation is CommentThreadFixtureOperations.Create
                or CommentThreadFixtureOperations.RejectDepthOverrun;
            bool isMutation = operation.Operation is CommentThreadFixtureOperations.Edit
                or CommentThreadFixtureOperations.SoftDelete;
            if (operation.ParentRole is not null && !createdRoles.Contains(operation.ParentRole))
                throw new InvalidOperationException($"Comment thread parent role {operation.ParentRole} is not prepared before its child.");
            if (isCreate && !createdRoles.Add(operation.SemanticRole))
                throw new InvalidOperationException("Comment thread fixture create roles must be independent.");
            if (isMutation && !mutationRoles.Add(operation.SemanticRole))
                throw new InvalidOperationException("Comment thread fixture roles may have only one owned mutation.");

            if (operation.ActorMode == CommentAuthorModes.Public
                ? operation.AccountId is not > 0 || !string.IsNullOrWhiteSpace(operation.AnonymousScope)
                : operation.AccountId is not null)
                throw new InvalidOperationException("Comment thread fixture actor binding is invalid.");

            if (operation.Operation is CommentThreadFixtureOperations.Create
                    or CommentThreadFixtureOperations.RejectDepthOverrun
                && string.IsNullOrWhiteSpace(operation.Content))
                throw new InvalidOperationException("Comment thread fixture creation content is required.");
            if (operation.Operation == CommentThreadFixtureOperations.Edit
                && string.IsNullOrWhiteSpace(operation.Content))
                throw new InvalidOperationException("Comment thread fixture edit content is required.");

            if (operation.Operation == CommentThreadFixtureOperations.RejectDepthOverrun)
            {
                if (operation.CapabilityId != "comment.thread.depth-boundary"
                    || !StringComparer.Ordinal.Equals(operation.ExpectedFailureCode, "comment_thread_depth_limit")
                    || operation.ParentRole is null && operation.ParentCommentId is null)
                    throw new InvalidOperationException("Depth overrun fixture operation is not bound to the production depth policy.");
            }
            if (isCreate && operation.ExistingCommentId is not null)
                throw new InvalidOperationException($"Comment creation {operation.SemanticRole} cannot carry an existing identity.");
            if (operation.Operation == CommentThreadFixtureOperations.Create
                && operation.ExpectedFailureCode is not null)
                throw new InvalidOperationException($"Comment creation {operation.SemanticRole} cannot carry a failure expectation.");
            if (isCreate && operation.CapabilityId is "comment.delete.root"
                    or "comment.delete.reply"
                    or "comment.version.edited")
                throw new InvalidOperationException($"Comment creation {operation.SemanticRole} has a mutation-only capability.");
            if (isMutation
                && (operation.ParentRole is not null
                    || operation.ParentCommentId is not null
                    || operation.ExpectedFailureCode is not null))
                throw new InvalidOperationException($"Comment mutation {operation.SemanticRole} cannot carry creation-only references.");
            if (operation.Operation == CommentThreadFixtureOperations.Edit
                && operation.CapabilityId != "comment.version.edited")
                throw new InvalidOperationException("Comment edit fixture must use comment.version.edited.");
            if (operation.Operation == CommentThreadFixtureOperations.SoftDelete
                && operation.CapabilityId is not ("comment.delete.root" or "comment.delete.reply"))
                throw new InvalidOperationException("Comment delete fixture must use an owned delete capability.");
            if (isCreate && operation.CapabilityId == "comment.thread.root"
                && (operation.ParentRole is not null || operation.ParentCommentId is not null))
                throw new InvalidOperationException("Comment thread root fixture cannot carry a parent relation.");
            if (isCreate && operation.CapabilityId is "comment.thread.reply" or "comment.thread.nested"
                && operation.ParentRole is null && operation.ParentCommentId is null)
                throw new InvalidOperationException("Reply and nested fixtures require a parent relation.");
            if (isCreate && operation.CapabilityId == "comment.thread.depth-boundary"
                && operation.SemanticRole != "depth-root"
                && operation.ParentRole is null && operation.ParentCommentId is null)
                throw new InvalidOperationException("Depth-boundary child fixture requires a parent relation.");
            if (operation.ActorMode == CommentAuthorModes.ZkAnonymous
                && isCreate
                && (string.IsNullOrWhiteSpace(operation.AnonymousScope)
                    || string.IsNullOrWhiteSpace(operation.DisplayLanguage)))
                throw new InvalidOperationException("zk_anonymous fixture creation requires its canonical scope and language.");
        }

        foreach (CommentThreadFixtureOperation operation in plan.Operations)
        {
            bool hasCreate = plan.Operations.Any(item => item.Operation == CommentThreadFixtureOperations.Create
                && item.SemanticRole == operation.SemanticRole);
            if (operation.Operation is CommentThreadFixtureOperations.Edit or CommentThreadFixtureOperations.SoftDelete)
            {
                if (hasCreate && operation.ExistingCommentId is not null)
                    throw new InvalidOperationException($"Comment mutation {operation.SemanticRole} must not mix a new and existing identity.");
                if (!hasCreate && operation.ExistingCommentId is not > 0)
                    throw new InvalidOperationException($"Comment mutation {operation.SemanticRole} has no existing identity.");
            }
        }

        long[] existingIds = plan.Operations
            .Where(item => item.Operation is CommentThreadFixtureOperations.Edit or CommentThreadFixtureOperations.SoftDelete)
            .Select(item => item.ExistingCommentId ?? 0)
            .Where(item => item > 0)
            .ToArray();
        if (existingIds.Distinct().Count() != existingIds.Length)
            throw new InvalidOperationException("Comment thread fixture mutations must own independent identities.");
    }

    internal static void ValidatePlanForTests(CommentThreadFixturePlan plan) => ValidatePlan(plan);

    private static bool IsAllowedCapability(string capabilityId) => s_allowedCapabilities.Contains(capabilityId);

    private static string DeterministicMutationId(string owner, string role)
    {
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes($"{owner}\0{role}"));
        Span<byte> bytes = stackalloc byte[16];
        digest.AsSpan(0, 16).CopyTo(bytes);
        return new Guid(bytes).ToString("D", CultureInfo.InvariantCulture);
    }

    private static bool IsDigest(string value) => value.StartsWith("sha256:", StringComparison.Ordinal)
        && value.Length == 71 && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    private static bool IsValidCrossDomainSentinel(CommentFixtureCrossDomainSentinel sentinel, int articleId)
        => sentinel.Schema == "fsusblog.comment-fixture-cross-domain-sentinel.v1"
            && sentinel.ArticleId == articleId
            && sentinel.AccountIds.Count > 0
            && sentinel.AccountIds.All(item => item > 0)
            && sentinel.AccountIds.Order().SequenceEqual(sentinel.AccountIds)
            && sentinel.AccountIds.Distinct().Count() == sentinel.AccountIds.Count
            && sentinel.AdminPrincipalId > 0
            && IsDigest(sentinel.ArticleDigest)
            && IsDigest(sentinel.AuthDigest)
            && IsDigest(sentinel.AdminDigest)
            && IsDigest(sentinel.SecurityDigest);

    internal static bool SameCrossDomainSentinel(
        CommentFixtureCrossDomainSentinel expected,
        CommentFixtureCrossDomainSentinel actual)
        => expected.Schema == actual.Schema
            && expected.ArticleId == actual.ArticleId
            && expected.AccountIds.SequenceEqual(actual.AccountIds)
            && expected.AdminPrincipalId == actual.AdminPrincipalId
            && expected.ArticleDigest == actual.ArticleDigest
            && expected.AuthDigest == actual.AuthDigest
            && expected.AdminDigest == actual.AdminDigest
            && expected.SecurityDigest == actual.SecurityDigest;

    private static string OperationPlanDigest(
        CommentFixturePortBinding binding,
        CommentThreadFixtureOperation operation)
        => Digest(JsonSerializer.Serialize(new
        {
            Schema = "fsusblog.comment-thread-fixture-operation.v1",
            binding.PlanDigest,
            binding.Owner,
            binding.TestSession,
            operation.CapabilityId,
            operation.SemanticRole,
            operation.Operation,
            operation.ActorMode,
            operation.AccountId,
            ContentDigest = Digest(operation.Content),
            operation.ParentRole,
            operation.ParentCommentId,
            operation.ExistingCommentId,
            operation.ExpectedFailureCode,
            operation.AnonymousScope,
            operation.DisplayLanguage
        }));

    private static string NormalizeDigest(string value)
        => IsDigest(value) ? value : $"sha256:{value}";

    private static string RawDigest(string value)
        => IsDigest(value) ? value[7..] : value;

    private static string Digest(string value)
        => $"sha256:{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)))}";

    private string RequireAnonymousCapability(string owner, string testSession, long commentId)
        => anonymousCapabilities.TryGet(owner, testSession, commentId, out string secret)
            ? secret
            : throw new InvalidOperationException("Anonymous fixture capability is unavailable; outer isolated namespace cleanup is required.");

    private async Task<string> RequireAnonymousCapabilityAsync(
        CommentFixturePortBinding binding,
        CommentThreadFixtureOwnedIdentity expected,
        CancellationToken cancellationToken)
    {
        if (anonymousCapabilities.TryGet(binding.Owner, binding.TestSession, expected.CommentId, out string secret))
            return secret;
        CommentAnonymousFixtureOperationReference? reference = await anonymousOperations.ReadAsync(
            RawDigest(expected.OperationPlanDigest),
            cancellationToken).ConfigureAwait(false);
        if (!IsExactAnonymousOperationReference(reference, binding, expected))
            throw new InvalidOperationException("Anonymous fixture durable capability reference is missing, stale, or cross-plan.");
        anonymousCapabilities.Store(binding.Owner, binding.TestSession, expected.CommentId, reference!.ManagementSecret);
        return reference.ManagementSecret;
    }

    internal static bool IsExactAnonymousOperationReference(
        CommentAnonymousFixtureOperationReference? reference,
        CommentFixturePortBinding binding,
        CommentThreadFixtureOwnedIdentity expected)
    {
        string operationPlanDigest = RawDigest(expected.OperationPlanDigest);
        return reference is not null
            && expected.ActorMode == CommentAuthorModes.ZkAnonymous
            && expected.AccountId is null
            && reference.OperationPlanDigest == operationPlanDigest
            && reference.PlanDigest == binding.PlanDigest
            && reference.Owner == binding.Owner
            && reference.TestSession == binding.TestSession
            && reference.SemanticRole == expected.SemanticRole
            && reference.ArticleId == expected.ArticleId
            && reference.CommentId == expected.CommentId
            && !string.IsNullOrWhiteSpace(reference.ManagementSecret)
            && reference.Comment.Created
            && reference.Comment.CommentId == expected.CommentId
            && reference.Comment.ManagementSecret is null
            && reference.AuthorityEvidence.SemanticRole == expected.SemanticRole
            && reference.AuthorityEvidence.OperationPlanDigest == operationPlanDigest
            && reference.AuthorityEvidence.Simulation
            && !reference.AuthorityEvidence.ProductionUsable
            && !reference.AuthorityEvidence.TicketExposed;
    }

    private async Task RequireAnonymousDeleteAsync(
        Comment row,
        string secret,
        CancellationToken cancellationToken)
    {
        CommentManagementChallengeResult challenge = await RequireAnonymousChallengeAsync(
            row.Id,
            secret,
            CommentManagementPurposes.Delete,
            cancellationToken).ConfigureAwait(false);
        CommentAuthorMutationResult result = await authorManagement.DeleteAsAnonymousAsync(
            row.Id,
            secret,
            challenge.Challenge!,
            cancellationToken).ConfigureAwait(false);
        RequireMutation(result, row.Id.ToString(CultureInfo.InvariantCulture));
    }

    private sealed record FixtureIdentity(
        long CommentId,
        int? AccountId,
        string ActorMode,
        string OperationPlanDigest,
        string CapabilityId);
}
