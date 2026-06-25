using System.Data.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.Extensions.Caching.Memory;
using SqlSugar;

namespace FsusBlog.Server.Services.Distribution;

public sealed class RelatedReadingService(
    ISqlSugarClient db,
    IUnifiedCache cache,
    IMemoryCache memoryCache)
{
    private const int RelatedLimit = 6;
    private const int CandidateWindow = 120;
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

    private static readonly HashSet<string> StopWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "the", "and", "for", "with", "from", "this", "that", "article", "blog", "https", "http", "www"
    };

    public async Task<RelatedReadingResponse?> BuildAsync(int articleId, CancellationToken cancellationToken = default)
    {
        if (articleId <= 0)
        {
            return null;
        }

        long version = await GetArticleListVersionAsync(cancellationToken);
        string cacheKey = $"related-reading:{version}:{articleId}";
        if (memoryCache.TryGetValue(cacheKey, out RelatedReadingResponse? cached) && cached is not null)
        {
            return cached;
        }

        DateTime now = DateTime.UtcNow;
        RelatedArticleRow? article = await LoadPublicArticleAsync(articleId, now, cancellationToken);

        if (article is null)
        {
            return null;
        }

        int[] sourceTagIds = [.. await db.Queryable<ArticleTag>()
            .Where(tag => tag.ArticleId == articleId)
            .Select(tag => tag.TagId)
            .ToListAsync(cancellationToken)];
        HashSet<int> sourceTags = sourceTagIds.ToHashSet();
        string[] keywords = ExtractKeywords(article.Title, article.Summary, article.MarkdownContent);

        List<RelatedArticleRow> candidates = await db.Queryable<Article>()
            .LeftJoin<ArticleBody>((candidate, body) => candidate.Id == body.ArticleId)
            .Where((candidate, body) => candidate.Id != articleId
                && !candidate.IsDeleted
                && candidate.Status == ArticleStatus.Published
                && (candidate.PublishedAt == null || candidate.PublishedAt <= now)
                && (candidate.ScheduledPublishAt == null || candidate.ScheduledPublishAt <= now))
            .OrderByDescending((candidate, body) => candidate.PublishedAt ?? candidate.CreateTime)
            .OrderByDescending((candidate, body) => candidate.Id)
            .Take(CandidateWindow)
            .Select((candidate, body) => new RelatedArticleRow
            {
                Id = candidate.Id,
                Title = candidate.Title,
                Summary = candidate.Summary,
                CreateTime = candidate.CreateTime,
                PublishedAt = candidate.PublishedAt,
                CategoryId = candidate.CategoryId,
                MarkdownContent = body.MarkdownContent
            })
            .ToListAsync(cancellationToken);

        Dictionary<int, HashSet<int>> candidateTags = await LoadTagMapAsync(candidates.Select(static candidate => candidate.Id).ToArray(), cancellationToken);
        List<RelatedReadingItem> related = candidates
            .Select(candidate => ScoreCandidate(article, candidate, sourceTags, candidateTags.GetValueOrDefault(candidate.Id), keywords))
            .OrderByDescending(static scored => scored.Score)
            .ThenBy(static scored => scored.PublishedDistance)
            .ThenByDescending(static scored => scored.Row.SortTime)
            .ThenByDescending(static scored => scored.Row.Id)
            .Take(RelatedLimit)
            .Select(static scored => ToItem(scored.Row, scored.Reason))
            .ToList();

        RelatedArticleRow? previous = await LoadAdjacentAsync(article, newer: false, now, cancellationToken);
        RelatedArticleRow? next = await LoadAdjacentAsync(article, newer: true, now, cancellationToken);

        var response = new RelatedReadingResponse(
            related,
            previous is null ? null : ToItem(previous, "上一篇"),
            next is null ? null : ToItem(next, "下一篇"));
        memoryCache.Set(cacheKey, response, CacheTtl);
        return response;
    }

    private async ValueTask<long> GetArticleListVersionAsync(CancellationToken cancellationToken)
    {
        string? version = await cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", cancellationToken);
        return long.TryParse(version, out long parsed) ? parsed : 0;
    }

    private async Task<RelatedArticleRow?> LoadPublicArticleAsync(
        int articleId,
        DateTime now,
        CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync("""
            SELECT
                a.id AS "Id",
                a.title AS "Title",
                a.summary AS "Summary",
                a.createtime AS "CreateTime",
                a.published_at AS "PublishedAt",
                a.categoryid AS "CategoryId",
                b.markdown_content AS "MarkdownContent"
            FROM article a
            LEFT JOIN article_body b ON a.id = b.article_id
            WHERE a.id = @ArticleId
              AND a.isdeleted = false
              AND a.status = @PublishedStatus
              AND (a.published_at IS NULL OR a.published_at <= @Now)
              AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)
            LIMIT 1;
            """,
            new[]
            {
                new SugarParameter("@ArticleId", articleId),
                new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published),
                new SugarParameter("@Now", now)
            });

        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        int fId = reader.GetOrdinal("Id");
        int fTitle = reader.GetOrdinal("Title");
        int fSummary = reader.GetOrdinal("Summary");
        int fCreateTime = reader.GetOrdinal("CreateTime");
        int fPublishedAt = reader.GetOrdinal("PublishedAt");
        int fCategoryId = reader.GetOrdinal("CategoryId");
        int fMarkdownContent = reader.GetOrdinal("MarkdownContent");

        return new RelatedArticleRow
        {
            Id = reader.GetInt32(fId),
            Title = reader.IsDBNull(fTitle) ? string.Empty : reader.GetString(fTitle),
            Summary = reader.IsDBNull(fSummary) ? null : reader.GetString(fSummary),
            CreateTime = reader.GetDateTime(fCreateTime),
            PublishedAt = reader.IsDBNull(fPublishedAt) ? null : reader.GetDateTime(fPublishedAt),
            CategoryId = reader.GetInt32(fCategoryId),
            MarkdownContent = reader.IsDBNull(fMarkdownContent) ? null : reader.GetString(fMarkdownContent)
        };
    }

    private async Task<Dictionary<int, HashSet<int>>> LoadTagMapAsync(int[] articleIds, CancellationToken cancellationToken)
    {
        if (articleIds.Length == 0)
        {
            return [];
        }

        List<RelatedTagRow> rows = await db.Queryable<ArticleTag>()
            .Where(tag => articleIds.Contains(tag.ArticleId))
            .Select(tag => new RelatedTagRow
            {
                ArticleId = tag.ArticleId,
                TagId = tag.TagId
            })
            .ToListAsync(cancellationToken);

        return rows
            .GroupBy(static row => row.ArticleId)
            .ToDictionary(
                static group => group.Key,
                static group => group.Select(static row => row.TagId).ToHashSet());
    }

    private async Task<RelatedArticleRow?> LoadAdjacentAsync(
        RelatedArticleRow article,
        bool newer,
        DateTime now,
        CancellationToken cancellationToken)
    {
        DateTime sortTime = article.SortTime;
        ISugarQueryable<Article> query = db.Queryable<Article>()
            .Where(candidate => candidate.Id != article.Id
                && !candidate.IsDeleted
                && candidate.Status == ArticleStatus.Published
                && (candidate.PublishedAt == null || candidate.PublishedAt <= now)
                && (candidate.ScheduledPublishAt == null || candidate.ScheduledPublishAt <= now));

        query = newer
            ? query.Where(candidate => (candidate.PublishedAt ?? candidate.CreateTime) > sortTime
                || ((candidate.PublishedAt ?? candidate.CreateTime) == sortTime && candidate.Id > article.Id))
                .OrderBy(candidate => candidate.PublishedAt ?? candidate.CreateTime)
                .OrderBy(candidate => candidate.Id)
            : query.Where(candidate => (candidate.PublishedAt ?? candidate.CreateTime) < sortTime
                || ((candidate.PublishedAt ?? candidate.CreateTime) == sortTime && candidate.Id < article.Id))
                .OrderByDescending(candidate => candidate.PublishedAt ?? candidate.CreateTime)
                .OrderByDescending(candidate => candidate.Id);

        return await query
            .Select(candidate => new RelatedArticleRow
            {
                Id = candidate.Id,
                Title = candidate.Title,
                Summary = candidate.Summary,
                CreateTime = candidate.CreateTime,
                PublishedAt = candidate.PublishedAt,
                CategoryId = candidate.CategoryId
            })
            .FirstAsync(cancellationToken);
    }

    private static ScoredRelatedArticle ScoreCandidate(
        RelatedArticleRow source,
        RelatedArticleRow candidate,
        HashSet<int> sourceTags,
        HashSet<int>? candidateTags,
        string[] keywords)
    {
        int score = 0;
        var reasons = new List<string>(4);

        if (candidate.CategoryId == source.CategoryId)
        {
            score += 80;
            reasons.Add("同分类");
        }

        int sharedTags = candidateTags is null ? 0 : sourceTags.Intersect(candidateTags).Count();
        if (sharedTags > 0)
        {
            score += Math.Min(60, sharedTags * 30);
            reasons.Add("共同标签");
        }

        int keywordMatches = CountKeywordMatches(candidate, keywords);
        if (keywordMatches > 0)
        {
            score += Math.Min(40, keywordMatches * 10);
            reasons.Add("全文关键词");
        }

        int publishedDistance = Math.Abs(RoundingHelper.RoundToInt((candidate.SortTime - source.SortTime).TotalDays));
        if (publishedDistance <= 14)
        {
            score += Math.Max(1, 20 - publishedDistance);
            reasons.Add("发布时间接近");
        }

        if (reasons.Count == 0)
        {
            reasons.Add("近期发布");
        }

        return new ScoredRelatedArticle(candidate, score, publishedDistance, string.Join(" / ", reasons));
    }

    private static int CountKeywordMatches(RelatedArticleRow candidate, string[] keywords)
    {
        if (keywords.Length == 0)
        {
            return 0;
        }

        string haystack = string.Join(' ', candidate.Title, candidate.Summary, candidate.MarkdownContent).ToLowerInvariant();
        int count = 0;
        foreach (string keyword in keywords)
        {
            if (haystack.Contains(keyword, StringComparison.Ordinal))
            {
                count++;
            }
        }

        return count;
    }

    private static string[] ExtractKeywords(params string?[] values)
    {
        string text = string.Join(' ', values.Where(static value => !string.IsNullOrWhiteSpace(value))).ToLowerInvariant();
        var tokens = new List<string>(16);
        var buffer = new List<char>(32);

        void FlushWord()
        {
            if (buffer.Count >= 3)
            {
                string token = new(buffer.ToArray());
                if (!StopWords.Contains(token))
                {
                    tokens.Add(token);
                }
            }

            buffer.Clear();
        }

        for (int i = 0; i < text.Length; i++)
        {
            char value = text[i];
            if (char.IsLetterOrDigit(value) && !IsCjk(value))
            {
                buffer.Add(value);
                continue;
            }

            FlushWord();
            if (IsCjk(value) && i + 1 < text.Length && IsCjk(text[i + 1]))
            {
                tokens.Add(text.Substring(i, 2));
            }
        }

        FlushWord();
        return [.. tokens.Distinct(StringComparer.Ordinal).Take(12)];
    }

    private static bool IsCjk(char value)
        => value is >= '\u4e00' and <= '\u9fff';

    private static RelatedReadingItem ToItem(RelatedArticleRow row, string reason)
        => new(row.Id, row.Title, row.Summary, row.CreateTime, reason);

    private sealed class RelatedArticleRow
    {
        public int Id { get; init; }
        public string Title { get; init; } = string.Empty;
        public string? Summary { get; init; }
        public DateTime CreateTime { get; init; }
        public DateTime? PublishedAt { get; init; }
        public int CategoryId { get; init; }
        public string? MarkdownContent { get; init; }
        public DateTime SortTime => PublishedAt ?? CreateTime;
    }

    private sealed class RelatedTagRow
    {
        public int ArticleId { get; init; }
        public int TagId { get; init; }
    }

    private sealed record ScoredRelatedArticle(RelatedArticleRow Row, int Score, int PublishedDistance, string Reason);
}
