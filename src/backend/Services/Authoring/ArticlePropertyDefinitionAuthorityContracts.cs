using FsusBlog.Server.Infrastructure.Auth;

namespace FsusBlog.Server.Services.Authoring;

public interface IArticlePropertyDefinitionStore
{
    Task<ArticlePropertyDefinitionWriteReceipt> CreateAsync(
        CreateArticlePropertyDefinitionCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticlePropertyDefinition?> GetAsync(
        ArticlePropertyDefinitionActor actor,
        ArticlePropertyDefinitionOwner owner,
        Guid definitionId,
        CancellationToken cancellationToken = default);

    Task<ArticlePropertyDefinitionPage> ListAsync(
        ArticlePropertyDefinitionActor actor,
        ArticlePropertyDefinitionOwner owner,
        ArticlePropertyDefinitionPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default);

    Task<ArticlePropertyDefinitionWriteReceipt> UpdateAsync(
        UpdateArticlePropertyDefinitionCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticlePropertyDefinitionWriteReceipt> RenameAsync(
        RenameArticlePropertyDefinitionCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticlePropertyDefinitionWriteReceipt> DeprecateAsync(
        DeprecateArticlePropertyDefinitionCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticlePropertyDefinitionWriteReceipt> DeleteAsync(
        DeleteArticlePropertyDefinitionCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticlePropertyDefinitionVerificationResult> VerifyAsync(
        ArticlePropertyDefinitionActor actor,
        ArticlePropertyDefinitionOwner owner,
        Guid definitionId,
        CancellationToken cancellationToken = default);
}

public interface IArticlePropertyDefinitionPermissionAuthority
{
    void EnsureAllowed(
        ArticlePropertyDefinitionActor actor,
        ArticlePropertyDefinitionOwner owner,
        bool manage);
}

public sealed class ArticlePropertyDefinitionPermissionAuthority : IArticlePropertyDefinitionPermissionAuthority
{
    public void EnsureAllowed(
        ArticlePropertyDefinitionActor actor,
        ArticlePropertyDefinitionOwner owner,
        bool manage)
    {
        ArticlePropertyDefinitionContract.ValidateActor(actor);
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        bool articleWrite = actor.Permissions.Contains(AdminPermissions.ArticleWrite);
        bool allowed = owner.UserId is > 0
            ? articleWrite && owner.UserId == actor.AdminPrincipalId
            : articleWrite && (!manage || actor.Permissions.Contains(AdminPermissions.SystemConfig));
        if (!allowed)
        {
            throw new ArticlePropertyDefinitionAccessDeniedException();
        }
    }
}

/// <summary>
/// The definition authority never reads article values itself. This port supplies the
/// current value-owner's impact count when a schema mutation creates reconciliation work.
/// A later value authority can implement this port without creating a second definition store.
/// </summary>
public interface IArticlePropertyDefinitionImpactAuthority
{
    Task<ArticlePropertyDefinitionImpact> GetImpactAsync(
        ArticlePropertyDefinitionOwner owner,
        ArticlePropertyDefinition? before,
        ArticlePropertyDefinition after,
        string commandKind,
        CancellationToken cancellationToken = default);
}

public sealed class UnavailableArticlePropertyDefinitionImpactAuthority : IArticlePropertyDefinitionImpactAuthority
{
    public Task<ArticlePropertyDefinitionImpact> GetImpactAsync(
        ArticlePropertyDefinitionOwner owner,
        ArticlePropertyDefinition? before,
        ArticlePropertyDefinition after,
        string commandKind,
        CancellationToken cancellationToken = default)
    {
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        ArticlePropertyDefinitionContract.ValidateDefinition(after);
        cancellationToken.ThrowIfCancellationRequested();
        if (before is null || string.Equals(commandKind, "rename", StringComparison.Ordinal))
        {
            return Task.FromResult(new ArticlePropertyDefinitionImpact(0, []));
        }

        return Task.FromResult(new ArticlePropertyDefinitionImpact(
            null,
            [new ArticlePropertyDefinitionObligation(
                "article-property-definition-reconciliation",
                null,
                true,
                "article_property_value_authority_not_available")]));
    }
}

public interface IArticlePropertyDefinitionPersistence
{
    Task<ArticlePropertyDefinition?> GetAsync(
        ArticlePropertyDefinitionOwner owner,
        Guid definitionId,
        CancellationToken cancellationToken = default);

    Task<ArticlePropertyDefinitionPage> ListAsync(
        ArticlePropertyDefinitionOwner owner,
        ArticlePropertyDefinitionPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default);

    Task<ArticlePropertyDefinitionWriteReceipt> ExecuteAsync(
        ArticlePropertyDefinitionOwner owner,
        long actorAdminPrincipalId,
        Guid requestId,
        string commandDigest,
        Guid definitionId,
        ArticlePropertyDefinitionRecordedCommand command,
        Func<ArticlePropertyDefinitionMutationSnapshot, CancellationToken, Task<ArticlePropertyDefinitionMutation>> planner,
        CancellationToken cancellationToken = default);

    Task<ArticlePropertyDefinitionVerificationSnapshot?> ReadVerificationSnapshotAsync(
        ArticlePropertyDefinitionOwner owner,
        Guid definitionId,
        int receiptLimit,
        CancellationToken cancellationToken = default);
}

public sealed record ArticlePropertyDefinitionMutationSnapshot(
    ArticlePropertyDefinitionOwner Owner,
    long OwnerRevision,
    IReadOnlyList<ArticlePropertyDefinition> Definitions,
    ArticlePropertyDefinition? TargetDefinition);

public sealed record ArticlePropertyDefinitionMutation(
    long ExpectedOwnerRevision,
    ArticlePropertyDefinition? PreviousDefinition,
    ArticlePropertyDefinition Definition,
    ArticlePropertyDefinitionWriteReceipt Receipt,
    ArticlePropertyDefinitionImpact? Impact = null);

public sealed record ArticlePropertyDefinitionIdempotencyLookup(
    long ActorAdminPrincipalId,
    Guid RequestId,
    string CommandDigest,
    Guid ReceiptId);
