// fixture-catalog: producer comment-moderation
// fixture-catalog: port comment-thread-lifecycle
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
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
    long? ParentCommentId = null,
    long? ExistingCommentId = null,
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
    long CommentId,
    int ArticleId,
    string ActorMode,
    int? AccountId,
    long RootId,
    long? ParentId,
    long? ReplyToCommentId,
    int Depth,
    int CurrentVersion,
    bool IsDeleted,
    string ModerationStatus,
    string ContentDigest,
    IReadOnlyList<CommentRevisionResult> History,
    bool PubliclyVisible,
    IReadOnlyList<string> OutboxEventIds,
    string OperationPlanDigest);

public sealed record CommentThreadFixtureResult(
    string Schema,
    CommentFixturePortBinding Binding,
    IReadOnlyList<CommentThreadFixtureEntity> Entities,
    IReadOnlyDictionary<string, string> NegativeResults,
    IReadOnlyList<CommentFixtureZkAuthorityEvidence> ZkAuthorityEvidence);

public sealed record CommentThreadFixtureObservationIdentity(
    long CommentId,
    int? AccountId,
    string ActorMode,
    string OperationPlanDigest);

public sealed record CommentThreadFixtureObservationPlan(
    string Schema,
    CommentFixturePortBinding Binding,
    IReadOnlyDictionary<string, CommentThreadFixtureObservationIdentity> Roles);

public sealed record CommentThreadFixtureOwnedIdentity(
    long CommentId,
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
    IReadOnlyList<long> DeletedCommentIds,
    IReadOnlyList<long> StillPublicCommentIds,
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
public sealed class CommentThreadFixturePort(
    ICommentEndpointService comments,
    ICommentAnonymousFixtureProvider anonymousComments,
    ICommentAnonymousFixtureCapabilityVault anonymousCapabilities,
    ICommentAnonymousFixtureOperationLedger anonymousOperations,
    ICommentAuthorManagementService authorManagement,
    ICommentManagementCapabilityService managementCapabilities,
    ICommentQueryService publicQueries,
    ISqlSugarClient db) : ICommentThreadFixturePort
{
    private const string PlanSchema = "fsusblog.comment-thread-fixture-plan.v1";
    private const string ResultSchema = "fsusblog.comment-thread-fixture-result.v1";
    private const string ObservationSchema = "fsusblog.comment-thread-fixture-observation.v1";
    private const string CleanupSchema = "fsusblog.comment-thread-fixture-cleanup.v1";

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
                        OperationPlanDigest(plan.Binding, operation)));
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
                                : NormalizeDigest(evidence.OperationPlanDigest)));
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
            entities = await ObserveAsync(plan.Binding.ArticleId, roles, cancellationToken).ConfigureAwait(false);
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
                || !IsDigest(item.Value.OperationPlanDigest))
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
                item.Value.OperationPlanDigest),
            StringComparer.Ordinal);
        return await ObserveAsync(plan.Binding.ArticleId, identities, cancellationToken).ConfigureAwait(false);
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
            if (row.IsDeleted)
            {
                if (expected.ActorMode == CommentAuthorModes.ZkAnonymous)
                {
                    anonymousCapabilities.Remove(receipt.Binding.Owner, receipt.Binding.TestSession, row.Id);
                    await anonymousOperations.RemoveAsync(RawDigest(expected.OperationPlanDigest), CancellationToken.None)
                        .ConfigureAwait(false);
                }
                continue;
            }
            if (expected.AccountId is > 0)
            {
                await RequireAccountMutationAsync(row.Id, expected.AccountId.Value, CommentManagementPurposes.Delete,
                    (challenge, version) => authorManagement.DeleteAsAccountAsync(row.Id, expected.AccountId.Value, challenge, cancellationToken),
                    cancellationToken).ConfigureAwait(false);
                continue;
            }
            string secret = await RequireAnonymousCapabilityAsync(
                receipt.Binding,
                expected,
                cancellationToken).ConfigureAwait(false);
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
                        || row.AuthorMode != item.Value.ActorMode)
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
        long? resolvedParentId = parent?.CommentId ?? operation.ParentCommentId;
        string? parentId = resolvedParentId?.ToString(CultureInfo.InvariantCulture);
        Comment? parentRow = parent is null ? null : await db.Queryable<Comment>()
            .Where(item => item.Id == parent.CommentId)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        parentRow ??= resolvedParentId is null ? null : await db.Queryable<Comment>()
            .Where(item => item.Id == resolvedParentId.Value)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
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
        int articleId,
        IReadOnlyDictionary<string, FixtureIdentity> roles,
        CancellationToken cancellationToken)
    {
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
                || row.UserId != identity.AccountId)
                throw new InvalidOperationException($"Comment role {role} does not match its owned article/actor reference.");
            IReadOnlyList<CommentRevisionResult> history = await authorManagement.ReadRevisionsAsAdminAsync(row.Id, cancellationToken)
                .ConfigureAwait(false);
            if (history.Count == 0 || history.Select(item => item.Version).Distinct().Count() != history.Count
                || history.Max(item => item.Version) != row.CurrentVersion)
                throw new InvalidOperationException($"Comment role {role} has incomplete revision history.");
            CommentPermalinkContextDto publicProjection = await publicQueries.GetPermalinkContextAsync(articleId, row.Id)
                .ConfigureAwait(false);
            List<CommentMutationOutboxEvent> outbox = await db.Queryable<CommentMutationOutboxEvent>()
                .Where(item => item.CommentId == row.Id)
                .OrderBy(item => item.Id, OrderByType.Asc)
                .ToListAsync(cancellationToken).ConfigureAwait(false);
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
                identity.OperationPlanDigest));
        }
        return entities;
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
        string[] roles = plan.Operations.Where(item => item.Operation == CommentThreadFixtureOperations.Create)
            .Select(item => item.SemanticRole).ToArray();
        if (roles.Distinct(StringComparer.Ordinal).Count() != roles.Length)
            throw new InvalidOperationException("Comment thread fixture create roles must be independent.");
        if (plan.Operations.Any(item => item.ActorMode is not (CommentAuthorModes.Public or CommentAuthorModes.ZkAnonymous)))
            throw new InvalidOperationException("Comment thread fixture plan contains a non-canonical actor mode.");
    }

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
        string OperationPlanDigest);
}
