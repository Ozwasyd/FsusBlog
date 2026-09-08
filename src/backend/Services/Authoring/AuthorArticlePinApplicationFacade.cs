using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Services.Authoring;

public sealed record AuthorArticlePinReadOptions(
    Guid RequestId,
    int Limit = AuthorArticlePinProjectionContract.DefaultPageSize,
    string? Cursor = null,
    long? ExpectedCollectionRevision = null,
    string? ExpectedArticleProjectionDigest = null,
    string? ExpectedPermissionRevision = null,
    string? ExpectedSiteRevision = null,
    string? ExpectedSessionRevision = null);

public sealed record AuthorArticlePinOpenOptions(
    Guid RequestId,
    int ArticleId,
    long CollectionRevision,
    string ArticleVersionReference,
    string RevisionVersionReference,
    string PermissionRevision,
    string PermissionReference,
    string SiteRevision,
    string SessionRevision);

/// <summary>
/// Owner-derived internal application surface shared by the authoring rail and switcher. Callers
/// never supply an administrator or site scope; both are projected from the authenticated request.
/// </summary>
public interface IAuthorArticlePinApplicationFacade
{
    Task<AuthorArticlePinWriteReceipt> AddAsync(
        int articleId,
        long expectedRevision,
        Guid requestId,
        CancellationToken cancellationToken = default);

    Task<AuthorArticlePinWriteReceipt> RemoveAsync(
        int articleId,
        long expectedRevision,
        Guid requestId,
        CancellationToken cancellationToken = default);

    Task<AuthorArticlePinWriteReceipt> ReorderAsync(
        long expectedRevision,
        Guid requestId,
        IReadOnlyList<int> articleIds,
        int? afterArticleId,
        CancellationToken cancellationToken = default);

    Task<AuthorArticlePinProjectionPage> ReadAsync(
        AuthorArticlePinReadOptions options,
        CancellationToken cancellationToken = default);

    Task<AuthorArticlePinOpenValidationResult> RevalidateOpenAsync(
        AuthorArticlePinOpenOptions options,
        CancellationToken cancellationToken = default);
}

public sealed class AuthorArticlePinApplicationFacade(
    IAuthorArticlePinStore store,
    IAuthorArticlePinProjectionService projection,
    IHttpContextAccessor httpContextAccessor,
    IConfiguration configuration) : IAuthorArticlePinApplicationFacade
{
    public Task<AuthorArticlePinWriteReceipt> AddAsync(
        int articleId,
        long expectedRevision,
        Guid requestId,
        CancellationToken cancellationToken = default)
        => store.AddAsync(
            new AddAuthorArticlePinCommand(ResolveOwner(), articleId, expectedRevision, requestId),
            cancellationToken);

    public Task<AuthorArticlePinWriteReceipt> RemoveAsync(
        int articleId,
        long expectedRevision,
        Guid requestId,
        CancellationToken cancellationToken = default)
        => store.RemoveAsync(
            new RemoveAuthorArticlePinCommand(ResolveOwner(), articleId, expectedRevision, requestId),
            cancellationToken);

    public Task<AuthorArticlePinWriteReceipt> ReorderAsync(
        long expectedRevision,
        Guid requestId,
        IReadOnlyList<int> articleIds,
        int? afterArticleId,
        CancellationToken cancellationToken = default)
        => store.ReorderAsync(
            new ReorderAuthorArticlePinsCommand(
                ResolveOwner(),
                expectedRevision,
                requestId,
                articleIds,
                afterArticleId),
            cancellationToken);

    public Task<AuthorArticlePinProjectionPage> ReadAsync(
        AuthorArticlePinReadOptions options,
        CancellationToken cancellationToken = default)
        => projection.ReadAsync(
            new AuthorArticlePinProjectionRequest(
                ResolveOwner(),
                options.RequestId,
                options.Limit,
                options.Cursor,
                options.ExpectedCollectionRevision,
                options.ExpectedArticleProjectionDigest,
                options.ExpectedPermissionRevision,
                options.ExpectedSiteRevision,
                options.ExpectedSessionRevision),
            cancellationToken);

    public Task<AuthorArticlePinOpenValidationResult> RevalidateOpenAsync(
        AuthorArticlePinOpenOptions options,
        CancellationToken cancellationToken = default)
        => projection.RevalidateOpenAsync(
            new AuthorArticlePinOpenValidationRequest(
                ResolveOwner(),
                options.RequestId,
                options.ArticleId,
                options.CollectionRevision,
                options.ArticleVersionReference,
                options.RevisionVersionReference,
                options.PermissionRevision,
                options.PermissionReference,
                options.SiteRevision,
                options.SessionRevision),
            cancellationToken);

    private AuthorArticlePinOwner ResolveOwner()
    {
        HttpContext? context = httpContextAccessor.HttpContext;
        if (context?.User.Identity?.IsAuthenticated != true
            || !context.User.IsAdminPrincipal()
            || !context.User.TryGetAdminPrincipalId(out long adminPrincipalId)
            || string.IsNullOrWhiteSpace(context.User.GetAdminSessionId())
            || !context.User.HasAdminPermission(AdminPermissions.ArticleWrite))
        {
            throw new AuthorArticlePinAccessDeniedException();
        }
        string siteScope = SqlAuthorArticlePinPermissionAuthority.ResolveSiteScope(configuration);
        var owner = new AuthorArticlePinOwner(adminPrincipalId, siteScope);
        AuthorArticlePinContract.ValidateOwner(owner);
        return owner;
    }
}
