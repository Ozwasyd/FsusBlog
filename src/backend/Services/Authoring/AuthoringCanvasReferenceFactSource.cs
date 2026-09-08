using System.Data.Common;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Production adapter for canvas reference facts. Article metadata is read in bounded SQL batches;
/// optional heading/block coordinates stay behind their typed source authority.
/// </summary>
public sealed class AuthoringCanvasReferenceFactSource(
    IAuthoringCanvasArticleReferenceReader articles,
    IEnumerable<IAuthoringCanvasCoordinateFactProvider> coordinateProviders) : IAuthoringCanvasReferenceFactSource
{
    private readonly IAuthoringCanvasCoordinateFactProvider? _coordinateProvider =
        ResolveCoordinateProvider(coordinateProviders);

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
            await articles.ReadBatchAsync(query.Targets, cancellationToken).ConfigureAwait(false);
        ValidateArticleFactSet(query.Targets, articleFacts);
        IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact> coordinateFacts =
            _coordinateProvider is null
                ? new Dictionary<Guid, AuthoringCanvasCoordinateFact>()
                : await _coordinateProvider.ReadBatchAsync(
                    new AuthoringCanvasCoordinateFactQuery(
                        query.CanvasId,
                        query.CanvasRevision,
                        query.CanvasContentDigest,
                        query.Owner,
                        query.Targets.Where(static target => target.NodeType is
                            AuthoringCanvasNodeType.HeadingReference or AuthoringCanvasNodeType.BlockReference).ToArray()),
                    cancellationToken).ConfigureAwait(false);

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
                    AuthoringCanvasReferenceCoordinateState.Missing,
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

    private static IAuthoringCanvasCoordinateFactProvider? ResolveCoordinateProvider(
        IEnumerable<IAuthoringCanvasCoordinateFactProvider> providers)
    {
        IAuthoringCanvasCoordinateFactProvider[] materialized = providers.Take(2).ToArray();
        return materialized.Length switch
        {
            0 => null,
            1 => materialized[0],
            _ => throw new InvalidOperationException("multiple_authoring_canvas_coordinate_fact_providers")
        };
    }

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
/// Optional typed authority supplied by #1808/#1868. Absence is a stable SourceStale projection,
/// never a startup failure or guessed coordinate.
/// </summary>
public interface IAuthoringCanvasCoordinateFactProvider
{
    Task<IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact>> ReadBatchAsync(
        AuthoringCanvasCoordinateFactQuery query,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// PostgreSQL reader for existing article and immutable revision authorities. It never selects an
/// article body, rendered HTML, DOM, relation, property, workspace, or graph-layout column.
/// </summary>
public sealed class PostgresAuthoringCanvasArticleReferenceReader(ISqlSugarClient db)
    : IAuthoringCanvasArticleReferenceReader
{
    public async Task<AuthoringCanvasArticleReadAuthority> ReadAuthorityAsync(
        AuthoringCanvasOwner owner,
        AuthoringCanvasReferencePermission permission,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            WITH content_authority AS (
                SELECT GREATEST(
                           COALESCE((SELECT MAX(xmin::text::bigint) FROM article), 1),
                           COALESCE((SELECT MAX(xmin::text::bigint) FROM article_revision), 1)
                       ) AS content_generation,
                       (SELECT COUNT(*) FROM article) AS article_count,
                       (SELECT COUNT(*) FROM article_revision) AS revision_count
            )
            SELECT p.id, p.status, p.isroot, p.permissions,
                   p.xmin::text::bigint AS principal_generation,
                   c.content_generation, c.article_count, c.revision_count
            FROM admin_principal p
            CROSS JOIN content_authority c
            WHERE p.id = @AdminPrincipalId;
            """,
            new SugarParameter("@AdminPrincipalId", owner.AdminPrincipalId)).ConfigureAwait(false);
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

    public async Task<IReadOnlyDictionary<int, AuthoringCanvasArticleReferenceRecord>> ReadBatchAsync(
        IReadOnlyList<AuthoringCanvasReferenceTarget> targets,
        CancellationToken cancellationToken = default)
    {
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
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, title, summary, status, isdeleted, current_revision_id
            FROM article
            WHERE id = ANY(@ArticleIds);
            """,
            ArrayParameter("@ArticleIds", articleIds)).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                int articleId = reader.GetInt32(reader.GetOrdinal("id"));
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
            using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                SELECT id, article_id, title, summary
                FROM article_revision
                WHERE id = ANY(@RevisionIds);
                """,
                ArrayParameter("@RevisionIds", pinnedRevisionIds)).ConfigureAwait(false);
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
