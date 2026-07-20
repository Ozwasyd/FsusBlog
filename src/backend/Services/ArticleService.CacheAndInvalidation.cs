using System.Data;
using System.Data.Common;
using System.Runtime.CompilerServices;
using System.Text;

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

namespace FsusBlog.Server.Services;

public partial class ArticleService
{
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
            .InnerJoin<ArticlePublicationRecord>((article, publication) => article.CurrentPublicationId == publication.Id)
            .Where(a => !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now))
            .OrderByDescending((article, publication) => article.Views)
            .Take(count)
            .Select((article, publication) => new { article.Id, article.Views })
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

    private async Task InvalidatePublicAotWithCurrentStateAsync(
        int articleId,
        (List<int> CategoryIds, List<int> TagIds) beforeState,
        string operation)
    {
        var currentState = await LoadArticleAotStateAsync(articleId);
        await InvalidatePublicAotAsync(
            articleId,
            MergeIds(beforeState.CategoryIds, currentState.CategoryIds),
            MergeIds(beforeState.TagIds, currentState.TagIds),
            operation);
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

    private async Task<ArticleMutationState?> LoadArticleMutationStateAsync(int articleId, bool isDeleted)
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
              AND a.isdeleted = @IsDeleted
            GROUP BY a.id, a.categoryid, a.xmin;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@IsDeleted", isDeleted));
        if (!await reader.ReadAsync(Ct))
        {
            return null;
        }

        int categoryId = reader.ReadInt32("categoryid");
        string rowVersion = reader.ReadString("row_version");
        int[] tags = reader.ReadFieldValue<int[]>("tag_ids");
        return new ArticleMutationState([categoryId], tags.ToList(), rowVersion);
    }

    private async Task<bool> LockDeletedArticleForMutationAsync(int articleId, string rowVersion)
    {
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT 1
            FROM article
            WHERE id = @ArticleId
              AND isdeleted = true
              AND xmin::text = @RowVersion
            FOR UPDATE;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@RowVersion", rowVersion));
        return await reader.ReadAsync(Ct);
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
        return ArticleProjection.ToResponse(articlePreview with
        {
            Tags = tags
        });
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
        if (string.IsNullOrWhiteSpace(value))
            return string.Empty;
        var trimmed = value.Trim();
        return trimmed.Length > maxLen ? trimmed[..maxLen] : trimmed;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static List<int> NormalizeTagIds(IReadOnlyList<int>? tagIds)
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
            items[i] = item with
            {
                Tags = tagMap.TryGetValue(item.Id, out var tags) ? tags : ArticleReadModelCollections.EmptyTags
            };
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

    private async ValueTask<long> GetListCacheVersionAsync(CancellationToken cancellationToken)
    {
        string? ver = await _stringReader.GetStringAsync(CachePolicyId.ArticleListVersion, "main", cancellationToken);
        return long.TryParse(ver, out long parsed) ? parsed : 0;
    }

    private async ValueTask<long> GetSearchCacheVersionAsync(CancellationToken cancellationToken)
    {
        string? ver = await _stringReader.GetStringAsync(CachePolicyId.ArticleSearchVersion, "main", cancellationToken);
        return long.TryParse(ver, out long parsed) ? parsed : 0;
    }

    private string RedisKey(string key) => _runtimeKeyScope.PrefixKey(key);

    internal static string NormalizeSearchKeyword(string? keyword)
    {
        if (string.IsNullOrWhiteSpace(keyword))
        {
            return string.Empty;
        }

        string normalized = keyword.Normalize(NormalizationForm.FormKC).Trim();
        var builder = new StringBuilder(Math.Min(normalized.Length, MaxSearchKeywordLength));
        bool previousWhitespace = false;
        foreach (char ch in normalized)
        {
            if (char.IsWhiteSpace(ch))
            {
                if (builder.Length > 0 && !previousWhitespace)
                {
                    builder.Append(' ');
                    previousWhitespace = true;
                }

                continue;
            }

            builder.Append(char.ToLowerInvariant(ch));
            previousWhitespace = false;
            if (builder.Length >= MaxSearchKeywordLength)
            {
                break;
            }
        }

        return builder.ToString().TrimEnd();
    }

    internal static bool ShouldCacheSearchKeyword(string normalizedKeyword)
    {
        if (normalizedKeyword.Length < MinCacheableSearchKeywordLength || normalizedKeyword.Length > MaxCacheableSearchKeywordLength)
        {
            return false;
        }

        int lettersOrDigits = 0;
        int digits = 0;
        int spaces = 0;
        Span<bool> asciiSeen = stackalloc bool[128];
        int distinctAscii = 0;
        foreach (char ch in normalizedKeyword)
        {
            if (char.IsLetterOrDigit(ch))
            {
                lettersOrDigits++;
                if (char.IsDigit(ch))
                {
                    digits++;
                }
            }

            if (ch == ' ')
            {
                spaces++;
            }

            if (ch < asciiSeen.Length && !asciiSeen[ch])
            {
                asciiSeen[ch] = true;
                distinctAscii++;
            }
        }

        if (lettersOrDigits == 0)
        {
            return false;
        }

        bool looksRandom = normalizedKeyword.Length >= 24
            && spaces == 0
            && digits > 0
            && distinctAscii >= 12;
        return !looksRandom;
    }

    internal static string BuildArticleSearchIdentity(long version, string normalizedKeyword)
        => string.Concat("search:v", version.ToString(), ":", normalizedKeyword.Replace(':', '_'));

    private static string BuildArticleListIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status, bool includePrivate, string keyword)
    {
        return string.Concat(
            "v2:",
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

    private static string BuildArticleListCountIdentity(long version, int? categoryId, int? tagId, bool isDeleted, int? status, bool includePrivate, string keyword)
        => string.Concat(
            includePrivate ? "admin:" : "public:",
            version.ToString(System.Globalization.CultureInfo.InvariantCulture), ":",
            categoryId?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "0", ":",
            tagId?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "0", ":",
            isDeleted ? "1" : "0",
            ":",
            status?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "-1",
            ":",
            keyword);

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
