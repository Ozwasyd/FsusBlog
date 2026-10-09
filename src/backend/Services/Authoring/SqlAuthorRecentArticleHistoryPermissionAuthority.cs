using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Binds history writes and reads to the authenticated administrator, live session, configured
/// site and the current article lifecycle. Missing, archived and deleted articles all become the
/// same non-projectable decision; no article metadata is returned to the projection layer.
/// </summary>
public sealed class SqlAuthorRecentArticleHistoryPermissionAuthority(
    IAuthorRecentArticleHistoryPersistedPermissionReader permissions,
    IHttpContextAccessor httpContextAccessor,
    IConfiguration configuration) :
    IAuthorRecentArticleHistoryMutationAuthorizer,
    IAuthorRecentArticleHistoryPermissionProjectionProvider
{
    /// <summary>
    /// Preserve the original direct SQL construction boundary using the sole persisted reader implementation.
    /// Production composition explicitly injects the registered scoped reader through the primary constructor.
    /// </summary>
    public SqlAuthorRecentArticleHistoryPermissionAuthority(
        ISqlSugarClient db,
        IHttpContextAccessor httpContextAccessor,
        IConfiguration configuration,
        TimeProvider timeProvider)
        : this(new AuthorRecentArticleHistoryPersistedPermissionReader(db, configuration, timeProvider),
            httpContextAccessor, configuration)
    {
    }

    public async Task AuthorizeAsync(
        AuthorRecentArticleHistoryOwner owner,
        int articleId,
        CancellationToken cancellationToken = default)
    {
        AuthorRecentArticleHistoryContract.ValidateOwner(owner);
        AuthorRecentArticleHistoryContract.ValidateArticleId(articleId);
        AuthorRecentArticleHistoryPermissionSnapshot snapshot = await ResolveAsync(
            new AuthorRecentArticleHistoryPermissionRequest(owner, Guid.CreateVersion7(), [articleId]),
            cancellationToken).ConfigureAwait(false);
        AuthorRecentArticleHistoryPermissionDecision? decision = snapshot.Decisions
            .SingleOrDefault(candidate => candidate.ArticleId == articleId);
        if (snapshot.Status != AuthorRecentArticleHistoryPermissionSnapshotStatus.Current
            || decision is null
            || !decision.CanWrite)
        {
            throw new AuthorRecentArticleHistoryAccessDeniedException();
        }
    }

    public async Task<AuthorRecentArticleHistoryPermissionSnapshot> ResolveAsync(
        AuthorRecentArticleHistoryPermissionRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        AuthorRecentArticleHistoryContract.ValidateOwner(request.Owner);
        AuthorRecentArticleHistoryContract.ValidateRequestId(request.RequestId);
        int[] articleIds = [.. request.ArticleIds];
        if (articleIds.Any(static articleId => articleId <= 0)
            || articleIds.Distinct().Count() != articleIds.Length
            || articleIds.Length > AuthorRecentArticleHistoryContract.MaxEntriesPerOwner)
        {
            return Unavailable(request.Owner, "author_recent_history_permission_request_invalid");
        }

        HttpContext? context = httpContextAccessor.HttpContext;
        ClaimsPrincipal? principal = context?.User;
        string? sessionId = principal.GetAdminSessionId();
        if (context is null
            || principal?.Identity?.IsAuthenticated != true
            || !principal.IsAdminPrincipal()
            || !principal.TryGetAdminPrincipalId(out long adminPrincipalId)
            || adminPrincipalId != request.Owner.AdminPrincipalId
            || !principal.HasAdminPermission(AdminPermissions.ArticleWrite)
            || string.IsNullOrWhiteSpace(sessionId)
            || !string.Equals(request.Owner.SiteScope, ResolveSiteScope(configuration), StringComparison.Ordinal))
        {
            return Unavailable(request.Owner, "author_recent_history_permission_context_denied");
        }

        return await permissions.ResolveAsync(
            new AuthorRecentArticleHistoryPermissionRequest(request.Owner, request.RequestId, articleIds),
            sessionId,
            cancellationToken).ConfigureAwait(false);
    }

    public static string ResolveSiteScope(IConfiguration configuration)
    {
        string configured = configuration["SITE_BASEURL"]
            ?? PublicSiteIdentityDefaults.SiteBaseUrl;
        return configured.Trim().TrimEnd('/');
    }

    private static AuthorRecentArticleHistoryPermissionSnapshot Unavailable(
        AuthorRecentArticleHistoryOwner owner,
        string reason)
        => new(
            AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable,
            owner,
            string.Empty,
            string.Empty,
            string.Empty,
            [],
            AuthorRecentArticleHistoryContract.HashText($"unavailable:{owner.AdminPrincipalId}:{owner.SiteScope}:{reason}"));
}

public interface IAuthorRecentArticleHistoryPermissionProjectionProvider
{
    Task<AuthorRecentArticleHistoryPermissionSnapshot> ResolveAsync(
        AuthorRecentArticleHistoryPermissionRequest request,
        CancellationToken cancellationToken = default);
}
