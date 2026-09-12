using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Owner-derived internal write surface for private author article pins. Callers never supply an
/// administrator or site scope; both are projected from the authenticated request.
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
}

public sealed class AuthorArticlePinApplicationFacade(
    IAuthorArticlePinStore store,
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
