using FsusBlog.Server.Infrastructure.Auth;

namespace FsusBlog.Server.Services.Authoring;

public interface IArticleTemplateStore
{
    Task<ArticleTemplateWriteReceipt> CreateAsync(
        CreateArticleTemplateCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateDefinition?> GetAsync(
        ArticleTemplateActor actor,
        Guid templateId,
        ArticleTemplatePermission permission = ArticleTemplatePermission.Read,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplatePage> ListAsync(
        ArticleTemplateActor actor,
        ArticleTemplateScope scope,
        ArticleTemplatePageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateVersion?> GetVersionAsync(
        ArticleTemplateActor actor,
        Guid templateId,
        Guid versionId,
        ArticleTemplatePermission permission = ArticleTemplatePermission.Read,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateVersionPage> ListVersionsAsync(
        ArticleTemplateActor actor,
        Guid templateId,
        int? afterVersionNumber,
        int limit,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateWriteReceipt> CreateVersionAsync(
        CreateArticleTemplateVersionCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateWriteReceipt> RenameAsync(
        RenameArticleTemplateCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateWriteReceipt> RetireAsync(
        RetireArticleTemplateCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateWriteReceipt> DeleteAsync(
        DeleteArticleTemplateCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateVerificationResult> VerifyAsync(
        ArticleTemplateActor actor,
        Guid templateId,
        CancellationToken cancellationToken = default);
}

public interface IArticleTemplatePermissionAuthority
{
    void EnsureAllowed(
        ArticleTemplateActor actor,
        ArticleTemplateScope scope,
        ArticleTemplatePermission permission);
}

public sealed class ArticleTemplatePermissionAuthority : IArticleTemplatePermissionAuthority
{
    public void EnsureAllowed(
        ArticleTemplateActor actor,
        ArticleTemplateScope scope,
        ArticleTemplatePermission permission)
    {
        ArticleTemplateContract.ValidateActor(actor);
        ArticleTemplateContract.ValidateScope(scope);
        if (!Enum.IsDefined(permission))
        {
            throw new ArticleTemplateAccessDeniedException();
        }

        bool hasArticleWrite = actor.Permissions.Contains(AdminPermissions.ArticleWrite);
        bool allowed = scope.Kind switch
        {
            ArticleTemplateScopeKind.Personal => hasArticleWrite
                && scope.OwnerAdminPrincipalId == actor.AdminPrincipalId,
            ArticleTemplateScopeKind.Site when permission == ArticleTemplatePermission.Manage =>
                hasArticleWrite && actor.Permissions.Contains(AdminPermissions.SystemConfig),
            ArticleTemplateScopeKind.Site => hasArticleWrite,
            _ => false
        };
        if (!allowed)
        {
            throw new ArticleTemplateAccessDeniedException();
        }
    }
}

public interface IArticleTemplateReferenceAuthority
{
    Task ValidateAsync(
        ArticleTemplateActor actor,
        ArticleTemplateScope scope,
        ArticleTemplateDefaults defaults,
        CancellationToken cancellationToken = default);

    /// <summary>Validate all references and return canonical property values with current definition pins.</summary>
    async Task<IReadOnlyList<ArticleTemplatePropertyPin>> ValidateAndPinAsync(
        ArticleTemplateActor actor,
        ArticleTemplateScope scope,
        ArticleTemplateDefaults defaults,
        CancellationToken cancellationToken = default)
    {
        await ValidateAsync(actor, scope, defaults, cancellationToken).ConfigureAwait(false);
        if (defaults.PropertyDefaults.Count != 0)
        {
            throw new ArticleTemplateReferenceException("article_template_property_authority_unavailable");
        }
        return Array.Empty<ArticleTemplatePropertyPin>();
    }
}

public interface IArticleTemplatePersistence
{
    Task<ArticleTemplateDefinition?> GetAsync(
        Guid templateId,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplatePage> ListAsync(
        ArticleTemplateScope scope,
        ArticleTemplatePageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateVersion?> GetVersionAsync(
        Guid templateId,
        Guid versionId,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateVersionPage> ListVersionsAsync(
        Guid templateId,
        int? afterVersionNumber,
        int limit,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateWriteReceipt> ExecuteAsync(
        ArticleTemplateScope scope,
        long actorAdminPrincipalId,
        Guid requestId,
        string commandDigest,
        Guid templateId,
        Func<ArticleTemplateMutationSnapshot, CancellationToken, Task<ArticleTemplateMutation>> planner,
        CancellationToken cancellationToken = default);

    Task<ArticleTemplateVerificationSnapshot?> ReadVerificationSnapshotAsync(
        Guid templateId,
        int receiptLimit,
        CancellationToken cancellationToken = default);
}

public sealed record ArticleTemplateMutationSnapshot(
    ArticleTemplateScope Scope,
    long ScopeRevision,
    IReadOnlyList<ArticleTemplateDefinition> Definitions,
    ArticleTemplateDefinition? TargetDefinition,
    IReadOnlyList<ArticleTemplateVersion> TargetVersions,
    long TargetUsageCount);

public sealed record ArticleTemplateMutation(
    long ExpectedScopeRevision,
    ArticleTemplateDefinition? PreviousDefinition,
    ArticleTemplateDefinition Definition,
    ArticleTemplateVersion? VersionToInsert,
    ArticleTemplateWriteReceipt Receipt);

public sealed record ArticleTemplateIdempotencyRecord(
    long ActorAdminPrincipalId,
    Guid RequestId,
    string CommandDigest,
    Guid ReceiptId);

public sealed record ArticleTemplateVerificationSnapshot(
    ArticleTemplateDefinition Definition,
    IReadOnlyList<ArticleTemplateVersion> Versions,
    IReadOnlyList<ArticleTemplateWriteReceipt> Receipts,
    IReadOnlyList<ArticleTemplateIdempotencyRecord> IdempotencyRecords,
    IReadOnlyList<ArticleTemplateAuditLink> AuditLinks,
    bool ReceiptLimitExceeded);

public sealed record ArticleTemplateAuditLink(
    Guid AuditReference,
    string Source,
    string Type,
    string Action,
    string? TargetType,
    string? TargetId,
    string EventInfo,
    string? ReasonCode,
    string Outcome,
    bool IsHighValue);

public sealed record ArticleTemplateVerificationViolation(string Code, string Detail);

public sealed record ArticleTemplateVerificationResult(
    bool Valid,
    IReadOnlyList<ArticleTemplateVerificationViolation> Violations);

public interface IArticleTemplateVerifier
{
    ArticleTemplateVerificationResult Verify(ArticleTemplateVerificationSnapshot snapshot);
}

