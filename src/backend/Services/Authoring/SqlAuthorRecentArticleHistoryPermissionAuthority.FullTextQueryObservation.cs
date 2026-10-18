using System.Collections.Immutable;
using System.Data.Common;
using System.Security.Claims;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed partial class SqlAuthorRecentArticleHistoryPermissionAuthority
{
    // These are internal SQL observations only. The #2316 owner still owns Search's
    // PermissionRevision/PermissionPolicyDigest and its actor mapping. No public DTO, hash,
    // query grant, registration or result admission is manufactured here.
    private const int FullTextObservationArticleLimit = 10_000;
    private readonly object _fullTextObservationIssuer = new();

    internal async Task<FullTextQueryPermissionObservation?> ObserveFullTextQueryPermissionAsync(
        AuthorRecentArticleHistoryPermissionRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(request.ArticleIds);
        cancellationToken.ThrowIfCancellationRequested();
        AuthorRecentArticleHistoryContract.ValidateOwner(request.Owner);
        AuthorRecentArticleHistoryContract.ValidateRequestId(request.RequestId);
        ImmutableArray<int> ids = request.ArticleIds.Take(FullTextObservationArticleLimit + 1).ToImmutableArray();
        if (ids.Length > FullTextObservationArticleLimit || ids.Any(static id => id <= 0)
            || ids.Distinct().Count() != ids.Length || db.Ado.Transaction is not null)
        {
            return null;
        }
        FullTextActorContext? actor = CaptureFullTextActor(request.Owner);
        if (actor is null)
        {
            return null;
        }

        FullTextActorState? before = await ReadFullTextActorAsync(actor, cancellationToken).ConfigureAwait(false);
        if (!FullTextActorIsLive(before))
        {
            return null;
        }
        ImmutableArray<FullTextArticleState>? first = await ReadFullTextArticlesAsync(actor, ids, cancellationToken)
            .ConfigureAwait(false);
        FullTextActorState? middle = await ReadFullTextActorAsync(actor, cancellationToken).ConfigureAwait(false);
        if (first is null || before != middle || !FullTextActorIsLive(middle))
        {
            return null;
        }
        ImmutableArray<FullTextArticleState>? second = await ReadFullTextArticlesAsync(actor, ids, cancellationToken)
            .ConfigureAwait(false);
        FullTextActorState? after = await ReadFullTextActorAsync(actor, cancellationToken).ConfigureAwait(false);
        if (second is null || !first.Value.SequenceEqual(second.Value) || before != after
            || !FullTextActorIsLive(after) || !FullTextContextIsCurrent(actor, cancellationToken))
        {
            return null;
        }
        return new FullTextQueryPermissionObservation(_fullTextObservationIssuer, request.Owner,
            request.RequestId, ids, actor, before!, first.Value);
    }

    /// <summary>
    /// Reobserves the same SQL rows and actor. A future consumer must call this around
    /// every asynchronous stage and immediately before emitting any search-derived fact.
    /// A current observation alone is neither Search result admission nor a public grant.
    /// </summary>
    internal async Task<bool> RevalidateFullTextQueryPermissionAsync(
        FullTextQueryPermissionObservation observation,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(observation);
        cancellationToken.ThrowIfCancellationRequested();
        if (!observation.IsIssuedBy(_fullTextObservationIssuer)
            || !FullTextContextIsCurrent(observation.ActorContext, cancellationToken))
        {
            return false;
        }
        FullTextQueryPermissionObservation? current = await ObserveFullTextQueryPermissionAsync(
            new(observation.Owner, observation.RequestId, observation.ArticleIds), cancellationToken).ConfigureAwait(false);
        return current is not null && current.ActorState == observation.ActorState
            && current.Articles.SequenceEqual(observation.Articles)
            && FullTextContextIsCurrent(observation.ActorContext, cancellationToken)
            && FullTextActorIsLive(observation.ActorState);
    }

    private FullTextActorContext? CaptureFullTextActor(AuthorRecentArticleHistoryOwner owner)
    {
        HttpContext? context = httpContextAccessor.HttpContext;
        ClaimsPrincipal? principal = context?.User;
        string? sessionId = principal.GetAdminSessionId();
        return context is not null && principal?.Identity?.IsAuthenticated == true
            && principal.IsAdminPrincipal() && principal.TryGetAdminPrincipalId(out long principalId)
            && principalId == owner.AdminPrincipalId && principal.HasAdminPermission(AdminPermissions.ArticleWrite)
            && !string.IsNullOrWhiteSpace(sessionId)
            && string.Equals(owner.SiteScope, ResolveSiteScope(configuration), StringComparison.Ordinal)
            ? new(context, principal, principalId, sessionId, owner.SiteScope) : null;
    }

    private bool FullTextContextIsCurrent(FullTextActorContext actor, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        FullTextActorContext? current = CaptureFullTextActor(new(actor.PrincipalId, actor.SiteScope));
        return db.Ado.Transaction is null && current == actor;
    }

    private bool FullTextActorIsLive(FullTextActorState? state)
    {
        DateTime now = Utc(timeProvider.GetUtcNow().UtcDateTime);
        return state is not null && state.PrincipalGeneration > 0 && state.SessionGeneration > 0
            && state.Status == AdminPrincipalStatus.Active
            && (state.IsRoot || HasPersistedPermission(state.Permissions, AdminPermissions.ArticleWrite))
            && state.RevokedAtUtc is null && state.IdleExpiresAtUtc > now && state.AbsoluteExpiresAtUtc > now;
    }

    private async Task<FullTextActorState?> ReadFullTextActorAsync(
        FullTextActorContext actor,
        CancellationToken cancellationToken)
    {
        if (!FullTextContextIsCurrent(actor, cancellationToken))
        {
            return null;
        }
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT ap.status, ap.isroot, ap.permissions,
                   ap.xmin::text::bigint AS principal_generation,
                   s.xmin::text::bigint AS session_generation,
                   s.revokedatutc, s.idleexpiresatutc, s.absoluteexpiresatutc
            FROM admin_principal ap
            JOIN admin_session s ON s.adminprincipalid = ap.id
            WHERE ap.id = @AdminPrincipalId AND s.sessionid = @SessionId;
            """,
            new SugarParameter("@AdminPrincipalId", actor.PrincipalId),
            new SugarParameter("@SessionId", actor.SessionId)).ConfigureAwait(false);
        if (!FullTextContextIsCurrent(actor, cancellationToken))
        {
            return null;
        }
        bool found = await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
        if (!FullTextContextIsCurrent(actor, cancellationToken) || !found)
        {
            return null;
        }
        var state = new FullTextActorState(
            reader.GetInt64(reader.GetOrdinal("principal_generation")),
            reader.GetInt64(reader.GetOrdinal("session_generation")),
            reader.GetString(reader.GetOrdinal("status")),
            reader.GetBoolean(reader.GetOrdinal("isroot")),
            reader.GetString(reader.GetOrdinal("permissions")),
            reader.IsDBNull(reader.GetOrdinal("revokedatutc"))
                ? null : Utc(reader.GetDateTime(reader.GetOrdinal("revokedatutc"))),
            Utc(reader.GetDateTime(reader.GetOrdinal("idleexpiresatutc"))),
            Utc(reader.GetDateTime(reader.GetOrdinal("absoluteexpiresatutc"))));
        bool duplicate = await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
        return FullTextContextIsCurrent(actor, cancellationToken) && !duplicate && FullTextActorIsLive(state)
            ? state : null;
    }

    private async Task<ImmutableArray<FullTextArticleState>?> ReadFullTextArticlesAsync(
        FullTextActorContext actor,
        ImmutableArray<int> ids,
        CancellationToken cancellationToken)
    {
        if (!FullTextContextIsCurrent(actor, cancellationToken))
        {
            return null;
        }
        if (ids.IsEmpty)
        {
            return ImmutableArray<FullTextArticleState>.Empty;
        }
        HashSet<int> requestedIds = ids.ToHashSet();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT a.id, a.status, a.current_revision_id,
                   a.xmin::text::bigint AS article_generation,
                   current_revision.xmin::text::bigint AS revision_generation,
                   ownership.id AS ownership_revision_id,
                   ownership.xmin::text::bigint AS ownership_generation
            FROM article a
            JOIN article_revision current_revision
              ON current_revision.id = a.current_revision_id AND current_revision.article_id = a.id
            JOIN LATERAL (
                SELECT r.id, r.xmin
                FROM article_revision r
                WHERE r.article_id = a.id AND r.created_by_admin_principal_id = @AdminPrincipalId
                ORDER BY r.id
                LIMIT 1
            ) ownership ON TRUE
            WHERE a.id = ANY(CAST(@ArticleIds AS integer[]))
              AND NOT a.isdeleted AND a.status IN (0, 1, 2)
            ORDER BY a.id
            LIMIT @Limit;
            """,
            new SugarParameter("@AdminPrincipalId", actor.PrincipalId),
            new SugarParameter("@ArticleIds", FormatIntegerArray(ids)),
            new SugarParameter("@Limit", ids.Length + 1)).ConfigureAwait(false);
        if (!FullTextContextIsCurrent(actor, cancellationToken))
        {
            return null;
        }
        var result = ImmutableArray.CreateBuilder<FullTextArticleState>();
        while (true)
        {
            bool found = await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
            if (!FullTextContextIsCurrent(actor, cancellationToken))
            {
                return null;
            }
            if (!found)
            {
                break;
            }
            int id = reader.GetInt32(reader.GetOrdinal("id"));
            var state = new FullTextArticleState(id,
                (ArticleStatus)reader.GetInt32(reader.GetOrdinal("status")),
                reader.GetInt64(reader.GetOrdinal("current_revision_id")),
                reader.GetInt64(reader.GetOrdinal("article_generation")),
                reader.GetInt64(reader.GetOrdinal("revision_generation")),
                reader.GetInt64(reader.GetOrdinal("ownership_revision_id")),
                reader.GetInt64(reader.GetOrdinal("ownership_generation")));
            if (result.Count >= ids.Length || !requestedIds.Contains(id)
                || (result.Count > 0 && result[^1].ArticleId >= id)
                || state.Status is not (ArticleStatus.Draft or ArticleStatus.Scheduled or ArticleStatus.Published)
                || state.CurrentRevisionId <= 0 || state.ArticleGeneration <= 0 || state.RevisionGeneration <= 0
                || state.OwnershipRevisionId <= 0 || state.OwnershipGeneration <= 0)
            {
                return null;
            }
            result.Add(state);
        }
        return result.ToImmutable();
    }

    internal sealed record FullTextActorContext(
        HttpContext Context, ClaimsPrincipal Principal, long PrincipalId, string SessionId, string SiteScope);

    internal sealed record FullTextActorState(
        long PrincipalGeneration, long SessionGeneration, string Status, bool IsRoot, string Permissions,
        DateTime? RevokedAtUtc, DateTime IdleExpiresAtUtc, DateTime AbsoluteExpiresAtUtc);

    internal sealed record FullTextArticleState(
        int ArticleId, ArticleStatus Status, long CurrentRevisionId, long ArticleGeneration,
        long RevisionGeneration, long OwnershipRevisionId, long OwnershipGeneration);

    /// <summary>
    /// Internal raw facts issued by this SQL reader. It contains no Search digest/revision,
    /// candidate, count, facet, snippet or grant. Only its issuing instance can revalidate it.
    /// </summary>
    internal sealed class FullTextQueryPermissionObservation(
        object issuer,
        AuthorRecentArticleHistoryOwner owner,
        Guid requestId,
        ImmutableArray<int> articleIds,
        FullTextActorContext actorContext,
        FullTextActorState actorState,
        ImmutableArray<FullTextArticleState> articles)
    {
        internal AuthorRecentArticleHistoryOwner Owner { get; } = owner;
        internal Guid RequestId { get; } = requestId;
        internal ImmutableArray<int> ArticleIds { get; } = articleIds;
        internal FullTextActorContext ActorContext { get; } = actorContext;
        internal FullTextActorState ActorState { get; } = actorState;
        internal ImmutableArray<FullTextArticleState> Articles { get; } = articles;

        internal bool IsIssuedBy(object expectedIssuer) => ReferenceEquals(issuer, expectedIssuer);
    }
}
