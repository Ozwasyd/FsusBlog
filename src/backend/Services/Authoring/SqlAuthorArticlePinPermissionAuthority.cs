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
/// Production adapter for the current administrator permission authority. Until a narrower
/// per-article authority exists, it maps the persisted root/article.write grant onto the exact
/// requested stable identities. It still binds every decision to the authenticated administrator,
/// live database session and configured site; any missing input is an unavailable/deny result.
/// </summary>
public sealed class SqlAuthorArticlePinPermissionAuthority(
    ISqlSugarClient db,
    IHttpContextAccessor httpContextAccessor,
    IConfiguration configuration,
    TimeProvider timeProvider) :
    IAuthorArticlePinPermissionProjectionProvider,
    IAuthorArticlePinMutationAuthorizer
{
    public async Task AuthorizeAsync(
        AuthorArticlePinOwner owner,
        IReadOnlyList<int> articleIds,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (articleIds.Count == 0)
        {
            throw new AuthorArticlePinAccessDeniedException();
        }
        AuthorArticlePinPermissionSnapshot snapshot = await ResolveAsync(
            new AuthorArticlePinPermissionBatchRequest(owner, Guid.CreateVersion7(), articleIds),
            cancellationToken).ConfigureAwait(false);
        if (snapshot.Status != AuthorArticlePinPermissionSnapshotStatus.Current
            || snapshot.Decisions.Any(static decision => !decision.CanProject))
        {
            throw new AuthorArticlePinAccessDeniedException();
        }
    }

    /// <summary>
    /// Awaits the original SQL commands and asynchronous reader disposal before completing.
    /// The request and any existing ADO cancellation token cancel command execution as well as reads;
    /// the caller's prior ADO token is restored on success, denial, cancellation and failure.
    /// </summary>
    /// <remarks>
    /// The caller must serialize use of its borrowed client and own its connection and transaction
    /// lifecycle. Cancellation may leave a PostgreSQL transaction aborted; this reader never replaces
    /// the client, commits or rolls back that transaction, or abandons pending SQL work.
    /// Command completion follows the native driver's cancellation response policy. This contract
    /// does not impose an execution deadline or prove the Graph metadata reader's 250 ms budget.
    /// </remarks>
    public async Task<AuthorArticlePinPermissionSnapshot> ResolveAsync(
        AuthorArticlePinPermissionBatchRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        AuthorArticlePinContract.ValidateOwner(request.Owner);
        AuthorArticlePinContract.ValidateRequestId(request.RequestId);
        int[] articleIds = [.. request.ArticleIds];
        if (articleIds.Length > AuthorArticlePinContract.MaxPinsPerOwner
            || articleIds.Any(static articleId => articleId <= 0)
            || articleIds.Distinct().Count() != articleIds.Length)
        {
            return Unavailable(request.Owner, "article_pin_permission_request_invalid");
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
            return Unavailable(request.Owner, "article_pin_permission_context_denied");
        }

        IAdo ado = db.Ado;
        CancellationToken? previousCancellation = ado.CancellationToken;
        using CancellationTokenSource? linkedCancellation = previousCancellation is { CanBeCanceled: true } previous
            ? CancellationTokenSource.CreateLinkedTokenSource(previous, cancellationToken)
            : null;
        CancellationToken commandCancellation = linkedCancellation?.Token ?? cancellationToken;
        try
        {
            ado.CancellationToken = commandCancellation;
            PermissionState? state = await ReadPermissionStateAsync(
                ado,
                adminPrincipalId,
                sessionId,
                commandCancellation).ConfigureAwait(false);
            commandCancellation.ThrowIfCancellationRequested();
            DateTime now = timeProvider.GetUtcNow().UtcDateTime;
            if (state is null
                || !string.Equals(state.PrincipalStatus, AdminPrincipalStatus.Active, StringComparison.Ordinal)
                || (!state.IsRoot && !HasPersistedPermission(state.Permissions, AdminPermissions.ArticleWrite))
                || state.RevokedAtUtc.HasValue
                || state.IdleExpiresAtUtc <= now
                || state.AbsoluteExpiresAtUtc <= now)
            {
                return Unavailable(request.Owner, "article_pin_permission_session_denied");
            }

            Dictionary<int, ArticleAccessState> articles = await ReadArticleStatesAsync(ado, articleIds, commandCancellation)
                .ConfigureAwait(false);
            commandCancellation.ThrowIfCancellationRequested();
            string siteRevision = AuthorArticlePinProjectionContract.HashText(
                $"site:{request.Owner.SiteScope}");
            string permissionRevision = AuthorArticlePinProjectionContract.HashText(
                $"permission:{adminPrincipalId}:{state.PrincipalRowVersion}:{state.IsRoot}:{state.Permissions}");
            string sessionRevision = AuthorArticlePinProjectionContract.HashText(
                $"session:{sessionId}:{state.SessionRowVersion}:{state.IdleExpiresAtUtc:O}:{state.AbsoluteExpiresAtUtc:O}");
            AuthorArticlePinPermissionDecision[] decisions = articleIds.Select(articleId =>
            {
                bool canOpen = articles.TryGetValue(articleId, out ArticleAccessState? article)
                    && !article.IsDeleted
                    && article.Status != ArticleStatus.Deleted;
                string articleRevision = article is null
                    ? "missing"
                    : $"{(int)article.Status}:{article.IsDeleted}";
                return new AuthorArticlePinPermissionDecision(
                    articleId,
                    CanProject: true,
                    CanOpen: canOpen,
                    AuthorArticlePinProjectionContract.HashText(
                        $"article-permission:{adminPrincipalId}:{request.Owner.SiteScope}:{articleId}:{articleRevision}:{permissionRevision}:{sessionRevision}"));
            }).ToArray();
            var snapshot = new AuthorArticlePinPermissionSnapshot(
                AuthorArticlePinPermissionSnapshotStatus.Current,
                request.Owner,
                permissionRevision,
                siteRevision,
                sessionRevision,
                decisions,
                string.Empty);
            return snapshot with
            {
                ContentDigest = AuthorArticlePinProjectionContract.ComputePermissionDigest(snapshot)
            };
        }
        catch (Exception)
        {
            // Report cancellation only after the awaited command and reader cleanup have finished.
            commandCancellation.ThrowIfCancellationRequested();
            throw;
        }
        finally
        {
            ado.CancellationToken = previousCancellation;
        }
    }

    public static string ResolveSiteScope(IConfiguration configuration)
    {
        string configured = configuration["SITE_BASEURL"]
            ?? PublicSiteIdentityDefaults.SiteBaseUrl;
        return configured.Trim().TrimEnd('/');
    }

    private async Task<PermissionState?> ReadPermissionStateAsync(
        IAdo ado,
        long adminPrincipalId,
        string sessionId,
        CancellationToken cancellationToken)
    {
        await using DbDataReader reader = (DbDataReader)await ado.GetDataReaderAsync(
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
                : DateTime.SpecifyKind(reader.GetDateTime(reader.GetOrdinal("revokedatutc")), DateTimeKind.Utc),
            DateTime.SpecifyKind(reader.GetDateTime(reader.GetOrdinal("idleexpiresatutc")), DateTimeKind.Utc),
            DateTime.SpecifyKind(reader.GetDateTime(reader.GetOrdinal("absoluteexpiresatutc")), DateTimeKind.Utc),
            reader.GetString(reader.GetOrdinal("session_row_version")));
    }

    private async Task<Dictionary<int, ArticleAccessState>> ReadArticleStatesAsync(
        IAdo ado,
        IReadOnlyList<int> articleIds,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<int, ArticleAccessState>();
        if (articleIds.Count == 0)
        {
            return result;
        }
        await using DbDataReader reader = (DbDataReader)await ado.GetDataReaderAsync(
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

    private static AuthorArticlePinPermissionSnapshot Unavailable(
        AuthorArticlePinOwner owner,
        string reason)
        => new(
            AuthorArticlePinPermissionSnapshotStatus.Unavailable,
            owner,
            string.Empty,
            string.Empty,
            string.Empty,
            [],
            string.Empty,
            reason);

    private sealed record PermissionState(
        string PrincipalStatus,
        bool IsRoot,
        string Permissions,
        string PrincipalRowVersion,
        DateTime? RevokedAtUtc,
        DateTime IdleExpiresAtUtc,
        DateTime AbsoluteExpiresAtUtc,
        string SessionRowVersion);

    private sealed record ArticleAccessState(
        ArticleStatus Status,
        bool IsDeleted);
}
