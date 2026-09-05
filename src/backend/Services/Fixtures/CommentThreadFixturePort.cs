// fixture-catalog: port comment-thread-lifecycle
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
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

public sealed record CommentThreadFixtureOperation(
    string CapabilityId,
    string SemanticRole,
    string Operation,
    string ActorMode,
    int? AccountId,
    string Content,
    string? ParentRole = null,
    string? ExpectedFailureCode = null,
    string? AnonymousScope = null,
    string? DisplayLanguage = null,
    byte[]? AnonymousTicket = null);

public sealed record CommentThreadFixturePlan(
    string Schema,
    string RunId,
    string Namespace,
    string Owner,
    int ArticleId,
    string InventoryDigest,
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
    IReadOnlyList<string> OutboxEventIds);

public sealed record CommentThreadFixtureResult(
    string Schema,
    string RunId,
    string Namespace,
    string Owner,
    int ArticleId,
    string InventoryDigest,
    IReadOnlyList<CommentThreadFixtureEntity> Entities,
    IReadOnlyDictionary<string, string> NegativeResults);

public sealed record CommentThreadFixtureCleanupReceipt(
    string Schema,
    string RunId,
    string Namespace,
    string Owner,
    string InventoryDigest,
    IReadOnlyDictionary<long, int?> OwnedComments);

public interface ICommentThreadFixturePort
{
    Task<CommentThreadFixtureResult> ExecuteAsync(
        CommentThreadFixturePlan plan,
        CancellationToken cancellationToken = default);

    Task CleanupAsync(
        CommentThreadFixtureCleanupReceipt receipt,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Test-only typed composition port. All mutations delegate to the production
/// comment command and author-management services; the database is read only.
/// </summary>
public sealed class CommentThreadFixturePort(
    ICommentEndpointService comments,
    ICommentAuthorManagementService authorManagement,
    ICommentManagementCapabilityService managementCapabilities,
    ICommentQueryService publicQueries,
    ISqlSugarClient db) : ICommentThreadFixturePort
{
    private const string PlanSchema = "fsusblog.comment-thread-fixture-plan.v1";
    private const string ResultSchema = "fsusblog.comment-thread-fixture-result.v1";
    private const string CleanupSchema = "fsusblog.comment-thread-fixture-cleanup.v1";

    public async Task<CommentThreadFixtureResult> ExecuteAsync(
        CommentThreadFixturePlan plan,
        CancellationToken cancellationToken = default)
    {
        ValidatePlan(plan);
        var roles = new Dictionary<string, FixtureIdentity>(StringComparer.Ordinal);
        var negativeResults = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (CommentThreadFixtureOperation operation in plan.Operations)
        {
            cancellationToken.ThrowIfCancellationRequested();
            switch (operation.Operation)
            {
                case CommentThreadFixtureOperations.Create:
                case CommentThreadFixtureOperations.RejectDepthOverrun:
                    CommentCreateResult created = await CreateAsync(plan, operation, roles, cancellationToken)
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
                    roles.Add(operation.SemanticRole, new FixtureIdentity(created.CommentId, operation.AccountId, created.ManagementSecret));
                    break;

                case CommentThreadFixtureOperations.Edit:
                    await EditAsync(operation, RequireRole(roles, operation.SemanticRole), cancellationToken)
                        .ConfigureAwait(false);
                    break;

                case CommentThreadFixtureOperations.SoftDelete:
                    await SoftDeleteAsync(operation, RequireRole(roles, operation.SemanticRole), cancellationToken)
                        .ConfigureAwait(false);
                    break;

                default:
                    throw new InvalidOperationException($"Unknown comment thread fixture operation {operation.Operation}.");
            }
        }

        List<CommentThreadFixtureEntity> entities = await ObserveAsync(plan, roles, cancellationToken)
            .ConfigureAwait(false);
        if (entities.Count != roles.Count)
            throw new InvalidOperationException("Comment thread fixture observation is partial.");

        return new CommentThreadFixtureResult(
            ResultSchema,
            plan.RunId,
            plan.Namespace,
            plan.Owner,
            plan.ArticleId,
            plan.InventoryDigest,
            entities,
            negativeResults);
    }

    public async Task CleanupAsync(
        CommentThreadFixtureCleanupReceipt receipt,
        CancellationToken cancellationToken = default)
    {
        if (receipt.Schema != CleanupSchema || string.IsNullOrWhiteSpace(receipt.RunId)
            || string.IsNullOrWhiteSpace(receipt.Namespace) || string.IsNullOrWhiteSpace(receipt.Owner)
            || !IsDigest(receipt.InventoryDigest) || receipt.OwnedComments.Count == 0)
            throw new InvalidOperationException("Comment thread cleanup receipt is invalid.");

        List<Comment> owned = await db.Queryable<Comment>()
            .Where(item => receipt.OwnedComments.Keys.Contains(item.Id))
            .OrderBy(item => item.Depth, OrderByType.Desc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (owned.Count != receipt.OwnedComments.Count)
            throw new InvalidOperationException("Comment thread cleanup receipt contains missing identities.");
        foreach (Comment row in owned)
        {
            int? expectedActor = receipt.OwnedComments[row.Id];
            if (row.UserId != expectedActor)
                throw new InvalidOperationException($"Comment {row.Id} actor is not owned by the cleanup receipt.");
            if (row.IsDeleted)
                continue;
            if (expectedActor is not > 0)
                throw new InvalidOperationException("Anonymous cleanup requires an ephemeral management capability and cannot scan storage.");
            await RequireAccountMutationAsync(row.Id, expectedActor.Value, CommentManagementPurposes.Delete,
                (challenge, version) => authorManagement.DeleteAsAccountAsync(row.Id, expectedActor.Value, challenge, cancellationToken),
                cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<CommentCreateResult> CreateAsync(
        CommentThreadFixturePlan plan,
        CommentThreadFixtureOperation operation,
        IReadOnlyDictionary<string, FixtureIdentity> roles,
        CancellationToken cancellationToken)
    {
        FixtureIdentity? parent = operation.ParentRole is null ? null : RequireRole(roles, operation.ParentRole);
        string? parentId = parent?.CommentId.ToString(CultureInfo.InvariantCulture);
        Comment? parentRow = parent is null ? null : await db.Queryable<Comment>()
            .Where(item => item.Id == parent.CommentId)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        string? rootId = parentRow is null ? null : (parentRow.RootId ?? parentRow.Id).ToString(CultureInfo.InvariantCulture);

        if (operation.ActorMode == CommentAuthorModes.Public)
        {
            if (operation.AccountId is not > 0)
                throw new InvalidOperationException($"Public role {operation.SemanticRole} requires an account reference.");
            var request = new CommentCreateV2RequestCoreModel(
                plan.ArticleId,
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
            return await comments.CreateAttributablePublicCommentResultAsync(
                new AccountPrincipalContext(operation.AccountId.Value, null),
                request,
                DeterministicMutationId(plan.Owner, operation.SemanticRole))
                .ConfigureAwait(false);
        }

        if (operation.ActorMode == CommentAuthorModes.ZkAnonymous)
        {
            if (string.IsNullOrWhiteSpace(operation.AnonymousScope)
                || string.IsNullOrWhiteSpace(operation.DisplayLanguage)
                || operation.AnonymousTicket is not { Length: > 0 })
                throw new InvalidOperationException($"zk_anonymous role {operation.SemanticRole} requires its verified ephemeral ticket reference.");
            return await comments.CreateStrongAnonymousCommentResultAsync(
                new AnonymousCommentCreateRequestCoreModel(
                    plan.ArticleId,
                    operation.Content,
                    parentId,
                    rootId,
                    parentId,
                    operation.AnonymousScope,
                    operation.DisplayLanguage,
                    operation.AnonymousTicket),
                cancellationToken: cancellationToken).ConfigureAwait(false);
        }

        throw new InvalidOperationException($"Actor mode {operation.ActorMode} is not canonical.");
    }

    private async Task EditAsync(
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
        if (operation.ActorMode == CommentAuthorModes.ZkAnonymous && !string.IsNullOrWhiteSpace(identity.ManagementSecret))
        {
            CommentManagementChallengeResult challenge = await RequireAnonymousChallengeAsync(
                row.Id, identity.ManagementSecret, CommentManagementPurposes.Edit, cancellationToken).ConfigureAwait(false);
            CommentAuthorMutationResult result = await authorManagement.EditAsAnonymousAsync(
                row.Id,
                identity.ManagementSecret,
                new CommentEditRequest(challenge.CurrentVersion, operation.Content, challenge.Challenge!),
                cancellationToken).ConfigureAwait(false);
            RequireMutation(result, operation.SemanticRole);
            return;
        }
        throw new InvalidOperationException($"Role {operation.SemanticRole} has no owned edit authority.");
    }

    private async Task SoftDeleteAsync(
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
        if (operation.ActorMode == CommentAuthorModes.ZkAnonymous && !string.IsNullOrWhiteSpace(identity.ManagementSecret))
        {
            CommentManagementChallengeResult challenge = await RequireAnonymousChallengeAsync(
                row.Id, identity.ManagementSecret, CommentManagementPurposes.Delete, cancellationToken).ConfigureAwait(false);
            CommentAuthorMutationResult result = await authorManagement.DeleteAsAnonymousAsync(
                row.Id, identity.ManagementSecret, challenge.Challenge!, cancellationToken).ConfigureAwait(false);
            RequireMutation(result, operation.SemanticRole);
            return;
        }
        throw new InvalidOperationException($"Role {operation.SemanticRole} has no owned delete authority.");
    }

    private async Task<List<CommentThreadFixtureEntity>> ObserveAsync(
        CommentThreadFixturePlan plan,
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
                || row.ArticleId != plan.ArticleId
                || row.UserId != identity.AccountId)
                throw new InvalidOperationException($"Comment role {role} does not match its owned article/actor reference.");
            IReadOnlyList<CommentRevisionResult> history = await authorManagement.ReadRevisionsAsAdminAsync(row.Id, cancellationToken)
                .ConfigureAwait(false);
            if (history.Count == 0 || history.Select(item => item.Version).Distinct().Count() != history.Count
                || history.Max(item => item.Version) != row.CurrentVersion)
                throw new InvalidOperationException($"Comment role {role} has incomplete revision history.");
            CommentPermalinkContextDto publicProjection = await publicQueries.GetPermalinkContextAsync(plan.ArticleId, row.Id)
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
                outbox.Select(item => item.EventId).ToArray()));
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
        if (plan.Schema != PlanSchema || string.IsNullOrWhiteSpace(plan.RunId)
            || string.IsNullOrWhiteSpace(plan.Namespace) || string.IsNullOrWhiteSpace(plan.Owner)
            || plan.ArticleId <= 0 || !IsDigest(plan.InventoryDigest) || plan.Operations.Count == 0)
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

    private static string Digest(string value)
        => $"sha256:{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)))}";

    private sealed record FixtureIdentity(long CommentId, int? AccountId, string? ManagementSecret);
}
