using System.Data.Common;
using System.Security.Claims;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public interface IAuthorArticlePinMutationAuthorizer
{
    Task AuthorizeAsync(
        AuthorArticlePinOwner owner,
        IReadOnlyList<int> articleIds,
        CancellationToken cancellationToken = default);
}

public sealed class UnavailableAuthorArticlePinMutationAuthorizer : IAuthorArticlePinMutationAuthorizer
{
    public static UnavailableAuthorArticlePinMutationAuthorizer Instance { get; } = new();

    private UnavailableAuthorArticlePinMutationAuthorizer()
    {
    }

    public Task AuthorizeAsync(
        AuthorArticlePinOwner owner,
        IReadOnlyList<int> articleIds,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        throw new AuthorArticlePinAccessDeniedException();
    }
}

/// <summary>
/// Production write authorizer for private author article pins. It binds every mutation to the
/// authenticated administrator, live database session, configured site and exact stable article
/// identities. Any missing, deleted or unauthorized input fails closed before the store mutates.
/// </summary>
public sealed class SqlAuthorArticlePinPermissionAuthority(
    ISqlSugarClient db,
    IHttpContextAccessor httpContextAccessor,
    IConfiguration configuration,
    TimeProvider timeProvider) : IAuthorArticlePinMutationAuthorizer
{
    public async Task AuthorizeAsync(
        AuthorArticlePinOwner owner,
        IReadOnlyList<int> articleIds,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        AuthorArticlePinContract.ValidateOwner(owner);
        int[] requestedArticleIds = [.. articleIds];
        if (requestedArticleIds.Length == 0
            || requestedArticleIds.Length > AuthorArticlePinContract.MaxPinsPerOwner
            || requestedArticleIds.Any(static articleId => articleId <= 0)
            || requestedArticleIds.Distinct().Count() != requestedArticleIds.Length)
        {
            throw new AuthorArticlePinAccessDeniedException();
        }

        HttpContext? context = httpContextAccessor.HttpContext;
        ClaimsPrincipal? principal = context?.User;
        string? sessionId = principal.GetAdminSessionId();
        if (context is null
            || principal?.Identity?.IsAuthenticated != true
            || !principal.IsAdminPrincipal()
            || !principal.TryGetAdminPrincipalId(out long adminPrincipalId)
            || adminPrincipalId != owner.AdminPrincipalId
            || !principal.HasAdminPermission(AdminPermissions.ArticleWrite)
            || string.IsNullOrWhiteSpace(sessionId)
            || !string.Equals(owner.SiteScope, ResolveSiteScope(configuration), StringComparison.Ordinal))
        {
            throw new AuthorArticlePinAccessDeniedException();
        }

        PermissionState? state = await ReadPermissionStateAsync(
            adminPrincipalId,
            sessionId,
            cancellationToken).ConfigureAwait(false);
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        if (state is null
            || !string.Equals(state.PrincipalStatus, AdminPrincipalStatus.Active, StringComparison.Ordinal)
            || (!state.IsRoot && !HasPersistedPermission(state.Permissions, AdminPermissions.ArticleWrite))
            || state.RevokedAtUtc.HasValue
            || state.IdleExpiresAtUtc <= now
            || state.AbsoluteExpiresAtUtc <= now)
        {
            throw new AuthorArticlePinAccessDeniedException();
        }

        Dictionary<int, ArticleAccessState> articles = await ReadArticleStatesAsync(
            requestedArticleIds,
            cancellationToken).ConfigureAwait(false);
        if (articles.Count != requestedArticleIds.Length
            || articles.Values.Any(static article => article.IsDeleted || article.Status == ArticleStatus.Deleted))
        {
            throw new AuthorArticlePinAccessDeniedException();
        }
    }

    public static string ResolveSiteScope(IConfiguration configuration)
    {
        string configured = configuration["SITE_BASEURL"]
            ?? PublicSiteIdentityDefaults.SiteBaseUrl;
        return configured.Trim().TrimEnd('/');
    }

    private async Task<PermissionState?> ReadPermissionStateAsync(
        long adminPrincipalId,
        string sessionId,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT ap.status AS principal_status,
                   ap.isroot,
                   ap.permissions,
                   s.revokedatutc,
                   s.idleexpiresatutc,
                   s.absoluteexpiresatutc
            FROM admin_principal ap
            JOIN admin_session s ON s.adminprincipalid = ap.id
            WHERE ap.id = @AdminPrincipalId
              AND s.sessionid = @SessionId;
            """,
            new SugarParameter("@AdminPrincipalId", adminPrincipalId),
            new SugarParameter("@SessionId", sessionId)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        return new PermissionState(
            reader.GetString(reader.GetOrdinal("principal_status")),
            reader.GetBoolean(reader.GetOrdinal("isroot")),
            reader.GetString(reader.GetOrdinal("permissions")),
            reader.IsDBNull(reader.GetOrdinal("revokedatutc"))
                ? null
                : DateTime.SpecifyKind(reader.GetDateTime(reader.GetOrdinal("revokedatutc")), DateTimeKind.Utc),
            DateTime.SpecifyKind(reader.GetDateTime(reader.GetOrdinal("idleexpiresatutc")), DateTimeKind.Utc),
            DateTime.SpecifyKind(reader.GetDateTime(reader.GetOrdinal("absoluteexpiresatutc")), DateTimeKind.Utc));
    }

    private async Task<Dictionary<int, ArticleAccessState>> ReadArticleStatesAsync(
        IReadOnlyList<int> articleIds,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<int, ArticleAccessState>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, status, isdeleted
            FROM article
            WHERE id = ANY(CAST(@ArticleIds AS integer[]));
            """,
            new SugarParameter("@ArticleIds", FormatIntegerArray(articleIds))).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            int articleId = reader.GetInt32(reader.GetOrdinal("id"));
            result.Add(articleId, new ArticleAccessState(
                (ArticleStatus)reader.GetInt32(reader.GetOrdinal("status")),
                reader.GetBoolean(reader.GetOrdinal("isdeleted"))));
        }
        return result;
    }

    private static bool HasPersistedPermission(string permissions, string required)
        => permissions.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Contains(required, StringComparer.Ordinal);

    private static string FormatIntegerArray(IEnumerable<int> values)
        => string.Concat(
            "{",
            string.Join(',', values.Select(static value =>
                value.ToString(System.Globalization.CultureInfo.InvariantCulture))),
            "}");

    private sealed record PermissionState(
        string PrincipalStatus,
        bool IsRoot,
        string Permissions,
        DateTime? RevokedAtUtc,
        DateTime IdleExpiresAtUtc,
        DateTime AbsoluteExpiresAtUtc);

    private sealed record ArticleAccessState(
        ArticleStatus Status,
        bool IsDeleted);
}
