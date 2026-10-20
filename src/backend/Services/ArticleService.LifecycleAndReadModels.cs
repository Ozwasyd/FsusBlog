using FsusBlog.Contracts.Articles;
using System.Data;
using System.Data.Common;
using System.Runtime.CompilerServices;
using System.Text;

using FsusBlog.Core.Integrity;
using FsusBlog.Core.Services.Articles;
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
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services.Articles;

using SqlSugar;

using StackExchange.Redis;

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

        DateTime now = UtcNow;
        ArticleVersionCoordinates version = await LoadCurrentVersionCoordinatesAsync(id).ConfigureAwait(false);
        var beforeScope = new ArticleMutationScopeSnapshot(
            state.CategoryIds.Single(),
            state.TagIds,
            ArticleMutationVisibility.From(state.Status, state.IsDeleted));
        bool fenceEstablished = false;
        bool mutationCommitted = false;
        try
        {
            fenceEstablished = await EstablishArticlePublicMutationFenceAsync(id, ct).ConfigureAwait(false);
            bool success = false;
            ArticleMutationTransactionResult result = await ExecuteArticleMutationTransactionAsync(async () =>
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
                    await RecordArticleMutationOutboxAsync(
                        id,
                        ArticleMutationEventTypes.Deleted,
                        version,
                        now,
                        beforeScope,
                        beforeScope with
                        {
                            Visibility = "deleted"
                        },
                        ct);
                }
            }, ct);
            ct.ThrowIfCancellationRequested();
            mutationCommitted = result.IsSuccess && success;
            if (mutationCommitted && IsArticleVaultGroupTransaction)
            {
                EnqueueArticleVaultPostCommitAction(id, async () =>
                {
                    string mutationId = await InvalidateCache(id).ConfigureAwait(false);
                    await InvalidatePublicAotAsync(id, state.CategoryIds, state.TagIds, "delete", mutationId)
                        .ConfigureAwait(false);
                    await _mutationSideEffects.AfterDeletedAsync(id).ConfigureAwait(false);
                });
                return true;
            }
            if (mutationCommitted)
            {
                string mutationId = await InvalidateCache(id);
                ct.ThrowIfCancellationRequested();
                await InvalidatePublicAotAsync(id, state.CategoryIds, state.TagIds, "delete", mutationId);
                ct.ThrowIfCancellationRequested();
                await _mutationSideEffects.AfterDeletedAsync(id);
            }
            return mutationCommitted;
        }
        finally
        {
            if (fenceEstablished && !mutationCommitted && !IsArticleVaultGroupTransaction)
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

        ArticleVersionCoordinates version = await LoadCurrentVersionCoordinatesAsync(id).ConfigureAwait(false);
        DateTime restoredAt = UtcNow;
        var beforeScope = new ArticleMutationScopeSnapshot(
            state.CategoryIds.Single(),
            state.TagIds,
            "deleted");

        bool success = false;
        var result = await _db.Ado.UseTranAsync(async () =>
        {
            await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(_db, ct).ConfigureAwait(false);
            int updated = await _db.Ado.ExecuteCommandAsync(
                """
                UPDATE article
                SET isdeleted = false,
                    deleted_at = NULL
                WHERE id = @ArticleId
                  AND isdeleted = true
                  AND xmin::text = @RowVersion;
                """,
                new SugarParameter("@ArticleId", id),
                new SugarParameter("@RowVersion", state.RowVersion));
            if (updated > 0)
            {
                success = true;
                ArticleVersionCoordinates published = await ArticlePublicationTransitionWriter.ApplyAsync(
                    _db,
                    new ArticlePublicationTransitionRequest(
                        id,
                        version,
                        ArticleStatus.Published,
                        null,
                        restoredAt,
                        ArticlePublicationTransitionKinds.Restore,
                        ArticleStatusTransitionOperation.Restore),
                    ct).ConfigureAwait(false);
                await RecordArticleMutationOutboxAsync(
                    id,
                    ArticleMutationEventTypes.Restored,
                    published,
                    restoredAt,
                    beforeScope,
                    beforeScope with
                    {
                        Visibility = "published"
                    },
                    ct);
            }
        });
        ct.ThrowIfCancellationRequested();
        success = result.IsSuccess && success;
        if (success)
        {
            string mutationId = await InvalidateCache(id);
            ct.ThrowIfCancellationRequested();
            await InvalidatePublicAotAsync(id, state.CategoryIds, state.TagIds, "restore", mutationId);
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
        if (state is null)
            return false;
        var article = await _db.Queryable<Article>().ClearFilter().InSingleAsync(id);
        if (article == null || !article.IsDeleted)
            return false;
        ct.ThrowIfCancellationRequested();
        ArticleVersionCoordinates version = await LoadCurrentVersionCoordinatesAsync(id).ConfigureAwait(false);
        var beforeScope = new ArticleMutationScopeSnapshot(
            state.CategoryIds.Single(),
            state.TagIds,
            "deleted");
        DateTime deletedAt = UtcNow;

        var result = await _db.Ado.UseTranAsync(async () =>
        {
            await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(_db, ct).ConfigureAwait(false);
            bool locked = await LockDeletedArticleForMutationAsync(id, state.RowVersion);
            if (!locked)
            {
                return 0;
            }

            return await new ArticleDeletionKernel(_db).DeleteLockedAsync(
                [id],
                articleId => RecordArticleMutationOutboxAsync(
                    articleId,
                    ArticleMutationEventTypes.PermanentlyDeleted,
                    version,
                    deletedAt,
                    beforeScope,
                    beforeScope with
                    {
                        Visibility = "absent"
                    },
                    ct),
                ct).ConfigureAwait(false);
        });

        ct.ThrowIfCancellationRequested();
        if (result.IsSuccess && result.Data > 0)
        {
            string mutationId = await InvalidateCache(id);
            ct.ThrowIfCancellationRequested();
            await InvalidatePublicAotAsync(id, state.CategoryIds, state.TagIds, "permanent-delete", mutationId);
            ct.ThrowIfCancellationRequested();
            await _mutationSideEffects.AfterPermanentlyDeletedAsync(id, ct);
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
        Dictionary<int, ArticleVersionCoordinates> versions = new();
        Dictionary<int, ArticleMutationScopeSnapshot> scopes = new();
        ct.ThrowIfCancellationRequested();
        var result = await _db.Ado.UseTranAsync(async () =>
        {
            await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(_db, ct).ConfigureAwait(false);
            List<TrashArticleRow> lockedTrashArticles = await LoadTrashArticlesForUpdateAsync(ct);
            if (lockedTrashArticles.Count == 0)
            {
                return 0;
            }

            articleIds = lockedTrashArticles.Select(static a => a.Id).ToList();
            foreach (int articleId in articleIds)
            {
                versions[articleId] = await LoadCurrentVersionCoordinatesAsync(articleId).ConfigureAwait(false);
                scopes[articleId] = await LoadCurrentMutationScopeAsync(articleId).ConfigureAwait(false);
            }
            categoryIds = lockedTrashArticles.Select(static a => a.CategoryId).Distinct().ToList();
            tagIds = await LoadArticleTagIdsAsync(articleIds);
            return await new ArticleDeletionKernel(_db).DeleteLockedAsync(
                articleIds,
                articleId => RecordArticleMutationOutboxAsync(
                    articleId,
                    ArticleMutationEventTypes.TrashCleared,
                    versions[articleId],
                    UtcNow,
                    scopes[articleId],
                    scopes[articleId] with
                    {
                        Visibility = "absent"
                    },
                    ct),
                ct).ConfigureAwait(false);
        });

        ct.ThrowIfCancellationRequested();
        if (result.IsSuccess)
        {
            string mutationId = await InvalidateCache();
            ct.ThrowIfCancellationRequested();
            await InvalidatePublicAotBatchAsync(articleIds, categoryIds, tagIds, "clear-trash", mutationId);
            ct.ThrowIfCancellationRequested();
            await _mutationSideEffects.AfterTrashClearedAsync(articleIds, ct);
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
            SELECT id, categoryid, coverimageurl
            FROM article
            WHERE isdeleted = true
            FOR UPDATE;
            """);
        while (await reader.ReadAsync(cancellationToken))
        {
            rows.Add(new TrashArticleRow(
                reader.ReadInt32("id"),
                reader.ReadInt32("categoryid"),
                reader.IsNull("coverimageurl") ? null : reader.ReadString("coverimageurl")));
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
                ct => _cacheReader.TryGetAsync(CachePolicyId.ArticleSearch, cacheIdentity, ServerCacheBinaryCodec.DecodeArticleSearch, ct),
                async ct => await _dbConcurrencyGate.ExecuteAsync(
                    "article-search",
                    async gateCt =>
                    {
                        List<ArticleListItemReadModel> result = await LoadSearchArticlesFromSourceAsync(normalizedKeyword, gateCt);
                        gateCt.ThrowIfCancellationRequested();
                        byte[] encoded = ServerCacheBinaryCodec.EncodeArticleSearch(result);
                        gateCt.ThrowIfCancellationRequested();
                        await _cacheWriter.SetRawAsync(CachePolicyId.ArticleSearch, cacheIdentity, encoded, null, gateCt);
                        FsusObservability.RecordCacheOperation("search", CachePolicyId.ArticleSearch.ToString(), "l2", "write_versioned", TimeSpan.Zero);
                        return result;
                    },
                    async gateCt =>
                    {
                        CacheReadResult<List<ArticleListItemReadModel>> retry = await _cacheReader.TryGetAsync(CachePolicyId.ArticleSearch, cacheIdentity, ServerCacheBinaryCodec.DecodeArticleSearch, gateCt);
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
        IReadOnlyList<ArticleHotProjectionRow> projection = await GetArticleHotProjectionAsync(effectiveCt).ConfigureAwait(false);
        return projection.Take(count)
            .Select(static row => new PopularArticleSummaryDto(row.Id, row.Title, row.Views))
            .ToList();
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

        IReadOnlyList<ArticleHotProjectionRow> projection = await GetArticleHotProjectionAsync(effectiveCt).ConfigureAwait(false);
        return projection
            .Where(static row => HasUsableFeaturedCover(row.CoverImageUrl))
            .Take(size)
            .Select(static row => new FeaturedArticleSummaryDto(
                row.Id,
                row.Title,
                row.CoverImageUrl.Trim(),
                row.Views,
                row.CreateTime,
                new ArticleCategoryView(row.CategoryId, row.CategoryName)))
            .ToList();
    }

    private Task<IReadOnlyList<ArticleHotProjectionRow>>? _articleHotProjectionTask;
    private readonly object _articleHotProjectionGate = new();

    private async Task<IReadOnlyList<ArticleHotProjectionRow>> GetArticleHotProjectionAsync(CancellationToken cancellationToken)
    {
        Task<IReadOnlyList<ArticleHotProjectionRow>> selected;
        lock (_articleHotProjectionGate)
        {
            selected = _articleHotProjectionTask ??= LoadArticleHotProjectionAsync(cancellationToken);
        }
        return await selected.WaitAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task<IReadOnlyList<ArticleHotProjectionRow>> LoadArticleHotProjectionAsync(CancellationToken cancellationToken)
    {
        string redisKey = RedisKey("blog:top_articles");
        CacheReadResult<List<int>> seed = await TryReadHotArticleSeedAsync(
            redisKey,
            MaxHotArticlesCount,
            cancellationToken).ConfigureAwait(false);
        FsusObservability.RecordArticleHotFrameSeed("bundle", seed.Hit ? "redis" : "miss");

        DateTime now = UtcNow;
        var query = _db.Queryable<Article>()
            .InnerJoin<ArticlePublicationRecord>((article, publication) => article.CurrentPublicationId == publication.Id)
            .InnerJoin<ArticleRevision>((article, publication, revision) => publication.ArticleRevisionId == revision.Id)
            .LeftJoin<Category>((article, publication, revision, category) => revision.CategoryId == category.Id)
            .Where((article, publication, revision, category) => !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= now)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= now));
        if (seed.Hit && seed.Value is { Count: > 0 } ids)
        {
            query = query.In(article => article.Id, ids);
        }
        else
        {
            query = query.OrderByDescending((article, publication, revision, category) => article.Views).Take(MaxHotArticlesCount);
        }

        var sqlObj = query.Select((article, publication, revision, category) => new
        {
            article.Id,
            revision.Title,
            revision.CoverImageUrl,
            article.Views,
            article.CreateTime,
            revision.CategoryId,
            CategoryName = category.Name
        }).ToSql();

        List<ArticleHotProjectionRow> rows = await _dbConcurrencyGate.ExecuteClassifiedAsync(
            DbWorkloadClass.PublicShortRead,
            "article-hot-featured-frame-projection",
            async gateCt =>
            {
                FsusObservability.RecordArticleHotFrameDatabaseCommand("bundle");
                var projected = new List<ArticleHotProjectionRow>(seed.Value?.Count ?? MaxHotArticlesCount);
                using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value);
                int fId = reader.GetOrdinal("Id"), fTitle = reader.GetOrdinal("Title"), fCover = reader.GetOrdinal("CoverImageUrl"),
                    fViews = reader.GetOrdinal("Views"), fCreateTime = reader.GetOrdinal("CreateTime"),
                    fCatId = reader.GetOrdinal("CategoryId"), fCatName = reader.GetOrdinal("CategoryName");

                while (await reader.ReadAsync(gateCt))
                {
                    projected.Add(new ArticleHotProjectionRow(
                        reader.GetInt32(fId),
                        reader.GetString(fTitle),
                        reader.IsDBNull(fCover) ? string.Empty : reader.GetString(fCover),
                        reader.GetInt32(fViews),
                        reader.GetDateTime(fCreateTime),
                        reader.GetInt32(fCatId),
                        reader.IsDBNull(fCatName) ? string.Empty : reader.GetString(fCatName)));
                }
                return projected;
            },
            _ => Task.FromException<List<ArticleHotProjectionRow>>(new TimeoutException("db-gate-timeout:article-hot-featured-frame-projection")),
            cancellationToken).ConfigureAwait(false);

        if (seed.Hit && seed.Value is { Count: > 0 } orderedSeedIds)
        {
            var ranks = new Dictionary<int, int>(orderedSeedIds.Count);
            for (int i = 0; i < orderedSeedIds.Count; i++)
            {
                ranks.TryAdd(orderedSeedIds[i], i);
            }
            rows.Sort((left, right) => ranks.GetValueOrDefault(left.Id, int.MaxValue)
                .CompareTo(ranks.GetValueOrDefault(right.Id, int.MaxValue)));
        }
        return rows;
    }

    private sealed record ArticleHotProjectionRow(
        int Id,
        string Title,
        string CoverImageUrl,
        int Views,
        DateTime CreateTime,
        int CategoryId,
        string CategoryName);

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
        ArticleListCursorPosition? cursor,
        ArticleListSortMode sort,
        CancellationToken cancellationToken)
    {
        List<string> whereClauses = ["a.isdeleted = @IsDeleted"];
        List<SugarParameter> parameters =
        [
            new("@IsDeleted", isDeleted),
            new("@Now", UtcNow)
        ];

        if (!isDeleted && !includePrivate)
        {
            whereClauses.Add("a.status = @PublishedStatus");
            whereClauses.Add("a.current_publication_id IS NOT NULL");
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
            whereClauses.Add(!isDeleted && !includePrivate
                ? "EXISTS (SELECT 1 FROM article_publication filter_publication JOIN article_revision filter_revision ON filter_revision.id = filter_publication.article_revision_id WHERE filter_publication.id = a.current_publication_id AND filter_revision.categoryid = @CategoryId)"
                : "a.categoryid = @CategoryId");
            parameters.Add(new SugarParameter("@CategoryId", categoryId.Value));
        }

        if (tagId.HasValue)
        {
            whereClauses.Add(!isDeleted && !includePrivate
                ? "EXISTS (SELECT 1 FROM article_publication filter_publication JOIN article_revision filter_revision ON filter_revision.id = filter_publication.article_revision_id WHERE filter_publication.id = a.current_publication_id AND @TagId = ANY(COALESCE(string_to_array(NULLIF(filter_revision.tag_ids, ''), ',')::integer[], ARRAY[]::integer[])))"
                : "EXISTS (SELECT 1 FROM article_tag at WHERE at.articleid = a.id AND at.tagid = @TagId)");
            parameters.Add(new SugarParameter("@TagId", tagId.Value));
        }

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            whereClauses.Add(!isDeleted && !includePrivate
                ? "EXISTS (SELECT 1 FROM article_publication filter_publication JOIN article_revision filter_revision ON filter_revision.id = filter_publication.article_revision_id WHERE filter_publication.id = a.current_publication_id AND (filter_revision.title LIKE @Keyword OR filter_revision.summary LIKE @Keyword))"
                : "(a.title LIKE @Keyword OR a.summary LIKE @Keyword)");
            parameters.Add(new SugarParameter("@Keyword", $"%{keyword}%"));
            parameters.Add(new SugarParameter("@KeywordExact", keyword));
            parameters.Add(new SugarParameter("@KeywordPrefix", $"{keyword}%"));
        }

        string whereSql = string.Join(" AND ", whereClauses);
        if (ShouldUsePublicKeysetPagination(isDeleted, status, includePrivate))
        {
            string countIdentity = BuildArticleListCountIdentity(version, categoryId, tagId, isDeleted, status, includePrivate, keyword);
            return await LoadPublicArticleListPageByKeysetAsync(
                page,
                size,
                categoryId,
                tagId,
                keyword,
                cursor,
                sort,
                whereSql,
                parameters,
                countIdentity,
                version,
                cancellationToken);
        }

        parameters.Add(new SugarParameter("@Limit", size));
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
                a.published_at AS "PublishedAt",
                current_revision.id AS "CurrentRevisionId",
                current_revision.revision_no AS "RevisionNo",
                publication.id AS "CurrentPublicationId",
                publication.publication_no AS "PublicationNo"
            FROM article a
            LEFT JOIN article_revision current_revision ON current_revision.id = a.current_revision_id
            LEFT JOIN article_publication publication ON publication.id = a.current_publication_id
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
        int? categoryId,
        int? tagId,
        string keyword,
        ArticleListCursorPosition? cursor,
        ArticleListSortMode sort,
        string whereSql,
        IReadOnlyCollection<SugarParameter> baseParameters,
        string countIdentity,
        long queryVersion,
        CancellationToken cancellationToken)
    {
        int totalCount = await GetCachedArticleListTotalCountAsync(countIdentity, whereSql, baseParameters, cancellationToken);

        List<ArticleListItemReadModel> pageItems = await LoadPublicArticleListKeysetPageItemsAsync(
            whereSql,
            baseParameters,
            cursor,
            sort,
            size + 1,
            cancellationToken);
        bool hasMore = pageItems.Count > size;
        if (hasMore)
        {
            pageItems.RemoveAt(pageItems.Count - 1);
        }

        ArticleListItemReadModel? lastItem = pageItems.Count > 0 ? pageItems[^1] : null;
        return new ArticleListPageReadModel
        {
            Items = pageItems,
            Total = totalCount,
            NextCursor = hasMore && lastItem is not null
                ? (_articleListCursorCodec ?? throw new InvalidOperationException("Article list cursor codec is unavailable.")).Encode(
                    new ArticleListCursorPosition(lastItem.CreateTime, lastItem.Id, lastItem.CursorSortValue),
                    categoryId,
                    tagId,
                    keyword,
                    size,
                    queryVersion,
                    sort)
                : null,
            HasMore = hasMore
        };
    }

    private async Task<List<ArticleListItemReadModel>> LoadPublicArticleListKeysetPageItemsAsync(
        string whereSql,
        IReadOnlyCollection<SugarParameter> baseParameters,
        ArticleListCursorPosition? cursor,
        ArticleListSortMode sort,
        int limit,
        CancellationToken cancellationToken)
    {
        string pageSql = BuildArticleListKeysetPageSql(whereSql, cursor.HasValue, sort);
        List<SugarParameter> parameters = CloneArticleListParameters(baseParameters);
        parameters.Add(new SugarParameter("@Limit", limit));
        if (cursor is { } position)
        {
            parameters.Add(new SugarParameter("@CursorTime", position.CreateTimeUtc));
            parameters.Add(new SugarParameter("@CursorId", position.Id));
            parameters.Add(new SugarParameter("@CursorSortValue", position.SortValue));
        }

        var pageItems = new List<ArticleListItemReadModel>(limit);
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(pageSql, parameters))
        {
            await ReadArticleListItemsAsync(reader, pageItems, cancellationToken, includePublishedTags: true, includeCursorSortValue: true);
        }

        return pageItems;
    }

    private async Task<int> GetCachedArticleListTotalCountAsync(
        string countIdentity,
        string whereSql,
        IReadOnlyCollection<SugarParameter> baseParameters,
        CancellationToken cancellationToken)
    {
        return await _cacheMissCoordinator.CoordinateAsync(
            CachePolicyId.ArticleListCount,
            countIdentity,
            async ct =>
            {
                string? cached = await _stringReader.GetStringAsync(CachePolicyId.ArticleListCount, countIdentity, ct).ConfigureAwait(false);
                return int.TryParse(cached, out int parsed) && parsed >= 0
                    ? new CacheReadResult<int>(true, parsed)
                    : new CacheReadResult<int>(false, default);
            },
            async ct =>
            {
                string countSql = $$"""
                    SELECT COUNT(1) AS "__TotalCount"
                    FROM article a
                    WHERE {{whereSql}};
                    """;

                int totalCount = 0;
                using (var countReader = (DbDataReader)await _db.Ado.GetDataReaderAsync(countSql, CloneArticleListParameters(baseParameters)))
                {
                    if (await countReader.ReadAsync(ct))
                    {
                        totalCount = countReader.IsNull("__TotalCount") ? 0 : Convert.ToInt32(countReader.ReadValue("__TotalCount"));
                    }
                }

                await _stringWriter.SetStringAsync(
                    CachePolicyId.ArticleListCount,
                    countIdentity,
                    totalCount.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    cancellationToken: ct).ConfigureAwait(false);
                return totalCount;
            },
            "article-list-count",
            cancellationToken).ConfigureAwait(false);
    }

    private static string BuildArticleListKeysetPageSql(
        string whereSql,
        bool hasCursor,
        ArticleListSortMode sort)
    {
        string sortExpression = sort switch
        {
            ArticleListSortMode.Relevance => "(CASE WHEN revision.title = @KeywordExact THEN 3 WHEN revision.title LIKE @KeywordPrefix THEN 2 WHEN revision.title LIKE @Keyword THEN 1 ELSE 0 END)::bigint",
            ArticleListSortMode.Hot => "a.views::bigint",
            _ => "0::bigint"
        };
        string cursorClause = !hasCursor
            ? string.Empty
            : sort == ArticleListSortMode.Latest
                ? ArticleListCursorWhereClause
                : $" AND ({sortExpression} < @CursorSortValue OR ({sortExpression} = @CursorSortValue AND (a.createtime < @CursorTime OR (a.createtime = @CursorTime AND a.id < @CursorId))))";
        string orderBy = sort switch
        {
            ArticleListSortMode.Relevance or ArticleListSortMode.Hot => $"{sortExpression} DESC, a.createtime DESC, a.id DESC",
            _ => "a.createtime DESC, a.id DESC"
        };
        return $$"""
            SELECT
                a.id AS "Id",
                revision.title AS "Title",
                revision.summary AS "Summary",
                revision.cover_image_url AS "CoverImageUrl",
                a.views AS "Views",
                a.createtime AS "CreateTime",
                revision.categoryid AS "CategoryId",
                c.name AS "CategoryName",
                a.isdeleted AS "IsDeleted",
                a.status AS "Status",
                a.scheduled_publish_at AS "ScheduledPublishAt",
                a.published_at AS "PublishedAt",
                revision.id AS "CurrentRevisionId",
                revision.revision_no AS "RevisionNo",
                publication.id AS "CurrentPublicationId",
                publication.publication_no AS "PublicationNo",
                {{sortExpression}} AS "CursorSortValue",
                COALESCE(tag_projection.tag_ids, ARRAY[]::integer[]) AS "TagIds",
                COALESCE(tag_projection.tag_names, ARRAY[]::text[]) AS "TagNames"
            FROM article a
            JOIN article_publication publication ON publication.id = a.current_publication_id
            JOIN article_revision revision ON revision.id = publication.article_revision_id
            LEFT JOIN category c ON revision.categoryid = c.id
            LEFT JOIN LATERAL (
                SELECT
                    array_agg(tag.id ORDER BY source.ordinality) AS tag_ids,
                    array_agg(tag.name ORDER BY source.ordinality) AS tag_names
                FROM unnest(string_to_array(NULLIF(revision.tag_ids, ''), ',')::integer[])
                    WITH ORDINALITY AS source(tag_id, ordinality)
                JOIN tag ON tag.id = source.tag_id
            ) tag_projection ON TRUE
            WHERE {{whereSql}}{{cursorClause}}
            ORDER BY {{orderBy}}
            LIMIT @Limit;
            """;
    }

    private static async Task ReadArticleListItemsAsync(
        DbDataReader reader,
        List<ArticleListItemReadModel> list,
        CancellationToken cancellationToken,
        bool includePublishedTags = false,
        bool includeCursorSortValue = false)
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
        int fCurrentRevisionId = reader.GetOrdinal("CurrentRevisionId");
        int fRevisionNo = reader.GetOrdinal("RevisionNo");
        int fCurrentPublicationId = reader.GetOrdinal("CurrentPublicationId");
        int fPublicationNo = reader.GetOrdinal("PublicationNo");
        int fTagIds = includePublishedTags ? reader.GetOrdinal("TagIds") : -1;
        int fTagNames = includePublishedTags ? reader.GetOrdinal("TagNames") : -1;
        int fCursorSortValue = includeCursorSortValue ? reader.GetOrdinal("CursorSortValue") : -1;

        while (await reader.ReadAsync(cancellationToken))
        {
            IReadOnlyList<TagReadModel> tags = ArticleReadModelCollections.EmptyTags;
            if (includePublishedTags)
            {
                int[] tagIds = reader.GetFieldValue<int[]>(fTagIds);
                string[] tagNames = reader.GetFieldValue<string[]>(fTagNames);
                tags = tagIds
                    .Zip(tagNames, static (id, name) => new TagReadModel { Id = id, Name = name })
                    .ToArray();
            }

            list.Add(new ArticleListItemReadModel
            {
                Id = reader.GetInt32(fId),
                Title = reader.IsDBNull(fTitle) ? string.Empty : reader.GetString(fTitle),
                Summary = reader.IsDBNull(fSum) ? string.Empty : reader.GetString(fSum),
                CoverImageUrl = reader.IsDBNull(fCover) ? null : reader.GetString(fCover),
                Views = reader.GetInt32(fViews),
                CursorSortValue = includeCursorSortValue ? reader.GetInt64(fCursorSortValue) : 0,
                CreateTime = NormalizeArticleListTimestampUtc(reader.GetDateTime(fTime)),
                CategoryId = reader.GetInt32(fCatId),
                CategoryName = reader.IsDBNull(fCatName) ? "默认" : reader.GetString(fCatName),
                IsDeleted = reader.GetBoolean(fDel),
                Status = (ArticleStatus)reader.GetInt32(fStatus),
                ScheduledPublishAt = reader.IsDBNull(fScheduled) ? null : NormalizeArticleListTimestampUtc(reader.GetDateTime(fScheduled)),
                PublishedAt = reader.IsDBNull(fPublished) ? null : NormalizeArticleListTimestampUtc(reader.GetDateTime(fPublished)),
                CurrentRevisionId = reader.IsDBNull(fCurrentRevisionId) ? 0 : reader.GetInt64(fCurrentRevisionId),
                RevisionNo = reader.IsDBNull(fRevisionNo) ? 0 : reader.GetInt32(fRevisionNo),
                CurrentPublicationId = reader.IsDBNull(fCurrentPublicationId) ? null : reader.GetInt64(fCurrentPublicationId),
                PublicationNo = reader.IsDBNull(fPublicationNo) ? null : reader.GetInt32(fPublicationNo),
                Tags = tags
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

    private async Task AttachPublishedArticleListTagsAsync(List<ArticleListItemReadModel> list, CancellationToken cancellationToken)
    {
        if (list.Count == 0)
        {
            return;
        }

        int[] ids = list.Select(static item => item.Id).ToArray();
        List<PublishedArticleTagRow> rows = await _db.Queryable<Article>()
            .InnerJoin<ArticlePublicationRecord>((article, publication) => article.CurrentPublicationId == publication.Id)
            .InnerJoin<ArticleRevision>((article, publication, revision) => publication.ArticleRevisionId == revision.Id)
            .Where(article => ids.Contains(article.Id))
            .Select((article, publication, revision) => new PublishedArticleTagRow
            {
                ArticleId = article.Id,
                TagIds = revision.TagIds
            })
            .ToListAsync(cancellationToken);
        var map = rows.ToDictionary(
            static row => row.ArticleId,
            static row => row.TagIds.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(static value => int.TryParse(value, out int parsed) ? parsed : 0)
                .Where(static value => value > 0)
                .ToArray());
        int[] tagIds = map.Values.SelectMany(static values => values).Distinct().ToArray();
        Dictionary<int, string> tagNames = tagIds.Length == 0
            ? []
            : (await _db.Queryable<Tag>().Where(tag => tagIds.Contains(tag.Id)).ToListAsync(cancellationToken))
                .ToDictionary(static tag => tag.Id, static tag => tag.Name);
        for (int index = 0; index < list.Count; index++)
        {
            ArticleListItemReadModel item = list[index];
            IReadOnlyList<TagReadModel> tags = map.TryGetValue(item.Id, out int[]? itemTagIds)
                ? itemTagIds.Where(tagNames.ContainsKey).Select(tagId => new TagReadModel { Id = tagId, Name = tagNames[tagId] }).ToArray()
                : ArticleReadModelCollections.EmptyTags;
            list[index] = item with
            {
                Tags = tags
            };
        }
    }

    private sealed class PublishedArticleTagRow
    {
        public int ArticleId
        {
            get; init;
        }
        public string TagIds { get; init; } = string.Empty;
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

        DateTime now = UtcNow;
        var sqlObj = _db.Queryable<Article>()
            .InnerJoin<ArticlePublicationRecord>((article, publication) => article.CurrentPublicationId == publication.Id)
            .InnerJoin<ArticleRevision>((article, publication, revision) => publication.ArticleRevisionId == revision.Id)
            .LeftJoin<Category>((article, publication, revision, category) => revision.CategoryId == category.Id)
            .Where((article, publication, revision, category) => ids.Contains(article.Id)
                && !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= now)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= now))
            .Select((article, publication, revision, category) => new
            {
                article.Id,
                revision.Title,
                revision.Summary,
                revision.CoverImageUrl,
                article.Views,
                article.CreateTime,
                revision.CategoryId,
                CategoryName = category.Name,
                article.IsDeleted,
                RevisionId = revision.Id,
                revision.RevisionNo,
                PublicationId = publication.Id,
                publication.PublicationNo,
                article.PublishedAt
            })
            .ToSql();

        var metadataFromDb = new Dictionary<int, SearchArticleProjectionRow>(ids.Count);
        cancellationToken.ThrowIfCancellationRequested();
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
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
            int fRevisionId = reader.GetOrdinal("RevisionId");
            int fRevisionNo = reader.GetOrdinal("RevisionNo");
            int fPublicationId = reader.GetOrdinal("PublicationId");
            int fPublicationNo = reader.GetOrdinal("PublicationNo");
            int fPublishedAt = reader.GetOrdinal("PublishedAt");

            while (await reader.ReadAsync(cancellationToken))
            {
                metadataFromDb[reader.GetInt32(fId)] = new SearchArticleProjectionRow(
                    reader.IsDBNull(fTitle) ? string.Empty : reader.GetString(fTitle),
                    reader.IsDBNull(fSum) ? string.Empty : reader.GetString(fSum),
                    reader.IsDBNull(fCover) ? null : reader.GetString(fCover),
                    reader.GetInt32(fViews),
                    NormalizeArticleListTimestampUtc(reader.GetDateTime(fTime)),
                    reader.GetInt32(fCatId),
                    reader.IsDBNull(fCatName) ? "默认" : reader.GetString(fCatName),
                    reader.GetBoolean(fDel),
                    reader.GetInt64(fRevisionId),
                    reader.GetInt32(fRevisionNo),
                    reader.GetInt64(fPublicationId),
                    reader.GetInt32(fPublicationNo),
                    NormalizeArticleListTimestampUtc(reader.GetDateTime(fPublishedAt)));
            }
        }

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
                Title = metadata.Title,
                Snippet = searchIndexArticle.Content,
                Summary = metadata.Summary,
                CoverImageUrl = metadata.Cover,
                Views = metadata.Views,
                CreateTime = metadata.Time,
                CategoryId = metadata.CatId,
                CategoryName = metadata.CatName,
                IsDeleted = metadata.IsDel,
                Status = ArticleStatus.Published,
                PublishedAt = metadata.PublishedAt,
                CurrentRevisionId = metadata.RevisionId,
                RevisionNo = metadata.RevisionNo,
                CurrentPublicationId = metadata.PublicationId,
                PublicationNo = metadata.PublicationNo,
                Tags = ArticleReadModelCollections.EmptyTags
            });
        }

        await AttachPublishedArticleListTagsAsync(resultList, cancellationToken);

        return resultList;
    }

    private sealed record SearchArticleProjectionRow(
        string Title,
        string Summary,
        string? Cover,
        int Views,
        DateTime Time,
        int CatId,
        string CatName,
        bool IsDel,
        long RevisionId,
        int RevisionNo,
        long PublicationId,
        int PublicationNo,
        DateTime PublishedAt);

}
