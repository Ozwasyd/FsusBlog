using System.Data.Common;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Caching.Memory;

using SqlSugar;

namespace FsusBlog.Server.Services.Distribution;

public sealed class RelatedReadingService(
    ISqlSugarClient db,
    ICacheTypedReader cacheReader,
    ICacheRawWriter cacheWriter,
    ICacheStringReader stringReader,
    IMemoryCache memoryCache)
{
    private const int RelatedLimit = 6;
    private const int CandidateWindow = 120;
    private static readonly TimeSpan s_cacheTtl = TimeSpan.FromMinutes(5);
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly string[] s_scoreReasons = CreateScoreReasons();

    private static readonly HashSet<string> s_stopWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "the", "and", "for", "with", "from", "this", "that", "article", "blog", "https", "http", "www"
    };

    public async Task<RelatedReadingResponse?> BuildAsync(int articleId, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        if (articleId <= 0)
        {
            return null;
        }

        long version = await GetArticleListVersionAsync(cancellationToken);
        string cacheKey = $"article:{articleId}:v:{version}";
        if (memoryCache.TryGetValue(cacheKey, out RelatedReadingResponse? cached) && cached is not null)
        {
            FsusObservability.RecordRelatedReadingBuild(cacheHit: true, FsusObservability.GetElapsed(startedAt));
            return cached;
        }

        CacheReadResult<RelatedReadingResponse> sharedCached = await cacheReader.TryGetAsync(
            CachePolicyId.RelatedReading,
            cacheKey,
            DecodeRelatedReading,
            cancellationToken);
        if (sharedCached.Hit && sharedCached.Value is not null)
        {
            memoryCache.Set(cacheKey, sharedCached.Value, s_cacheTtl);
            FsusObservability.RecordRelatedReadingBuild(cacheHit: true, FsusObservability.GetElapsed(startedAt));
            return sharedCached.Value;
        }

        DateTime now = DateTime.UtcNow;
        RelatedArticleRow? article = await LoadPublicArticleAsync(articleId, now, cancellationToken);

        if (article is null)
        {
            FsusObservability.RecordRelatedReadingBuild(cacheHit: false, FsusObservability.GetElapsed(startedAt));
            return null;
        }

        int[] sourceTagIds = await LoadSourceTagIdsAsync(articleId, cancellationToken);
        HashSet<int> sourceTags = sourceTagIds.ToHashSet();
        string[] keywords = ExtractKeywords(article.Title, article.Summary);

        CandidateIndex candidateIndex = await LoadCandidateIndexAsync(articleId, article.CategoryId, now, cancellationToken);
        List<RelatedReadingItem> related = candidateIndex.Rows
            .Select(candidate => ScoreCandidate(article, candidate, sourceTags, candidateIndex.Tags.GetValueOrDefault(candidate.Id), keywords))
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
        memoryCache.Set(cacheKey, response, s_cacheTtl);
        await cacheWriter.SetRawAsync(CachePolicyId.RelatedReading, cacheKey, JsonSerializer.SerializeToUtf8Bytes(response, s_jsonOptions), s_cacheTtl, cancellationToken);
        FsusObservability.RecordRelatedReadingBuild(cacheHit: false, FsusObservability.GetElapsed(startedAt));
        return response;
    }

    private static (bool Success, RelatedReadingResponse? Value) DecodeRelatedReading(ReadOnlyMemory<byte> bytes)
    {
        RelatedReadingResponse? value = JsonSerializer.Deserialize<RelatedReadingResponse>(bytes.Span, s_jsonOptions);
        return (value is not null, value);
    }

    private async ValueTask<long> GetArticleListVersionAsync(CancellationToken cancellationToken)
    {
        string? version = await stringReader.GetStringAsync(CachePolicyId.ArticleListVersion, "main", cancellationToken);
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
                a.categoryid AS "CategoryId"
            FROM article a
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

        return new RelatedArticleRow
        {
            Id = reader.GetInt32(fId),
            Title = reader.IsDBNull(fTitle) ? string.Empty : reader.GetString(fTitle),
            Summary = reader.IsDBNull(fSummary) ? null : reader.GetString(fSummary),
            CreateTime = AsUtc(reader.GetDateTime(fCreateTime)),
            PublishedAt = reader.IsDBNull(fPublishedAt) ? null : AsUtc(reader.GetDateTime(fPublishedAt)),
            CategoryId = reader.GetInt32(fCategoryId)
        };
    }

    private async Task<int[]> LoadSourceTagIdsAsync(int articleId, CancellationToken cancellationToken)
        => [.. await db.Queryable<ArticleTag>()
            .Where(tag => tag.ArticleId == articleId)
            .Select(tag => tag.TagId)
            .ToListAsync(cancellationToken)];

    private async Task<CandidateIndex> LoadCandidateIndexAsync(
        int articleId,
        int categoryId,
        DateTime now,
        CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync("""
            WITH candidates AS (
                SELECT
                    a.id AS "Id",
                    a.title AS "Title",
                    a.summary AS "Summary",
                    a.createtime AS "CreateTime",
                    a.published_at AS "PublishedAt",
                    a.categoryid AS "CategoryId",
                    COALESCE(a.published_at, a.createtime) AS "SortTime"
                FROM article a
                WHERE a.id <> @ArticleId
                  AND a.isdeleted = false
                  AND a.status = @PublishedStatus
                  AND (a.published_at IS NULL OR a.published_at <= @Now)
                  AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)
                  AND (
                      a.categoryid = @CategoryId OR EXISTS (
                          SELECT 1
                          FROM article_tag source_tag
                          INNER JOIN article_tag candidate_tag ON candidate_tag.tagid = source_tag.tagid
                          WHERE source_tag.articleid = @ArticleId
                            AND candidate_tag.articleid = a.id
                      )
                  )
                ORDER BY COALESCE(a.published_at, a.createtime) DESC, a.id DESC
                LIMIT @CandidateWindow
            )
            SELECT
                candidates."Id",
                candidates."Title",
                candidates."Summary",
                candidates."CreateTime",
                candidates."PublishedAt",
                candidates."CategoryId",
                article_tag.tagid AS "TagId"
            FROM candidates
            LEFT JOIN article_tag ON article_tag.articleid = candidates."Id"
            ORDER BY candidates."SortTime" DESC, candidates."Id" DESC;
            """,
            new[]
            {
                new SugarParameter("@ArticleId", articleId),
                new SugarParameter("@CategoryId", categoryId),
                new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published),
                new SugarParameter("@Now", now),
                new SugarParameter("@CandidateWindow", CandidateWindow)
            });

        int fId = reader.GetOrdinal("Id");
        int fTitle = reader.GetOrdinal("Title");
        int fSummary = reader.GetOrdinal("Summary");
        int fCreateTime = reader.GetOrdinal("CreateTime");
        int fPublishedAt = reader.GetOrdinal("PublishedAt");
        int fCategoryId = reader.GetOrdinal("CategoryId");
        int fTagId = reader.GetOrdinal("TagId");

        var rows = new List<RelatedArticleRow>(CandidateWindow);
        var seenRows = new HashSet<int>();
        var tags = new Dictionary<int, HashSet<int>>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            int id = reader.GetInt32(fId);
            if (seenRows.Add(id))
            {
                rows.Add(new RelatedArticleRow
                {
                    Id = id,
                    Title = reader.IsDBNull(fTitle) ? string.Empty : reader.GetString(fTitle),
                    Summary = reader.IsDBNull(fSummary) ? null : reader.GetString(fSummary),
                    CreateTime = AsUtc(reader.GetDateTime(fCreateTime)),
                    PublishedAt = reader.IsDBNull(fPublishedAt) ? null : AsUtc(reader.GetDateTime(fPublishedAt)),
                    CategoryId = reader.GetInt32(fCategoryId)
                });
            }

            if (!reader.IsDBNull(fTagId))
            {
                if (!tags.TryGetValue(id, out HashSet<int>? articleTags))
                {
                    articleTags = [];
                    tags[id] = articleTags;
                }

                articleTags.Add(reader.GetInt32(fTagId));
            }
        }

        return new CandidateIndex(rows, tags);
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
        RelatedReadingScore score = ScoreCandidateValues(
            source.CategoryId,
            source.SortTime,
            sourceTags,
            candidate.CategoryId,
            candidate.SortTime,
            candidateTags,
            candidate.Title,
            candidate.Summary,
            keywords);
        return new ScoredRelatedArticle(candidate, score.Score, score.PublishedDistance, score.Reason);
    }

    private static RelatedReadingScore ScoreCandidateValues(
        int sourceCategoryId,
        DateTime sourcePublishedAt,
        IReadOnlyCollection<int> sourceTagIds,
        int candidateCategoryId,
        DateTime candidatePublishedAt,
        IReadOnlyCollection<int>? candidateTagIds,
        string candidateTitle,
        string? candidateSummary,
        string[] keywords)
    {
        int score = 0;
        int reasonMask = 0;
        if (candidateCategoryId == sourceCategoryId)
        {
            score += 80;
            reasonMask |= 1;
        }

        int sharedTags = CountSharedTags(sourceTagIds, candidateTagIds);
        if (sharedTags > 0)
        {
            score += Math.Min(60, sharedTags * 30);
            reasonMask |= 2;
        }

        int keywordMatches = CountKeywordMatches(candidateTitle, candidateSummary, keywords);
        if (keywordMatches > 0)
        {
            score += Math.Min(40, keywordMatches * 10);
            reasonMask |= 4;
        }

        int publishedDistance = Math.Abs(RoundingHelper.RoundToInt((candidatePublishedAt - sourcePublishedAt).TotalDays));
        if (publishedDistance <= 14)
        {
            score += Math.Max(1, 20 - publishedDistance);
            reasonMask |= 8;
        }

        return new RelatedReadingScore(score, publishedDistance, s_scoreReasons[reasonMask]);
    }

    private static int CountSharedTags(
        IReadOnlyCollection<int> sourceTagIds,
        IReadOnlyCollection<int>? candidateTagIds)
    {
        if (sourceTagIds.Count == 0 || candidateTagIds is null || candidateTagIds.Count == 0)
        {
            return 0;
        }

        int count = 0;
        int firstMatch = 0;
        bool hasFirstMatch = false;
        foreach (int candidateTagId in candidateTagIds)
        {
            if (hasFirstMatch && candidateTagId == firstMatch)
            {
                continue;
            }

            if (!ContainsTag(sourceTagIds, candidateTagId))
            {
                continue;
            }

            if (++count == 2)
            {
                return count;
            }

            firstMatch = candidateTagId;
            hasFirstMatch = true;
        }

        return count;
    }

    private static bool ContainsTag(IReadOnlyCollection<int> tags, int candidate)
    {
        if (tags is HashSet<int> hashSet)
        {
            return hashSet.Contains(candidate);
        }

        foreach (int tag in tags)
        {
            if (tag == candidate)
            {
                return true;
            }
        }

        return false;
    }

    private static int CountKeywordMatches(string title, string? summary, string[] keywords)
    {
        int count = 0;
        foreach (string keyword in keywords)
        {
            if (title.Contains(keyword, StringComparison.OrdinalIgnoreCase)
                || (summary?.Contains(keyword, StringComparison.OrdinalIgnoreCase) ?? false))
            {
                count++;
            }
        }

        return count;
    }

    private static string[] CreateScoreReasons()
    {
        var reasons = new string[16];
        for (int mask = 0; mask < reasons.Length; mask++)
        {
            var values = new List<string>(4);
            if ((mask & 1) != 0)
                values.Add("同分类");
            if ((mask & 2) != 0)
                values.Add("共同标签");
            if ((mask & 4) != 0)
                values.Add("全文关键词");
            if ((mask & 8) != 0)
                values.Add("发布时间接近");
            reasons[mask] = values.Count == 0 ? "近期发布" : string.Join(" / ", values);
        }

        return reasons;
    }

    internal static string[] ExtractKeywords(params string?[] values)
    {
        string text = string.Join(' ', values.Where(static value => !string.IsNullOrWhiteSpace(value))).ToLowerInvariant();
        var tokens = new List<string>(16);
        var buffer = new List<char>(32);

        void FlushWord()
        {
            if (buffer.Count >= 3)
            {
                string token = string.Create(buffer.Count, buffer, static (span, chars) =>
                {
                    CollectionsMarshal.AsSpan(chars).CopyTo(span);
                });
                if (!s_stopWords.Contains(token))
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
                tokens.Add(string.Create(2, (First: value, Second: text[i + 1]), static (span, pair) =>
                {
                    span[0] = pair.First;
                    span[1] = pair.Second;
                }));
            }
        }

        FlushWord();
        return [.. tokens.Distinct(StringComparer.Ordinal).Take(12)];
    }

    private static bool IsCjk(char value)
        => value is >= '\u4e00' and <= '\u9fff';

    private static RelatedReadingItem ToItem(RelatedArticleRow row, string reason)
        => new(row.Id, row.Title, row.Summary, AsUtc(row.CreateTime), reason);

    private static DateTime AsUtc(DateTime value)
        => value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };

    internal static RelatedReadingBenchmarkResult ScoreCandidateForBenchmark(
        int sourceCategoryId,
        DateTime sourcePublishedAt,
        IReadOnlyCollection<int> sourceTagIds,
        int candidateCategoryId,
        DateTime candidatePublishedAt,
        IReadOnlyCollection<int> candidateTagIds,
        string candidateTitle,
        string? candidateSummary,
        string[] keywords)
    {
        RelatedReadingScore scored = ScoreCandidateValues(
            sourceCategoryId,
            sourcePublishedAt,
            sourceTagIds,
            candidateCategoryId,
            candidatePublishedAt,
            candidateTagIds,
            candidateTitle,
            candidateSummary,
            keywords);
        return new RelatedReadingBenchmarkResult(scored.Score, scored.PublishedDistance, scored.Reason);
    }

    private sealed class RelatedArticleRow
    {
        public int Id
        {
            get; init;
        }
        public string Title { get; init; } = string.Empty;
        public string? Summary
        {
            get; init;
        }
        public DateTime CreateTime
        {
            get; init;
        }
        public DateTime? PublishedAt
        {
            get; init;
        }
        public int CategoryId
        {
            get; init;
        }
        public DateTime SortTime => PublishedAt ?? CreateTime;
    }

    private sealed record CandidateIndex(
        List<RelatedArticleRow> Rows,
        Dictionary<int, HashSet<int>> Tags);

    private readonly record struct ScoredRelatedArticle(RelatedArticleRow Row, int Score, int PublishedDistance, string Reason);
    private readonly record struct RelatedReadingScore(int Score, int PublishedDistance, string Reason);
}

internal readonly record struct RelatedReadingBenchmarkResult(int Score, int PublishedDistance, string Reason);
