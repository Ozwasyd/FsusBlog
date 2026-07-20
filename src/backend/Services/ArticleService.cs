using System.Data;
using System.Data.Common;
using System.Runtime.CompilerServices;
using System.Text;

using FsusBlog.Core.Integrity;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Content;
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
using FsusBlog.Server.Services.Background;

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
    IConnectionMultiplexer _redisConnection,
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
    ArticleBodyRepairQueue _articleBodyRepairQueue) : IArticleCoreGateway
#pragma warning restore IDE1006
{
    private readonly record struct TrashArticleRow(int Id, int CategoryId, string? CoverImageUrl);
    private readonly record struct ArticleRevisionCoordinates(long Id, int RevisionNo);
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
    private readonly IDatabase _redis = _redisConnection.GetDatabase();
    private CancellationToken Ct => _httpContextAccessor.HttpContext?.RequestAborted ?? CancellationToken.None;

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

        var updatedIds = new HashSet<int>();
        var updatedViews = new Dictionary<int, int>();
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

        string hotRankKey = RedisKey("blog:top_articles");
        IBatch redisBatch = _redis.CreateBatch();
        var redisTasks = new List<Task>(normalized.Length * 2);
        foreach ((int articleId, int count) in normalized)
        {
            cancellationToken.ThrowIfCancellationRequested();
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

        string normalizedKeyword = NormalizeArticleListKeyword(keyword);
        long version = await GetListCacheVersionAsync(effectiveCt);
        string cacheIdentity = BuildArticleListIdentity(version, page, size, categoryId, tagId, isDeleted, status, includePrivate, normalizedKeyword);

        return await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.ArticleList,
                cacheIdentity,
                ct => _cacheReader.TryGetAsync(CachePolicyId.ArticleList, cacheIdentity, ServerCacheBinaryCodec.DecodeArticleListPage, ct),
                async ct => await _dbConcurrencyGate.ExecuteAsync(
                    "article-list",
                    async gateCt =>
                    {
                        ArticleListPageReadModel result = await LoadArticleListPageFromDbAsync(version, page, size, categoryId, tagId, isDeleted, status, includePrivate, normalizedKeyword, cursor: null, gateCt);
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
            gateCt => LoadArticleDetailFromDbAsync(id, includePrivate: false, cacheIdentity: id, gateCt),
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

        if (!string.IsNullOrWhiteSpace(cached.Content))
        {
            return new CacheReadResult<ArticleDetailReadModel>(true, await OverlayProjectedViewsAsync(cached, cancellationToken));
        }

        string healedContent = await LoadArticleContentAsync(id, cancellationToken);
        if (string.IsNullOrWhiteSpace(healedContent))
        {
            MarkArticleBodyMissing(id, "article-detail-cache");
            return new CacheReadResult<ArticleDetailReadModel>(true, await OverlayProjectedViewsAsync(cached, cancellationToken));
        }

        ReadingEstimate healedReading = ReadingEstimator.Estimate(healedContent);
        var healed = cached with
        {
            Content = healedContent,
            WordCount = healedReading.EffectiveChars,
            EstimatedReadingMinutes = healedReading.Minutes,
            ShowReadingNotice = healedReading.ShowLongReadNotice
        };
        cancellationToken.ThrowIfCancellationRequested();
        byte[] encodedHealed = ServerCacheBinaryCodec.EncodeArticleDetail(healed);
        cancellationToken.ThrowIfCancellationRequested();
        await _cacheWriter.SetRawAsync(CachePolicyId.ArticleDetail, id, encodedHealed, null, cancellationToken);
        return new CacheReadResult<ArticleDetailReadModel>(true, await OverlayProjectedViewsAsync(healed, cancellationToken));
    }

    private async Task<ArticleDetailReadModel> OverlayProjectedViewsAsync(
        ArticleDetailReadModel article,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        double? projectedViews = await _redis.SortedSetScoreAsync(RedisKey("blog:top_articles"), article.Id).ConfigureAwait(false);
        if (!projectedViews.HasValue || projectedViews.Value < article.Views || projectedViews.Value > int.MaxValue)
        {
            return article;
        }

        return article with
        {
            Views = (int)Math.Round(projectedViews.Value, MidpointRounding.AwayFromZero)
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
                CASE WHEN @IncludePrivate THEN a.published_at ELSE publication.published_at END AS "PublishedAt",
                CASE WHEN @IncludePrivate THEN ab.updated_at ELSE published_revision.created_at END AS "UpdatedAt",
                (ab.article_id IS NOT NULL AND btrim(COALESCE(ab.markdown_content, '')) <> '') AS "BodyAvailable",
                CASE WHEN @IncludePrivate THEN current_revision.id ELSE published_revision.id END AS "CurrentRevisionId",
                CASE WHEN @IncludePrivate THEN current_revision.revision_no ELSE published_revision.revision_no END AS "RevisionNo",
                publication.id AS "CurrentPublicationId",
                publication.publication_no AS "PublicationNo",
                c.name AS "CategoryName",
                CASE
                    WHEN ab.article_id IS NULL OR btrim(COALESCE(ab.markdown_content, '')) = '' THEN ''
                    WHEN @IncludePrivate THEN ab.markdown_content
                    ELSE published_revision.markdown_content
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
            LEFT JOIN article_revision current_revision ON current_revision.id = a.current_revision_id
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
                current_revision.id,
                current_revision.revision_no,
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
                }
            }
        }

        if (article != null)
        {
            if (!includePrivate && cacheIdentity is not null && !string.IsNullOrWhiteSpace(article.Content))
            {
                cancellationToken.ThrowIfCancellationRequested();
                byte[] encoded = ServerCacheBinaryCodec.EncodeArticleDetail(article);
                cancellationToken.ThrowIfCancellationRequested();
                await _cacheWriter.SetRawAsync(CachePolicyId.ArticleDetail, cacheIdentity.Value, encoded, null, cancellationToken);
            }
        }
        else if (!includePrivate && cacheIdentity is not null)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await _cacheWriter.SetRawAsync(CachePolicyId.ArticleDetail, cacheIdentity.Value, Array.Empty<byte>(), TimeSpan.FromMinutes(5), cancellationToken);
        }

        return article;
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

    private async Task<string> LoadArticleContentAsync(int articleId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string content = await _db.Queryable<Article>()
            .InnerJoin<ArticlePublicationRecord>((article, publication) => article.CurrentPublicationId == publication.Id)
            .InnerJoin<ArticleRevision>((article, publication, revision) => publication.ArticleRevisionId == revision.Id)
            .Where(article => article.Id == articleId && !article.IsDeleted)
            .Select((article, publication, revision) => revision.MarkdownContent)
            .FirstAsync(cancellationToken) ?? string.Empty;

        return content;
    }

    private void MarkArticleBodyMissing(int articleId, string source)
    {
        _articleBodyRepairQueue.TrySchedule(articleId, source);
        _logger.LogWarning("article_body_missing {ArticleId} {Source}", articleId, source);
        FsusObservability.RecordOperation("article_body", "read", "missing", TimeSpan.Zero);
    }

    public async Task<int> CreateAsync(ArticleWriteRequestCoreModel dto, CancellationToken cancellationToken = default)
    {
        CancellationToken ct = ResolveCancellationToken(cancellationToken);
        ct.ThrowIfCancellationRequested();
        var title = NormalizeText(dto.Title, MaxTitleLength);
        var content = NormalizeText(dto.Content, MaxContentLength);
        var summary = NormalizeText(dto.Summary, MaxSummaryLength);
        var coverImageUrl = NormalizeText(dto.CoverImageUrl, 512);
        var tagIds = NormalizeTagIds(dto.TagIds);
        ArticleSummaryProjectionResult summaryProjection = ArticleSummaryProjection.Resolve(summary, content);
        string safeSummary = summaryProjection.Text;
        ArticleRightsWriteModel rights = ResolveCreateArticleRights(dto);
        DateTime now = DateTime.UtcNow;
        ArticleStatus status = (ArticleStatus)dto.Status;
        ValidateWriteTarget(status, dto.ScheduledPublishAt, now);
        var article = new Article
        {
            Title = title,
            Summary = safeSummary,
            CoverImageUrl = coverImageUrl,
            CategoryId = dto.CategoryId,
            CreateTime = now,
            Status = status,
            ScheduledPublishAt = status == ArticleStatus.Scheduled ? dto.ScheduledPublishAt : null,
            PublishedAt = status == ArticleStatus.Published ? now : null,
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
                await _mutationFence.BeginPublicMutationFenceAsync(null, ct).ConfigureAwait(false);
                fenceEstablished = true;
            }

            var result = await _db.Ado.UseTranAsync(async () =>
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
                await _db.Insertable(new ArticleBody { ArticleId = id, MarkdownContent = content, UpdatedAt = DateTime.UtcNow }).ExecuteCommandAsync();
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
                    ArticleSummaryProjection.AttachGenerationVersion("initial publish", summaryProjection));
                var assetReferences = new ArticleAssetReferenceStore(_db);
                await assetReferences.ReplaceCurrentArticleAsync(id, content, coverImageUrl, ct).ConfigureAwait(false);
                await assetReferences.ReplaceRevisionAsync(revision.Id, id, content, coverImageUrl, ct).ConfigureAwait(false);
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
                    rights);
                long? responsibilitySnapshotId = await LoadResponsibilitySnapshotIdAsync(revision.Id);
                ArticleVersionCoordinates version = await ArticlePublicationTransitionWriter.ApplyAsync(
                    _db,
                    new ArticlePublicationTransitionRequest(
                        id,
                        ArticleVersionCoordinates.Revision(revision.Id, revision.RevisionNo, rightsSnapshotId, responsibilitySnapshotId),
                        status,
                        article.ScheduledPublishAt,
                        now,
                        TransitionKindFor(status),
                        ArticleStatusTransitionOperation.Create));
                await RecordArticleMutationOutboxAsync(id, ArticleMutationEventTypes.Created, version);
                return id;
            });

            mutationCommitted = result.IsSuccess && result.Data > 0;
            ct.ThrowIfCancellationRequested();
            if (result.IsSuccess && result.Data == 0)
            {
                return 0;
            }

            if (result.IsSuccess)
            {
                await InvalidateCache();
                ct.ThrowIfCancellationRequested();
                await InvalidatePublicAotAsync(null, [dto.CategoryId], tagIds, "create");
                ct.ThrowIfCancellationRequested();
                ArticleListItemResponse? realtimePreview = await LoadRealtimePreviewAsync(result.Data);
                ct.ThrowIfCancellationRequested();

                await _mutationSideEffects.AfterCreatedAsync(article, result.Data, realtimePreview);

                return result.Data;
            }
            if (result.ErrorException is ArticleWriteValidationException validationException)
            {
                throw validationException;
            }
            _logger.LogError("创建文章失败 | DbError: {Error}", result.ErrorMessage);
            return 0;
        }
        finally
        {
            if (fenceEstablished && !mutationCommitted)
            {
                await RecoverAbortedPublicMutationFenceAsync(null, "article-create-fence-aborted").ConfigureAwait(false);
            }
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
        ArticleRollbackMetadata? rollback = null)
    {
        await _db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(hashtext('article_revision'), @articleId);",
            new SugarParameter[] { new("@articleId", articleId) });
        long actorAdminPrincipalId = rollback?.ActorAdminPrincipalId ?? ResolveRevisionAdminPrincipalId();
        string orderedTagIds = string.Join(',', tagIds.OrderBy(static id => id));
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
                    @content,
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
                    new("@content", content),
                    new("@diffSummary", diffSummary),
                    new("@createdByAdminPrincipalId", actorAdminPrincipalId),
                    new("@rollbackSourceRevisionId", (object?)rollback?.SourceRevisionId ?? DBNull.Value),
                    new("@rollbackReason", (object?)rollback?.Reason ?? DBNull.Value),
                    new("@createdAt", DateTime.UtcNow)
                });
            if (await reader.ReadAsync(Ct).ConfigureAwait(false))
            {
                return new ArticleRevisionCoordinates(reader.ReadInt64("id"), reader.ReadInt32("revision_no"));
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
        ArticleRightsWriteModel rights)
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
            new SugarParameter("@CreatedAt", DateTime.UtcNow));
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

    private async Task<ArticleRightsWriteModel> ResolveUpdateArticleRightsAsync(
        int articleId,
        ArticleWriteRequestCoreModel request,
        ArticleRollbackMetadata? rollback)
    {
        if (rollback.HasValue)
        {
            ArticleRightsSnapshot? historical = await _db.Queryable<ArticleRightsSnapshot>()
                .Where(item => item.ArticleId == articleId
                    && item.ArticleRevisionId == rollback.Value.SourceRevisionId)
                .FirstAsync(Ct)
                .ConfigureAwait(false);
            return historical is not null
                ? ToRightsWriteModel(historical)
                : throw new ArticleWriteValidationException(
                    "article_revision_package_incomplete",
                    "The historical revision has no rights snapshot.");
        }

        ArticleRightsMutationMode mutation = ResolveRightsMutation(request);
        if (mutation == ArticleRightsMutationMode.Replace)
        {
            return request.Rights is not null
                ? NormalizeArticleRights(request.Rights)
                : throw new ArticleWriteValidationException(
                    "article_rights_payload_required",
                    "Rights replacement requires a complete payload.");
        }

        if (mutation == ArticleRightsMutationMode.Reset)
        {
            if (request.Rights is not null)
            {
                throw new ArticleWriteValidationException(
                    "article_rights_reset_payload_conflict",
                    "Rights reset cannot include a replacement payload.");
            }

            return NormalizeArticleRights(null);
        }

        if (mutation != ArticleRightsMutationMode.Preserve)
        {
            throw new ArticleWriteValidationException(
                "article_rights_mutation_invalid",
                "Rights mutation mode is invalid.");
        }

        ArticleRightsPolicy? current = await _db.Queryable<ArticleRightsPolicy>()
            .Where(item => item.ArticleId == articleId)
            .FirstAsync(Ct)
            .ConfigureAwait(false);
        return current is null ? NormalizeArticleRights(null) : ToRightsWriteModel(current);
    }

    private static ArticleRightsMutationMode ResolveRightsMutation(ArticleWriteRequestCoreModel request)
        => request.RightsMutation == ArticleRightsMutationMode.Preserve && request.Rights is not null
            ? ArticleRightsMutationMode.Replace
            : request.RightsMutation;

    private static ArticleRightsWriteModel ToRightsWriteModel(ArticleRightsPolicy policy)
        => new(
            policy.Enabled,
            policy.LicenseType,
            policy.CopyrightHolder,
            policy.CopyrightYear,
            policy.RightsStatement,
            policy.AttributionTemplate,
            policy.CopyPolicy,
            policy.MaxExcerptChars,
            policy.AllowCodeCopy,
            policy.ShowPublicBadge,
            policy.ProofBindingEnabled);

    private static ArticleRightsWriteModel ToRightsWriteModel(ArticleRightsSnapshot snapshot)
        => new(
            snapshot.Enabled,
            snapshot.LicenseType,
            snapshot.CopyrightHolder,
            snapshot.CopyrightYear,
            snapshot.RightsStatement,
            snapshot.AttributionTemplate,
            snapshot.CopyPolicy,
            snapshot.MaxExcerptChars,
            snapshot.AllowCodeCopy,
            snapshot.ShowPublicBadge,
            snapshot.ProofBindingEnabled);

    private static string? NormalizeOptionalRightsText(string? value, int maxLength)
    {
        string normalized = NormalizeText(value, maxLength);
        return normalized.Length == 0 ? null : normalized;
    }

    private static SugarParameter NullableStringParameter(string name, string? value)
        => new(name, (object?)value ?? DBNull.Value, System.Data.DbType.String);

    private static SugarParameter NullableInt32Parameter(string name, int? value)
        => new(name, (object?)value ?? DBNull.Value, System.Data.DbType.Int32);

    private static string NormalizeRightsToken(string? value, string fallback, int maxLength)
    {
        string? normalized = NormalizeText(value, maxLength);
        return string.IsNullOrWhiteSpace(normalized) ? fallback : normalized;
    }

    private Task RecordArticleMutationOutboxAsync(int articleId, string eventType, ArticleVersionCoordinates version)
        => _db.Insertable(new ArticleMutationOutboxEvent
        {
            EventId = Guid.NewGuid().ToString("N"),
            AggregateId = articleId,
            ArticleRevisionId = version.RevisionId,
            RevisionNo = version.RevisionNo,
            ArticlePublicationId = version.PublicationId,
            PublicationNo = version.PublicationNo,
            EventType = eventType,
            PayloadJson = ArticlePublicationTransitionWriter.BuildOutboxPayload(articleId, eventType, version),
            Status = "pending",
            RetryCount = 0,
            NextRetryAt = DateTime.UtcNow,
            CreatedAt = DateTime.UtcNow
        }).ExecuteCommandAsync();

    private async Task RecordArticleMutationOutboxAsync(int articleId, string eventType)
    {
        ArticleVersionCoordinates version = await LoadCurrentVersionCoordinatesAsync(articleId).ConfigureAwait(false);
        await RecordArticleMutationOutboxAsync(articleId, eventType, version).ConfigureAwait(false);
    }

    private async Task<ArticleVersionCoordinates> LoadCurrentVersionCoordinatesAsync(int articleId)
    {
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT
                revision.id AS revision_id,
                revision.revision_no,
                rights.id AS rights_snapshot_id,
                responsibility.id AS responsibility_snapshot_id,
                publication.id AS publication_id,
                publication.publication_no
            FROM article article
            JOIN article_revision revision ON revision.id = article.current_revision_id
            JOIN article_rights_snapshot rights
              ON rights.article_id = article.id
             AND rights.article_revision_id = revision.id
            LEFT JOIN article_responsibility_snapshot responsibility
              ON responsibility.article_revision_id = revision.id
            LEFT JOIN article_publication publication
              ON publication.id = article.current_publication_id
            WHERE article.id = @ArticleId;
            """,
            new SugarParameter("@ArticleId", articleId));
        if (!await reader.ReadAsync(Ct).ConfigureAwait(false))
        {
            throw new InvalidOperationException($"Article {articleId} has no current version coordinates.");
        }

        return new ArticleVersionCoordinates(
            reader.ReadInt64("revision_id"),
            reader.ReadInt32("revision_no"),
            reader.ReadInt64("rights_snapshot_id"),
            reader.IsNull("responsibility_snapshot_id") ? null : reader.ReadInt64("responsibility_snapshot_id"),
            reader.IsNull("publication_id") ? null : reader.ReadInt64("publication_id"),
            reader.IsNull("publication_no") ? null : reader.ReadInt32("publication_no"));
    }

    public Task<bool> UpdateAsync(int id, ArticleWriteRequestCoreModel dto, CancellationToken cancellationToken = default)
        => UpdateAsync(id, dto, transitionKind: null, force: false, rollback: null, cancellationToken);

    private async Task<bool> UpdateAsync(
        int id,
        ArticleWriteRequestCoreModel dto,
        string? transitionKind,
        bool force,
        ArticleRollbackMetadata? rollback,
        CancellationToken cancellationToken)
    {
        CancellationToken ct = ResolveCancellationToken(cancellationToken);
        ct.ThrowIfCancellationRequested();
        var state = await LoadArticleUpdateStateAsync(id);
        if (state is null)
        {
            return false;
        }

        if (!force && dto.BaseRevisionId != state.CurrentRevisionId)
        {
            throw state.ToConflictException();
        }

        var title = NormalizeText(dto.Title, MaxTitleLength);
        var content = NormalizeText(dto.Content, MaxContentLength);
        var summary = NormalizeText(dto.Summary, MaxSummaryLength);
        var coverImageUrl = NormalizeText(dto.CoverImageUrl, 512);
        var tagIds = NormalizeTagIds(dto.TagIds);
        ArticleSummaryProjectionResult summaryProjection = ArticleSummaryProjection.Resolve(summary, content);
        string safeSummary = summaryProjection.Text;
        DateTime now = DateTime.UtcNow;
        ArticleStatus requestedStatus = (ArticleStatus)dto.Status;
        ValidateWriteTarget(requestedStatus, dto.ScheduledPublishAt, now);

        ArticleStatus status = requestedStatus;
        DateTime? scheduledPublishAt = status == ArticleStatus.Scheduled ? dto.ScheduledPublishAt : null;
        DateTime? publishedAt = state.PublishedAt ?? (status == ArticleStatus.Published ? now : null);
        bool requiresPublicFence = ArticlePublication.IsPubliclyVisible(
                state.Status,
                isDeleted: false,
                publishedAt: state.PublishedAt,
                scheduledPublishAt: null,
                utcNow: now)
            || ArticlePublication.IsPubliclyVisible(
                status,
                isDeleted: false,
                publishedAt: publishedAt,
                scheduledPublishAt: scheduledPublishAt,
                utcNow: now);
        bool fenceEstablished = false;
        bool mutationCommitted = false;
        try
        {
            if (requiresPublicFence)
            {
                await _mutationFence.BeginPublicMutationFenceAsync(id, ct).ConfigureAwait(false);
                fenceEstablished = true;
            }

            bool articleUpdated = false;
            var result = await _db.Ado.UseTranAsync(async () =>
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

                bool updated = await TryUpdateArticleRowAsync(
                    state,
                    id,
                    title,
                    safeSummary,
                    coverImageUrl,
                    dto.CategoryId,
                    force ? null : dto.BaseRevisionId);
                if (!updated)
                {
                    ArticleUpdateState? current = await LoadArticleUpdateStateAsync(id);
                    if (current is not null)
                    {
                        throw current.ToConflictException();
                    }

                    return;
                }

                articleUpdated = true;
                await UpsertArticleBodyAsync(id, content, now);
                await ApplyArticleTagsAsync(id, tagIds);
                ArticleRevisionCoordinates revision = await SaveArticleRevisionAsync(
                    id,
                    title,
                    content,
                    safeSummary,
                    coverImageUrl,
                    dto.CategoryId,
                    tagIds,
                    ArticleSummaryProjection.AttachGenerationVersion("article updated", summaryProjection),
                    rollback);
                var assetReferences = new ArticleAssetReferenceStore(_db);
                await assetReferences.ReplaceCurrentArticleAsync(id, content, coverImageUrl, ct).ConfigureAwait(false);
                await assetReferences.ReplaceRevisionAsync(revision.Id, id, content, coverImageUrl, ct).ConfigureAwait(false);
                ArticleRightsWriteModel rights = await ResolveUpdateArticleRightsAsync(id, dto, rollback).ConfigureAwait(false);
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
                    publishedAt,
                    scheduledPublishAt,
                    rights);
                long? responsibilitySnapshotId = rollback.HasValue
                    ? await CloneResponsibilitySnapshotAsync(id, revision, rollback.Value.SourceRevisionId).ConfigureAwait(false)
                    : await LoadResponsibilitySnapshotIdAsync(revision.Id);
                ArticleVersionCoordinates version = await ArticlePublicationTransitionWriter.ApplyAsync(
                    _db,
                    new ArticlePublicationTransitionRequest(
                        id,
                        ArticleVersionCoordinates.Revision(revision.Id, revision.RevisionNo, rightsSnapshotId, responsibilitySnapshotId),
                        status,
                        scheduledPublishAt,
                        now,
                        transitionKind ?? TransitionKindFor(status),
                        transitionKind == ArticlePublicationTransitionKinds.Rollback
                            ? ArticleStatusTransitionOperation.Rollback
                            : ArticleStatusTransitionOperation.Update));
                await RecordArticleMutationOutboxAsync(id, ArticleMutationEventTypes.Updated, version);
            });

            mutationCommitted = result.IsSuccess && articleUpdated;
            ct.ThrowIfCancellationRequested();
            if (mutationCommitted)
            {
                await InvalidateCache(id);
                ct.ThrowIfCancellationRequested();
                await InvalidatePublicAotAsync(
                    id,
                    MergeIds([state.CategoryId], [dto.CategoryId]),
                    MergeIds(state.TagIds, tagIds),
                    "update");
                ct.ThrowIfCancellationRequested();
                ArticleListItemResponse? realtimePreview = await LoadRealtimePreviewAsync(id);
                ct.ThrowIfCancellationRequested();
                await _mutationSideEffects.AfterUpdatedAsync(id, realtimePreview);
                return true;
            }
            if (result.ErrorException is ArticleWriteValidationException validationException)
            {
                throw validationException;
            }
            if (result.ErrorException is ArticleRevisionConflictException revisionConflictException)
            {
                throw revisionConflictException;
            }
            if (result.ErrorException is not null)
            {
                throw result.ErrorException;
            }
            return false;
        }
        finally
        {
            if (fenceEstablished && !mutationCommitted)
            {
                await RecoverAbortedPublicMutationFenceAsync(id, "article-update-fence-aborted").ConfigureAwait(false);
            }
        }
    }

    private async Task<ArticleUpdateState?> LoadArticleUpdateStateAsync(int articleId)
    {
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT a.categoryid,
                   a.xmin::text AS row_version,
                   a.status,
                   a.published_at,
                   a.current_revision_id,
                   revision.revision_no,
                   revision.created_at AS revision_updated_at,
                   COALESCE(
                       array_agg(at.tagid ORDER BY at.tagid)
                           FILTER (WHERE at.tagid IS NOT NULL),
                       ARRAY[]::integer[]
                   ) AS tag_ids
            FROM article a
            JOIN article_revision revision ON revision.id = a.current_revision_id
            LEFT JOIN article_tag at ON at.articleid = a.id
            WHERE a.id = @ArticleId
              AND a.isdeleted = false
            GROUP BY a.id, a.categoryid, a.xmin, a.status, a.published_at,
                     a.current_revision_id, revision.revision_no, revision.created_at;
            """,
            new SugarParameter("@ArticleId", articleId));
        if (!await reader.ReadAsync(Ct))
        {
            return null;
        }

        int categoryId = reader.ReadInt32("categoryid");
        string rowVersion = reader.ReadString("row_version");
        var status = (ArticleStatus)reader.ReadInt32("status");
        DateTime? publishedAt = reader.IsNull("published_at")
            ? null
            : NormalizeArticleListTimestampUtc(reader.ReadDateTime("published_at"));
        int[] tags = reader.ReadFieldValue<int[]>("tag_ids");
        return new ArticleUpdateState(
            categoryId,
            tags.ToList(),
            rowVersion,
            status,
            publishedAt,
            reader.ReadInt64("current_revision_id"),
            reader.ReadInt32("revision_no"),
            NormalizeArticleListTimestampUtc(reader.ReadDateTime("revision_updated_at")));
    }

    private Task UpsertArticleBodyAsync(int articleId, string markdownContent, DateTime updatedAt)
        => _db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_body (article_id, markdown_content, updated_at)
            VALUES (@ArticleId, @MarkdownContent, @UpdatedAt)
            ON CONFLICT (article_id)
            DO UPDATE SET
                markdown_content = EXCLUDED.markdown_content,
                updated_at = EXCLUDED.updated_at
            WHERE article_body.markdown_content IS DISTINCT FROM EXCLUDED.markdown_content;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@MarkdownContent", markdownContent),
            new SugarParameter("@UpdatedAt", updatedAt));

    private async Task<bool> TryUpdateArticleRowAsync(
        ArticleUpdateState state,
        int articleId,
        string title,
        string summary,
        string? coverImageUrl,
        int categoryId,
        long? baseRevisionId)
    {
        int affectedRows = await _db.Ado.ExecuteCommandAsync(
            """
            UPDATE article
            SET title = @Title,
                summary = @Summary,
                coverimageurl = @CoverImageUrl,
                categoryid = @CategoryId
            WHERE id = @ArticleId
              AND isdeleted = false
              AND (@BaseRevisionId = 0 OR current_revision_id = @BaseRevisionId)
              AND xmin::text = @RowVersion;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@RowVersion", state.RowVersion),
            new SugarParameter("@BaseRevisionId", baseRevisionId.GetValueOrDefault()),
            new SugarParameter("@Title", title),
            new SugarParameter("@Summary", summary),
            new SugarParameter("@CoverImageUrl", (object?)coverImageUrl ?? DBNull.Value),
            new SugarParameter("@CategoryId", categoryId));
        return affectedRows > 0;
    }

    private async Task ApplyArticleTagsAsync(int articleId, List<int> tagIds)
    {
        var parameters = new List<SugarParameter>(tagIds.Count + 1)
        {
            new("@ArticleId", articleId)
        };
        string desiredTagsSql;
        if (tagIds.Count == 0)
        {
            desiredTagsSql = "SELECT NULL::integer AS tagid WHERE false";
        }
        else
        {
            var values = new string[tagIds.Count];
            for (int i = 0; i < tagIds.Count; i++)
            {
                string parameterName = string.Concat("@TagId", i.ToString(System.Globalization.CultureInfo.InvariantCulture));
                values[i] = string.Concat("(", parameterName, ")");
                parameters.Add(new SugarParameter(parameterName, tagIds[i]));
            }

            desiredTagsSql = string.Concat("VALUES ", string.Join(", ", values));
        }

        await _db.Ado.ExecuteCommandAsync(
            $"""
            WITH desired_tags AS (
                SELECT DISTINCT tagid
                FROM ({desiredTagsSql}) AS input(tagid)
            ),
            deleted_tags AS (
                DELETE FROM article_tag existing
                WHERE existing.articleid = @ArticleId
                  AND NOT EXISTS (
                      SELECT 1
                      FROM desired_tags desired
                      WHERE desired.tagid = existing.tagid
                  )
                RETURNING existing.tagid
            )
            INSERT INTO article_tag (articleid, tagid)
            SELECT @ArticleId, desired.tagid
            FROM desired_tags desired
            ON CONFLICT (articleid, tagid) DO NOTHING;
            """,
            parameters);
    }

    private sealed record ArticleUpdateState(
        int CategoryId,
        List<int> TagIds,
        string RowVersion,
        ArticleStatus Status,
        DateTime? PublishedAt,
        long CurrentRevisionId,
        int RevisionNo,
        DateTime UpdatedAtUtc)
    {
        public ArticleRevisionConflictException ToConflictException()
            => new(CurrentRevisionId, RevisionNo, (int)Status, UpdatedAtUtc);
    }

    private static string TransitionKindFor(ArticleStatus status)
        => status switch
        {
            ArticleStatus.Draft => ArticlePublicationTransitionKinds.SaveDraft,
            ArticleStatus.Scheduled => ArticlePublicationTransitionKinds.Schedule,
            ArticleStatus.Archived => ArticlePublicationTransitionKinds.Archive,
            _ => ArticlePublicationTransitionKinds.ImmediatePublish
        };

    private static void ValidateWriteTarget(
        ArticleStatus status,
        DateTime? scheduledPublishAt,
        DateTime utcNow)
    {
        ArticleStatusTransitionValidation? validation = ArticleStatusTransitionPolicy.ValidateTarget(
            (int)status,
            scheduledPublishAt,
            utcNow);
        if (validation.HasValue)
        {
            throw new ArticleStatusTransitionValidationException(validation.Value);
        }
    }

    private async Task<long?> LoadResponsibilitySnapshotIdAsync(long revisionId)
    {
        long value = await _db.Queryable<ArticleResponsibilitySnapshot>()
            .Where(snapshot => snapshot.ArticleRevisionId == revisionId)
            .Select(snapshot => snapshot.Id)
            .FirstAsync(Ct);
        return value > 0 ? value : null;
    }

    private async Task<long> CloneResponsibilitySnapshotAsync(
        int articleId,
        ArticleRevisionCoordinates targetRevision,
        long sourceRevisionId)
    {
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            INSERT INTO article_responsibility_snapshot (
                article_id,
                article_revision_id,
                revision_no,
                inherit_site_author,
                authors_json,
                reviewer_json,
                sources_json,
                update_summary,
                update_reason,
                effective_at,
                conclusion_impact,
                methodology,
                applicability,
                limitations,
                responsible_person_confirmed,
                created_at)
            SELECT
                @ArticleId,
                @TargetRevisionId,
                @TargetRevisionNo,
                inherit_site_author,
                authors_json,
                reviewer_json,
                sources_json,
                update_summary,
                update_reason,
                effective_at,
                conclusion_impact,
                methodology,
                applicability,
                limitations,
                responsible_person_confirmed,
                @CreatedAt
            FROM article_responsibility_snapshot
            WHERE article_id = @ArticleId
              AND article_revision_id = @SourceRevisionId
            RETURNING id;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@TargetRevisionId", targetRevision.Id),
            new SugarParameter("@TargetRevisionNo", targetRevision.RevisionNo),
            new SugarParameter("@SourceRevisionId", sourceRevisionId),
            new SugarParameter("@CreatedAt", DateTime.UtcNow));
        if (await reader.ReadAsync(Ct).ConfigureAwait(false))
        {
            return reader.ReadInt64("id");
        }

        throw new ArticleWriteValidationException(
            "article_revision_package_incomplete",
            "The historical revision has no responsibility snapshot.");
    }

    private sealed record ArticleMutationState(List<int> CategoryIds, List<int> TagIds, string RowVersion);

}
