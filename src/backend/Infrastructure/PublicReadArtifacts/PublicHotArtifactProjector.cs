using System.Collections.Frozen;
using System.Data.Common;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.Extensions.Options;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public interface IPublicHotArtifactProjector
{
    Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken ct);

    Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
        PublicHotReadSnapshot current,
        int articleId,
        CancellationToken ct);
}

public sealed class PublicHotArtifactProjector(
    ISqlSugarClient db,
    IAedsEncoder aeds,
    IDbConcurrencyGate dbConcurrencyGate,
    IOptions<PublicHotReadOptions> options,
    ILogger<PublicHotArtifactProjector> logger) : IPublicHotArtifactProjector
{
    private const int MaxPageSize = 100;
    private const int MaxHotArticlesCount = 100;
    private const int LongReadThreshold = 5_000;
    private const int ReadingCharsPerMinute = 300;

    private bool? legacyArticleContentColumnExists;

    public Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
        PublicHotReadSnapshot current,
        int articleId,
        CancellationToken ct)
        => BuildSnapshotAsync(current.HtmlArtifacts, ct);

    public Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken ct)
        => BuildSnapshotAsync([], ct);

    private Task<PublicHotReadSnapshot> BuildSnapshotAsync(
        IEnumerable<KeyValuePair<string, PublicHtmlArtifact>> existingHtml,
        CancellationToken ct)
        => dbConcurrencyGate.ExecuteAsync(
            "public-hot-read-rebuild",
            gateCt => BuildSnapshotCoreAsync(existingHtml, gateCt),
            _ => Task.FromException<PublicHotReadSnapshot>(
                new TimeoutException("db-gate-timeout:public-hot-read-rebuild")),
            ct);

    private async Task<PublicHotReadSnapshot> BuildSnapshotCoreAsync(
        IEnumerable<KeyValuePair<string, PublicHtmlArtifact>> existingHtml,
        CancellationToken ct)
    {
        PublicHotReadOptions value = options.Value;
        DateTime utcNow = DateTime.UtcNow;
        long version = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        List<int> articleIds = await QueryPublicArticleIdsAsync(utcNow, value, ct).ConfigureAwait(false);
        FrozenDictionary<int, PublicBinaryArtifact> articleFrames = await BuildArticleFramesAsync(articleIds, version, value, ct).ConfigureAwait(false);
        FrozenDictionary<PublicListKey, PublicBinaryArtifact> listFrames = await BuildListFramesAsync(utcNow, version, value, ct).ConfigureAwait(false);
        PublicBinaryArtifact categoryFrame = await BuildCategoryFrameAsync(version, value, ct).ConfigureAwait(false);
        PublicBinaryArtifact tagFrame = await BuildTagFrameAsync(version, value, ct).ConfigureAwait(false);
        FrozenDictionary<string, PublicHtmlArtifact> html = existingHtml.ToFrozenDictionary(StringComparer.Ordinal);

        return new PublicHotReadSnapshot(
            version,
            articleFrames,
            listFrames,
            categoryFrame,
            tagFrame,
            html);
    }

    private async Task<List<int>> QueryPublicArticleIdsAsync(DateTime utcNow, PublicHotReadOptions options, CancellationToken ct)
    {
        return await db.Queryable<Article>()
            .Where(article => !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= utcNow)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= utcNow))
            .OrderBy(article => article.PublishedAt, OrderByType.Desc)
            .OrderBy(article => article.Id, OrderByType.Desc)
            .Take(Math.Clamp(options.MaxArticleFrames, 1, 1_000_000))
            .Select(article => article.Id)
            .ToListAsync(ct)
            .ConfigureAwait(false);
    }

    private async Task<FrozenDictionary<int, PublicBinaryArtifact>> BuildArticleFramesAsync(
        IReadOnlyList<int> articleIds,
        long version,
        PublicHotReadOptions options,
        CancellationToken ct)
    {
        if (articleIds.Count == 0)
        {
            return FrozenDictionary<int, PublicBinaryArtifact>.Empty;
        }

        var frames = new Dictionary<int, PublicBinaryArtifact>(articleIds.Count);
        foreach (int articleId in articleIds)
        {
            ct.ThrowIfCancellationRequested();
            ArticleDetailReadModel? detail = await LoadArticleDetailFromDbAsync(articleId, ct).ConfigureAwait(false);
            if (detail is null)
            {
                continue;
            }

            ArticleDetailCoreModel core = ArticleProjection.ToCoreDetailModel(detail);
            frames[articleId] = EncodeFrame(AedsFrameType.ArticleDetail, PodBinaryCodec.EncodeArticleDetail(core), version, options);
        }

        return frames.ToFrozenDictionary();
    }

    private async Task<FrozenDictionary<PublicListKey, PublicBinaryArtifact>> BuildListFramesAsync(
        DateTime utcNow,
        long version,
        PublicHotReadOptions options,
        CancellationToken ct)
    {
        var frames = new Dictionary<PublicListKey, PublicBinaryArtifact>();
        int[] pages = NormalizePositive(options.PreloadPages, [1], Math.Clamp(options.MaxPreloadPage, 1, ushort.MaxValue));
        int[] sizes = NormalizePositive(options.PreloadSizes, [1, 3, 5, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));
        int[] hotSizes = NormalizePositive(options.HotSizes, [1, 3, 5, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));
        int[] featuredSizes = NormalizePositive(options.FeaturedSizes, [3, 4, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));

        foreach (int page in pages)
        {
            foreach (int size in sizes)
            {
                await AddArticlePageFrameAsync(frames, new PublicListKey(PublicListKind.Home, 0, (ushort)page, (byte)size), page, size, null, null, version, options, ct).ConfigureAwait(false);
                await AddArticlePageFrameAsync(frames, new PublicListKey(PublicListKind.Archive, 0, (ushort)page, (byte)size), page, size, null, null, version, options, ct).ConfigureAwait(false);
            }
        }

        List<int> categoryIds = await QueryPublicCategoryIdsAsync(utcNow, ct).ConfigureAwait(false);
        foreach (int categoryId in categoryIds)
        {
            foreach (int page in pages)
            {
                foreach (int size in sizes)
                {
                    await AddArticlePageFrameAsync(
                            frames,
                            new PublicListKey(PublicListKind.Category, categoryId, (ushort)page, (byte)size),
                            page,
                            size,
                            categoryId,
                            null,
                            version,
                            options,
                            ct)
                        .ConfigureAwait(false);
                }
            }
        }

        List<int> tagIds = await QueryPublicTagIdsAsync(utcNow, ct).ConfigureAwait(false);
        foreach (int tagId in tagIds)
        {
            foreach (int page in pages)
            {
                foreach (int size in sizes)
                {
                    await AddArticlePageFrameAsync(
                            frames,
                            new PublicListKey(PublicListKind.Tag, tagId, (ushort)page, (byte)size),
                            page,
                            size,
                            null,
                            tagId,
                            version,
                            options,
                            ct)
                        .ConfigureAwait(false);
                }
            }
        }

        foreach (int size in hotSizes)
        {
            await AddHotFrameAsync(frames, size, version, options, ct).ConfigureAwait(false);
        }

        foreach (int size in featuredSizes)
        {
            await AddFeaturedFrameAsync(frames, size, version, options, ct).ConfigureAwait(false);
        }

        return frames.ToFrozenDictionary();
    }

    private async Task<List<int>> QueryPublicCategoryIdsAsync(DateTime utcNow, CancellationToken ct)
    {
        return await db.Queryable<Article>()
            .Where(article => !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= utcNow)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= utcNow))
            .Select(article => article.CategoryId)
            .Distinct()
            .ToListAsync(ct)
            .ConfigureAwait(false);
    }

    private async Task<List<int>> QueryPublicTagIdsAsync(DateTime utcNow, CancellationToken ct)
    {
        return await db.Queryable<ArticleTag, Article>((articleTag, article) => articleTag.ArticleId == article.Id)
            .Where((articleTag, article) => !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= utcNow)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= utcNow))
            .Select((articleTag, article) => articleTag.TagId)
            .Distinct()
            .ToListAsync(ct)
            .ConfigureAwait(false);
    }

    private async Task AddArticlePageFrameAsync(
        Dictionary<PublicListKey, PublicBinaryArtifact> frames,
        PublicListKey key,
        int page,
        int size,
        int? categoryId,
        int? tagId,
        long version,
        PublicHotReadOptions options,
        CancellationToken ct)
    {
        try
        {
            CorePageResult<ArticleListCoreModel> pageResult = await LoadArticlePageFromDbAsync(page, size, categoryId, tagId, ct).ConfigureAwait(false);
            frames[key] = EncodeFrame(AedsFrameType.ArticleList, PodBinaryCodec.EncodeArticlePage(pageResult), version, options);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug(ex, "public-hot-list-project-skip {Kind} {TargetId} {Page} {Size}", key.Kind, key.TargetId, key.Page, key.Size);
        }
    }

    private async Task AddHotFrameAsync(
        Dictionary<PublicListKey, PublicBinaryArtifact> frames,
        int size,
        long version,
        PublicHotReadOptions options,
        CancellationToken ct)
    {
        try
        {
            IReadOnlyList<PopularArticleCoreModel> result = await LoadHotArticlesFromDbAsync(size, ct).ConfigureAwait(false);
            frames[new PublicListKey(PublicListKind.Hot, 0, 1, (byte)size)] =
                EncodeFrame(AedsFrameType.ArticleHot, PodBinaryCodec.EncodePopularArticles(result), version, options);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug(ex, "public-hot-list-project-skip hot {Size}", size);
        }
    }

    private async Task AddFeaturedFrameAsync(
        Dictionary<PublicListKey, PublicBinaryArtifact> frames,
        int size,
        long version,
        PublicHotReadOptions options,
        CancellationToken ct)
    {
        try
        {
            IReadOnlyList<FeaturedArticleCoreModel> result = await LoadFeaturedArticlesFromDbAsync(size, ct).ConfigureAwait(false);
            frames[new PublicListKey(PublicListKind.Featured, 0, 1, (byte)size)] =
                EncodeFrame(AedsFrameType.ArticleFeatured, PodBinaryCodec.EncodeFeaturedArticleCoreList(result), version, options);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug(ex, "public-hot-list-project-skip featured {Size}", size);
        }
    }

    private async Task<CorePageResult<ArticleListCoreModel>> LoadArticlePageFromDbAsync(
        int page,
        int size,
        int? categoryId,
        int? tagId,
        CancellationToken ct)
    {
        page = page < 1 ? 1 : page;
        size = size switch
        {
            < 1 => 10,
            > MaxPageSize => MaxPageSize,
            _ => size
        };

        List<string> whereClauses =
        [
            "a.isdeleted = @IsDeleted",
            "a.status = @PublishedStatus",
            "(a.published_at IS NULL OR a.published_at <= @Now)",
            "(a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)"
        ];
        List<SugarParameter> parameters =
        [
            new("@IsDeleted", false),
            new("@PublishedStatus", (int)ArticleStatus.Published),
            new("@Now", DateTime.UtcNow),
            new("@Offset", (page - 1) * size),
            new("@Limit", size)
        ];

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

        string whereSql = string.Join(" AND ", whereClauses);
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
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(combinedSql, parameters))
        {
            if (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                totalCount = reader.IsDBNull(0) ? 0 : Convert.ToInt32(reader.GetValue(0));
            }

            if (!await reader.NextResultAsync(ct).ConfigureAwait(false))
            {
                return new CorePageResult<ArticleListCoreModel>([], totalCount);
            }

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

            while (await reader.ReadAsync(ct).ConfigureAwait(false))
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
                    Tags = []
                });
            }
        }

        if (list.Count > 0)
        {
            var ids = new List<int>(list.Count);
            for (int i = 0; i < list.Count; i++)
            {
                ids.Add(list[i].Id);
            }

            IReadOnlyDictionary<int, List<TagReadModel>> tagMap = await LoadArticleTagMapAsync(ids, ct).ConfigureAwait(false);
            AttachTags(list, tagMap);
        }

        return new CorePageResult<ArticleListCoreModel>(list.Select(ArticleProjection.ToCoreListModel).ToList(), totalCount);
    }

    private async Task<ArticleDetailReadModel?> LoadArticleDetailFromDbAsync(int id, CancellationToken ct)
    {
        DateTime utcNow = DateTime.UtcNow;
        var query = db.Queryable<Article>()
            .LeftJoin<Category>((a, c) => a.CategoryId == c.Id)
            .Where(a => a.Id == id
                && a.IsDeleted == false
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= utcNow)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= utcNow))
            .Select((a, c) => new
            {
                a.Id,
                a.Title,
                a.Summary,
                a.CoverImageUrl,
                a.CategoryId,
                a.Views,
                a.CreateTime,
                a.IsDeleted,
                a.Status,
                a.ScheduledPublishAt,
                a.PublishedAt,
                CategoryName = c.Name
            });

        var sqlObj = query.ToSql();
        ArticleDetailReadModel? article = null;
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            if (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                int fId = reader.GetOrdinal("Id");
                int fTitle = reader.GetOrdinal("Title");
                int fSum = reader.GetOrdinal("Summary");
                int fCover = reader.GetOrdinal("CoverImageUrl");
                int fCatId = reader.GetOrdinal("CategoryId");
                int fViews = reader.GetOrdinal("Views");
                int fTime = reader.GetOrdinal("CreateTime");
                int fIsDel = reader.GetOrdinal("IsDeleted");
                int fStatus = reader.GetOrdinal("Status");
                int fScheduled = reader.GetOrdinal("ScheduledPublishAt");
                int fPublished = reader.GetOrdinal("PublishedAt");
                int fCatName = reader.GetOrdinal("CategoryName");

                article = new ArticleDetailReadModel
                {
                    Id = reader.GetInt32(fId),
                    Title = reader.IsDBNull(fTitle) ? string.Empty : reader.GetString(fTitle),
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
                    Tags = []
                };
            }
        }

        if (article is null)
        {
            return null;
        }

        string content = await LoadArticleContentAsync(id, ct).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(content) && !string.IsNullOrWhiteSpace(article.Summary))
        {
            content = article.Summary;
        }

        int wordCount = CalculateReadableLength(content);
        IReadOnlyDictionary<int, List<TagReadModel>> tagMap = await LoadArticleTagMapAsync([id], ct).ConfigureAwait(false);
        return article with
        {
            Content = content,
            WordCount = wordCount,
            EstimatedReadingMinutes = Math.Max(1, (wordCount + ReadingCharsPerMinute - 1) / ReadingCharsPerMinute),
            ShowReadingNotice = wordCount > LongReadThreshold,
            Tags = tagMap.TryGetValue(id, out var tags) ? tags : []
        };
    }

    private async Task<IReadOnlyList<PopularArticleCoreModel>> LoadHotArticlesFromDbAsync(int count, CancellationToken ct)
    {
        count = Math.Clamp(count, 1, MaxHotArticlesCount);
        DateTime now = DateTime.UtcNow;
        var rows = await db.Queryable<Article>()
            .Where(a => !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now))
            .OrderByDescending(a => a.Views)
            .OrderByDescending(a => a.Id)
            .Take(count)
            .Select(a => new { a.Id, a.Title, a.Views })
            .ToListAsync(ct)
            .ConfigureAwait(false);

        return rows.Select(row => new PopularArticleCoreModel(
            PodProjector.ProjectPopularArticle(row.Id, row.Title ?? string.Empty, row.Views),
            row.Id,
            row.Title ?? string.Empty,
            row.Views)).ToList();
    }

    private async Task<IReadOnlyList<FeaturedArticleCoreModel>> LoadFeaturedArticlesFromDbAsync(int count, CancellationToken ct)
    {
        count = Math.Clamp(count, 1, 20);
        DateTime now = DateTime.UtcNow;
        var rows = await db.Queryable<Article>()
            .LeftJoin<Category>((a, c) => a.CategoryId == c.Id)
            .Where(a => !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now)
                && a.CoverImageUrl != null
                && a.CoverImageUrl != "")
            .OrderByDescending(a => a.Views)
            .OrderByDescending(a => a.Id)
            .Take(count)
            .Select((a, c) => new
            {
                a.Id,
                a.Title,
                a.CoverImageUrl,
                a.Views,
                a.CreateTime,
                a.CategoryId,
                CategoryName = c.Name
            })
            .ToListAsync(ct)
            .ConfigureAwait(false);

        return rows.Select(row => new FeaturedArticleCoreModel(
            row.Id,
            row.Title ?? string.Empty,
            row.CoverImageUrl ?? string.Empty,
            row.Views,
            row.CreateTime,
            new ArticleCategoryCoreModel(row.CategoryId, row.CategoryName ?? string.Empty))).ToList();
    }

    private async Task<string> LoadArticleContentAsync(int articleId, CancellationToken ct)
    {
        string content = await db.Queryable<ArticleBody>()
            .Where(it => it.ArticleId == articleId)
            .Select(it => it.MarkdownContent)
            .FirstAsync() ?? string.Empty;

        if (!string.IsNullOrWhiteSpace(content) || !await LegacyArticleContentColumnExistsAsync().ConfigureAwait(false))
        {
            return content;
        }

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            "SELECT COALESCE(content, '') AS content FROM article WHERE id = @id LIMIT 1;",
            new[] { new SugarParameter("@id", articleId) });
        if (await reader.ReadAsync(ct).ConfigureAwait(false) && !reader.IsDBNull(0))
        {
            return reader.GetString(0);
        }

        return string.Empty;
    }

    private async Task<bool> LegacyArticleContentColumnExistsAsync()
    {
        if (legacyArticleContentColumnExists.HasValue)
        {
            return legacyArticleContentColumnExists.Value;
        }

        int exists = await db.Ado.GetIntAsync("""
            SELECT COUNT(1)
            FROM information_schema.columns
            WHERE table_name = 'article'
              AND column_name = 'content';
            """);
        legacyArticleContentColumnExists = exists > 0;
        return legacyArticleContentColumnExists.Value;
    }

    private async Task<Dictionary<int, List<TagReadModel>>> LoadArticleTagMapAsync(IReadOnlyCollection<int> articleIds, CancellationToken ct)
    {
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

        var tagRows = await db.Queryable<ArticleTag>()
            .InnerJoin<Tag>((at, t) => at.TagId == t.Id)
            .Where(at => ids.Contains(at.ArticleId))
            .Select((at, t) => new { at.ArticleId, t.Id, t.Name })
            .ToListAsync(ct)
            .ConfigureAwait(false);

        var tagMap = new Dictionary<int, List<TagReadModel>>(ids.Count);
        foreach (var row in tagRows)
        {
            if (!tagMap.TryGetValue(row.ArticleId, out var tags))
            {
                tags = [];
                tagMap[row.ArticleId] = tags;
            }

            tags.Add(new TagReadModel { Id = row.Id, Name = row.Name ?? string.Empty });
        }

        return tagMap;
    }

    private static void AttachTags(List<ArticleListItemReadModel> items, IReadOnlyDictionary<int, List<TagReadModel>> tagMap)
    {
        for (int i = 0; i < items.Count; i++)
        {
            ArticleListItemReadModel item = items[i];
            items[i] = item with { Tags = tagMap.TryGetValue(item.Id, out var tags) ? tags : [] };
        }
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

    private async Task<PublicBinaryArtifact> BuildCategoryFrameAsync(long version, PublicHotReadOptions options, CancellationToken ct)
    {
        DateTime now = DateTime.UtcNow;
        var query = db.Queryable<Category>()
            .LeftJoin<Article>((c, a) => c.Id == a.CategoryId
                && a.IsDeleted == false
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now))
            .GroupBy(c => new { c.Id, c.Name })
            .OrderBy(c => c.Id)
            .Select((c, a) => new
            {
                c.Id,
                c.Name,
                ArticleCount = SqlFunc.AggregateCount(a.Id)
            });

        var sqlObj = query.ToSql();
        var result = new List<CategoryListItemResponse>();
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id");
            int fName = reader.GetOrdinal("Name");
            int fCount = reader.GetOrdinal("ArticleCount");

            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                result.Add(ArticleProjection.ToCategoryResponse(
                    reader.GetInt32(fId),
                    reader.IsDBNull(fName) ? string.Empty : reader.GetString(fName),
                    (int)reader.GetInt64(fCount)));
            }
        }

        return EncodeFrame(AedsFrameType.CategoryList, PodBinaryCodec.EncodeCategoryList(result), version, options);
    }

    private async Task<PublicBinaryArtifact> BuildTagFrameAsync(long version, PublicHotReadOptions options, CancellationToken ct)
    {
        DateTime now = DateTime.UtcNow;
        var query = db.Queryable<Tag>()
            .LeftJoin<ArticleTag>((t, at) => t.Id == at.TagId)
            .LeftJoin<Article>((t, at, a) => at.ArticleId == a.Id
                && a.IsDeleted == false
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now))
            .GroupBy(t => new { t.Id, t.Name })
            .OrderBy(t => t.Id)
            .Select((t, at, a) => new
            {
                t.Id,
                t.Name,
                ArticleCount = SqlFunc.AggregateCount(a.Id)
            });

        var sqlObj = query.ToSql();
        var result = new List<TagWithCountDto>();
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id");
            int fName = reader.GetOrdinal("Name");
            int fCount = reader.GetOrdinal("ArticleCount");

            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                result.Add(new TagWithCountDto(
                    reader.GetInt32(fId),
                    reader.IsDBNull(fName) ? string.Empty : reader.GetString(fName),
                    (int)reader.GetInt64(fCount)));
            }
        }

        return EncodeFrame(AedsFrameType.TagList, PodBinaryCodec.EncodeTagWithCountList(result), version, options);
    }

    private PublicBinaryArtifact EncodeFrame(AedsFrameType frameType, byte[] payload, long version, PublicHotReadOptions options)
        => PublicHotReadBinaryArtifactFactory.FromPayload(aeds, frameType, payload, options.CacheControl, version, options);

    private static int[] NormalizePositive(int[]? values, int[] fallback, int max)
    {
        int[] normalized = (values is { Length: > 0 } ? values : fallback)
            .Where(value => value > 0 && value <= max)
            .Distinct()
            .Order()
            .ToArray();

        return normalized.Length == 0 ? fallback.Where(value => value <= max).ToArray() : normalized;
    }
}

public sealed class PublicHotReadStartupWarmupService(
    IServiceScopeFactory scopeFactory,
    PublicHotReadStore store,
    ILogger<PublicHotReadStartupWarmupService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            store.BeginBuild("startup");
            await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
            var projector = scope.ServiceProvider.GetRequiredService<IPublicHotArtifactProjector>();
            PublicHotReadSnapshot snapshot = await projector.BuildInitialSnapshotAsync(stoppingToken).ConfigureAwait(false);
            store.Publish(snapshot);
            logger.LogInformation("public-hot-read-snapshot-ready {Version}", snapshot.Version);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            store.ReportBuildFailure("startup", ex);
            logger.LogWarning(ex, "public-hot-read-snapshot-warmup-failed");
        }
    }
}
