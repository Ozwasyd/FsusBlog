using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;
using SqlSugar;
using StackExchange.Redis;
using System.Data;
using System.Data.Common;
using System.Runtime.CompilerServices;

namespace FsusBlog.Server.Services;

/// <summary>
/// 文章核心业务服务
/// 修复日期: 2026-02-23 (应用 DataReader 物理级映射，引入 MemoryCache 实现 Double-Check 缓存锁，彻底解决后台作用域销毁炸弹)
///[架构重构 2026-03-01]
/// 1. 废弃 Read-Time 摘要计算，改为 Write-Time 计算，消灭 LOH 内存暴涨与网络带宽冗余。
/// 2. 补充 RegisterPostEvictionCallback 解决 SemaphoreSlim 游离造成的内核句柄泄露。
/// 3. 废弃高危的 Task.Run 游离线程，阻塞等待搜索索引落盘，杜绝生产环境滚动发版导致的索引永久损坏。
/// 4. 引入 IN(...) 容量阀门与 Parallel.ForEachAsync 控制外部 I/O 并发风暴。
/// </summary>
public class ArticleService(
    ISqlSugarClient _db,
    ISearchIndexService _searchIndex,
    IConnectionMultiplexer _redisConnection,
    IUnifiedCache _cache,
    ICacheMissCoordinator _cacheMissCoordinator,
    IDbConcurrencyGate _dbConcurrencyGate,
    IRuntimeKeyScope _runtimeKeyScope,
    IHttpContextAccessor _httpContextAccessor,
    ILogger<ArticleService> _logger,
    IPublicAotInvalidationService _publicAotInvalidationService,
    ICacheInvalidationDispatcher _cacheInvalidationDispatcher,
    IArticleMutationSideEffectCoordinator _mutationSideEffects) : IArticleService
{
    private readonly record struct TrashArticleRow(int Id, int CategoryId);

    private const int MaxPageSize = 100;
    private const int MaxSearchKeywordLength = 128;
    private const int MaxHotArticlesCount = 100;
    private const int MaxTitleLength = 256;
    private const int MaxSummaryLength = 512;
    private const int MaxContentLength = 200_000;
    private const int MaxTagIds = 32;
    private const int LongReadThreshold = 5_000;
    private const int ReadingCharsPerMinute = 300;
    private const int PublicKeysetWalkPageThreshold = 3;

    private readonly IDatabase _redis = _redisConnection.GetDatabase();
    private static int s_legacyArticleContentColumnState;

    private CancellationToken Ct => _httpContextAccessor.HttpContext?.RequestAborted ?? CancellationToken.None;

    private CancellationToken ResolveCancellationToken(CancellationToken cancellationToken)
        => cancellationToken.CanBeCanceled ? cancellationToken : Ct;

    public async ValueTask IncreaseViewCountAsync(int id)
        => await IncreaseViewCountAsync(id, 1);

    public async ValueTask IncreaseViewCountAsync(int id, int count)
    {
        if (count <= 0)
        {
            return;
        }

        int? currentViews = await TryIncreaseArticleViewsAsync(id, count);
        if (!currentViews.HasValue)
        {
            await _redis.SortedSetRemoveAsync(RedisKey("blog:top_articles"), id);
            return;
        }

        await _redis.SortedSetAddAsync(RedisKey("blog:top_articles"), id, currentViews.Value);

        // 逻辑自洽：增加阅读量不触发全局列表版本号变更
        await _cache.RemoveAsync(CachePolicyId.ArticleDetail, id.ToString());
    }

    private async Task<int?> TryIncreaseArticleViewsAsync(int id, int count)
    {
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            UPDATE article
            SET views = views + @Count
            WHERE id = @Id
              AND isdeleted = false
            RETURNING views;
            """,
            new SugarParameter("@Id", id),
            new SugarParameter("@Count", count));
        if (!await reader.ReadAsync(Ct))
        {
            return null;
        }

        return reader.GetInt32(0);
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
            ") AS v(id, delta) WHERE a.id = v.id AND a.isdeleted = false RETURNING a.id;");

        var updatedIds = new HashSet<int>();
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sql.ToString(), parameters))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                updatedIds.Add(reader.GetInt32(0));
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
                redisTasks.Add(redisBatch.SortedSetIncrementAsync(hotRankKey, articleId, count));
                redisTasks.Add(_cache.RemoveAsync(CachePolicyId.ArticleDetail, articleId.ToString(), cancellationToken));
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
        page = page < 1 ? 1 : page;
        size = size switch
        {
            < 1 => 10,
            > MaxPageSize => MaxPageSize,
            _ => size
        };

        string normalizedKeyword = NormalizeArticleListKeyword(keyword);
        long version = await GetListCacheVersionAsync(effectiveCt);
        string cacheIdentity = BuildArticleListIdentity(version, page, size, categoryId, tagId, isDeleted, status, includePrivate, normalizedKeyword);

        return await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.ArticleList,
                cacheIdentity,
                ct => _cache.TryGetAsync(CachePolicyId.ArticleList, cacheIdentity, ServerCacheBinaryCodec.DecodeArticleListPage, ct),
                async ct => await _dbConcurrencyGate.ExecuteAsync(
                    "article-list",
                    async gateCt =>
                    {
                        ArticleListPageReadModel result = await LoadArticleListPageFromDbAsync(page, size, categoryId, tagId, isDeleted, status, includePrivate, normalizedKeyword, gateCt);
                        gateCt.ThrowIfCancellationRequested();
                        byte[] encoded = ServerCacheBinaryCodec.EncodeArticleListPage(result);
                        gateCt.ThrowIfCancellationRequested();
                        await _cache.SetRawAsync(CachePolicyId.ArticleList, cacheIdentity, encoded, null, gateCt);
                        return result;
                    },
                    async gateCt =>
                    {
                        CacheReadResult<ArticleListPageReadModel> retry = await _cache.TryGetAsync(CachePolicyId.ArticleList, cacheIdentity, ServerCacheBinaryCodec.DecodeArticleListPage, gateCt);
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
        string cacheIdentity = id.ToString();
        if (includePrivate)
        {
            return await LoadArticleDetailFromDbAsync(id, includePrivate: true, cacheIdentity: null, effectiveCt);
        }

        return await _cacheMissCoordinator.CoordinateAsync(
            CachePolicyId.ArticleDetail,
            cacheIdentity,
            gateCt => TryReadArticleDetailCacheAsync(id, cacheIdentity, gateCt),
            gateCt => LoadArticleDetailFromDbAsync(id, includePrivate: false, cacheIdentity, gateCt),
            "article-detail",
            effectiveCt);
    }

    private async Task<CacheReadResult<ArticleDetailReadModel>> TryReadArticleDetailCacheAsync(
        int id,
        string cacheIdentity,
        CancellationToken cancellationToken)
    {
        var detailCache = await _cache.TryGetAsync(CachePolicyId.ArticleDetail, cacheIdentity, ServerCacheBinaryCodec.DecodeArticleDetail, cancellationToken);
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
            return new CacheReadResult<ArticleDetailReadModel>(true, cached);
        }

        string healedContent = await LoadArticleContentAsync(id, cancellationToken);
        if (string.IsNullOrWhiteSpace(healedContent))
        {
            healedContent = cached.Summary ?? string.Empty;
        }

        if (string.IsNullOrWhiteSpace(healedContent))
        {
            return new CacheReadResult<ArticleDetailReadModel>(true, cached);
        }

        int healedWordCount = CalculateReadableLength(healedContent);
        var healed = cached with
        {
            Content = healedContent,
            WordCount = healedWordCount,
            EstimatedReadingMinutes = Math.Max(1, (healedWordCount + ReadingCharsPerMinute - 1) / ReadingCharsPerMinute),
            ShowReadingNotice = healedWordCount > LongReadThreshold
        };
        cancellationToken.ThrowIfCancellationRequested();
        byte[] encodedHealed = ServerCacheBinaryCodec.EncodeArticleDetail(healed);
        cancellationToken.ThrowIfCancellationRequested();
        await _cache.SetRawAsync(CachePolicyId.ArticleDetail, cacheIdentity, encodedHealed, null, cancellationToken);
        return new CacheReadResult<ArticleDetailReadModel>(true, healed);
    }

    private async Task<ArticleDetailReadModel?> LoadArticleDetailFromDbAsync(
        int id,
        bool includePrivate,
        string? cacheIdentity,
        CancellationToken cancellationToken)
    {
        DateTime utcNow = DateTime.UtcNow;
        var baseQuery = _db.Queryable<Article>()
            .LeftJoin<Category>((a, c) => a.CategoryId == c.Id)
            .Where(a => a.Id == id);
        if (!includePrivate)
        {
            baseQuery = baseQuery.Where(a => a.IsDeleted == false
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= utcNow)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= utcNow));
        }

        var query = baseQuery.Select((a, c) => new { a.Id, a.Title, a.Summary, a.CoverImageUrl, a.CategoryId, a.Views, a.CreateTime, a.IsDeleted, a.Status, a.ScheduledPublishAt, a.PublishedAt, CategoryName = c.Name });

        var sqlObj = query.ToSql();
        ArticleDetailReadModel? article = null;
        cancellationToken.ThrowIfCancellationRequested();
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            if (await reader.ReadAsync(cancellationToken))
            {
                int fId = reader.GetOrdinal("Id"), fTitle = reader.GetOrdinal("Title"),
                    fSum = reader.GetOrdinal("Summary"), fCover = reader.GetOrdinal("CoverImageUrl"),
                    fCatId = reader.GetOrdinal("CategoryId"), fViews = reader.GetOrdinal("Views"),
                    fTime = reader.GetOrdinal("CreateTime"), fIsDel = reader.GetOrdinal("IsDeleted"), fStatus = reader.GetOrdinal("Status"),
                    fScheduled = reader.GetOrdinal("ScheduledPublishAt"), fPublished = reader.GetOrdinal("PublishedAt"), fCatName = reader.GetOrdinal("CategoryName");

                article = new ArticleDetailReadModel
                {
                    Id = reader.GetInt32(fId),
                    Title = reader.GetString(fTitle),
                    Summary = reader.IsDBNull(fSum) ? string.Empty : reader.GetString(fSum),
                    CoverImageUrl = reader.IsDBNull(fCover) ? null : reader.GetString(fCover),
                    CategoryId = reader.GetInt32(fCatId),
                    Views = reader.GetInt32(fViews),
                    CreateTime = reader.GetDateTime(fTime),
                    IsDeleted = reader.GetBoolean(fIsDel),
                    Status = (ArticleStatus)reader.GetInt32(fStatus),
                    ScheduledPublishAt = reader.IsDBNull(fScheduled) ? null : reader.GetDateTime(fScheduled),
                    PublishedAt = reader.IsDBNull(fPublished) ? null : reader.GetDateTime(fPublished),
                    CategoryName = reader.IsDBNull(fCatName) ? "默认分类" : reader.GetString(fCatName),
                    Tags = ArticleReadModelCollections.EmptyTags
                };
            }
        }

        if (article != null)
        {
            string content = await LoadArticleContentAsync(id, cancellationToken);
            if (string.IsNullOrWhiteSpace(content) && !string.IsNullOrWhiteSpace(article.Summary))
            {
                content = article.Summary;
            }
            int wordCount = CalculateReadableLength(content);
            int estimatedReadingMinutes = Math.Max(1, (wordCount + ReadingCharsPerMinute - 1) / ReadingCharsPerMinute);
            bool showReadingNotice = wordCount > LongReadThreshold;

            var tags = await LoadArticleTagsAsync(id, cancellationToken);
            article = article with
            {
                Content = content,
                WordCount = wordCount,
                EstimatedReadingMinutes = estimatedReadingMinutes,
                ShowReadingNotice = showReadingNotice,
                Tags = tags
            };
            if (!includePrivate && cacheIdentity is not null)
            {
                cancellationToken.ThrowIfCancellationRequested();
                byte[] encoded = ServerCacheBinaryCodec.EncodeArticleDetail(article);
                cancellationToken.ThrowIfCancellationRequested();
                await _cache.SetRawAsync(CachePolicyId.ArticleDetail, cacheIdentity, encoded, null, cancellationToken);
            }
        }
        else if (!includePrivate && cacheIdentity is not null)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await _cache.SetRawAsync(CachePolicyId.ArticleDetail, cacheIdentity, Array.Empty<byte>(), TimeSpan.FromMinutes(5), cancellationToken);
        }

        return article;
    }

    private async Task<string> LoadArticleContentAsync(int articleId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string content = await _db.Queryable<ArticleBody>()
            .Where(it => it.ArticleId == articleId)
            .Select(it => it.MarkdownContent)
            .FirstAsync(cancellationToken) ?? string.Empty;

        if (!string.IsNullOrWhiteSpace(content))
        {
            return content;
        }

        if (!await LegacyArticleContentColumnExistsAsync(cancellationToken))
        {
            return content;
        }

        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            "SELECT COALESCE(content, '') AS content FROM article WHERE id = @id LIMIT 1;",
            new[] { new SugarParameter("@id", articleId) });
        if (await reader.ReadAsync(cancellationToken) && !reader.IsDBNull(0))
        {
            return reader.GetString(0);
        }

        return string.Empty;
    }

    private async Task<bool> LegacyArticleContentColumnExistsAsync(CancellationToken cancellationToken)
    {
        int state = Volatile.Read(ref s_legacyArticleContentColumnState);
        if (state != 0)
        {
            return state == 1;
        }

        cancellationToken.ThrowIfCancellationRequested();
        int exists = await _db.Ado.GetIntAsync("""
            SELECT COUNT(1)
            FROM information_schema.columns
            WHERE table_name = 'article'
              AND column_name = 'content';
            """);
        cancellationToken.ThrowIfCancellationRequested();
        bool existsInSchema = exists > 0;
        Volatile.Write(ref s_legacyArticleContentColumnState, existsInSchema ? 1 : 2);
        return existsInSchema;
    }

    public async Task<int> CreateAsync(CreateArticleRequest dto, CancellationToken cancellationToken = default)
    {
        CancellationToken ct = ResolveCancellationToken(cancellationToken);
        ct.ThrowIfCancellationRequested();
        var title = NormalizeText(dto.Title, MaxTitleLength);
        var content = NormalizeText(dto.Content, MaxContentLength);
        var summary = NormalizeText(dto.Summary, MaxSummaryLength);
        var coverImageUrl = NormalizeText(dto.CoverImageUrl, 512);
        var tagIds = NormalizeTagIds(dto.TagIds);
        var safeSummary = string.IsNullOrWhiteSpace(summary) ? GenerateSafeSummary(content) : summary;
        DateTime now = DateTime.UtcNow;
        ArticleStatus status = NormalizeWriteStatus(dto.Status, dto.ScheduledPublishAt, now);
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

        var result = await _db.Ado.UseTranAsync(async () => {
            int id = await _db.Insertable(article).ExecuteReturnIdentityAsync();
            await _db.Insertable(new ArticleBody { ArticleId = id, MarkdownContent = content, UpdatedAt = DateTime.UtcNow }).ExecuteCommandAsync();
            if (tagIds.Count > 0)
            {
                await _db.Insertable(BuildArticleTags(id, tagIds)).ExecuteCommandAsync();
            }
            await SaveArticleRevisionAsync(id, title, content, safeSummary, coverImageUrl, dto.CategoryId, tagIds, "initial publish");
            await RecordArticleMutationOutboxAsync(id, "created");
            return id;
        });

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
        _logger.LogError("创建文章失败 | DbError: {Error}", result.ErrorMessage);
        return 0;
    }

    private static int CalculateReadableLength(string? content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return 0;
        }

        int count = 0;
        foreach (char ch in content)
        {
            if (!char.IsWhiteSpace(ch))
            {
                count++;
            }
        }

        return count;
    }

    private static ArticleStatus NormalizeWriteStatus(ArticleStatus requested, DateTime? scheduledPublishAt, DateTime utcNow)
    {
        if (requested == ArticleStatus.Scheduled)
        {
            return scheduledPublishAt.HasValue && scheduledPublishAt.Value > utcNow
                ? ArticleStatus.Scheduled
                : ArticleStatus.Published;
        }

        return requested is ArticleStatus.Draft or ArticleStatus.Published or ArticleStatus.Archived or ArticleStatus.Deleted
            ? requested
            : ArticleStatus.Published;
    }

    private async Task SaveArticleRevisionAsync(
        int articleId,
        string title,
        string content,
        string? summary,
        string? coverImageUrl,
        int categoryId,
        IReadOnlyList<int> tagIds,
        string diffSummary)
    {
        await _db.Ado.ExecuteCommandAsync(
            """
            SELECT pg_advisory_xact_lock(hashtext('article_revision'), @articleId);
            LOCK TABLE article_revision IN ROW EXCLUSIVE MODE;
            """,
            new SugarParameter[] { new("@articleId", articleId) });
        long actorAdminPrincipalId = ResolveRevisionAdminPrincipalId();
        string orderedTagIds = string.Join(',', tagIds.OrderBy(static id => id));
        await _db.Ado.ExecuteCommandAsync(
            """
            WITH locked_article AS (
                SELECT id, xmin::text AS row_version
                FROM article
                WHERE id = @articleId
                  AND isdeleted = false
                FOR UPDATE
            ),
            locked_revisions AS (
                SELECT revision_no
                FROM article_revision
                WHERE article_id = @articleId
                FOR UPDATE
            ),
            next_revision AS (
                SELECT locked_article.id AS article_id,
                       locked_article.row_version,
                       COALESCE(MAX(revision_no), 0) + 1 AS revision_no
                FROM locked_article
                LEFT JOIN locked_revisions ON TRUE
                GROUP BY locked_article.id, locked_article.row_version
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
                @createdAt
            FROM next_revision;
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
                new("@createdAt", DateTime.UtcNow)
            });
    }

    private long ResolveRevisionAdminPrincipalId()
        => _httpContextAccessor.HttpContext?.User.TryGetAdminPrincipalId(out long adminPrincipalId) == true
            ? adminPrincipalId
            : 0;

    private Task RecordArticleMutationOutboxAsync(int articleId, string eventType)
        => _db.Insertable(new ArticleMutationOutboxEvent
        {
            EventId = Guid.NewGuid().ToString("N"),
            AggregateId = articleId,
            EventType = eventType,
            PayloadJson = $"{{\"articleId\":{articleId},\"eventType\":\"{eventType}\"}}",
            Status = "pending",
            RetryCount = 0,
            NextRetryAt = DateTime.UtcNow,
            CreatedAt = DateTime.UtcNow
        }).ExecuteCommandAsync();

    public async Task<bool> UpdateAsync(int id, UpdateArticleRequest dto, CancellationToken cancellationToken = default)
    {
        CancellationToken ct = ResolveCancellationToken(cancellationToken);
        ct.ThrowIfCancellationRequested();
        var state = await LoadArticleUpdateStateAsync(id);
        if (state is null)
        {
            return false;
        }

        var title = NormalizeText(dto.Title, MaxTitleLength);
        var content = NormalizeText(dto.Content, MaxContentLength);
        var summary = NormalizeText(dto.Summary, MaxSummaryLength);
        var coverImageUrl = NormalizeText(dto.CoverImageUrl, 512);
        var tagIds = NormalizeTagIds(dto.TagIds);
        var safeSummary = string.IsNullOrWhiteSpace(summary) ? GenerateSafeSummary(content) : summary;
        DateTime now = DateTime.UtcNow;
        ArticleStatus status = NormalizeWriteStatus(dto.Status, dto.ScheduledPublishAt, now);
        DateTime? scheduledPublishAt = status == ArticleStatus.Scheduled ? dto.ScheduledPublishAt : null;
        DateTime? publishedAt = status == ArticleStatus.Published ? now : null;
        DateTime? archivedAt = status == ArticleStatus.Archived ? now : null;

        bool articleUpdated = false;
        var result = await _db.Ado.UseTranAsync(async () =>
        {
            bool updated = await TryUpdateArticleRowAsync(
                state,
                id,
                title,
                safeSummary,
                coverImageUrl,
                dto.CategoryId,
                status,
                scheduledPublishAt,
                publishedAt,
                archivedAt,
                status == ArticleStatus.Deleted,
                status == ArticleStatus.Deleted ? now : null);
            if (!updated)
            {
                return;
            }

            articleUpdated = true;
            await _db.Storageable(new ArticleBody { ArticleId = id, MarkdownContent = content, UpdatedAt = DateTime.UtcNow }).ExecuteCommandAsync();
            await ApplyArticleTagsAsync(id, tagIds);
            await SaveArticleRevisionAsync(id, title, content, safeSummary, coverImageUrl, dto.CategoryId, tagIds, "article updated");
            await RecordArticleMutationOutboxAsync(id, "updated");
        });

        ct.ThrowIfCancellationRequested();
        if (result.IsSuccess && articleUpdated)
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
        return false;
    }

    private async Task<ArticleUpdateState?> LoadArticleUpdateStateAsync(int articleId)
    {
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT a.categoryid,
                   a.xmin::text AS row_version,
                   COALESCE(
                       array_agg(at.tagid ORDER BY at.tagid)
                           FILTER (WHERE at.tagid IS NOT NULL),
                       ARRAY[]::integer[]
                   ) AS tag_ids
            FROM article a
            LEFT JOIN article_tag at ON at.articleid = a.id
            WHERE a.id = @ArticleId
              AND a.isdeleted = false
            GROUP BY a.id, a.categoryid, a.xmin;
            """,
            new SugarParameter("@ArticleId", articleId));
        if (!await reader.ReadAsync(Ct))
        {
            return null;
        }

        int categoryId = reader.GetInt32(0);
        string rowVersion = reader.GetString(1);
        int[] tags = reader.GetFieldValue<int[]>(2);
        return new ArticleUpdateState(categoryId, tags.ToList(), rowVersion);
    }

    private async Task<bool> TryUpdateArticleRowAsync(
        ArticleUpdateState state,
        int articleId,
        string title,
        string summary,
        string? coverImageUrl,
        int categoryId,
        ArticleStatus status,
        DateTime? scheduledPublishAt,
        DateTime? publishedAt,
        DateTime? archivedAt,
        bool isDeleted,
        DateTime? deletedAt)
    {
        int affectedRows = await _db.Ado.ExecuteCommandAsync(
            """
            UPDATE article
            SET title = @Title,
                summary = @Summary,
                coverimageurl = @CoverImageUrl,
                categoryid = @CategoryId,
                status = @Status,
                scheduled_publish_at = CAST(@ScheduledPublishAt AS timestamp),
                published_at = CAST(@PublishedAt AS timestamp),
                archived_at = CAST(@ArchivedAt AS timestamp),
                isdeleted = @IsDeleted,
                deleted_at = CAST(@DeletedAt AS timestamp)
            WHERE id = @ArticleId
              AND isdeleted = false
              AND xmin::text = @RowVersion;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@RowVersion", state.RowVersion),
            new SugarParameter("@Title", title),
            new SugarParameter("@Summary", summary),
            new SugarParameter("@CoverImageUrl", (object?)coverImageUrl ?? DBNull.Value),
            new SugarParameter("@CategoryId", categoryId),
            new SugarParameter("@Status", (int)status),
            new SugarParameter("@ScheduledPublishAt", (object?)scheduledPublishAt ?? DBNull.Value),
            new SugarParameter("@PublishedAt", (object?)publishedAt ?? DBNull.Value),
            new SugarParameter("@ArchivedAt", (object?)archivedAt ?? DBNull.Value),
            new SugarParameter("@IsDeleted", isDeleted),
            new SugarParameter("@DeletedAt", (object?)deletedAt ?? DBNull.Value));
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

    private sealed record ArticleUpdateState(int CategoryId, List<int> TagIds, string RowVersion);

    public async Task<bool> DeleteAsync(int id, CancellationToken cancellationToken = default)
    {
        CancellationToken ct = ResolveCancellationToken(cancellationToken);
        ct.ThrowIfCancellationRequested();
        var state = await LoadArticleAotStateAsync(id);
        DateTime now = DateTime.UtcNow;
        bool success = false;
        var result = await _db.Ado.UseTranAsync(async () =>
        {
            int updated = await _db.Updateable<Article>()
                .SetColumns(it => it.IsDeleted == true)
                .SetColumns(it => it.Status == ArticleStatus.Deleted)
                .SetColumns(it => it.DeletedAt == now)
                .Where(it => it.Id == id)
                .ExecuteCommandAsync();
            if (updated > 0)
            {
                success = true;
                await RecordArticleMutationOutboxAsync(id, "deleted");
            }
        });
        ct.ThrowIfCancellationRequested();
        success = result.IsSuccess && success;
        if (success)
        {
            await InvalidateCache(id);
            ct.ThrowIfCancellationRequested();
            await InvalidatePublicAotAsync(id, state.CategoryIds, state.TagIds, "delete");
            ct.ThrowIfCancellationRequested();
            await _mutationSideEffects.AfterDeletedAsync(id);
        }
        return success;
    }

    public async Task<bool> RestoreAsync(int id, CancellationToken cancellationToken = default)
    {
        CancellationToken ct = ResolveCancellationToken(cancellationToken);
        ct.ThrowIfCancellationRequested();
        var state = await LoadArticleAotStateAsync(id);
        DateTime now = DateTime.UtcNow;
        bool success = false;
        var result = await _db.Ado.UseTranAsync(async () =>
        {
            int updated = await _db.Updateable<Article>()
                .SetColumns(it => it.IsDeleted == false)
                .SetColumns(it => it.Status == ArticleStatus.Published)
                .SetColumns(it => it.DeletedAt == null)
                .SetColumns(it => it.PublishedAt == now)
                .Where(it => it.Id == id)
                .ExecuteCommandAsync();
            if (updated > 0)
            {
                success = true;
                await RecordArticleMutationOutboxAsync(id, "restored");
            }
        });
        ct.ThrowIfCancellationRequested();
        success = result.IsSuccess && success;
        if (success)
        {
            await InvalidateCache(id);
            ct.ThrowIfCancellationRequested();
            await InvalidatePublicAotAsync(id, state.CategoryIds, state.TagIds, "restore");
            ct.ThrowIfCancellationRequested();
            ArticleListItemResponse? realtimePreview = await LoadRealtimePreviewAsync(id);
            ct.ThrowIfCancellationRequested();
            await _mutationSideEffects.AfterRestoredAsync(id, realtimePreview);
        }
        return success;
    }

    public async Task<bool> PermanentlyDeleteArticleAsync(int id, CancellationToken cancellationToken = default)
    {
        CancellationToken ct = ResolveCancellationToken(cancellationToken);
        ct.ThrowIfCancellationRequested();
        var article = await _db.Queryable<Article>().ClearFilter().InSingleAsync(id);
        if (article == null) return false;
        ct.ThrowIfCancellationRequested();
        article.Content = await _db.Queryable<ArticleBody>().Where(it => it.ArticleId == id).Select(it => it.MarkdownContent).FirstAsync() ?? string.Empty;
        ct.ThrowIfCancellationRequested();
        var tagIds = await LoadArticleTagIdsAsync(id);
        var imageUrls = ImageHelper.ExtractIllustrationUrls(article.Content);

        var result = await _db.Ado.UseTranAsync(async () => {
            await _db.Deleteable<Comment>().Where(c => c.ArticleId == id).ExecuteCommandAsync();
            await _db.Deleteable<ArticleTag>().Where(at => at.ArticleId == id).ExecuteCommandAsync();
            await _db.Deleteable<ArticleBody>().Where(it => it.ArticleId == id).ExecuteCommandAsync();
            await RecordArticleMutationOutboxAsync(id, "permanently-deleted");
            return await _db.Deleteable<Article>().In(id).ExecuteCommandAsync();
        });

        ct.ThrowIfCancellationRequested();
        if (result.IsSuccess)
        {
            await InvalidateCache(id);
            ct.ThrowIfCancellationRequested();
            await InvalidatePublicAotAsync(id, [article.CategoryId], tagIds, "permanent-delete");
            ct.ThrowIfCancellationRequested();
            await _mutationSideEffects.AfterPermanentlyDeletedAsync(id, imageUrls, ct);
            return true;
        }
        return false;
    }

    public async Task<int> ClearTrashAsync(CancellationToken cancellationToken = default)
    {
        CancellationToken ct = ResolveCancellationToken(cancellationToken);
        ct.ThrowIfCancellationRequested();

        List<int> articleIds = [];
        List<int> categoryIds = [];
        List<int> tagIds = [];
        Dictionary<int, string> trashedBodyMap = new();
        ct.ThrowIfCancellationRequested();
        var result = await _db.Ado.UseTranAsync(async () => {
            List<TrashArticleRow> lockedTrashArticles = await LoadTrashArticlesForUpdateAsync(ct);
            if (lockedTrashArticles.Count == 0)
            {
                return 0;
            }

            articleIds = lockedTrashArticles.Select(static a => a.Id).ToList();
            categoryIds = lockedTrashArticles.Select(static a => a.CategoryId).Distinct().ToList();
            tagIds = await LoadArticleTagIdsAsync(articleIds);
            trashedBodyMap = (await _db.Queryable<ArticleBody>()
                .Where(it => articleIds.Contains(it.ArticleId))
                .Select(it => new { it.ArticleId, it.MarkdownContent })
                .ToListAsync(ct))
                .ToDictionary(static it => it.ArticleId, static it => it.MarkdownContent);

            //[修改日期 2026-03-01]
            // 物理防线：将上千个 ID 拆分为每批 500 个的块 (Chunking) 进行删除事务。
            // 防止构建超出数据库解析上限的超大 IN (...) 语法树。
            foreach (var chunk in articleIds.Chunk(500))
            {
                await _db.Deleteable<Comment>().Where(c => chunk.Contains(c.ArticleId)).ExecuteCommandAsync();
                await _db.Deleteable<ArticleTag>().Where(at => chunk.Contains(at.ArticleId)).ExecuteCommandAsync();
                await _db.Deleteable<ArticleBody>().Where(it => chunk.Contains(it.ArticleId)).ExecuteCommandAsync();
                foreach (int articleId in chunk)
                {
                    await RecordArticleMutationOutboxAsync(articleId, "trash-cleared");
                }
                await _db.Deleteable<Article>()
                    .Where(it => chunk.Contains(it.Id) && it.IsDeleted)
                    .ExecuteCommandAsync();
            }
            return articleIds.Count;
        });

        ct.ThrowIfCancellationRequested();
        if (result.IsSuccess)
        {
            await InvalidateCache();
            ct.ThrowIfCancellationRequested();
            await InvalidatePublicAotBatchAsync(articleIds, categoryIds, tagIds, "clear-trash");
            ct.ThrowIfCancellationRequested();
            await _mutationSideEffects.AfterTrashClearedAsync(articleIds, trashedBodyMap, ct);
            return result.Data;
        }
        _logger.LogError("清空回收站失败 | DbError: {Error}", result.ErrorMessage);
        return -1;
    }

    private async Task<List<TrashArticleRow>> LoadTrashArticlesForUpdateAsync(CancellationToken cancellationToken)
    {
        var rows = new List<TrashArticleRow>();
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT id, categoryid
            FROM article
            WHERE isdeleted = true
            FOR UPDATE;
            """);
        while (await reader.ReadAsync(cancellationToken))
        {
            rows.Add(new TrashArticleRow(reader.GetInt32(0), reader.GetInt32(1)));
        }

        return rows;
    }

    public async Task<List<ArticleListItemReadModel>> SearchArticlesAsync(string keyword, CancellationToken cancellationToken = default)
    {
        CancellationToken effectiveCt = ResolveCancellationToken(cancellationToken);
        effectiveCt.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(keyword))
        {
            return [];
        }

        keyword = keyword.Trim();
        if (keyword.Length > MaxSearchKeywordLength)
        {
            keyword = keyword[..MaxSearchKeywordLength];
        }

        string cacheIdentity = $"keyword:{keyword}";

        return await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.ArticleSearch,
                cacheIdentity,
                ct => _cache.TryGetAsync(CachePolicyId.ArticleSearch, cacheIdentity, ServerCacheBinaryCodec.DecodeArticleSearch, ct),
                async ct => await _dbConcurrencyGate.ExecuteAsync(
                    "article-search",
                    async gateCt =>
                    {
                        List<ArticleListItemReadModel> result = await LoadSearchArticlesFromSourceAsync(keyword, gateCt);
                        gateCt.ThrowIfCancellationRequested();
                        byte[] encoded = ServerCacheBinaryCodec.EncodeArticleSearch(result);
                        gateCt.ThrowIfCancellationRequested();
                        await _cache.SetRawAsync(CachePolicyId.ArticleSearch, cacheIdentity, encoded, null, gateCt);
                        return result;
                    },
                    async gateCt =>
                    {
                        CacheReadResult<List<ArticleListItemReadModel>> retry = await _cache.TryGetAsync(CachePolicyId.ArticleSearch, cacheIdentity, ServerCacheBinaryCodec.DecodeArticleSearch, gateCt);
                        if (retry.Hit)
                        {
                            return retry.Value ?? [];
                        }

                        throw new TimeoutException($"db-gate-timeout:article-search:{keyword}");
                    },
                    ct),
                "article-search",
                effectiveCt)
            .ConfigureAwait(false)
            ?? [];
    }

    public async Task<List<PopularArticleSummaryDto>> GetHotArticlesAsync(int count = 10, CancellationToken cancellationToken = default)
    {
        CancellationToken effectiveCt = ResolveCancellationToken(cancellationToken);
        effectiveCt.ThrowIfCancellationRequested();
        count = count switch
        {
            < 1 => 10,
            > MaxHotArticlesCount => MaxHotArticlesCount,
            _ => count
        };

        string redisKey = RedisKey("blog:top_articles");
        List<int> ids = await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.TopArticles,
                $"seed:{count}",
                ct => TryReadHotArticleSeedAsync(redisKey, count, ct),
                async ct => await _dbConcurrencyGate.ExecuteAsync(
                    "article-hot-seed",
                    gateCt => SeedHotArticlesAsync(redisKey, count, gateCt),
                    async gateCt =>
                    {
                        CacheReadResult<List<int>> retry = await TryReadHotArticleSeedAsync(redisKey, count, gateCt);
                        if (retry.Hit && retry.Value is not null)
                        {
                            return retry.Value;
                        }

                        throw new TimeoutException($"db-gate-timeout:article-hot-seed:{count}");
                    },
                    ct),
                "article-hot-seed",
                effectiveCt)
            .ConfigureAwait(false)
            ?? [];

        if (ids.Count == 0)
        {
            return [];
        }

        DateTime now = DateTime.UtcNow;
        effectiveCt.ThrowIfCancellationRequested();
        var sqlObj = _db.Queryable<Article>()
            .In(a => a.Id, ids)
            .Where(a => !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now))
            .Select(a => new { a.Id, a.Title, a.Views })
            .ToSql();
        var articles = new List<PopularArticleSummaryDto>(ids.Count);
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id"), fTitle = reader.GetOrdinal("Title"), fViews = reader.GetOrdinal("Views");
            while (await reader.ReadAsync(effectiveCt))
            {
                articles.Add(new PopularArticleSummaryDto(reader.GetInt32(fId), reader.GetString(fTitle), reader.GetInt32(fViews)));
            }
        }
        return OrderHotArticles(ids, articles);
    }

    public async Task<List<FeaturedArticleSummaryDto>> GetFeaturedArticlesAsync(int size, CancellationToken cancellationToken = default)
    {
        CancellationToken effectiveCt = ResolveCancellationToken(cancellationToken);
        effectiveCt.ThrowIfCancellationRequested();
        size = size switch
        {
            < 1 => 3,
            > 20 => 20,
            _ => size
        };

        string redisKey = RedisKey("blog:top_articles");
        // 精选文章对候选集的基数要求更高，我们取较多的热文进行过滤
        int seedCount = MaxHotArticlesCount;
        List<int> ids = await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.TopArticles,
                $"seed:{seedCount}",
                ct => TryReadHotArticleSeedAsync(redisKey, seedCount, ct),
                async ct => await _dbConcurrencyGate.ExecuteAsync(
                    "article-hot-seed",
                    gateCt => SeedHotArticlesAsync(redisKey, seedCount, gateCt),
                    async gateCt =>
                    {
                        CacheReadResult<List<int>> retry = await TryReadHotArticleSeedAsync(redisKey, seedCount, gateCt);
                        if (retry.Hit && retry.Value is not null)
                        {
                            return retry.Value;
                        }

                        throw new TimeoutException($"db-gate-timeout:article-hot-seed:{seedCount}");
                    },
                    ct),
                "article-hot-seed",
                effectiveCt)
            .ConfigureAwait(false)
            ?? [];

        if (ids.Count == 0)
        {
            return [];
        }

        DateTime now = DateTime.UtcNow;
        effectiveCt.ThrowIfCancellationRequested();
        var sqlObj = _db.Queryable<Article>()
            .LeftJoin<Category>((a, c) => a.CategoryId == c.Id)
            .In(a => a.Id, ids)
            .Where(a => !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now)
                && a.CoverImageUrl != null
                && a.CoverImageUrl != "")
            .Select((a, c) => new { a.Id, a.Title, a.CoverImageUrl, a.Views, a.CreateTime, a.CategoryId, CategoryName = c.Name })
            .ToSql();

        var articles = new List<FeaturedArticleSummaryDto>(size);
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id"), fTitle = reader.GetOrdinal("Title"), fCover = reader.GetOrdinal("CoverImageUrl"),
                fViews = reader.GetOrdinal("Views"), fCreateTime = reader.GetOrdinal("CreateTime"),
                fCatId = reader.GetOrdinal("CategoryId"), fCatName = reader.GetOrdinal("CategoryName");

            while (await reader.ReadAsync(effectiveCt))
            {
                string coverImageUrl = reader.IsDBNull(fCover) ? string.Empty : reader.GetString(fCover);
                if (!HasUsableFeaturedCover(coverImageUrl))
                {
                    continue;
                }

                articles.Add(new FeaturedArticleSummaryDto(
                    reader.GetInt32(fId),
                    reader.GetString(fTitle),
                    coverImageUrl.Trim(),
                    reader.GetInt32(fViews),
                    reader.GetDateTime(fCreateTime),
                    new ArticleCategoryView(reader.GetInt32(fCatId), reader.IsDBNull(fCatName) ? string.Empty : reader.GetString(fCatName))
                ));
            }
        }

        // 按照 redis 榜单分数顺序重新排序，然后取 count 个
        var idDictionary = new Dictionary<int, int>(ids.Count);
        for (int i = 0; i < ids.Count; i++)
        {
            idDictionary.TryAdd(ids[i], i);
        }

        articles.Sort((a, b) =>
        {
            int indexA = idDictionary.GetValueOrDefault(a.Id, int.MaxValue);
            int indexB = idDictionary.GetValueOrDefault(b.Id, int.MaxValue);
            return indexA.CompareTo(indexB);
        });

        return articles.Take(size).ToList();
    }

    internal static bool HasUsableFeaturedCoverForTests(string? coverImageUrl)
        => HasUsableFeaturedCover(coverImageUrl);

    private static bool HasUsableFeaturedCover(string? coverImageUrl)
        => !string.IsNullOrWhiteSpace(coverImageUrl);

    private async Task<ArticleListPageReadModel> LoadArticleListPageFromDbAsync(
        int page,
        int size,
        int? categoryId,
        int? tagId,
        bool isDeleted,
        int? status,
        bool includePrivate,
        string keyword,
        CancellationToken cancellationToken)
    {
        List<string> whereClauses = ["a.isdeleted = @IsDeleted"];
        List<SugarParameter> parameters =
        [
            new("@IsDeleted", isDeleted),
            new("@Now", DateTime.UtcNow),
            new("@Limit", size)
        ];

        if (!isDeleted && !includePrivate)
        {
            whereClauses.Add("a.status = @PublishedStatus");
            whereClauses.Add("(a.published_at IS NULL OR a.published_at <= @Now)");
            whereClauses.Add("(a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)");
            parameters.Add(new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published));
        }
        else if (status.HasValue)
        {
            whereClauses.Add("a.status = @Status");
            parameters.Add(new SugarParameter("@Status", status.Value));
        }

        if (categoryId.HasValue)
        {
            whereClauses.Add("a.categoryid = @CategoryId");
            parameters.Add(new SugarParameter("@CategoryId", categoryId.Value));
        }

        if (tagId.HasValue)
        {
            whereClauses.Add("""
                EXISTS (
                    SELECT 1
                    FROM article_tag at
                    WHERE at.articleid = a.id AND at.tagid = @TagId
                )
                """);
            parameters.Add(new SugarParameter("@TagId", tagId.Value));
        }

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            whereClauses.Add("(a.title LIKE @Keyword OR a.summary LIKE @Keyword)");
            parameters.Add(new SugarParameter("@Keyword", $"%{keyword}%"));
        }

        string whereSql = string.Join(" AND ", whereClauses);
        if (ShouldUsePublicKeysetPagination(isDeleted, status, includePrivate)
            && page <= PublicKeysetWalkPageThreshold)
        {
            return await LoadPublicArticleListPageByKeysetAsync(page, size, whereSql, parameters, cancellationToken);
        }

        parameters.Add(new SugarParameter("@Offset", (page - 1) * size));
        string combinedSql = $$"""
            SELECT COUNT(1) AS "__TotalCount"
            FROM article a
            WHERE {{whereSql}};

            SELECT
                a.id AS "Id",
                a.title AS "Title",
                a.summary AS "Summary",
                a.coverimageurl AS "CoverImageUrl",
                a.views AS "Views",
                a.createtime AS "CreateTime",
                a.categoryid AS "CategoryId",
                c.name AS "CategoryName",
                a.isdeleted AS "IsDeleted",
                a.status AS "Status",
                a.scheduled_publish_at AS "ScheduledPublishAt",
                a.published_at AS "PublishedAt"
            FROM article a
            LEFT JOIN category c ON a.categoryid = c.id
            WHERE {{whereSql}}
            ORDER BY a.createtime DESC, a.id DESC
            OFFSET @Offset
            LIMIT @Limit;
            """;

        int totalCount = 0;
        var list = new List<ArticleListItemReadModel>(size);
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(combinedSql, parameters))
        {
            if (await reader.ReadAsync(cancellationToken))
            {
                totalCount = reader.IsDBNull(0) ? 0 : Convert.ToInt32(reader.GetValue(0));
            }

            if (!await reader.NextResultAsync(cancellationToken))
            {
                return new ArticleListPageReadModel { Items = [], Total = totalCount };
            }

            await ReadArticleListItemsAsync(reader, list, cancellationToken);
        }

        await AttachArticleListTagsAsync(list, cancellationToken);

        return new ArticleListPageReadModel { Items = list, Total = totalCount };
    }

    private static bool ShouldUsePublicKeysetPagination(bool isDeleted, int? status, bool includePrivate)
        => !isDeleted && !includePrivate && !status.HasValue;

    private async Task<ArticleListPageReadModel> LoadPublicArticleListPageByKeysetAsync(
        int page,
        int size,
        string whereSql,
        IReadOnlyCollection<SugarParameter> baseParameters,
        CancellationToken cancellationToken)
    {
        string countSql = $$"""
            SELECT COUNT(1) AS "__TotalCount"
            FROM article a
            WHERE {{whereSql}};
            """;

        int totalCount = 0;
        using (var countReader = (DbDataReader)await _db.Ado.GetDataReaderAsync(countSql, CloneArticleListParameters(baseParameters)))
        {
            if (await countReader.ReadAsync(cancellationToken))
            {
                totalCount = countReader.IsDBNull(0) ? 0 : Convert.ToInt32(countReader.GetValue(0));
            }
        }

        DateTime? cursorTime = null;
        int? cursorId = null;
        List<ArticleListItemReadModel> pageItems = [];
        for (int currentPage = 1; currentPage <= page; currentPage++)
        {
            List<SugarParameter> pageParameters = CloneArticleListParameters(baseParameters);
            string pageWhereSql = whereSql;
            if (cursorTime.HasValue && cursorId.HasValue)
            {
                pageWhereSql += " AND (a.createtime < @CursorTime OR (a.createtime = @CursorTime AND a.id < @CursorId))";
                pageParameters.Add(new SugarParameter("@CursorTime", cursorTime.Value));
                pageParameters.Add(new SugarParameter("@CursorId", cursorId.Value));
            }

            string pageSql = BuildArticleListKeysetPageSql(pageWhereSql);
            var currentItems = new List<ArticleListItemReadModel>(size);
            using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(pageSql, pageParameters))
            {
                await ReadArticleListItemsAsync(reader, currentItems, cancellationToken);
            }

            if (currentPage == page)
            {
                pageItems = currentItems;
                break;
            }

            if (currentItems.Count < size)
            {
                pageItems = [];
                break;
            }

            ArticleListItemReadModel last = currentItems[^1];
            cursorTime = last.CreateTime;
            cursorId = last.Id;
        }

        await AttachArticleListTagsAsync(pageItems, cancellationToken);
        return new ArticleListPageReadModel { Items = pageItems, Total = totalCount };
    }

    private static string BuildArticleListKeysetPageSql(string whereSql)
        => $$"""
            SELECT
                a.id AS "Id",
                a.title AS "Title",
                a.summary AS "Summary",
                a.coverimageurl AS "CoverImageUrl",
                a.views AS "Views",
                a.createtime AS "CreateTime",
                a.categoryid AS "CategoryId",
                c.name AS "CategoryName",
                a.isdeleted AS "IsDeleted",
                a.status AS "Status",
                a.scheduled_publish_at AS "ScheduledPublishAt",
                a.published_at AS "PublishedAt"
            FROM article a
            LEFT JOIN category c ON a.categoryid = c.id
            WHERE {{whereSql}}
            ORDER BY a.createtime DESC, a.id DESC
            LIMIT @Limit;
            """;

    private static async Task ReadArticleListItemsAsync(DbDataReader reader, List<ArticleListItemReadModel> list, CancellationToken cancellationToken)
    {
        int fId = reader.GetOrdinal("Id");
        int fTitle = reader.GetOrdinal("Title");
        int fSum = reader.GetOrdinal("Summary");
        int fCover = reader.GetOrdinal("CoverImageUrl");
        int fViews = reader.GetOrdinal("Views");
        int fTime = reader.GetOrdinal("CreateTime");
        int fCatId = reader.GetOrdinal("CategoryId");
        int fCatName = reader.GetOrdinal("CategoryName");
        int fDel = reader.GetOrdinal("IsDeleted");
        int fStatus = reader.GetOrdinal("Status");
        int fScheduled = reader.GetOrdinal("ScheduledPublishAt");
        int fPublished = reader.GetOrdinal("PublishedAt");

        while (await reader.ReadAsync(cancellationToken))
        {
            list.Add(new ArticleListItemReadModel
            {
                Id = reader.GetInt32(fId),
                Title = reader.IsDBNull(fTitle) ? string.Empty : reader.GetString(fTitle),
                Summary = reader.IsDBNull(fSum) ? string.Empty : reader.GetString(fSum),
                CoverImageUrl = reader.IsDBNull(fCover) ? null : reader.GetString(fCover),
                Views = reader.GetInt32(fViews),
                CreateTime = reader.GetDateTime(fTime),
                CategoryId = reader.GetInt32(fCatId),
                CategoryName = reader.IsDBNull(fCatName) ? "默认" : reader.GetString(fCatName),
                IsDeleted = reader.GetBoolean(fDel),
                Status = (ArticleStatus)reader.GetInt32(fStatus),
                ScheduledPublishAt = reader.IsDBNull(fScheduled) ? null : reader.GetDateTime(fScheduled),
                PublishedAt = reader.IsDBNull(fPublished) ? null : reader.GetDateTime(fPublished),
                Tags = ArticleReadModelCollections.EmptyTags
            });
        }
    }

    private async Task AttachArticleListTagsAsync(List<ArticleListItemReadModel> list, CancellationToken cancellationToken)
    {
        if (list.Count == 0)
        {
            return;
        }

        var ids = new List<int>(list.Count);
        for (int i = 0; i < list.Count; i++)
        {
            ids.Add(list[i].Id);
        }

        var tagDict = await LoadArticleTagMapAsync(ids, cancellationToken);
        AttachTags(list, tagDict);
    }

    private static List<SugarParameter> CloneArticleListParameters(IReadOnlyCollection<SugarParameter> source)
    {
        var cloned = new List<SugarParameter>(source.Count);
        foreach (SugarParameter parameter in source)
        {
            cloned.Add(new SugarParameter(parameter.ParameterName, parameter.Value));
        }

        return cloned;
    }

    private static string RewriteParameters(
        string sql,
        IReadOnlyCollection<SugarParameter> source,
        string prefix,
        out List<SugarParameter> rewritten)
    {
        rewritten = new List<SugarParameter>(source.Count);
        if (source.Count == 0)
        {
            return sql;
        }

        var sorted = source.ToArray();
        Array.Sort(sorted, static (left, right) => string.CompareOrdinal(right.ParameterName, left.ParameterName));

        for (int i = 0; i < sorted.Length; i++)
        {
            SugarParameter parameter = sorted[i];
            string rewrittenName = $"@{prefix}_{i}";
            sql = sql.Replace(parameter.ParameterName, rewrittenName, StringComparison.Ordinal);
            rewritten.Add(new SugarParameter(rewrittenName, parameter.Value));
        }

        return sql;
    }

    private async Task<List<ArticleListItemReadModel>> LoadSearchArticlesFromSourceAsync(string keyword, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var searchResults = await _searchIndex.SearchAsync(keyword);
        cancellationToken.ThrowIfCancellationRequested();
        if (searchResults.Count == 0)
        {
            return [];
        }

        int boundedCount = Math.Min(searchResults.Count, 200);
        var ids = new List<int>(boundedCount);
        for (int i = 0; i < boundedCount; i++)
        {
            ids.Add(searchResults[i].Id);
        }

        DateTime now = DateTime.UtcNow;
        var sqlObj = _db.Queryable<Article>()
            .LeftJoin<Category>((a, c) => a.CategoryId == c.Id)
            .Where(a => ids.Contains(a.Id)
                && !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now))
            .Select((a, c) => new
            {
                a.Id,
                a.Summary,
                a.CoverImageUrl,
                a.Views,
                a.CreateTime,
                a.CategoryId,
                CategoryName = c.Name,
                a.IsDeleted
            })
            .ToSql();

        var metadataFromDb = new Dictionary<int, (string Summary, string? Cover, int Views, DateTime Time, int CatId, string CatName, bool IsDel)>(ids.Count);
        cancellationToken.ThrowIfCancellationRequested();
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id");
            int fSum = reader.GetOrdinal("Summary");
            int fCover = reader.GetOrdinal("CoverImageUrl");
            int fViews = reader.GetOrdinal("Views");
            int fTime = reader.GetOrdinal("CreateTime");
            int fCatId = reader.GetOrdinal("CategoryId");
            int fCatName = reader.GetOrdinal("CategoryName");
            int fDel = reader.GetOrdinal("IsDeleted");

            while (await reader.ReadAsync(cancellationToken))
            {
                metadataFromDb[reader.GetInt32(fId)] = (
                    reader.IsDBNull(fSum) ? string.Empty : reader.GetString(fSum),
                    reader.IsDBNull(fCover) ? null : reader.GetString(fCover),
                    reader.GetInt32(fViews),
                    reader.GetDateTime(fTime),
                    reader.GetInt32(fCatId),
                    reader.IsDBNull(fCatName) ? "默认" : reader.GetString(fCatName),
                    reader.GetBoolean(fDel));
            }
        }

        var tagDict = await LoadArticleTagMapAsync(ids, cancellationToken);
        var resultList = new List<ArticleListItemReadModel>(ids.Count);
        for (int i = 0; i < boundedCount; i++)
        {
            Article searchIndexArticle = searchResults[i];
            int id = searchIndexArticle.Id;
            if (!metadataFromDb.TryGetValue(id, out var metadata))
            {
                continue;
            }

            resultList.Add(new ArticleListItemReadModel
            {
                Id = searchIndexArticle.Id,
                Title = searchIndexArticle.Title,
                Snippet = searchIndexArticle.Content,
                Summary = metadata.Summary,
                CoverImageUrl = metadata.Cover,
                Views = metadata.Views,
                CreateTime = metadata.Time,
                CategoryId = metadata.CatId,
                CategoryName = metadata.CatName,
                IsDeleted = metadata.IsDel,
                Tags = tagDict.TryGetValue(id, out var tags) ? tags : ArticleReadModelCollections.EmptyTags
            });
        }

        return resultList;
    }

    private async Task<CacheReadResult<List<int>>> TryReadHotArticleSeedAsync(string redisKey, int count, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RedisValue[] topIds = await _redis.SortedSetRangeByRankAsync(redisKey, 0, count - 1, Order.Descending);
        cancellationToken.ThrowIfCancellationRequested();
        List<int> ids = ExtractOrderedArticleIds(topIds);
        return ids.Count == 0
            ? new CacheReadResult<List<int>>(false, default)
            : new CacheReadResult<List<int>>(true, ids);
    }

    private async Task<List<int>> SeedHotArticlesAsync(string redisKey, int count, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DateTime now = DateTime.UtcNow;
        var topFromDb = await _db.Queryable<Article>()
            .Where(a => !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now))
            .OrderByDescending(a => a.Views)
            .Take(count)
            .Select(a => new { a.Id, a.Views })
            .ToListAsync(cancellationToken);

        if (topFromDb.Count == 0)
        {
            return [];
        }

        var entries = new SortedSetEntry[topFromDb.Count];
        var ids = new List<int>(topFromDb.Count);
        for (int i = 0; i < topFromDb.Count; i++)
        {
            entries[i] = new SortedSetEntry(topFromDb[i].Id, topFromDb[i].Views);
            ids.Add(topFromDb[i].Id);
        }

        cancellationToken.ThrowIfCancellationRequested();
        await _redis.SortedSetAddAsync(redisKey, entries);
        cancellationToken.ThrowIfCancellationRequested();
        return ids;
    }

    private async Task InvalidateCache(int? articleId = null)
    {
        await _cacheInvalidationDispatcher.InvalidateArticleMutationAsync(articleId, Ct);
    }

    private async Task InvalidatePublicAotAsync(int? articleId, IEnumerable<int>? categoryIds, IEnumerable<int>? tagIds, string operation)
    {
        await BoundaryExecutor.ExecuteAsync(
            () => _publicAotInvalidationService.InvalidateArticleMutationAsync(articleId, categoryIds, tagIds, Ct),
            _logger,
            $"invalidate-article-aot:{operation}");
    }

    private async Task InvalidatePublicAotBatchAsync(IEnumerable<int> articleIds, IEnumerable<int>? categoryIds, IEnumerable<int>? tagIds, string operation)
    {
        await BoundaryExecutor.ExecuteAsync(
            () => _publicAotInvalidationService.InvalidateArticleMutationBatchAsync(articleIds, categoryIds, tagIds, Ct),
            _logger,
            $"invalidate-article-aot-batch:{operation}");
    }

    private async Task<List<int>> LoadArticleTagIdsAsync(int articleId)
    {
        return await _db.Queryable<ArticleTag>()
            .Where(it => it.ArticleId == articleId)
            .Select(it => it.TagId)
            .ToListAsync(Ct);
    }

    private async Task<List<int>> LoadArticleTagIdsAsync(List<int> articleIds)
    {
        return await _db.Queryable<ArticleTag>()
            .Where(it => articleIds.Contains(it.ArticleId))
            .Select(it => it.TagId)
            .Distinct()
            .ToListAsync(Ct);
    }

    private async Task<(List<int> CategoryIds, List<int> TagIds)> LoadArticleAotStateAsync(int articleId)
    {
        var categoryId = await _db.Queryable<Article>()
            .ClearFilter()
            .Where(it => it.Id == articleId)
            .Select(it => it.CategoryId)
            .FirstAsync();

        return ([categoryId], await LoadArticleTagIdsAsync(articleId));
    }

    private async Task<ArticleListItemResponse?> LoadRealtimePreviewAsync(int id)
    {
        var sqlObj = _db.Queryable<Article>()
            .ClearFilter()
            .LeftJoin<Category>((a, c) => a.CategoryId == c.Id)
            .Where(a => a.Id == id && a.IsDeleted == false)
            .Select((a, c) => new
            {
                a.Id,
                a.Title,
                a.Summary,
                a.CoverImageUrl,
                a.Views,
                a.CreateTime,
                a.CategoryId,
                CategoryName = c.Name,
                a.IsDeleted
            })
            .ToSql();

        ArticleListItemReadModel? preview = null;
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            if (await reader.ReadAsync(Ct))
            {
                int fId = reader.GetOrdinal("Id");
                int fTitle = reader.GetOrdinal("Title");
                int fSummary = reader.GetOrdinal("Summary");
                int fCover = reader.GetOrdinal("CoverImageUrl");
                int fViews = reader.GetOrdinal("Views");
                int fCreateTime = reader.GetOrdinal("CreateTime");
                int fCategoryId = reader.GetOrdinal("CategoryId");
                int fCategoryName = reader.GetOrdinal("CategoryName");
                int fIsDeleted = reader.GetOrdinal("IsDeleted");

                preview = new ArticleListItemReadModel
                {
                    Id = reader.GetInt32(fId),
                    Title = reader.IsDBNull(fTitle) ? string.Empty : reader.GetString(fTitle),
                    Summary = reader.IsDBNull(fSummary) ? string.Empty : reader.GetString(fSummary),
                    CoverImageUrl = reader.IsDBNull(fCover) ? null : reader.GetString(fCover),
                    Views = reader.GetInt32(fViews),
                    CreateTime = reader.GetDateTime(fCreateTime),
                    CategoryId = reader.GetInt32(fCategoryId),
                    CategoryName = reader.IsDBNull(fCategoryName) ? "默认" : reader.GetString(fCategoryName),
                    Tags = ArticleReadModelCollections.EmptyTags,
                    IsDeleted = reader.GetBoolean(fIsDeleted)
                };
            }
        }

        if (preview is null)
        {
            return null;
        }

        ArticleListItemReadModel articlePreview = preview;
        IReadOnlyList<TagReadModel> tags = await LoadArticleTagsAsync(id, Ct);
        return ArticleProjection.ToResponse(articlePreview with { Tags = tags });
    }

    private static List<int> MergeIds(IEnumerable<int> left, IEnumerable<int> right)
    {
        var merged = new HashSet<int>();
        foreach (int value in left)
        {
            if (value > 0)
            {
                merged.Add(value);
            }
        }

        foreach (int value in right)
        {
            if (value > 0)
            {
                merged.Add(value);
            }
        }

        return [.. merged];
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string NormalizeText(string? value, int maxLen)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        var trimmed = value.Trim();
        return trimmed.Length > maxLen ? trimmed[..maxLen] : trimmed;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static List<int> NormalizeTagIds(List<int>? tagIds)
    {
        if (tagIds == null || tagIds.Count == 0)
        {
            return [];
        }

        var result = new List<int>(Math.Min(tagIds.Count, MaxTagIds));
        var set = new HashSet<int>();
        for (int i = 0; i < tagIds.Count && result.Count < MaxTagIds; i++)
        {
            var id = tagIds[i];
            if (set.Add(id))
            {
                result.Add(id);
            }
        }

        return result;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static List<ArticleTag> BuildArticleTags(int articleId, List<int> tagIds)
    {
        var items = new List<ArticleTag>(tagIds.Count);
        for (int i = 0; i < tagIds.Count; i++)
        {
            items.Add(new ArticleTag { ArticleId = articleId, TagId = tagIds[i] });
        }

        return items;
    }

    private async Task<IReadOnlyList<TagReadModel>> LoadArticleTagsAsync(int articleId, CancellationToken cancellationToken)
    {
        if (articleId <= 0)
        {
            return ArticleReadModelCollections.EmptyTags;
        }

        var tagMap = await LoadArticleTagMapAsync([articleId], cancellationToken);
        return tagMap.TryGetValue(articleId, out var tags) ? tags : ArticleReadModelCollections.EmptyTags;
    }

    private async Task<Dictionary<int, List<TagReadModel>>> LoadArticleTagMapAsync(
        IReadOnlyCollection<int> articleIds,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (articleIds.Count == 0)
        {
            return new Dictionary<int, List<TagReadModel>>();
        }

        var ids = articleIds
            .Where(id => id > 0)
            .Distinct()
            .ToList();
        if (ids.Count == 0)
        {
            return new Dictionary<int, List<TagReadModel>>();
        }

        var tagRows = await _db.Queryable<ArticleTag>()
            .InnerJoin<Tag>((at, t) => at.TagId == t.Id)
            .Where(at => ids.Contains(at.ArticleId))
            .Select((at, t) => new { at.ArticleId, t.Id, t.Name })
            .ToListAsync(cancellationToken);

        var tagMap = new Dictionary<int, List<TagReadModel>>(ids.Count);
        foreach (var row in tagRows)
        {
            if (!tagMap.TryGetValue(row.ArticleId, out var tags))
            {
                tags = [];
                tagMap[row.ArticleId] = tags;
            }

            tags.Add(new TagReadModel { Id = row.Id, Name = row.Name });
        }

        return tagMap;
    }

    private static void AttachTags(List<ArticleListItemReadModel> items, IReadOnlyDictionary<int, List<TagReadModel>> tagMap)
    {
        for (int i = 0; i < items.Count; i++)
        {
            var item = items[i];
            items[i] = item with { Tags = tagMap.TryGetValue(item.Id, out var tags) ? tags : ArticleReadModelCollections.EmptyTags };
        }
    }

    private static List<int> ExtractOrderedArticleIds(RedisValue[] values)
    {
        var ids = new List<int>(values.Length);
        for (int i = 0; i < values.Length; i++)
        {
            RedisValue value = values[i];
            if (value.HasValue)
            {
                ids.Add((int)value);
            }
        }

        return ids;
    }

    private static List<PopularArticleSummaryDto> OrderHotArticles(IReadOnlyList<int> ids, IReadOnlyList<PopularArticleSummaryDto> articles)
    {
        var articleMap = new Dictionary<int, PopularArticleSummaryDto>(articles.Count);
        for (int i = 0; i < articles.Count; i++)
        {
            PopularArticleSummaryDto article = articles[i];
            articleMap[article.Id] = article;
        }

        var ordered = new List<PopularArticleSummaryDto>(ids.Count);
        for (int i = 0; i < ids.Count; i++)
        {
            int id = ids[i];
            if (articleMap.TryGetValue(id, out PopularArticleSummaryDto article))
            {
                ordered.Add(article);
            }
        }

        return ordered;
    }

    internal static List<PopularArticleSummaryDto> OrderHotArticlesForTests(IReadOnlyList<int> ids, IReadOnlyList<PopularArticleSummaryDto> articles)
        => OrderHotArticles(ids, articles);

    internal static void AttachTagsForTests(List<ArticleListItemReadModel> items, IReadOnlyDictionary<int, List<TagReadModel>> tagMap)
        => AttachTags(items, tagMap);

    // [修改日期 2026-03-01]
    // 写入时绝对安全的摘要生成：防御 C# 字符串切片由于 UTF-16 代理对断裂引发的 Emoji 碎裂乱码。[MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string GenerateSafeSummary(string? content)
    {
        if (string.IsNullOrWhiteSpace(content)) return string.Empty;
        if (content.Length <= 200) return content;

        int len = 200;
        // 如果截断点切在了一个 4 字节 Emoji (HighSurrogate) 的头上，主动退让 1 字符，保持语义闭环
        if (char.IsHighSurrogate(content[len - 1])) len--;

        return content[..len];
    }

    private async ValueTask<long> GetListCacheVersionAsync(CancellationToken cancellationToken)
    {
        string? ver = await _cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", cancellationToken);
        return long.TryParse(ver, out long parsed) ? parsed : 0;
    }

    private string RedisKey(string key) => _runtimeKeyScope.PrefixKey(key);

    private static string BuildArticleListIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status, bool includePrivate, string keyword)
    {
        return string.Concat(
            includePrivate ? "admin:" : "public:",
            version.ToString(), ":",
            page.ToString(), ":",
            size.ToString(), ":",
            (categoryId ?? 0).ToString(), ":",
            (tagId ?? 0).ToString(), ":",
            isDeleted ? "1" : "0",
            ":",
            (status ?? -1).ToString(),
            ":",
            keyword);
    }

    private static string NormalizeArticleListKeyword(string? keyword)
    {
        if (string.IsNullOrWhiteSpace(keyword))
        {
            return string.Empty;
        }

        string trimmed = keyword.Trim();
        return trimmed.Length <= 80 ? trimmed : trimmed[..80];
    }
}
