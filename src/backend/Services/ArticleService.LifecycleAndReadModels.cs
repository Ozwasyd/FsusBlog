using FsusBlog.Core.Integrity;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
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
using System.Text;

namespace FsusBlog.Server.Services;

public partial class ArticleService
{
    public async Task<bool> DeleteAsync(int id, CancellationToken cancellationToken = default)
    {
        CancellationToken ct = ResolveCancellationToken(cancellationToken);
        ct.ThrowIfCancellationRequested();
        ArticleMutationState? state = await LoadArticleMutationStateAsync(id, isDeleted: false);
        if (state is null)
        {
            return false;
        }

        DateTime now = DateTime.UtcNow;
        bool fenceEstablished = false;
        bool mutationCommitted = false;
        try
        {
            await _mutationSideEffects.BeginPublicMutationFenceAsync(id, ct).ConfigureAwait(false);
            fenceEstablished = true;
            bool success = false;
            var result = await _db.Ado.UseTranAsync(async () =>
            {
                int updated = await _db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE article
                    SET isdeleted = true,
                        status = @Status,
                        deleted_at = CAST(@DeletedAt AS timestamp)
                    WHERE id = @ArticleId
                      AND isdeleted = false
                      AND xmin::text = @RowVersion;
                    """,
                    new SugarParameter("@ArticleId", id),
                    new SugarParameter("@Status", (int)ArticleStatus.Deleted),
                    new SugarParameter("@DeletedAt", now),
                    new SugarParameter("@RowVersion", state.RowVersion));
                if (updated > 0)
                {
                    success = true;
                    await RecordArticleMutationOutboxAsync(id, "deleted");
                }
            });
            ct.ThrowIfCancellationRequested();
            mutationCommitted = result.IsSuccess && success;
            if (mutationCommitted)
            {
                await InvalidateCache(id);
                ct.ThrowIfCancellationRequested();
                await InvalidatePublicAotAsync(id, state.CategoryIds, state.TagIds, "delete");
                ct.ThrowIfCancellationRequested();
                await _mutationSideEffects.AfterDeletedAsync(id);
            }
            return mutationCommitted;
        }
        finally
        {
            if (fenceEstablished && !mutationCommitted)
            {
                await RecoverAbortedPublicMutationFenceAsync(id, "article-delete-fence-aborted").ConfigureAwait(false);
            }
        }
    }

    public async Task<bool> RestoreAsync(int id, CancellationToken cancellationToken = default)
    {
        CancellationToken ct = ResolveCancellationToken(cancellationToken);
        ct.ThrowIfCancellationRequested();
        ArticleMutationState? state = await LoadArticleMutationStateAsync(id, isDeleted: true);
        if (state is null)
        {
            return false;
        }

        bool success = false;
        var result = await _db.Ado.UseTranAsync(async () =>
        {
            int updated = await _db.Ado.ExecuteCommandAsync(
                """
                UPDATE article
                SET isdeleted = false,
                    status = @Status,
                    deleted_at = NULL,
                    published_at = NULL
                WHERE id = @ArticleId
                  AND isdeleted = true
                  AND xmin::text = @RowVersion;
                """,
                new SugarParameter("@ArticleId", id),
                new SugarParameter("@Status", (int)ArticleStatus.Draft),
                new SugarParameter("@RowVersion", state.RowVersion));
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
        ArticleMutationState? state = await LoadArticleMutationStateAsync(id, isDeleted: true);
        if (state is null) return false;
        var article = await _db.Queryable<Article>().ClearFilter().InSingleAsync(id);
        if (article == null || !article.IsDeleted) return false;
        ct.ThrowIfCancellationRequested();
        article.Content = await _db.Queryable<ArticleBody>().Where(it => it.ArticleId == id).Select(it => it.MarkdownContent).FirstAsync() ?? string.Empty;
        ct.ThrowIfCancellationRequested();
        var imageUrls = ImageHelper.ExtractIllustrationUrls(article.Content);

        var result = await _db.Ado.UseTranAsync(async () => {
            bool locked = await LockDeletedArticleForMutationAsync(id, state.RowVersion);
            if (!locked)
            {
                return 0;
            }

            await _db.Deleteable<Comment>().Where(c => c.ArticleId == id).ExecuteCommandAsync();
            await _db.Deleteable<ArticleTag>().Where(at => at.ArticleId == id).ExecuteCommandAsync();
            await _db.Deleteable<ArticleBody>().Where(it => it.ArticleId == id).ExecuteCommandAsync();
            await RecordArticleMutationOutboxAsync(id, "permanently-deleted");
            return await _db.Ado.ExecuteCommandAsync(
                """
                DELETE FROM article
                WHERE id = @ArticleId
                  AND isdeleted = true
                  AND xmin::text = @RowVersion;
                """,
                new SugarParameter("@ArticleId", id),
                new SugarParameter("@RowVersion", state.RowVersion));
        });

        ct.ThrowIfCancellationRequested();
        if (result.IsSuccess && result.Data > 0)
        {
            await InvalidateCache(id);
            ct.ThrowIfCancellationRequested();
            await InvalidatePublicAotAsync(id, state.CategoryIds, state.TagIds, "permanent-delete");
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
            rows.Add(new TrashArticleRow(reader.ReadInt32("id"), reader.ReadInt32("categoryid")));
        }

        return rows;
    }

    public async Task<List<ArticleListItemReadModel>> SearchArticlesAsync(string keyword, CancellationToken cancellationToken = default)
    {
        CancellationToken effectiveCt = ResolveCancellationToken(cancellationToken);
        effectiveCt.ThrowIfCancellationRequested();
        string normalizedKeyword = NormalizeSearchKeyword(keyword);
        if (normalizedKeyword.Length == 0)
        {
            return [];
        }

        if (!ShouldCacheSearchKeyword(normalizedKeyword))
        {
            FsusObservability.RecordCacheOperation("search", CachePolicyId.ArticleSearch.ToString(), "policy", "bypass_low_value_keyword", TimeSpan.Zero);
            return await _dbConcurrencyGate.ExecuteAsync(
                    "article-search-uncached",
                    gateCt => LoadSearchArticlesFromSourceAsync(normalizedKeyword, gateCt),
                    _ => Task.FromException<List<ArticleListItemReadModel>>(new TimeoutException($"db-gate-timeout:article-search-uncached:{normalizedKeyword}")),
                    effectiveCt)
                .ConfigureAwait(false);
        }

        long searchVersion = await GetSearchCacheVersionAsync(effectiveCt);
        string cacheIdentity = BuildArticleSearchIdentity(searchVersion, normalizedKeyword);

        return await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.ArticleSearch,
                cacheIdentity,
                ct => _cache.TryGetAsync(CachePolicyId.ArticleSearch, cacheIdentity, ServerCacheBinaryCodec.DecodeArticleSearch, ct),
                async ct => await _dbConcurrencyGate.ExecuteAsync(
                    "article-search",
                    async gateCt =>
                    {
                        List<ArticleListItemReadModel> result = await LoadSearchArticlesFromSourceAsync(normalizedKeyword, gateCt);
                        gateCt.ThrowIfCancellationRequested();
                        byte[] encoded = ServerCacheBinaryCodec.EncodeArticleSearch(result);
                        gateCt.ThrowIfCancellationRequested();
                        await _cache.SetRawAsync(CachePolicyId.ArticleSearch, cacheIdentity, encoded, null, gateCt);
                        FsusObservability.RecordCacheOperation("search", CachePolicyId.ArticleSearch.ToString(), "l2", "write_versioned", TimeSpan.Zero);
                        return result;
                    },
                    async gateCt =>
                    {
                        CacheReadResult<List<ArticleListItemReadModel>> retry = await _cache.TryGetAsync(CachePolicyId.ArticleSearch, cacheIdentity, ServerCacheBinaryCodec.DecodeArticleSearch, gateCt);
                        if (retry.Hit)
                        {
                            return retry.Value ?? [];
                        }

                        throw new TimeoutException($"db-gate-timeout:article-search:{normalizedKeyword}");
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
        long version,
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
        if (ShouldUsePublicKeysetPagination(isDeleted, status, includePrivate))
        {
            string countIdentity = BuildArticleListCountIdentity(version, categoryId, tagId, isDeleted, status, includePrivate, keyword);
            return await LoadPublicArticleListPageByKeysetAsync(page, size, whereSql, parameters, countIdentity, cancellationToken);
        }

        parameters.Add(new SugarParameter("@Offset", (page - 1) * size));
        string combinedSql = $$"""
            SELECT COUNT(1) AS "{{ArticleListTotalCountColumn}}"
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
                totalCount = reader.IsNull(ArticleListTotalCountColumn)
                    ? 0
                    : Convert.ToInt32(reader.ReadValue(ArticleListTotalCountColumn));
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
        string countIdentity,
        CancellationToken cancellationToken)
    {
        int totalCount = await GetCachedArticleListTotalCountAsync(countIdentity, whereSql, baseParameters, cancellationToken);
        long offset = ((long)page - 1L) * size;
        if (page > 1 && offset >= totalCount)
        {
            return new ArticleListPageReadModel { Items = [], Total = totalCount };
        }

        var parameters = new List<SugarParameter>(baseParameters.Count + 1);
        parameters.AddRange(baseParameters);
        parameters.Add(new SugarParameter("@Offset", checked((int)offset)));
        List<ArticleListItemReadModel> pageItems = await LoadPublicArticleListOffsetPageItemsAsync(whereSql, parameters, size, cancellationToken);
        await AttachArticleListTagsAsync(pageItems, cancellationToken);
        ArticleListItemReadModel? lastItem = pageItems.Count > 0 ? pageItems[^1] : null;
        bool hasMore = totalCount > page * size;
        return new ArticleListPageReadModel
        {
            Items = pageItems,
            Total = totalCount,
            NextCursor = hasMore && lastItem is not null ? FormatArticleListCursor(lastItem) : null,
            HasMore = hasMore
        };
    }

    private async Task<List<ArticleListItemReadModel>> LoadPublicArticleListOffsetPageItemsAsync(
        string whereSql,
        IReadOnlyCollection<SugarParameter> parameters,
        int size,
        CancellationToken cancellationToken)
    {
        string pageSql = BuildArticleListOffsetPageSql(whereSql);
        var pageItems = new List<ArticleListItemReadModel>(size);
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(pageSql, parameters))
        {
            await ReadArticleListItemsAsync(reader, pageItems, cancellationToken);
        }

        return pageItems;
    }

    private static string BuildArticleListOffsetPageSql(string whereSql)
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
            LIMIT @Limit OFFSET @Offset;
            """;

    private async Task<int> GetCachedArticleListTotalCountAsync(
        string countIdentity,
        string whereSql,
        IReadOnlyCollection<SugarParameter> baseParameters,
        CancellationToken cancellationToken)
    {
        string? cached = await _cache.GetStringAsync(CachePolicyId.ArticleListCount, countIdentity, cancellationToken).ConfigureAwait(false);
        if (int.TryParse(cached, out int parsed) && parsed >= 0)
        {
            return parsed;
        }

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
                totalCount = countReader.IsNull("__TotalCount") ? 0 : Convert.ToInt32(countReader.ReadValue("__TotalCount"));
            }
        }

        await _cache.SetStringAsync(
            CachePolicyId.ArticleListCount,
            countIdentity,
            totalCount.ToString(System.Globalization.CultureInfo.InvariantCulture),
            cancellationToken: cancellationToken).ConfigureAwait(false);
        return totalCount;
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
                CreateTime = NormalizeArticleListTimestampUtc(reader.GetDateTime(fTime)),
                CategoryId = reader.GetInt32(fCatId),
                CategoryName = reader.IsDBNull(fCatName) ? "默认" : reader.GetString(fCatName),
                IsDeleted = reader.GetBoolean(fDel),
                Status = (ArticleStatus)reader.GetInt32(fStatus),
                ScheduledPublishAt = reader.IsDBNull(fScheduled) ? null : NormalizeArticleListTimestampUtc(reader.GetDateTime(fScheduled)),
                PublishedAt = reader.IsDBNull(fPublished) ? null : NormalizeArticleListTimestampUtc(reader.GetDateTime(fPublished)),
                Tags = ArticleReadModelCollections.EmptyTags
            });
        }
    }

    private static DateTime NormalizeArticleListTimestampUtc(DateTime value)
        => value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };

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

}
