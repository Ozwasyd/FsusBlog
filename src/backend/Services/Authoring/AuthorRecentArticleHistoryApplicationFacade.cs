using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Owner-derived application port for future authoring consumers. The caller supplies only the
/// durable article id, server revision and request CAS token; administrator and site scope always
/// come from the authenticated server request. Client/UI/search behavior is intentionally absent.
/// </summary>
public interface IAuthorRecentArticleHistoryApplicationFacade
{
    Task<AuthorRecentArticleHistoryReceipt> OpenAsync(
        int articleId,
        long serverRevision,
        long expectedCollectionRevision,
        Guid requestId,
        CancellationToken cancellationToken = default);

    Task<AuthorRecentArticleHistoryReceipt> EditAsync(
        int articleId,
        long serverRevision,
        long expectedCollectionRevision,
        Guid requestId,
        CancellationToken cancellationToken = default);

    Task<AuthorRecentArticleHistoryReceipt> ActivateAsync(
        int articleId,
        long serverRevision,
        long expectedCollectionRevision,
        Guid requestId,
        CancellationToken cancellationToken = default);

    Task<AuthorRecentArticleHistoryProjectionPage> ReadAsync(
        int limit,
        Guid requestId,
        string? cursor = null,
        long? expectedCollectionRevision = null,
        string? expectedPermissionRevision = null,
        string? expectedSiteRevision = null,
        string? expectedSessionRevision = null,
        CancellationToken cancellationToken = default);

    Task<AuthorRecentArticleHistoryVerificationResult> VerifyAsync(
        CancellationToken cancellationToken = default);
}

public sealed class AuthorRecentArticleHistoryApplicationFacade(
    IAuthorRecentArticleHistoryStore store,
    IAuthorRecentArticleHistoryProjectionService projection,
    IHttpContextAccessor httpContextAccessor,
    IConfiguration configuration) : IAuthorRecentArticleHistoryApplicationFacade
{
    public Task<AuthorRecentArticleHistoryReceipt> OpenAsync(
        int articleId,
        long serverRevision,
        long expectedCollectionRevision,
        Guid requestId,
        CancellationToken cancellationToken = default)
        => store.RecordOpenedAsync(
            ResolveOwner(),
            articleId,
            serverRevision,
            expectedCollectionRevision,
            requestId,
            cancellationToken);

    public Task<AuthorRecentArticleHistoryReceipt> EditAsync(
        int articleId,
        long serverRevision,
        long expectedCollectionRevision,
        Guid requestId,
        CancellationToken cancellationToken = default)
        => store.RecordEditedAsync(
            ResolveOwner(),
            articleId,
            serverRevision,
            expectedCollectionRevision,
            requestId,
            cancellationToken);

    public Task<AuthorRecentArticleHistoryReceipt> ActivateAsync(
        int articleId,
        long serverRevision,
        long expectedCollectionRevision,
        Guid requestId,
        CancellationToken cancellationToken = default)
        => store.RecordActivatedAsync(
            ResolveOwner(),
            articleId,
            serverRevision,
            expectedCollectionRevision,
            requestId,
            cancellationToken);

    public Task<AuthorRecentArticleHistoryProjectionPage> ReadAsync(
        int limit,
        Guid requestId,
        string? cursor = null,
        long? expectedCollectionRevision = null,
        string? expectedPermissionRevision = null,
        string? expectedSiteRevision = null,
        string? expectedSessionRevision = null,
        CancellationToken cancellationToken = default)
        => projection.ReadAsync(
            new AuthorRecentArticleHistoryProjectionRequest(
                ResolveOwner(),
                requestId,
                limit,
                cursor,
                expectedCollectionRevision,
                expectedPermissionRevision,
                expectedSiteRevision,
                expectedSessionRevision),
            cancellationToken);

    public Task<AuthorRecentArticleHistoryVerificationResult> VerifyAsync(
        CancellationToken cancellationToken = default)
        => projection.VerifyAsync(ResolveOwner(), cancellationToken);

    private AuthorRecentArticleHistoryOwner ResolveOwner()
    {
        HttpContext? context = httpContextAccessor.HttpContext;
        if (context?.User.Identity?.IsAuthenticated != true
            || !context.User.IsAdminPrincipal()
            || !context.User.TryGetAdminPrincipalId(out long adminPrincipalId)
            || string.IsNullOrWhiteSpace(context.User.GetAdminSessionId())
            || !context.User.HasAdminPermission(AdminPermissions.ArticleWrite))
        {
            throw new AuthorRecentArticleHistoryAccessDeniedException();
        }
        string siteScope = SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(configuration);
        var owner = new AuthorRecentArticleHistoryOwner(adminPrincipalId, siteScope);
        AuthorRecentArticleHistoryContract.ValidateOwner(owner);
        return owner;
    }
}
