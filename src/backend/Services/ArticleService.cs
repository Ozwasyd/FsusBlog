using System.Data;
using System.Data.Common;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Core.Integrity;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Background;

using Npgsql;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Services;

/// <summary>
/// Coordinates article persistence, cache invalidation, search indexing, and public artifact projection.
/// Search-index writes remain awaited across release transitions, and cache eviction owns per-key lock disposal.
/// </summary>
// Public named-argument source compatibility; exact exception registered in csharp-style-policy.
#pragma warning disable IDE1006
public partial class ArticleService(
    ISqlSugarClient _db,
    ISearchIndexService _searchIndex,
    IRedisOperationExecutor _redisOperations,
    ICacheTypedReader _cacheReader,
    ICacheRawWriter _cacheWriter,
    ICacheStringReader _stringReader,
    ICacheStringWriter _stringWriter,
    ICacheMissCoordinator _cacheMissCoordinator,
    IDbConcurrencyGate _dbConcurrencyGate,
    IRuntimeKeyScope _runtimeKeyScope,
    IHttpContextAccessor _httpContextAccessor,
    ILogger<ArticleService> _logger,
    IPublicAotInvalidationService _publicAotInvalidationService,
    ICacheInvalidationDispatcher _cacheInvalidationDispatcher,
    IArticlePublicMutationFence _mutationFence,
    IArticleMutationSideEffectCoordinator _mutationSideEffects,
    IArticleViewWriteBuffer _viewWriteBuffer,
    IArticlePublicationValidator _publicationValidator,
    ArticleBodyRepairQueue _articleBodyRepairQueue,
    TimeProvider? _timeProvider = null,
    IAuditLogStore? _vaultAuditLogStore = null,
    IArticleVaultExecutionStore? _vaultExecutionStore = null,
    IArticleVaultTransactionalGroupResultStore? _vaultGroupResultStore = null,
    IArticleDetailViewProjection? _articleDetailViewProjection = null,
    IArticleListCursorCodec? _articleListCursorCodec = null,
    IArticleViewProjectionObligationCoordinator? _articleViewProjectionObligations = null) : IArticleCoreGateway, IArticleMutationCommandService
#pragma warning restore IDE1006
{
    private readonly record struct TrashArticleRow(int Id, int CategoryId, string? CoverImageUrl);
    private readonly record struct ArticleRevisionCoordinates(long Id, int RevisionNo, long ContentBlockId);
    private readonly record struct ArticleUpdateExecution(
        ArticleVersionCoordinates Version,
        ArticleMutationOutcome Outcome);
    private readonly record struct ArticleMutationIdentity(
        long AdminPrincipalId,
        string ClientMutationId,
        string RequestHash);
    private sealed record ArticleRightsWriteModel(
        bool Enabled,
        string LicenseType,
        string? CopyrightHolder,
        int? CopyrightYear,
        string? RightsStatement,
        string? AttributionTemplate,
        string CopyPolicy,
        int MaxExcerptChars,
        bool AllowCodeCopy,
        bool ShowPublicBadge,
        bool ProofBindingEnabled);

    private const int MaxPageSize = 100;
    private const string ArticleListCursorWhereClause = " AND (a.createtime < @CursorTime OR (a.createtime = @CursorTime AND a.id < @CursorId))";
    private const string ArticleListTotalCountColumn = "__TotalCount";
    private const int MaxSearchKeywordLength = 128;
    private const int MinCacheableSearchKeywordLength = 2;
    private const int MaxCacheableSearchKeywordLength = 64;
    private const int MaxHotArticlesCount = 100;
    private const int MaxTitleLength = 256;
    private const int MaxSummaryLength = 512;
    private const int MaxContentLength = 200_000;
    private const int MaxTagIds = 32;
    private const int MaxArticleRevisionInsertAttempts = 3;
    private CancellationToken Ct => _httpContextAccessor.HttpContext?.RequestAborted ?? CancellationToken.None;
    private DateTime UtcNow => (_timeProvider ?? TimeProvider.System).GetUtcNow().UtcDateTime;

    private CancellationToken ResolveCancellationToken(CancellationToken cancellationToken)
        => cancellationToken.CanBeCanceled ? cancellationToken : Ct;

    private async Task RecoverAbortedPublicMutationFenceAsync(int? articleId, string reason)
    {
        try
        {
            await _mutationFence
                .RecoverAbortedPublicMutationFenceAsync(articleId, reason, CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                ex,
                "Failed to queue rebuild for aborted public mutation fence {ArticleId} {Reason}",
                articleId,
                reason);
        }
    }

    public async ValueTask IncreaseViewCountAsync(int id)
        => await IncreaseViewCountAsync(id, 1);

    public async ValueTask IncreaseViewCountAsync(int id, int count)
    {
        if (id <= 0 || count <= 0)
        {
            return;
        }

        await _viewWriteBuffer.EnqueueAsync(id, count, Ct);
    }

    public async ValueTask<IReadOnlySet<int>> IncreaseViewCountsAsync(
        IReadOnlyDictionary<int, int> articleCounts,
        CancellationToken cancellationToken = default)
    {
        if (articleCounts.Count == 0)
        {
            return new HashSet<int>();
        }

        var normalized = articleCounts
            .Where(static pair => pair.Key > 0 && pair.Value > 0)
            .GroupBy(static pair => pair.Key)
            .Select(static group => new KeyValuePair<int, int>(group.Key, group.Sum(static pair => pair.Value)))
            .ToArray();
        if (normalized.Length == 0)
        {
            return new HashSet<int>();
        }

        var sql = new System.Text.StringBuilder(
            "UPDATE article AS a SET views = a.views + v.delta FROM (VALUES ");
        var parameters = new List<SugarParameter>(normalized.Length * 2);
        for (int i = 0; i < normalized.Length; i++)
        {
            if (i > 0)
            {
                sql.Append(',');
            }

            sql.Append($"(@id_{i}, @delta_{i})");
            parameters.Add(new SugarParameter($"@id_{i}", normalized[i].Key));
            parameters.Add(new SugarParameter($"@delta_{i}", normalized[i].Value));
        }

        sql.Append(
            ") AS v(id, delta) WHERE a.id = v.id AND a.isdeleted = false RETURNING a.id, a.views;");

        IArticleViewProjectionObligationCoordinator obligations = _articleViewProjectionObligations
            ?? throw new InvalidOperationException("article_view_projection_obligation_coordinator_required");
        var updatedIds = new HashSet<int>();
        var updatedViews = new Dictionary<int, int>();
        DistributedInvalidationEvent? preparedProjection = null;
        var transaction = await _db.Ado.UseTranAsync(async () =>
        {
            using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sql.ToString(), parameters))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    int articleId = reader.ReadInt32("id");
                    int currentViews = reader.ReadInt32("views");
                    updatedIds.Add(articleId);
                    updatedViews[articleId] = currentViews;
                }
            }

            preparedProjection = await obligations
                .PrepareAsync(updatedViews, cancellationToken)
                .ConfigureAwait(false);
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            throw transaction.ErrorException
                ?? new InvalidOperationException("article_view_projection_transaction_failed");
        }

        foreach ((int articleId, int currentViews) in updatedViews)
        {
            _articleDetailViewProjection?.ApplyAuthoritative(articleId, currentViews, currentViews);
        }

        try
        {
            string hotRankKey = RedisKey("blog:top_articles");
            await _redisOperations.ExecuteAsync(
                RedisOperationPort.ArticleServiceOptionalProjection,
                async (multiplexer, _) =>
                {
                    IBatch redisBatch = multiplexer.GetDatabase().CreateBatch();
                    var redisTasks = new List<Task>(normalized.Length * 2);
                    foreach ((int articleId, int count) in normalized)
                    {
                        if (updatedIds.Contains(articleId))
                        {
                            int currentViews = updatedViews[articleId];
                            redisTasks.Add(redisBatch.SortedSetAddAsync(hotRankKey, articleId, currentViews));
                        }
                        else
                        {
                            redisTasks.Add(redisBatch.SortedSetRemoveAsync(hotRankKey, articleId));
                        }
                    }

                    redisBatch.Execute();
                    await Task.WhenAll(redisTasks).ConfigureAwait(false);
                },
                CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                ex,
                "article-view-hot-rank-update-degraded-after-persist {ArticleCount}",
                updatedViews.Count);
        }

        try
        {
            await obligations
                .PublishPreparedAsync(preparedProjection, CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                ex,
                "article-view-projection-publish-degraded-durable-replay-pending {ArticleCount}",
                updatedViews.Count);
        }

        return updatedIds;
    }

    public async Task<ArticleListPageReadModel> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string? keyword = null, CancellationToken cancellationToken = default)
    {
        CancellationToken effectiveCt = ResolveCancellationToken(cancellationToken);
        effectiveCt.ThrowIfCancellationRequested();
        if (page < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(page), page, "Article list page must be greater than zero.");
        }

        if (size < 1 || size > MaxPageSize)
        {
            throw new ArgumentOutOfRangeException(nameof(size), size, $"Article list size must be between 1 and {MaxPageSize}.");
        }

        if (ShouldUsePublicKeysetPagination(isDeleted, status, includePrivate))
        {
            throw new InvalidOperationException("Public article lists must use the cursor-aware core query.");
        }

        string normalizedKeyword = NormalizeArticleListKeyword(keyword);
        long version = await GetListCacheVersionAsync(effectiveCt);
        string cacheIdentity = BuildAdminArticleListIdentity(version, page, size, categoryId, tagId, isDeleted, status, includePrivate, normalizedKeyword);

        return await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.ArticleList,
                cacheIdentity,
                ct => _cacheReader.TryGetAsync(CachePolicyId.ArticleList, cacheIdentity, ServerCacheBinaryCodec.DecodeArticleListPage, ct),
                async ct => await _dbConcurrencyGate.ExecuteAsync(
                    "article-list",
                    async gateCt =>
                    {
                        ArticleListPageReadModel result = await LoadArticleListPageFromDbAsync(version, page, size, categoryId, tagId, isDeleted, status, includePrivate, normalizedKeyword, cursor: null, ArticleListSortMode.Latest, gateCt);
                        gateCt.ThrowIfCancellationRequested();
                        int totalPages = Math.Max(1, (int)Math.Ceiling(result.Total / (double)size));
                        if (page <= totalPages)
                        {
                            byte[] encoded = ServerCacheBinaryCodec.EncodeArticleListPage(result);
                            gateCt.ThrowIfCancellationRequested();
                            await _cacheWriter.SetRawAsync(CachePolicyId.ArticleList, cacheIdentity, encoded, null, gateCt);
                        }
                        return result;
                    },
                    async gateCt =>
                    {
                        CacheReadResult<ArticleListPageReadModel> retry = await _cacheReader.TryGetAsync(CachePolicyId.ArticleList, cacheIdentity, ServerCacheBinaryCodec.DecodeArticleListPage, gateCt);
                        if (retry.Hit)
                        {
                            return retry.Value ?? new ArticleListPageReadModel { Items = [], Total = 0 };
                        }

                        throw new TimeoutException($"db-gate-timeout:article-list:{cacheIdentity}");
                    },
                    ct),
                "article-list",
                effectiveCt)
            .ConfigureAwait(false)
            ?? new ArticleListPageReadModel { Items = [], Total = 0 };
    }

    public async Task<ArticleDetailReadModel?> GetByIdAsync(int id, bool includePrivate = false, CancellationToken cancellationToken = default)
    {
        CancellationToken effectiveCt = ResolveCancellationToken(cancellationToken);
        effectiveCt.ThrowIfCancellationRequested();
        if (includePrivate)
        {
            return await LoadArticleDetailFromDbAsync(id, includePrivate: true, cacheIdentity: null, effectiveCt);
        }

        return await _cacheMissCoordinator.CoordinateAsync(
            CachePolicyId.ArticleDetail,
            id,
            gateCt => TryReadArticleDetailCacheAsync(id, gateCt),
            async gateCt => await _dbConcurrencyGate.ExecuteAsync(
                "article-detail",
                innerCt => LoadArticleDetailFromDbAsync(id, includePrivate: false, cacheIdentity: id, innerCt),
                async innerCt =>
                {
                    CacheReadResult<ArticleDetailReadModel> retry = await TryReadArticleDetailCacheAsync(id, innerCt);
                    if (retry.Hit)
                    {
                        return retry.Value;
                    }

                    throw new TimeoutException($"db-gate-timeout:article-detail:{id}");
                },
                gateCt),
            "article-detail",
            effectiveCt);
    }

    private async Task<CacheReadResult<ArticleDetailReadModel>> TryReadArticleDetailCacheAsync(
        int id,
        CancellationToken cancellationToken)
    {
        var detailCache = await _cacheReader.TryGetAsync(CachePolicyId.ArticleDetail, id, ServerCacheBinaryCodec.DecodeArticleDetail, cancellationToken);
        if (!detailCache.Hit)
        {
            return new CacheReadResult<ArticleDetailReadModel>(false, default);
        }

        ArticleDetailReadModel? cached = detailCache.Value;
        if (cached is null)
        {
            return new CacheReadResult<ArticleDetailReadModel>(true, default);
        }

        return new CacheReadResult<ArticleDetailReadModel>(true, ProjectArticleViews(cached));
    }

    private ArticleDetailReadModel ProjectArticleViews(ArticleDetailReadModel article)
    {
        int projectedViews = _articleDetailViewProjection?.Project(article.Id, article.Views) ?? article.Views;
        if (projectedViews == article.Views)
        {
            return article;
        }

        return article with
        {
            Views = projectedViews
        };
    }

    private async Task<ArticleDetailReadModel?> LoadArticleDetailFromDbAsync(
        int id,
        bool includePrivate,
        int? cacheIdentity,
        CancellationToken cancellationToken)
    {
        DateTime utcNow = DateTime.UtcNow;
        string visibilitySql = string.Empty;
        var parameters = new List<SugarParameter>
        {
            new("@Id", id),
            new("@Now", utcNow),
            new("@IncludePrivate", includePrivate)
        };
        if (!includePrivate)
        {
            visibilitySql = """
                  AND a.isdeleted = false
                  AND a.status = @PublishedStatus
                  AND a.current_publication_id IS NOT NULL
                  AND (a.published_at IS NULL OR a.published_at <= @Now)
                  AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)
                """;
            parameters.Add(new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published));
        }

        ArticleDetailReadModel? article = null;
        cancellationToken.ThrowIfCancellationRequested();
        string sql = $$"""
            SELECT
                a.id AS "Id",
                CASE WHEN @IncludePrivate THEN a.title ELSE published_revision.title END AS "Title",
                CASE WHEN @IncludePrivate THEN a.summary ELSE published_revision.summary END AS "Summary",
                CASE WHEN @IncludePrivate THEN a.coverimageurl ELSE published_revision.cover_image_url END AS "CoverImageUrl",
                CASE WHEN @IncludePrivate THEN a.categoryid ELSE published_revision.categoryid END AS "CategoryId",
                a.views AS "Views",
                a.createtime AS "CreateTime",
                a.isdeleted AS "IsDeleted",
                a.status AS "Status",
                a.scheduled_publish_at AS "ScheduledPublishAt",
                a.published_at AS "PublishedAt",
                CASE
                    WHEN @IncludePrivate THEN GREATEST(
                        current_revision.created_at,
                        a.metadata_updated_at,
                        ab.updated_at,
                        a.public_updated_at)
                    ELSE a.public_updated_at
                END AS "UpdatedAt",
                CASE
                    WHEN @IncludePrivate THEN current_block.id IS NOT NULL OR ab.article_id IS NOT NULL
                    ELSE published_block.id IS NOT NULL
                        AND btrim(published_block.markdown_content) <> ''
                END AS "BodyAvailable",
                CASE WHEN @IncludePrivate THEN current_revision.id ELSE published_revision.id END AS "CurrentRevisionId",
                CASE WHEN @IncludePrivate THEN current_revision.revision_no ELSE published_revision.revision_no END AS "RevisionNo",
                CASE WHEN @IncludePrivate THEN current_block.id ELSE published_block.id END AS "ContentBlockId",
                publication.id AS "CurrentPublicationId",
                publication.publication_no AS "PublicationNo",
                c.name AS "CategoryName",
                CASE
                    WHEN @IncludePrivate THEN COALESCE(current_block.markdown_content, ab.markdown_content, current_revision.markdown_content, '')
                    ELSE published_block.markdown_content
                END AS "Content",
                rights.id AS "RightsSnapshotId",
                rights.article_revision_id AS "RightsArticleRevisionId",
                rights.revision_no AS "RightsRevisionNo",
                rights.enabled AS "RightsEnabled",
                rights.license_type AS "RightsLicenseType",
                rights.copyright_holder AS "RightsCopyrightHolder",
                rights.copyright_year AS "RightsCopyrightYear",
                rights.rights_statement AS "RightsStatement",
                rights.attribution_template AS "RightsAttributionTemplate",
                rights.copy_policy AS "RightsCopyPolicy",
                rights.max_excerpt_chars AS "RightsMaxExcerptChars",
                rights.allow_code_copy AS "RightsAllowCodeCopy",
                rights.show_public_badge AS "RightsShowPublicBadge",
                rights.proof_binding_enabled AS "RightsProofBindingEnabled",
                rights.canonical_url AS "RightsCanonicalUrl",
                rights.policy_hash AS "RightsPolicyHash",
                rights.content_canonical_hash AS "RightsContentCanonicalHash",
                CASE
                    WHEN rights_proof.id IS NULL THEN NULL
                    ELSE concat('urn:fsus:rights-proof:', rights_proof.id::text)
                END AS "RightsProofUrl",
                rights_proof.proof_status AS "RightsProofStatus",
                COALESCE(
                    array_agg(t.id ORDER BY t.id)
                        FILTER (WHERE t.id IS NOT NULL),
                    ARRAY[]::integer[]
                ) AS "TagIds",
                COALESCE(
                    array_agg(t.name ORDER BY t.id)
                        FILTER (WHERE t.id IS NOT NULL),
                    ARRAY[]::text[]
                ) AS "TagNames"
            FROM article a
            LEFT JOIN article_publication publication ON publication.id = a.current_publication_id
            LEFT JOIN article_revision published_revision ON published_revision.id = publication.article_revision_id
            LEFT JOIN article_revision_content_block published_block ON published_block.id = published_revision.content_block_id
            LEFT JOIN article_revision current_revision ON current_revision.id = a.current_revision_id
            LEFT JOIN article_revision_content_block current_block ON current_block.id = current_revision.content_block_id
            LEFT JOIN category c ON c.id = CASE WHEN @IncludePrivate THEN a.categoryid ELSE published_revision.categoryid END
            LEFT JOIN article_body ab ON ab.article_id = a.id
            LEFT JOIN LATERAL (
                SELECT snapshot.*
                FROM article_rights_snapshot snapshot
                WHERE (@IncludePrivate AND snapshot.article_revision_id = a.current_revision_id)
                   OR (NOT @IncludePrivate AND snapshot.id = publication.rights_snapshot_id)
                ORDER BY snapshot.revision_no DESC, snapshot.created_at DESC, snapshot.id DESC
                LIMIT 1
            ) rights ON TRUE
            LEFT JOIN LATERAL (
                SELECT proof.*
                FROM article_rights_proof proof
                WHERE proof.article_rights_snapshot_id = rights.id
                ORDER BY proof.created_at DESC, proof.id DESC
                LIMIT 1
            ) rights_proof ON TRUE
            LEFT JOIN LATERAL (
                SELECT unnest(
                    CASE WHEN @IncludePrivate THEN
                        ARRAY(SELECT link.tagid FROM article_tag link WHERE link.articleid = a.id ORDER BY link.tagid)
                    ELSE
                        COALESCE(string_to_array(NULLIF(published_revision.tag_ids, ''), ',')::integer[], ARRAY[]::integer[])
                    END
                ) AS tag_id
            ) selected_tag ON TRUE
            LEFT JOIN tag t ON t.id = selected_tag.tag_id
            WHERE a.id = @Id
            {{visibilitySql}}
            GROUP BY
                a.id,
                a.title,
                a.summary,
                a.coverimageurl,
                a.categoryid,
                a.views,
                a.createtime,
                a.isdeleted,
                a.status,
                a.scheduled_publish_at,
                a.published_at,
                a.metadata_updated_at,
                a.public_updated_at,
                publication.id,
                publication.publication_no,
                publication.published_at,
                published_revision.id,
                published_revision.revision_no,
                published_revision.title,
                published_revision.summary,
                published_revision.cover_image_url,
                published_revision.categoryid,
                published_revision.markdown_content,
                published_revision.created_at,
                published_block.id,
                published_block.markdown_content,
                current_revision.id,
                current_revision.revision_no,
                current_revision.markdown_content,
                current_block.id,
                current_block.markdown_content,
                ab.updated_at,
                c.name,
                rights.id,
                rights.article_revision_id,
                rights.revision_no,
                rights.enabled,
                rights.license_type,
                rights.copyright_holder,
                rights.copyright_year,
                rights.rights_statement,
                rights.attribution_template,
                rights.copy_policy,
                rights.max_excerpt_chars,
                rights.allow_code_copy,
                rights.show_public_badge,
                rights.proof_binding_enabled,
                rights.canonical_url,
                rights.policy_hash,
                rights.content_canonical_hash,
                rights_proof.id,
                rights_proof.proof_status,
                ab.article_id,
                ab.markdown_content;
            """;
        bool incompletePublicBody = false;
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sql, parameters))
        {
            if (await reader.ReadAsync(cancellationToken))
            {
                int fId = reader.GetOrdinal("Id"), fTitle = reader.GetOrdinal("Title"),
                    fSum = reader.GetOrdinal("Summary"), fCover = reader.GetOrdinal("CoverImageUrl"),
                    fCatId = reader.GetOrdinal("CategoryId"), fViews = reader.GetOrdinal("Views"),
                    fTime = reader.GetOrdinal("CreateTime"), fIsDel = reader.GetOrdinal("IsDeleted"), fStatus = reader.GetOrdinal("Status"),
                    fScheduled = reader.GetOrdinal("ScheduledPublishAt"), fPublished = reader.GetOrdinal("PublishedAt"), fUpdated = reader.GetOrdinal("UpdatedAt"), fCatName = reader.GetOrdinal("CategoryName"),
                    fContent = reader.GetOrdinal("Content"), fBodyAvailable = reader.GetOrdinal("BodyAvailable"), fTagIds = reader.GetOrdinal("TagIds"), fTagNames = reader.GetOrdinal("TagNames");
                string content = reader.IsDBNull(fContent) ? string.Empty : reader.GetString(fContent);
                string? summary = reader.IsDBNull(fSum) ? string.Empty : reader.GetString(fSum);
                bool bodyAvailable = !reader.IsDBNull(fBodyAvailable) && reader.GetBoolean(fBodyAvailable);

                ReadingEstimate reading = ReadingEstimator.Estimate(content);

                article = new ArticleDetailReadModel
                {
                    Id = reader.GetInt32(fId),
                    Title = reader.GetString(fTitle),
                    Summary = summary,
                    CoverImageUrl = reader.IsDBNull(fCover) ? null : reader.GetString(fCover),
                    CategoryId = reader.GetInt32(fCatId),
                    Views = reader.GetInt32(fViews),
                    CreateTime = NormalizeArticleListTimestampUtc(reader.GetDateTime(fTime)),
                    IsDeleted = reader.GetBoolean(fIsDel),
                    Status = (ArticleStatus)reader.GetInt32(fStatus),
                    ScheduledPublishAt = reader.IsDBNull(fScheduled) ? null : NormalizeArticleListTimestampUtc(reader.GetDateTime(fScheduled)),
                    PublishedAt = reader.IsDBNull(fPublished) ? null : NormalizeArticleListTimestampUtc(reader.GetDateTime(fPublished)),
                    UpdatedAt = reader.IsDBNull(fUpdated) ? null : NormalizeArticleListTimestampUtc(reader.GetDateTime(fUpdated)),
                    CurrentRevisionId = reader.GetInt64(reader.GetOrdinal("CurrentRevisionId")),
                    RevisionNo = reader.GetInt32(reader.GetOrdinal("RevisionNo")),
                    ContentBlockId = reader.IsDBNull(reader.GetOrdinal("ContentBlockId")) ? 0 : reader.GetInt64(reader.GetOrdinal("ContentBlockId")),
                    CurrentPublicationId = reader.IsDBNull(reader.GetOrdinal("CurrentPublicationId")) ? null : reader.GetInt64(reader.GetOrdinal("CurrentPublicationId")),
                    PublicationNo = reader.IsDBNull(reader.GetOrdinal("PublicationNo")) ? null : reader.GetInt32(reader.GetOrdinal("PublicationNo")),
                    CategoryName = reader.IsDBNull(fCatName) ? "默认分类" : reader.GetString(fCatName),
                    Content = content,
                    WordCount = reading.EffectiveChars,
                    EstimatedReadingMinutes = reading.Minutes,
                    ShowReadingNotice = reading.ShowLongReadNotice,
                    Tags = ReadArticleDetailTags(reader, fTagIds, fTagNames),
                    Rights = ReadArticleRights(reader)
                };
                if (article.Status == ArticleStatus.Published && !bodyAvailable)
                {
                    MarkArticleBodyMissing(article.Id, "article-detail-db");
                    if (!includePrivate)
                    {
                        incompletePublicBody = true;
                        article = null;
                    }
                }
            }
        }

        if (article != null)
        {
            _articleDetailViewProjection?.ApplyAuthoritative(article.Id, article.Views, article.Views);
            if (!includePrivate && cacheIdentity is not null)
            {
                cancellationToken.ThrowIfCancellationRequested();
                byte[] encoded = ServerCacheBinaryCodec.EncodeArticleDetail(article);
                cancellationToken.ThrowIfCancellationRequested();
                await _cacheWriter.SetRawAsync(CachePolicyId.ArticleDetail, cacheIdentity.Value, encoded, null, cancellationToken);
            }
        }
        else if (!includePrivate && cacheIdentity is not null && !incompletePublicBody)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await _cacheWriter.SetRawAsync(CachePolicyId.ArticleDetail, cacheIdentity.Value, Array.Empty<byte>(), TimeSpan.FromMinutes(5), cancellationToken);
        }

        return article is null ? null : ProjectArticleViews(article);
    }

    private static IReadOnlyList<TagReadModel> ReadArticleDetailTags(DbDataReader reader, int tagIdsOrdinal, int tagNamesOrdinal)
    {
        if (reader.IsDBNull(tagIdsOrdinal) || reader.IsDBNull(tagNamesOrdinal))
        {
            return ArticleReadModelCollections.EmptyTags;
        }

        int[] tagIds = reader.GetFieldValue<int[]>(tagIdsOrdinal);
        string[] tagNames = reader.GetFieldValue<string[]>(tagNamesOrdinal);
        int count = Math.Min(tagIds.Length, tagNames.Length);
        if (count == 0)
        {
            return ArticleReadModelCollections.EmptyTags;
        }

        var tags = new List<TagReadModel>(count);
        for (int i = 0; i < count; i++)
        {
            tags.Add(new TagReadModel { Id = tagIds[i], Name = tagNames[i] });
        }

        return tags;
    }

    private static ArticleRightsReadModel ReadArticleRights(DbDataReader reader)
    {
        int snapshotId = reader.GetOrdinal("RightsSnapshotId");
        if (reader.IsDBNull(snapshotId))
        {
            return new ArticleRightsReadModel();
        }

        return new ArticleRightsReadModel
        {
            SnapshotId = reader.GetInt64(snapshotId),
            ArticleRevisionId = reader.GetInt64(reader.GetOrdinal("RightsArticleRevisionId")),
            RevisionNo = reader.GetInt32(reader.GetOrdinal("RightsRevisionNo")),
            Enabled = reader.GetBoolean(reader.GetOrdinal("RightsEnabled")),
            LicenseType = ReadStringOrDefault(reader, "RightsLicenseType", "all-rights-reserved"),
            CopyrightHolder = ReadNullableString(reader, "RightsCopyrightHolder"),
            CopyrightYear = ReadNullableInt32(reader, "RightsCopyrightYear"),
            RightsStatement = ReadNullableString(reader, "RightsStatement"),
            AttributionTemplate = ReadNullableString(reader, "RightsAttributionTemplate"),
            CopyPolicy = ReadStringOrDefault(reader, "RightsCopyPolicy", "append-attribution"),
            MaxExcerptChars = reader.GetInt32(reader.GetOrdinal("RightsMaxExcerptChars")),
            AllowCodeCopy = reader.GetBoolean(reader.GetOrdinal("RightsAllowCodeCopy")),
            ShowPublicBadge = reader.GetBoolean(reader.GetOrdinal("RightsShowPublicBadge")),
            ProofBindingEnabled = reader.GetBoolean(reader.GetOrdinal("RightsProofBindingEnabled")),
            CanonicalUrl = ReadNullableString(reader, "RightsCanonicalUrl"),
            PolicyHash = ReadStringOrDefault(reader, "RightsPolicyHash", string.Empty),
            ContentCanonicalHash = ReadStringOrDefault(reader, "RightsContentCanonicalHash", string.Empty),
            ProofUrl = ReadNullableString(reader, "RightsProofUrl"),
            ProofStatus = ReadNullableString(reader, "RightsProofStatus")
        };
    }

    private static string ReadStringOrDefault(DbDataReader reader, string fieldName, string defaultValue)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? defaultValue : reader.GetString(ordinal);
    }

    private static string? ReadNullableString(DbDataReader reader, string fieldName)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private static int? ReadNullableInt32(DbDataReader reader, string fieldName)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? null : reader.GetInt32(ordinal);
    }

    private void MarkArticleBodyMissing(int articleId, string source)
    {
        _articleBodyRepairQueue.TrySchedule(articleId, source);
        _logger.LogWarning("article_body_missing {ArticleId} {Source}", articleId, source);
        FsusObservability.RecordOperation("article_body", "read", "missing", TimeSpan.Zero);
    }

    public async Task<int> CreateAsync(ArticleWriteRequestCoreModel dto, CancellationToken cancellationToken = default)
        => (await CreateMutationAsync(dto, identity: null, cancellationToken).ConfigureAwait(false)).ArticleId;

    private async Task<ArticleMutationResult> CreateMutationAsync(
        ArticleWriteRequestCoreModel dto,
        ArticleMutationIdentity? identity,
        CancellationToken cancellationToken = default)
    {
        CancellationToken ct = ResolveCancellationToken(cancellationToken);
        ct.ThrowIfCancellationRequested();
        if (identity.HasValue)
        {
            ArticleMutationCommand? existing = await LoadArticleMutationCommandAsync(identity.Value, ct).ConfigureAwait(false);
            if (existing is not null)
            {
                return ReplayArticleMutation(existing, identity.Value.RequestHash);
            }
        }
        var title = NormalizeText(dto.Title, MaxTitleLength);
        var content = NormalizeText(dto.Content, MaxContentLength);
        var summary = NormalizeText(dto.Summary, MaxSummaryLength);
        var coverImageUrl = NormalizeText(dto.CoverImageUrl, 512);
        var tagIds = NormalizeTagIds(dto.TagIds);
        ArticleSummaryProjectionResult summaryProjection = ArticleSummaryProjection.Resolve(summary, content);
        string safeSummary = summaryProjection.Text;
        ArticleRightsWriteModel rights = ResolveCreateArticleRights(dto);
        DateTime now = UtcNow;
        ArticleStatus status = (ArticleStatus)dto.Status;
        ValidateWriteTarget(status, dto.ScheduledPublishAt, now);
        var article = new Article
        {
            Title = title,
            Summary = safeSummary,
            CoverImageUrl = coverImageUrl,
            CategoryId = dto.CategoryId,
            CreateTime = now,
            MetadataUpdatedAt = now,
            Status = status,
            ScheduledPublishAt = status == ArticleStatus.Scheduled ? dto.ScheduledPublishAt : null,
            PublishedAt = status == ArticleStatus.Published ? now : null,
            LastPublishedAt = status == ArticleStatus.Published ? now : null,
            PublicUpdatedAt = status == ArticleStatus.Published ? now : null,
            ArchivedAt = status == ArticleStatus.Archived ? now : null,
            IsDeleted = false,
            Content = content
        };

        bool requiresPublicFence = ArticlePublication.IsPubliclyVisible(article, now);
        bool fenceEstablished = false;
        bool mutationCommitted = false;
        try
        {
            if (requiresPublicFence)
            {
                fenceEstablished = await EstablishArticlePublicMutationFenceAsync(null, ct).ConfigureAwait(false);
            }

            ArticleMutationTransactionResult<ArticleMutationResult> result = await ExecuteArticleMutationTransactionAsync(async () =>
            {
                ArticlePublicationValidationResult validation = await _publicationValidator.ValidateAsync(
                    new ArticlePublicationValidationInput(
                        dto.Title,
                        dto.Content,
                        dto.Summary,
                        dto.CoverImageUrl,
                        dto.CategoryId,
                        dto.TagIds,
                        status,
                        dto.ScheduledPublishAt),
                    now,
                    ct).ConfigureAwait(false);
                validation.ThrowIfWriteBlocked();

                int id = await _db.Insertable(article).ExecuteReturnIdentityAsync();
                await _db.Insertable(new ArticleBody { ArticleId = id, MarkdownContent = content, UpdatedAt = now }).ExecuteCommandAsync();
                if (tagIds.Count > 0)
                {
                    await _db.Insertable(BuildArticleTags(id, tagIds)).ExecuteCommandAsync();
                }
                ArticleRevisionCoordinates revision = await SaveArticleRevisionAsync(
                    id,
                    title,
                    content,
                    safeSummary,
                    coverImageUrl,
                    dto.CategoryId,
                    tagIds,
                    ArticleSummaryProjection.AttachGenerationVersion("initial publish", summaryProjection),
                    now);
                ArticleAssetReferenceWrite[] assetReferenceWrites = await new ArticleAssetReferenceWriteBoundary(_db)
                    .ResolveAsync(content, coverImageUrl, ct)
                    .ConfigureAwait(false);
                var assetReferences = new ArticleAssetReferenceStore(_db);
                await assetReferences.ReplaceCurrentArticleAsync(id, assetReferenceWrites, ct).ConfigureAwait(false);
                await assetReferences.ReplaceRevisionAsync(revision.Id, id, assetReferenceWrites, ct).ConfigureAwait(false);
                long rightsSnapshotId = await SaveArticleRightsAsync(
                    id,
                    revision,
                    title,
                    content,
                    safeSummary,
                    coverImageUrl,
                    dto.CategoryId,
                    tagIds,
                    status,
                    article.PublishedAt,
                    article.ScheduledPublishAt,
                    rights,
                    now);
                long? responsibilitySnapshotId = await LoadResponsibilitySnapshotIdAsync(revision.Id);
                int? responsibilityVersion = await LoadResponsibilityVersionAsync(responsibilitySnapshotId);
                ArticleVersionCoordinates version = await ArticlePublicationTransitionWriter.ApplyAsync(
                    _db,
                    new ArticlePublicationTransitionRequest(
                        id,
                        new ArticleVersionCoordinates(
                            revision.Id,
                            revision.RevisionNo,
                            rightsSnapshotId,
                            responsibilitySnapshotId,
                            null,
                            null,
                            responsibilityVersion),
                        status,
                        article.ScheduledPublishAt,
                        now,
                        TransitionKindFor(status),
                        ArticleStatusTransitionOperation.Create));
                await RecordArticleMutationOutboxAsync(
                    id,
                    ArticleMutationEventTypes.Created,
                    version,
                    now,
                    before: null,
                    after: new ArticleMutationScopeSnapshot(
                        dto.CategoryId,
                        tagIds,
                        ArticleMutationVisibility.From(status)));
                var mutation = new ArticleMutationResult(
                    id,
                    version.RevisionId,
                    version.RevisionNo,
                    version.PublicationId ?? 0,
                    version.PublicationNo ?? 0,
                    (int)status,
                    version.RightsSnapshotId,
                    version.RevisionNo,
                    IdempotencyReplay: false,
                    (byte)ErrorCode.None);
                if (identity.HasValue)
                {
                    await _db.Insertable(ToArticleMutationCommand(identity.Value, mutation, now))
                        .ExecuteCommandAsync(ct)
                        .ConfigureAwait(false);
                }
                return mutation;
            });

            mutationCommitted = result.IsSuccess && result.Data.ArticleId > 0;
            ct.ThrowIfCancellationRequested();
            if (result.IsSuccess && result.Data.ArticleId == 0)
            {
                return default;
            }

            if (result.IsSuccess && IsArticleVaultGroupTransaction)
            {
                int createdArticleId = result.Data.ArticleId;
                EnqueueArticleVaultPostCommitAction(null, async () =>
                {
                    string mutationId = await InvalidateCache().ConfigureAwait(false);
                    await InvalidatePublicAotAsync(null, [dto.CategoryId], tagIds, "create", mutationId).ConfigureAwait(false);
                    ArticleListItemResponse? realtimePreview = await LoadRealtimePreviewAsync(createdArticleId)
                        .ConfigureAwait(false);
                    await _mutationSideEffects.AfterCreatedAsync(article, createdArticleId, realtimePreview)
                        .ConfigureAwait(false);
                });
                return result.Data;
            }

            if (result.IsSuccess)
            {
                string mutationId = await InvalidateCache();
                ct.ThrowIfCancellationRequested();
                await InvalidatePublicAotAsync(null, [dto.CategoryId], tagIds, "create", mutationId);
                ct.ThrowIfCancellationRequested();
                ArticleListItemResponse? realtimePreview = await LoadRealtimePreviewAsync(result.Data.ArticleId);
                ct.ThrowIfCancellationRequested();

                await _mutationSideEffects.AfterCreatedAsync(article, result.Data.ArticleId, realtimePreview);

                return result.Data;
            }
            if (result.ErrorException is ArticleWriteValidationException validationException)
            {
                throw validationException;
            }
            if (identity.HasValue && IsArticleMutationIdentityConflict(result.ErrorException))
            {
                ArticleMutationCommand? existing = await LoadArticleMutationCommandAsync(identity.Value, ct).ConfigureAwait(false);
                if (existing is not null)
                {
                    return ReplayArticleMutation(existing, identity.Value.RequestHash);
                }
            }
            _logger.LogError("创建文章失败 | DbError: {Error}", result.ErrorMessage);
            return default;
        }
        finally
        {
            if (fenceEstablished && !mutationCommitted && !IsArticleVaultGroupTransaction)
            {
                await RecoverAbortedPublicMutationFenceAsync(null, "article-create-fence-aborted").ConfigureAwait(false);
            }
        }
    }

    private async Task<ArticleMutationCommand?> LoadArticleMutationCommandAsync(
        ArticleMutationIdentity identity,
        CancellationToken cancellationToken)
        => await _db.Queryable<ArticleMutationCommand>()
            .Where(command => command.AdminPrincipalId == identity.AdminPrincipalId
                && command.ClientMutationId == identity.ClientMutationId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

    private static ArticleMutationCommand ToArticleMutationCommand(
        ArticleMutationIdentity identity,
        ArticleMutationResult result,
        DateTime createdAtUtc)
        => new()
        {
            AdminPrincipalId = identity.AdminPrincipalId,
            ClientMutationId = identity.ClientMutationId,
            RequestHash = identity.RequestHash,
            ArticleId = result.ArticleId,
            RevisionId = result.RevisionId,
            RevisionNo = result.RevisionNo,
            ReleaseId = result.ReleaseId,
            ReleaseNo = result.ReleaseNo,
            Status = result.Status,
            RightsSnapshotId = result.RightsSnapshotId,
            RightsRevisionNo = result.RightsRevisionNo,
            CreatedAtUtc = createdAtUtc
        };

    private static ArticleMutationResult ReplayArticleMutation(
        ArticleMutationCommand command,
        string requestHash)
    {
        if (!CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(command.RequestHash),
                Convert.FromHexString(requestHash)))
        {
            throw new ArticleMutationContentConflictException();
        }

        return new ArticleMutationResult(
            command.ArticleId,
            command.RevisionId,
            command.RevisionNo,
            command.ReleaseId,
            command.ReleaseNo,
            command.Status,
            command.RightsSnapshotId,
            command.RightsRevisionNo,
            IdempotencyReplay: true,
            (byte)ErrorCode.None);
    }

    private static bool IsArticleMutationIdentityConflict(Exception? exception)
    {
        for (Exception? current = exception; current is not null; current = current.InnerException)
        {
            if (current is PostgresException postgres
                && string.Equals(postgres.SqlState, PostgresErrorCodes.UniqueViolation, StringComparison.Ordinal)
                && string.Equals(postgres.ConstraintName, "ux_article_mutation_command_identity", StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    async Task<Result<ArticleMutationResult>> IArticleMutationCommandService.CreateAsync(
        long adminPrincipalId,
        string clientMutationId,
        string requestHash,
        ArticleWriteRequestCoreModel request,
        CancellationToken cancellationToken)
    {
        if (adminPrincipalId <= 0)
        {
            return Result<ArticleMutationResult>.Failure(ErrorCode.Unauthorized, "admin_principal_required");
        }
        if (!Guid.TryParseExact(clientMutationId, "D", out Guid parsedMutationId)
            || !string.Equals(clientMutationId, parsedMutationId.ToString("D"), StringComparison.Ordinal))
        {
            return Result<ArticleMutationResult>.Failure(ErrorCode.Validation, "article_client_mutation_id_invalid");
        }
        if (requestHash.Length != 64 || !requestHash.All(Uri.IsHexDigit))
        {
            return Result<ArticleMutationResult>.Failure(ErrorCode.Validation, "article_mutation_request_hash_invalid");
        }

        try
        {
            ArticleMutationResult result = await CreateMutationAsync(
                request,
                new ArticleMutationIdentity(adminPrincipalId, clientMutationId, requestHash.ToUpperInvariant()),
                cancellationToken).ConfigureAwait(false);
            return result.ArticleId > 0
                ? Result<ArticleMutationResult>.Success(result)
                : Result<ArticleMutationResult>.Failure(ErrorCode.InfraFailure, "article_create_failed");
        }
        catch (ArticleMutationContentConflictException)
        {
            return Result<ArticleMutationResult>.Failure(ErrorCode.Conflict, "article_mutation_content_conflict");
        }
        catch (ArticleStatusTransitionValidationException ex)
        {
            return Result<ArticleMutationResult>.Failure(ErrorCode.Validation, ex.Validation.Code);
        }
        catch (ArticleWriteValidationException ex)
        {
            return Result<ArticleMutationResult>.Failure(ErrorCode.Validation, ex.Code);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Idempotent article create failed for admin {AdminPrincipalId}", adminPrincipalId);
            return Result<ArticleMutationResult>.Failure(ErrorCode.InfraFailure, "article_create_infrastructure_failure");
        }
    }

    async Task<Result<ArticleMutationResult>> IArticleMutationCommandService.UpdateAsync(
        int articleId,
        ArticleWriteRequestCoreModel request,
        CancellationToken cancellationToken)
    {
        if (articleId <= 0)
        {
            return Result<ArticleMutationResult>.Failure(ErrorCode.Validation, "article_id_invalid");
        }

        try
        {
            ArticleUpdateExecution? execution = null;
            bool updated = await UpdateAsync(
                articleId,
                request,
                transitionKind: null,
                force: false,
                rollback: null,
                captureExecution: value => execution = value,
                cancellationToken).ConfigureAwait(false);
            if (!updated)
            {
                return Result<ArticleMutationResult>.Failure(ErrorCode.NotFound, "article_not_found");
            }

            if (!execution.HasValue)
            {
                return Result<ArticleMutationResult>.Failure(ErrorCode.InfraFailure, "article_mutation_coordinates_unavailable");
            }
            ArticleVersionCoordinates version = execution.Value.Version;

            return Result<ArticleMutationResult>.Success(new ArticleMutationResult(
                articleId,
                version.RevisionId,
                version.RevisionNo,
                version.PublicationId ?? 0,
                version.PublicationNo ?? 0,
                request.Status,
                version.RightsSnapshotId,
                version.RevisionNo,
                IdempotencyReplay: false,
                (byte)ErrorCode.None,
                execution.Value.Outcome));
        }
        catch (ArticleRevisionConflictException ex)
        {
            return Result<ArticleMutationResult>.Failure(
                ErrorDetail.Create(ErrorCode.Conflict, "article_revision_conflict", ex.ToApiDetails()));
        }
        catch (ArticleStatusTransitionValidationException ex)
        {
            return Result<ArticleMutationResult>.Failure(ErrorCode.Validation, ex.Validation.Code);
        }
        catch (ArticleWriteValidationException ex)
        {
            return Result<ArticleMutationResult>.Failure(ErrorCode.Validation, ex.Code);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Article update failed for {ArticleId}", articleId);
            return Result<ArticleMutationResult>.Failure(ErrorCode.InfraFailure, "article_update_infrastructure_failure");
        }
    }

    private async Task<ArticleRevisionCoordinates> SaveArticleRevisionAsync(
        int articleId,
        string title,
        string content,
        string? summary,
        string? coverImageUrl,
        int categoryId,
        IReadOnlyList<int> tagIds,
        string diffSummary,
        DateTime createdAt,
        ArticleRollbackMetadata? rollback = null)
    {
        await _db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(hashtext('article_revision'), @articleId);",
            new SugarParameter[] { new("@articleId", articleId) });
        long actorAdminPrincipalId = rollback?.ActorAdminPrincipalId ?? ResolveRevisionAdminPrincipalId();
        string orderedTagIds = string.Join(',', tagIds.OrderBy(static id => id));
        long contentBlockId = await ArticleRevisionContentBlockStore.GetOrCreateAsync(
            _db,
            content,
            createdAt,
            Ct).ConfigureAwait(false);
        for (int attempt = 1; attempt <= MaxArticleRevisionInsertAttempts; attempt++)
        {
            Ct.ThrowIfCancellationRequested();
            using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
                """
                WITH locked_article AS (
                    SELECT id, xmin::text AS row_version
                    FROM article
                    WHERE id = @articleId
                      AND isdeleted = false
                    FOR UPDATE
                ),
                next_revision AS (
                    SELECT locked_article.id AS article_id,
                           locked_article.row_version,
                           COALESCE((
                               SELECT MAX(revision_no)
                               FROM article_revision
                               WHERE article_id = @articleId
                           ), 0) + 1 AS revision_no
                    FROM locked_article
                )
                INSERT INTO article_revision (
                    article_id,
                    revision_no,
                    title,
                    summary,
                    cover_image_url,
                    categoryid,
                    tag_ids,
                    content_block_id,
                    markdown_content,
                    diff_summary,
                    created_by_admin_principal_id,
                    rollback_source_revision_id,
                    rollback_reason,
                    created_at
                )
                SELECT
                    article_id,
                    revision_no,
                    @title,
                    @summary,
                    @coverImageUrl,
                    @categoryId,
                    @tagIds,
                    @contentBlockId,
                    '',
                    @diffSummary,
                    @createdByAdminPrincipalId,
                    CAST(@rollbackSourceRevisionId AS bigint),
                    @rollbackReason,
                    @createdAt
                FROM next_revision
                ON CONFLICT (article_id, revision_no) DO NOTHING
                RETURNING id, revision_no;
                """,
                new SugarParameter[]
                {
                    new("@articleId", articleId),
                    new("@title", title),
                    new("@summary", summary),
                    new("@coverImageUrl", coverImageUrl),
                    new("@categoryId", categoryId),
                    new("@tagIds", orderedTagIds),
                    new("@contentBlockId", contentBlockId),
                    new("@diffSummary", diffSummary),
                    new("@createdByAdminPrincipalId", actorAdminPrincipalId),
                    new("@rollbackSourceRevisionId", (object?)rollback?.SourceRevisionId ?? DBNull.Value),
                    new("@rollbackReason", (object?)rollback?.Reason ?? DBNull.Value),
                    new("@createdAt", createdAt)
                });
            if (await reader.ReadAsync(Ct).ConfigureAwait(false))
            {
                return new ArticleRevisionCoordinates(
                    reader.ReadInt64("id"),
                    reader.ReadInt32("revision_no"),
                    contentBlockId);
            }
            await reader.DisposeAsync().ConfigureAwait(false);

            int activeArticle = await _db.Ado.GetIntAsync(
                "SELECT COUNT(1) FROM article WHERE id = @articleId AND isdeleted = false;",
                new SugarParameter[] { new("@articleId", articleId) }).ConfigureAwait(false);
            if (activeArticle == 0)
            {
                throw new InvalidOperationException($"Article revision was not created for article {articleId}.");
            }

            if (attempt < MaxArticleRevisionInsertAttempts)
            {
                _logger.LogWarning(
                    "Article revision number conflict for {ArticleId}; retrying bounded attempt {Attempt}/{MaxAttempts}",
                    articleId,
                    attempt,
                    MaxArticleRevisionInsertAttempts);
            }
        }

        throw new InvalidOperationException(
            $"Article revision conflict retry limit exceeded for article {articleId} after {MaxArticleRevisionInsertAttempts} attempts.");
    }

    private long ResolveRevisionAdminPrincipalId()
        => _httpContextAccessor.HttpContext?.User.TryGetAdminPrincipalId(out long adminPrincipalId) == true
            ? adminPrincipalId
            : 0;

    private async Task<long> SaveArticleRightsAsync(
        int articleId,
        ArticleRevisionCoordinates revision,
        string title,
        string content,
        string? summary,
        string? coverImageUrl,
        int categoryId,
        IReadOnlyList<int> tagIds,
        ArticleStatus status,
        DateTime? publishedAt,
        DateTime? scheduledPublishAt,
        ArticleRightsWriteModel rights,
        DateTime createdAt)
    {
        long policyId = await EnsureArticleRightsPolicyAsync(articleId, rights).ConfigureAwait(false);
        string contentCanonicalHash = "sha256:" + ArticleCanonicalHashV1.ComputeHashHex(new ArticleCanonicalInput(
            ArticleId: articleId,
            ArticleRevisionId: revision.Id,
            RevisionNo: revision.RevisionNo,
            PublicRouteKey: $"article:{articleId}",
            Title: title,
            Summary: summary,
            CoverImageUrl: coverImageUrl,
            CategoryId: categoryId,
            TagIds: tagIds,
            Status: (int)status,
            PublishedAt: publishedAt,
            ScheduledPublishAt: scheduledPublishAt,
            MarkdownContent: content));
        string policyHash = ArticleRightsCanonicalHashV1.ComputeHashHex(new ArticleRightsCanonicalInput(
            ArticleId: articleId,
            ArticleRevisionId: revision.Id,
            RevisionNo: revision.RevisionNo,
            LicenseType: rights.LicenseType,
            CopyrightHolder: rights.CopyrightHolder,
            CopyrightYear: rights.CopyrightYear,
            RightsStatement: rights.RightsStatement,
            AttributionTemplate: rights.AttributionTemplate,
            CopyPolicy: rights.CopyPolicy,
            MaxExcerptChars: rights.MaxExcerptChars,
            AllowCodeCopy: rights.AllowCodeCopy,
            ShowPublicBadge: rights.ShowPublicBadge,
            CanonicalUrl: null,
            ContentCanonicalHash: contentCanonicalHash));

        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            INSERT INTO article_rights_snapshot (
                article_id,
                article_revision_id,
                revision_no,
                article_rights_policy_id,
                enabled,
                license_type,
                copyright_holder,
                copyright_year,
                rights_statement,
                attribution_template,
                copy_policy,
                max_excerpt_chars,
                allow_code_copy,
                show_public_badge,
                proof_binding_enabled,
                canonical_url,
                policy_hash,
                content_canonical_hash,
                created_at
            )
            VALUES (
                @ArticleId,
                @ArticleRevisionId,
                @RevisionNo,
                @PolicyId,
                @Enabled,
                @LicenseType,
                @CopyrightHolder,
                @CopyrightYear,
                @RightsStatement,
                @AttributionTemplate,
                @CopyPolicy,
                @MaxExcerptChars,
                @AllowCodeCopy,
                @ShowPublicBadge,
                @ProofBindingEnabled,
                @CanonicalUrl,
                @PolicyHash,
                @ContentCanonicalHash,
                @CreatedAt
            )
            RETURNING id;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@ArticleRevisionId", revision.Id),
            new SugarParameter("@RevisionNo", revision.RevisionNo),
            new SugarParameter("@PolicyId", policyId),
            new SugarParameter("@Enabled", rights.Enabled),
            new SugarParameter("@LicenseType", rights.LicenseType),
            NullableStringParameter("@CopyrightHolder", rights.CopyrightHolder),
            NullableInt32Parameter("@CopyrightYear", rights.CopyrightYear),
            NullableStringParameter("@RightsStatement", rights.RightsStatement),
            NullableStringParameter("@AttributionTemplate", rights.AttributionTemplate),
            new SugarParameter("@CopyPolicy", rights.CopyPolicy),
            new SugarParameter("@MaxExcerptChars", rights.MaxExcerptChars),
            new SugarParameter("@AllowCodeCopy", rights.AllowCodeCopy),
            new SugarParameter("@ShowPublicBadge", rights.ShowPublicBadge),
            new SugarParameter("@ProofBindingEnabled", rights.ProofBindingEnabled),
            NullableStringParameter("@CanonicalUrl", null),
            new SugarParameter("@PolicyHash", policyHash),
            new SugarParameter("@ContentCanonicalHash", contentCanonicalHash),
            new SugarParameter("@CreatedAt", createdAt));
        if (!await reader.ReadAsync(Ct).ConfigureAwait(false))
        {
            throw new InvalidOperationException($"Article rights snapshot was not created for article {articleId} revision {revision.Id}.");
        }

        return reader.ReadInt64("id");
    }

    private async Task<long> EnsureArticleRightsPolicyAsync(int articleId, ArticleRightsWriteModel rights)
    {
        ArticleRightsPolicy? current = await _db.Queryable<ArticleRightsPolicy>()
            .Where(item => item.ArticleId == articleId)
            .FirstAsync(Ct)
            .ConfigureAwait(false);
        if (current is not null && ToRightsWriteModel(current) == rights)
        {
            return current.Id;
        }

        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            INSERT INTO article_rights_policy (
                article_id,
                enabled,
                license_type,
                copyright_holder,
                copyright_year,
                rights_statement,
                attribution_template,
                copy_policy,
                max_excerpt_chars,
                allow_code_copy,
                show_public_badge,
                proof_binding_enabled,
                created_at,
                updated_at
            )
            VALUES (
                @ArticleId,
                @Enabled,
                @LicenseType,
                @CopyrightHolder,
                @CopyrightYear,
                @RightsStatement,
                @AttributionTemplate,
                @CopyPolicy,
                @MaxExcerptChars,
                @AllowCodeCopy,
                @ShowPublicBadge,
                @ProofBindingEnabled,
                @Now,
                @Now
            )
            ON CONFLICT (article_id)
            DO UPDATE SET
                enabled = EXCLUDED.enabled,
                license_type = EXCLUDED.license_type,
                copyright_holder = EXCLUDED.copyright_holder,
                copyright_year = EXCLUDED.copyright_year,
                rights_statement = EXCLUDED.rights_statement,
                attribution_template = EXCLUDED.attribution_template,
                copy_policy = EXCLUDED.copy_policy,
                max_excerpt_chars = EXCLUDED.max_excerpt_chars,
                allow_code_copy = EXCLUDED.allow_code_copy,
                show_public_badge = EXCLUDED.show_public_badge,
                proof_binding_enabled = EXCLUDED.proof_binding_enabled,
                updated_at = EXCLUDED.updated_at
            RETURNING id;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@Enabled", rights.Enabled),
            new SugarParameter("@LicenseType", rights.LicenseType),
            NullableStringParameter("@CopyrightHolder", rights.CopyrightHolder),
            NullableInt32Parameter("@CopyrightYear", rights.CopyrightYear),
            NullableStringParameter("@RightsStatement", rights.RightsStatement),
            NullableStringParameter("@AttributionTemplate", rights.AttributionTemplate),
            new SugarParameter("@CopyPolicy", rights.CopyPolicy),
            new SugarParameter("@MaxExcerptChars", rights.MaxExcerptChars),
            new SugarParameter("@AllowCodeCopy", rights.AllowCodeCopy),
            new SugarParameter("@ShowPublicBadge", rights.ShowPublicBadge),
            new SugarParameter("@ProofBindingEnabled", rights.ProofBindingEnabled),
            new SugarParameter("@Now", DateTime.UtcNow));
        if (!await reader.ReadAsync(Ct).ConfigureAwait(false))
        {
            throw new InvalidOperationException($"Article rights policy was not upserted for article {articleId}.");
        }

        return reader.ReadInt64("id");
    }

    private static ArticleRightsWriteModel NormalizeArticleRights(ArticleRightsRequestCoreModel? request)
    {
        if (request is null)
        {
            return new ArticleRightsWriteModel(
                Enabled: true,
                LicenseType: "all-rights-reserved",
                CopyrightHolder: null,
                CopyrightYear: null,
                RightsStatement: null,
                AttributionTemplate: null,
                CopyPolicy: "append-attribution",
                MaxExcerptChars: 300,
                AllowCodeCopy: true,
                ShowPublicBadge: true,
                ProofBindingEnabled: true);
        }

        ArticleRightsRequestCoreModel value = request.Value;
        if (value.MaxExcerptChars < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(value.MaxExcerptChars), value.MaxExcerptChars, "MaxExcerptChars cannot be negative.");
        }

        return new ArticleRightsWriteModel(
            Enabled: value.Enabled,
            LicenseType: NormalizeRightsToken(value.LicenseType, "all-rights-reserved", 48),
            CopyrightHolder: NormalizeOptionalRightsText(value.CopyrightHolder, 256),
            CopyrightYear: value.CopyrightYear,
            RightsStatement: NormalizeOptionalRightsText(value.RightsStatement, 4000),
            AttributionTemplate: NormalizeOptionalRightsText(value.AttributionTemplate, 4000),
            CopyPolicy: NormalizeRightsToken(value.CopyPolicy, "append-attribution", 48),
            MaxExcerptChars: value.MaxExcerptChars,
            AllowCodeCopy: value.AllowCodeCopy,
            ShowPublicBadge: value.ShowPublicBadge,
            ProofBindingEnabled: value.ProofBindingEnabled);
    }

    private static ArticleRightsWriteModel ResolveCreateArticleRights(ArticleWriteRequestCoreModel request)
    {
        ArticleRightsMutationMode mutation = ResolveRightsMutation(request);
        return mutation switch
        {
            ArticleRightsMutationMode.Preserve => NormalizeArticleRights(null),
            ArticleRightsMutationMode.Reset when request.Rights is null => NormalizeArticleRights(null),
            ArticleRightsMutationMode.Replace when request.Rights is not null => NormalizeArticleRights(request.Rights),
            ArticleRightsMutationMode.Reset => throw new ArticleWriteValidationException(
                "article_rights_reset_payload_conflict",
                "Rights reset cannot include a replacement payload."),
            ArticleRightsMutationMode.Replace => throw new ArticleWriteValidationException(
                "article_rights_payload_required",
                "Rights replacement requires a complete payload."),
            _ => throw new ArticleWriteValidationException(
                "article_rights_mutation_invalid",
                "Rights mutation mode is invalid.")
        };
    }

}
