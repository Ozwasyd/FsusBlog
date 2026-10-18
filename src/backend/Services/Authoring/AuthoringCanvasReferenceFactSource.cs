using System.Data.Common;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Production adapter for canvas reference facts. Article metadata is read in bounded SQL batches;
/// heading/block coordinates stay behind their typed, fail-closed source authority.
/// </summary>
public sealed class AuthoringCanvasReferenceFactSource(
    IAuthoringCanvasArticleReferenceReader articles,
    IAuthoringCanvasCoordinateFactProvider coordinateProvider) : IAuthoringCanvasReferenceFactSource
{
    public async Task<AuthoringCanvasReferenceAuthorityCoordinate> ReadAuthorityCoordinateAsync(
        AuthoringCanvasOwner owner,
        AuthoringCanvasReferencePermission permission,
        CancellationToken cancellationToken = default)
    {
        AuthoringCanvasContract.ValidateOwner(owner);
        AuthoringCanvasArticleReadAuthority authority = await articles.ReadAuthorityAsync(
            owner,
            permission,
            cancellationToken).ConfigureAwait(false);
        return Coordinate(owner, permission, authority);
    }

    public async Task<IReadOnlyList<AuthoringCanvasReferenceFact>> ReadBatchAsync(
        AuthoringCanvasReferenceFactQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        if (query.Targets.Count > AuthoringCanvasReferenceContract.MaxBatchSize)
        {
            throw new AuthoringCanvasBudgetExceededException("canvas_reference_batch_budget_exceeded");
        }
        AuthoringCanvasArticleReadAuthority authority = await articles.ReadAuthorityAsync(
            query.Owner,
            query.Permission,
            cancellationToken).ConfigureAwait(false);
        if (!authority.Authorized
            || !string.Equals(
                authority.PermissionFingerprint,
                query.AuthorityCoordinate.PermissionFingerprint,
                StringComparison.Ordinal))
        {
            return query.Targets.Select(Denied).ToArray();
        }
        if (Coordinate(query.Owner, query.Permission, authority) != query.AuthorityCoordinate)
        {
            throw new AuthoringCanvasValidationException("canvas_reference_authority_changed");
        }

        IReadOnlyDictionary<int, AuthoringCanvasArticleReferenceRecord> articleFacts =
            await articles.ReadBatchAsync(
                query.Owner,
                query.Permission,
                query.Targets,
                cancellationToken).ConfigureAwait(false);
        ValidateArticleFactSet(query.Targets, articleFacts);
        IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact> coordinateFacts =
            await coordinateProvider.ReadBatchAsync(
                new AuthoringCanvasCoordinateFactQuery(
                    query.CanvasId,
                    query.CanvasRevision,
                    query.CanvasContentDigest,
                    query.Owner,
                    query.Targets.Where(static target => target.NodeType is
                        AuthoringCanvasNodeType.HeadingReference or AuthoringCanvasNodeType.BlockReference).ToArray()),
                cancellationToken).ConfigureAwait(false);
        ValidateCoordinateFactSet(query.Targets, coordinateFacts);

        AuthoringCanvasArticleReadAuthority verifiedAuthority = await articles.ReadAuthorityAsync(
            query.Owner,
            query.Permission,
            cancellationToken).ConfigureAwait(false);
        if (!verifiedAuthority.Authorized
            || !string.Equals(
                verifiedAuthority.PermissionFingerprint,
                query.AuthorityCoordinate.PermissionFingerprint,
                StringComparison.Ordinal))
        {
            return query.Targets.Select(Denied).ToArray();
        }
        if (Coordinate(query.Owner, query.Permission, verifiedAuthority) != query.AuthorityCoordinate)
        {
            throw new AuthoringCanvasValidationException("canvas_reference_authority_changed");
        }

        var result = new List<AuthoringCanvasReferenceFact>(query.Targets.Count);
        foreach (AuthoringCanvasReferenceTarget target in query.Targets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!articleFacts.TryGetValue(target.TargetArticleId, out AuthoringCanvasArticleReferenceRecord? article))
            {
                result.Add(Missing(target));
                continue;
            }
            if (article.State is not AuthoringCanvasArticleState.Current)
            {
                result.Add(Lifecycle(target, article.State));
                continue;
            }

            long resolvedRevision = target.PinnedTargetRevision ?? article.CurrentRevision;
            AuthoringCanvasArticleRevisionDisplayFact? display = target.PinnedTargetRevision is null
                ? article.CurrentDisplay
                : article.PinnedDisplays.GetValueOrDefault(target.PinnedTargetRevision.Value);
            if (display is null)
            {
                result.Add(new AuthoringCanvasReferenceFact(
                    target.NodeId,
                    target.TargetArticleId,
                    AuthoringCanvasArticleState.Current,
                    AuthoringCanvasReferenceCoordinateState.SourceStale,
                    article.CurrentRevision,
                    target.PinnedTargetRevision ?? 0,
                    false,
                    null,
                    null,
                    null));
                continue;
            }

            AuthoringCanvasReferenceCoordinateState coordinateState =
                AuthoringCanvasReferenceCoordinateState.Current;
            string? coordinateSnippet = null;
            if (target.NodeType is AuthoringCanvasNodeType.HeadingReference
                or AuthoringCanvasNodeType.BlockReference)
            {
                if (!coordinateFacts.TryGetValue(target.NodeId, out AuthoringCanvasCoordinateFact? coordinate))
                {
                    coordinateState = AuthoringCanvasReferenceCoordinateState.SourceStale;
                }
                else
                {
                    ValidateCoordinateFact(target, resolvedRevision, coordinate);
                    coordinateState = coordinate.State;
                    coordinateSnippet = coordinate.ContextSnippet;
                }
            }

            string projectionReference = AuthoringCanvasContract.ComputeCommandDigest(
                "canvas-reference-display",
                target.TargetArticleId,
                article.CurrentRevision,
                article.CurrentDisplay.Title,
                article.CurrentDisplay.ContextSnippet);
            result.Add(new AuthoringCanvasReferenceFact(
                target.NodeId,
                target.TargetArticleId,
                AuthoringCanvasArticleState.Current,
                coordinateState,
                article.CurrentRevision,
                resolvedRevision,
                target.DisplayProjectionReference is not null
                    && !string.Equals(target.DisplayProjectionReference, projectionReference, StringComparison.Ordinal),
                display.Title,
                target.NodeType == AuthoringCanvasNodeType.ArticleReference
                    ? display.ContextSnippet
                    : coordinateSnippet,
                $"/manage/article/edit/{target.TargetArticleId}")
            {
                DisplayProjectionReference = projectionReference
            });
        }
        return result;
    }

    private static AuthoringCanvasReferenceAuthorityCoordinate Coordinate(
        AuthoringCanvasOwner owner,
        AuthoringCanvasReferencePermission permission,
        AuthoringCanvasArticleReadAuthority authority)
        => new(
            Math.Max(1, Math.Max(authority.PrincipalGeneration, authority.ContentGeneration)),
            AuthoringCanvasContract.ComputeCommandDigest(
                AuthoringCanvasReferenceContract.SchemaVersion,
                owner.AdminPrincipalId,
                owner.SiteScope,
                permission,
                authority.PrincipalGeneration,
                authority.ContentGeneration,
                authority.ArticleCount,
                authority.RevisionCount,
                authority.PermissionFingerprint,
                authority.Authorized),
            authority.PermissionFingerprint);

    private static void ValidateArticleFactSet(
        IReadOnlyList<AuthoringCanvasReferenceTarget> targets,
        IReadOnlyDictionary<int, AuthoringCanvasArticleReferenceRecord> facts)
    {
        var requested = targets.Select(static target => target.TargetArticleId).ToHashSet();
        foreach ((int articleId, AuthoringCanvasArticleReferenceRecord article) in facts)
        {
            if (!requested.Contains(articleId)
                || article is null
                || article.ArticleId != articleId
                || !Enum.IsDefined(article.State)
                || article.CurrentRevision < 0
                || article.CurrentDisplay is null
                || article.PinnedDisplays is null
                || article.CurrentDisplay.Revision != article.CurrentRevision
                || (article.State == AuthoringCanvasArticleState.Current && article.CurrentRevision <= 0)
                || article.PinnedDisplays.Any(static pair => pair.Key <= 0
                    || pair.Value is null
                    || pair.Value.Revision != pair.Key))
            {
                throw new AuthoringCanvasValidationException("canvas_reference_article_fact_set_invalid");
            }
        }
    }

    private static void ValidateCoordinateFactSet(
        IReadOnlyList<AuthoringCanvasReferenceTarget> targets,
        IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact> facts)
    {
        var requested = targets
            .Where(static target => target.NodeType is
                AuthoringCanvasNodeType.HeadingReference or AuthoringCanvasNodeType.BlockReference)
            .Select(static target => target.NodeId)
            .ToHashSet();
        if (facts.Any(pair => !requested.Contains(pair.Key)
                || pair.Value is null
                || pair.Value.NodeId != pair.Key))
        {
            throw new AuthoringCanvasValidationException("canvas_reference_coordinate_fact_set_invalid");
        }
    }

    private static void ValidateCoordinateFact(
        AuthoringCanvasReferenceTarget target,
        long resolvedRevision,
        AuthoringCanvasCoordinateFact fact)
    {
        if (fact.NodeId != target.NodeId
            || fact.TargetArticleId != target.TargetArticleId
            || fact.TargetRevision != resolvedRevision
            || fact.NodeType != target.NodeType
            || !Enum.IsDefined(fact.State))
        {
            throw new AuthoringCanvasValidationException("canvas_reference_coordinate_fact_invalid");
        }
        if (fact.ContextSnippet is not null)
        {
            var validationFact = new AuthoringCanvasReferenceFact(
                target.NodeId,
                target.TargetArticleId,
                AuthoringCanvasArticleState.Current,
                fact.State,
                resolvedRevision,
                resolvedRevision,
                false,
                null,
                fact.ContextSnippet,
                null);
            AuthoringCanvasReferenceContract.ValidateFact(target, validationFact);
        }
    }

    private static AuthoringCanvasReferenceFact Missing(AuthoringCanvasReferenceTarget target)
        => Lifecycle(target, AuthoringCanvasArticleState.Missing);

    private static AuthoringCanvasReferenceFact Lifecycle(
        AuthoringCanvasReferenceTarget target,
        AuthoringCanvasArticleState state)
        => new(
            target.NodeId,
            target.TargetArticleId,
            state,
            AuthoringCanvasReferenceCoordinateState.Current,
            0,
            0,
            false,
            null,
            null,
            null);

    private static AuthoringCanvasReferenceFact Denied(AuthoringCanvasReferenceTarget target)
        => Lifecycle(target, AuthoringCanvasArticleState.PermissionDeniedOrUnknown);
}

public sealed record AuthoringCanvasArticleReadAuthority(
    long PrincipalGeneration,
    long ContentGeneration,
    long ArticleCount,
    long RevisionCount,
    string PermissionFingerprint,
    bool Authorized);

public sealed record AuthoringCanvasArticleRevisionDisplayFact(
    long Revision,
    string? Title,
    string? ContextSnippet);

public sealed record AuthoringCanvasArticleReferenceRecord(
    int ArticleId,
    AuthoringCanvasArticleState State,
    long CurrentRevision,
    AuthoringCanvasArticleRevisionDisplayFact CurrentDisplay,
    IReadOnlyDictionary<long, AuthoringCanvasArticleRevisionDisplayFact> PinnedDisplays);

public interface IAuthoringCanvasArticleReferenceReader
{
    Task<AuthoringCanvasArticleReadAuthority> ReadAuthorityAsync(
        AuthoringCanvasOwner owner,
        AuthoringCanvasReferencePermission permission,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyDictionary<int, AuthoringCanvasArticleReferenceRecord>> ReadBatchAsync(
        AuthoringCanvasOwner owner,
        AuthoringCanvasReferencePermission permission,
        IReadOnlyList<AuthoringCanvasReferenceTarget> targets,
        CancellationToken cancellationToken = default);
}

public sealed record AuthoringCanvasCoordinateFactQuery(
    Guid CanvasId,
    long CanvasRevision,
    string CanvasContentDigest,
    AuthoringCanvasOwner Owner,
    IReadOnlyList<AuthoringCanvasReferenceTarget> Targets);

public sealed record AuthoringCanvasCoordinateFact(
    Guid NodeId,
    AuthoringCanvasNodeType NodeType,
    int TargetArticleId,
    long TargetRevision,
    AuthoringCanvasReferenceCoordinateState State,
    string? ContextSnippet);

/// <summary>
/// Production coordinate boundary. Its registered implementation delegates to at most one typed
/// external authority and returns no guessed facts when that authority is unavailable.
/// </summary>
public interface IAuthoringCanvasCoordinateFactProvider
{
    Task<IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact>> ReadBatchAsync(
        AuthoringCanvasCoordinateFactQuery query,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Optional typed ingress for the heading/block authority owned outside this boundary. Production
/// composition always resolves one provider; when the external authority is unavailable the
/// provider returns no guessed facts and the resolver projects SourceStale.
/// </summary>
public interface IAuthoringCanvasExternalCoordinateAuthority
{
    Task<IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact>> ReadBatchAsync(
        AuthoringCanvasCoordinateFactQuery query,
        CancellationToken cancellationToken = default);
}

public sealed class AuthoringCanvasCoordinateFactProvider(
    IEnumerable<IAuthoringCanvasExternalCoordinateAuthority> authorities)
    : IAuthoringCanvasCoordinateFactProvider
{
    private readonly IAuthoringCanvasExternalCoordinateAuthority? _authority = Resolve(authorities);

    public async Task<IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact>> ReadBatchAsync(
        AuthoringCanvasCoordinateFactQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        cancellationToken.ThrowIfCancellationRequested();
        if (query.Targets.Count > AuthoringCanvasReferenceContract.MaxBatchSize)
        {
            throw new AuthoringCanvasBudgetExceededException("canvas_reference_coordinate_batch_budget_exceeded");
        }
        return _authority is null
            ? new Dictionary<Guid, AuthoringCanvasCoordinateFact>()
            : await _authority.ReadBatchAsync(query, cancellationToken).ConfigureAwait(false);
    }

    private static IAuthoringCanvasExternalCoordinateAuthority? Resolve(
        IEnumerable<IAuthoringCanvasExternalCoordinateAuthority> authorities)
    {
        IAuthoringCanvasExternalCoordinateAuthority[] materialized = authorities.Take(2).ToArray();
        return materialized.Length switch
        {
            0 => null,
            1 => materialized[0],
            _ => throw new InvalidOperationException("multiple_authoring_canvas_external_coordinate_authorities")
        };
    }
}

/// <summary>
/// PostgreSQL reader for existing article and immutable revision authorities. It is restricted to
/// primary-site articles attributed to the requesting admin principal and never selects an article
/// body, rendered HTML, DOM, relation, property, workspace, or graph-layout column.
/// </summary>
public sealed class PostgresAuthoringCanvasArticleReferenceReader(ISqlSugarClient db)
    : IAuthoringCanvasArticleReferenceReader
{
    private const string PrimarySiteScope = "primary-site";

    public Task<AuthoringCanvasArticleReadAuthority> ReadAuthorityAsync(
        AuthoringCanvasOwner owner,
        AuthoringCanvasReferencePermission permission,
        CancellationToken cancellationToken = default)
        => WithCancellationAsync(
            token => ReadAuthorityCoreAsync(owner, permission, token),
            cancellationToken);

    private async Task<AuthoringCanvasArticleReadAuthority> ReadAuthorityCoreAsync(
        AuthoringCanvasOwner owner,
        AuthoringCanvasReferencePermission permission,
        CancellationToken cancellationToken)
    {
        AuthoringCanvasContract.ValidateOwner(owner);
        if (!Enum.IsDefined(permission))
        {
            throw new AuthoringCanvasValidationException("canvas_reference_permission_invalid");
        }
        cancellationToken.ThrowIfCancellationRequested();
        await using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            WITH principal AS (
                SELECT id, status, isroot, permissions,
                       xmin::text::bigint AS principal_generation
                FROM admin_principal
                WHERE id = @AdminPrincipalId
            ), accessible_articles AS (
                SELECT article.id AS article_id
                FROM article
                CROSS JOIN principal p
                WHERE @SiteScope = 'primary-site'
                  AND p.status = @ActiveStatus
                  AND (p.isroot OR @RequiredPermission = ANY(string_to_array(p.permissions, E'\n')))
                  AND (p.isroot OR EXISTS (
                      SELECT 1
                      FROM article_revision ownership
                      WHERE ownership.article_id = article.id
                        AND ownership.created_by_admin_principal_id = p.id))
            ), content_authority AS (
                SELECT GREATEST(
                           COALESCE((
                               SELECT MAX(article.xmin::text::bigint)
                               FROM article
                               JOIN accessible_articles access ON access.article_id = article.id), 1),
                           COALESCE((
                               SELECT MAX(revision.xmin::text::bigint)
                               FROM article_revision revision
                               JOIN accessible_articles access ON access.article_id = revision.article_id), 1)
                       ) AS content_generation,
                       (SELECT COUNT(*) FROM accessible_articles) AS article_count,
                       (SELECT COUNT(*)
                          FROM article_revision revision
                          JOIN accessible_articles access ON access.article_id = revision.article_id) AS revision_count
            )
            SELECT p.id, p.status, p.isroot, p.permissions,
                   p.principal_generation,
                   c.content_generation, c.article_count, c.revision_count
            FROM principal p
            CROSS JOIN content_authority c;
            """,
            new SugarParameter("@AdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@ActiveStatus", AdminPrincipalStatus.Active),
            new SugarParameter("@RequiredPermission", AdminPermissions.ArticleWrite)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return new AuthoringCanvasArticleReadAuthority(
                0,
                1,
                0,
                0,
                Fingerprint(owner, permission, 0, "missing", false, string.Empty),
                false);
        }

        long generation = reader.GetInt64(reader.GetOrdinal("principal_generation"));
        string status = reader.GetString(reader.GetOrdinal("status"));
        bool isRoot = reader.GetBoolean(reader.GetOrdinal("isroot"));
        string permissions = reader.GetString(reader.GetOrdinal("permissions"));
        bool authorized = string.Equals(status, AdminPrincipalStatus.Active, StringComparison.Ordinal)
            && string.Equals(owner.SiteScope, PrimarySiteScope, StringComparison.Ordinal)
            && (isRoot || permissions.Split(
                '\n',
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Contains(
                    AdminPermissions.ArticleWrite,
                    StringComparer.Ordinal));
        return new AuthoringCanvasArticleReadAuthority(
            generation,
            reader.GetInt64(reader.GetOrdinal("content_generation")),
            reader.GetInt64(reader.GetOrdinal("article_count")),
            reader.GetInt64(reader.GetOrdinal("revision_count")),
            Fingerprint(owner, permission, generation, status, isRoot, permissions),
            authorized);
    }

    public Task<IReadOnlyDictionary<int, AuthoringCanvasArticleReferenceRecord>> ReadBatchAsync(
        AuthoringCanvasOwner owner,
        AuthoringCanvasReferencePermission permission,
        IReadOnlyList<AuthoringCanvasReferenceTarget> targets,
        CancellationToken cancellationToken = default)
        => WithCancellationAsync(
            token => ReadBatchCoreAsync(owner, permission, targets, token),
            cancellationToken);

    private async Task<IReadOnlyDictionary<int, AuthoringCanvasArticleReferenceRecord>> ReadBatchCoreAsync(
        AuthoringCanvasOwner owner,
        AuthoringCanvasReferencePermission permission,
        IReadOnlyList<AuthoringCanvasReferenceTarget> targets,
        CancellationToken cancellationToken)
    {
        AuthoringCanvasContract.ValidateOwner(owner);
        if (!Enum.IsDefined(permission))
        {
            throw new AuthoringCanvasValidationException("canvas_reference_permission_invalid");
        }
        if (targets.Count > AuthoringCanvasReferenceContract.MaxBatchSize)
        {
            throw new AuthoringCanvasBudgetExceededException("canvas_reference_batch_budget_exceeded");
        }
        int[] articleIds = targets.Select(static target => target.TargetArticleId).Distinct().Order().ToArray();
        if (articleIds.Length == 0)
        {
            return new Dictionary<int, AuthoringCanvasArticleReferenceRecord>();
        }

        var articles = new Dictionary<int, MutableArticleFact>(articleIds.Length);
        await using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, title, summary, status, isdeleted, current_revision_id,
                   EXISTS (
                       SELECT 1
                       FROM admin_principal p
                       WHERE p.id = @AdminPrincipalId
                         AND p.status = @ActiveStatus
                         AND (p.isroot OR @RequiredPermission = ANY(string_to_array(p.permissions, E'\n')))
                         AND (p.isroot OR EXISTS (
                             SELECT 1
                             FROM article_revision ownership
                             WHERE ownership.article_id = article.id
                               AND ownership.created_by_admin_principal_id = p.id))
                   ) AS has_access
            FROM article
            WHERE id = ANY(@ArticleIds)
              AND @SiteScope = 'primary-site';
            """,
            ArrayParameter("@ArticleIds", articleIds),
            new SugarParameter("@AdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@ActiveStatus", AdminPrincipalStatus.Active),
            new SugarParameter("@RequiredPermission", AdminPermissions.ArticleWrite)).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                int articleId = reader.GetInt32(reader.GetOrdinal("id"));
                bool hasAccess = reader.GetBoolean(reader.GetOrdinal("has_access"));
                if (!hasAccess)
                {
                    articles.Add(articleId, new MutableArticleFact(
                        articleId,
                        AuthoringCanvasArticleState.PermissionDeniedOrUnknown,
                        0,
                        Display(0, null, null)));
                    continue;
                }
                bool deleted = reader.GetBoolean(reader.GetOrdinal("isdeleted"));
                var status = (ArticleStatus)reader.GetInt32(reader.GetOrdinal("status"));
                AuthoringCanvasArticleState state = deleted || status == ArticleStatus.Deleted
                    ? AuthoringCanvasArticleState.Deleted
                    : status == ArticleStatus.Archived
                        ? AuthoringCanvasArticleState.Archived
                        : AuthoringCanvasArticleState.Current;
                long currentRevision = reader.IsDBNull(reader.GetOrdinal("current_revision_id"))
                    ? 0
                    : reader.GetInt64(reader.GetOrdinal("current_revision_id"));
                articles.Add(articleId, new MutableArticleFact(
                    articleId,
                    state,
                    currentRevision,
                    Display(
                        currentRevision,
                        reader.GetString(reader.GetOrdinal("title")),
                        reader.IsDBNull(reader.GetOrdinal("summary"))
                            ? null
                            : reader.GetString(reader.GetOrdinal("summary")))));
            }
        }

        long[] pinnedRevisionIds = targets
            .Where(static target => target.PinnedTargetRevision is not null)
            .Select(static target => target.PinnedTargetRevision!.Value)
            .Distinct()
            .Order()
            .ToArray();
        if (pinnedRevisionIds.Length > 0)
        {
            await using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                SELECT id, article_id, title, summary
                FROM article_revision
                WHERE id = ANY(@RevisionIds)
                  AND @SiteScope = 'primary-site'
                  AND EXISTS (
                      SELECT 1
                      FROM admin_principal p
                      WHERE p.id = @AdminPrincipalId
                        AND p.status = @ActiveStatus
                        AND (p.isroot OR @RequiredPermission = ANY(string_to_array(p.permissions, E'\n')))
                        AND (p.isroot OR EXISTS (
                            SELECT 1
                            FROM article_revision ownership
                            WHERE ownership.article_id = article_revision.article_id
                              AND ownership.created_by_admin_principal_id = p.id)));
                """,
                ArrayParameter("@RevisionIds", pinnedRevisionIds),
                new SugarParameter("@AdminPrincipalId", owner.AdminPrincipalId),
                new SugarParameter("@SiteScope", owner.SiteScope),
                new SugarParameter("@ActiveStatus", AdminPrincipalStatus.Active),
                new SugarParameter("@RequiredPermission", AdminPermissions.ArticleWrite)).ConfigureAwait(false);
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                int articleId = reader.GetInt32(reader.GetOrdinal("article_id"));
                if (articles.TryGetValue(articleId, out MutableArticleFact? article))
                {
                    long revision = reader.GetInt64(reader.GetOrdinal("id"));
                    article.PinnedDisplays[revision] = Display(
                        revision,
                        reader.GetString(reader.GetOrdinal("title")),
                        reader.IsDBNull(reader.GetOrdinal("summary"))
                            ? null
                            : reader.GetString(reader.GetOrdinal("summary")));
                }
            }
        }

        return articles.ToDictionary(
            static pair => pair.Key,
            static pair => pair.Value.ToRecord());
    }

    private async Task<T> WithCancellationAsync<T>(
        Func<CancellationToken, Task<T>> read,
        CancellationToken cancellationToken)
    {
        CancellationToken? previous = db.Ado.CancellationToken;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(
            previous ?? CancellationToken.None,
            cancellationToken);
        linked.Token.ThrowIfCancellationRequested();
        // SqlSugar's original GetDataReaderAsync has no token parameter. Its ADO token
        // reaches the provider command; keep it installed until awaited reader cleanup ends.
        db.Ado.CancellationToken = linked.Token;
        try
        {
            T result = await read(linked.Token).ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested();
            return result;
        }
        finally
        {
            db.Ado.CancellationToken = previous;
        }
    }

    private static SugarParameter ArrayParameter(string name, Array value)
        => new(name, value)
        {
            IsArray = true
        };

    private static AuthoringCanvasArticleRevisionDisplayFact Display(
        long revision,
        string? title,
        string? summary)
        => new(
            revision,
            BoundedPlainText(title, AuthoringCanvasReferenceContract.MaxTitleLength),
            BoundedPlainText(summary, AuthoringCanvasReferenceContract.MaxContextSnippetLength));

    private static string? BoundedPlainText(string? value, int maximumLength)
    {
        if (string.IsNullOrWhiteSpace(value)
            || value.Any(static character => char.IsControl(character)
                && character is not '\n' and not '\r' and not '\t')
            || value.Contains('<', StringComparison.Ordinal)
            || value.Contains('>', StringComparison.Ordinal))
        {
            return null;
        }
        return value.Length <= maximumLength ? value : value[..maximumLength];
    }

    private static string Fingerprint(
        AuthoringCanvasOwner owner,
        AuthoringCanvasReferencePermission permission,
        long generation,
        string status,
        bool isRoot,
        string permissions)
    {
        string material = string.Join(
            '\n',
            owner.AdminPrincipalId,
            owner.SiteScope,
            permission,
            generation,
            status,
            isRoot,
            permissions);
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(material)));
    }

    private sealed class MutableArticleFact(
        int articleId,
        AuthoringCanvasArticleState state,
        long currentRevision,
        AuthoringCanvasArticleRevisionDisplayFact currentDisplay)
    {
        public Dictionary<long, AuthoringCanvasArticleRevisionDisplayFact> PinnedDisplays { get; } = [];

        public AuthoringCanvasArticleReferenceRecord ToRecord()
            => new(articleId, state, currentRevision, currentDisplay, PinnedDisplays);
    }
}
