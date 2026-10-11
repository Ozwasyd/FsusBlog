using System.Data.Common;
using System.Security.Claims;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Binds history writes and reads to the authenticated administrator, live session, configured
/// site and the current article lifecycle. Missing, archived and deleted articles all become the
/// same non-projectable decision; no article metadata is returned to the projection layer.
/// </summary>
public sealed partial class SqlAuthorRecentArticleHistoryPermissionAuthority(
    ISqlSugarClient db,
    IHttpContextAccessor httpContextAccessor,
    IConfiguration configuration,
    TimeProvider timeProvider) :
    IAuthorRecentArticleHistoryMutationAuthorizer,
    IAuthorRecentArticleHistoryPermissionProjectionProvider
{
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

        PermissionState? state = await ReadPermissionStateAsync(
            adminPrincipalId,
            sessionId,
            cancellationToken).ConfigureAwait(false);
        DateTime now = Utc(timeProvider.GetUtcNow().UtcDateTime);
        if (state is null
            || !string.Equals(state.PrincipalStatus, AdminPrincipalStatus.Active, StringComparison.Ordinal)
            || (!state.IsRoot && !HasPersistedPermission(state.Permissions, AdminPermissions.ArticleWrite))
            || state.RevokedAtUtc.HasValue
            || state.IdleExpiresAtUtc <= now
            || state.AbsoluteExpiresAtUtc <= now)
        {
            return Unavailable(request.Owner, "author_recent_history_permission_session_denied");
        }

        Dictionary<int, ArticleAccessState> articles = await ReadArticleStatesAsync(
            articleIds,
            cancellationToken).ConfigureAwait(false);
        string permissionRevision = AuthorRecentArticleHistoryContract.HashText(
            $"permission:{adminPrincipalId}:{state.PrincipalRowVersion}:{state.IsRoot}:{state.Permissions}");
        string siteRevision = AuthorRecentArticleHistoryContract.HashText(
            $"site:{request.Owner.SiteScope}");
        string sessionRevision = AuthorRecentArticleHistoryContract.HashText(
            $"session:{sessionId}:{state.SessionRowVersion}:{state.IdleExpiresAtUtc:O}:{state.AbsoluteExpiresAtUtc:O}");
        var decisions = new List<AuthorRecentArticleHistoryPermissionDecision>(articleIds.Length);
        foreach (int articleId in articleIds)
        {
            bool visible = articles.TryGetValue(articleId, out ArticleAccessState? article)
                && !article.IsDeleted
                && article.Status is not (ArticleStatus.Archived or ArticleStatus.Deleted);
            decisions.Add(new(
                articleId,
                CanProject: visible,
                CanWrite: visible,
                AuthorRecentArticleHistoryContract.HashText(
                    $"history-permission:{adminPrincipalId}:{request.Owner.SiteScope}:{articleId}:{visible}:{permissionRevision}:{siteRevision}:{sessionRevision}")));
        }
        var snapshot = new AuthorRecentArticleHistoryPermissionSnapshot(
            AuthorRecentArticleHistoryPermissionSnapshotStatus.Current,
            request.Owner,
            permissionRevision,
            siteRevision,
            sessionRevision,
            decisions,
            string.Empty);
        return snapshot with
        {
            ContentDigest = AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot)
        };
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
                   ap.xmin::text AS principal_row_version,
                   s.revokedatutc,
                   s.idleexpiresatutc,
                   s.absoluteexpiresatutc,
                   s.xmin::text AS session_row_version
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
            reader.GetString(reader.GetOrdinal("principal_row_version")),
            reader.IsDBNull(reader.GetOrdinal("revokedatutc"))
                ? null
                : Utc(reader.GetDateTime(reader.GetOrdinal("revokedatutc"))),
            Utc(reader.GetDateTime(reader.GetOrdinal("idleexpiresatutc"))),
            Utc(reader.GetDateTime(reader.GetOrdinal("absoluteexpiresatutc"))),
            reader.GetString(reader.GetOrdinal("session_row_version")));
    }

    private async Task<Dictionary<int, ArticleAccessState>> ReadArticleStatesAsync(
        IReadOnlyList<int> articleIds,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<int, ArticleAccessState>();
        if (articleIds.Count == 0)
        {
            return result;
        }
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
            result[articleId] = new ArticleAccessState(
                (ArticleStatus)reader.GetInt32(reader.GetOrdinal("status")),
                reader.GetBoolean(reader.GetOrdinal("isdeleted")));
        }
        return result;
    }

    private static bool HasPersistedPermission(string permissions, string required)
        => permissions.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Contains(required, StringComparer.Ordinal);

    private static string FormatIntegerArray(IEnumerable<int> articleIds)
        => $"{{{string.Join(',', articleIds)}}}";

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

    private static DateTime Utc(DateTime value)
        => value.Kind == DateTimeKind.Utc
            ? value
            : DateTime.SpecifyKind(value, DateTimeKind.Utc);

    private sealed record PermissionState(
        string PrincipalStatus,
        bool IsRoot,
        string Permissions,
        string PrincipalRowVersion,
        DateTime? RevokedAtUtc,
        DateTime IdleExpiresAtUtc,
        DateTime AbsoluteExpiresAtUtc,
        string SessionRowVersion);

    private sealed record ArticleAccessState(ArticleStatus Status, bool IsDeleted);
}

public interface IAuthorRecentArticleHistoryPermissionProjectionProvider
{
    Task<AuthorRecentArticleHistoryPermissionSnapshot> ResolveAsync(
        AuthorRecentArticleHistoryPermissionRequest request,
        CancellationToken cancellationToken = default);
}
