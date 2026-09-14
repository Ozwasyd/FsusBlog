using System.Data.Common;
using System.Diagnostics;
using System.Runtime.InteropServices;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Validation;

using SqlSugar;

namespace FsusBlog.Server.Services.Distribution;

public sealed class RelatedReadingService(
    ISqlSugarClient db,
    IOwnedFrameCache frameCache,
    ICacheMissCoordinator cacheMissCoordinator,
    ICacheStringReader stringReader,
    ICacheRawWriter cacheWriter,
    IAedsEncoder aeds)
{
    private const int RelatedLimit = 6;
    private const int CandidateWindow = 120;
    internal const int RankingAlgorithmVersion = 1;
    private static readonly TimeSpan s_cacheTtl = TimeSpan.FromMinutes(5);
    private static readonly string[] s_scoreReasons = CreateScoreReasons();
    private readonly BoundedTaskSingleFlight<bool> _buildFlights = new();

    private static readonly HashSet<string> s_stopWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "the", "and", "for", "with", "from", "this", "that", "article", "blog", "https", "http", "www"
    };

    public async Task<RelatedReadingResponse?> BuildAsync(int articleId, CancellationToken cancellationToken = default)
    {
        using OwnedAedsFrameReadLease? lease = await BuildFrameAsync(articleId, cancellationToken).ConfigureAwait(false);
        if (lease is null)
        {
            return null;
        }

        var decodedFrame = aeds.TryDecode(lease.Memory);
        if (!decodedFrame.IsSuccess
            || decodedFrame.Value.FrameType != AedsFrameType.ArticleRelatedReading
            || !PodBinaryCodec.TryDecodeRelatedReading(decodedFrame.Value.Payload, out RelatedReadingResponse response))
        {
            return null;
        }

        return response;
    }

    public async Task<OwnedAedsFrameReadLease?> BuildFrameAsync(
        int articleId,
        CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        if (articleId <= 0)
        {
            return null;
        }

        long version = await GetArticleListVersionAsync(cancellationToken).ConfigureAwait(false);
        string cacheKey = BuildCacheIdentity(articleId, version);
        bool cacheHit = false;
        bool negative = false;
        long frameBytes = 0;
        long allocationBytes = 0;
        long dbCommandCount = 0;
        OwnedFrameCacheReadResult initial = await frameCache.TryGetOwnedFrameAsync(
            CachePolicyId.RelatedReading,
            cacheKey,
            AedsFrameType.ArticleRelatedReading,
            cancellationToken).ConfigureAwait(false);
        if (!initial.Hit)
        {
            await _buildFlights.RunAsync(
                CachePolicyId.RelatedReading,
                cacheKey,
                async buildCt =>
                {
                    bool? completed = await cacheMissCoordinator.CoordinateAsync(
                        CachePolicyId.RelatedReading,
                        cacheKey,
                        async ct =>
                        {
                            OwnedFrameCacheReadResult cached = await frameCache.TryGetOwnedFrameAsync(
                                CachePolicyId.RelatedReading,
                                cacheKey,
                                AedsFrameType.ArticleRelatedReading,
                                ct).ConfigureAwait(false);
                            cached.Lease?.Dispose();
                            return new CacheReadResult<bool>(cached.Hit, cached.Hit);
                        },
                        async ct =>
                        {
                            long allocatedBefore = GC.GetTotalAllocatedBytes(precise: false);
                            RelatedReadingResponse? response = await BuildResponseAsync(articleId, ct).ConfigureAwait(false);
                            dbCommandCount = 1;
                            if (response is null)
                            {
                                negative = true;
                                allocationBytes = Math.Max(0, GC.GetTotalAllocatedBytes(precise: false) - allocatedBefore);
                                await cacheWriter.SetNegativeAsync(CachePolicyId.RelatedReading, cacheKey, ct).ConfigureAwait(false);
                                return true;
                            }

                            OwnedAedsFrame frame = AedsOwnedFrameBuilder.BuildOwned(
                                AedsFrameType.ArticleRelatedReading,
                                writer => PodBinaryCodec.WriteRelatedReading(response, writer));
                            frameBytes = frame.LogicalLength;
                            allocationBytes = Math.Max(0, GC.GetTotalAllocatedBytes(precise: false) - allocatedBefore);
                            await frameCache.SetOwnedFrameAsync(
                                CachePolicyId.RelatedReading,
                                cacheKey,
                                frame,
                                s_cacheTtl,
                                ct).ConfigureAwait(false);
                            return true;
                        },
                        "related-reading-frame",
                        buildCt).ConfigureAwait(false);
                    return completed == true;
                },
                cancellationToken).ConfigureAwait(false);
        }
        else
        {
            initial.Lease?.Dispose();
        }

        OwnedFrameCacheReadResult final = await frameCache.TryGetOwnedFrameAsync(
            CachePolicyId.RelatedReading,
            cacheKey,
            AedsFrameType.ArticleRelatedReading,
            cancellationToken).ConfigureAwait(false);
        cacheHit = initial.Hit || dbCommandCount == 0;
        negative = final.Negative;
        frameBytes = final.Lease?.Memory.Length ?? frameBytes;
        OwnedAedsFrameReadLease? result = final.Lease;

        FsusObservability.RecordRelatedReadingBuild(
            cacheHit,
            negative,
            frameBytes,
            allocationBytes,
            dbCommandCount,
            FsusObservability.GetElapsed(startedAt));
        return result;
    }

    internal static string BuildCacheIdentity(int articleId, long publicationGeneration)
        => FormattableString.Invariant(
            $"article:{articleId}:publication:{publicationGeneration}:ranking:{RankingAlgorithmVersion}:aeds-frame:{AedsFrameHeader.CurrentVersion}:aeds-schema:{AedsProtocolMetadata.SchemaVersion}");

    private async Task<RelatedReadingResponse?> BuildResponseAsync(int articleId, CancellationToken cancellationToken)
    {
        DateTime now = DateTime.UtcNow;
        RelatedReadingBuildData? build = await LoadBuildDataAsync(articleId, now, cancellationToken).ConfigureAwait(false);

        if (build is null)
        {
            return null;
        }

        RelatedArticleRow article = build.Source;
        HashSet<int> sourceTags = build.SourceTags;
        string[] keywords = ExtractKeywords(article.Title, article.Summary);

        CandidateIndex candidateIndex = build.Candidates;
        List<RelatedReadingItem> related = candidateIndex.Rows
            .Select(candidate => ScoreCandidate(article, candidate, sourceTags, candidateIndex.Tags.GetValueOrDefault(candidate.Id), keywords))
            .OrderByDescending(static scored => scored.Score)
            .ThenBy(static scored => scored.PublishedDistance)
            .ThenByDescending(static scored => scored.Row.SortTime)
            .ThenByDescending(static scored => scored.Row.Id)
            .Take(RelatedLimit)
            .Select(static scored => ToItem(scored.Row, scored.Reason))
            .ToList();

        var response = new RelatedReadingResponse(
            related,
            build.Previous is null ? null : ToItem(build.Previous, "上一篇"),
            build.Next is null ? null : ToItem(build.Next, "下一篇"));
        return response;
    }

    private async ValueTask<long> GetArticleListVersionAsync(CancellationToken cancellationToken)
    {
        string? version = await stringReader.GetStringAsync(CachePolicyId.ArticleListVersion, "main", cancellationToken);
        return long.TryParse(version, out long parsed) ? parsed : 0;
    }

    private async Task<RelatedReadingBuildData?> LoadBuildDataAsync(
        int articleId,
        DateTime now,
        CancellationToken cancellationToken)
    {
        const string PublicArticlePredicate = """
            a.isdeleted = false
              AND a.status = @PublishedStatus
              AND a.current_publication_id IS NOT NULL
              AND (a.published_at IS NULL OR a.published_at <= @Now)
              AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)
            """;
        string sql = $$"""
            WITH visible AS MATERIALIZED (
                SELECT
                    a.id,
                    revision.title,
                    revision.summary,
                    a.createtime,
                    publication.published_at,
                    revision.categoryid,
                    COALESCE(
                        string_to_array(NULLIF(revision.tag_ids, ''), ',')::integer[],
                        ARRAY[]::integer[]) AS tag_ids,
                    COALESCE(publication.published_at, a.published_at, a.createtime) AS sort_time
                FROM article a
                JOIN article_publication publication ON publication.id = a.current_publication_id
                JOIN article_revision revision ON revision.id = publication.article_revision_id
                WHERE {{PublicArticlePredicate}}
            ), source AS (
                SELECT * FROM visible WHERE id = @ArticleId
            ), candidates AS (
                SELECT visible.*
                FROM visible CROSS JOIN source
                WHERE visible.id <> source.id
                  AND (visible.categoryid = source.categoryid OR visible.tag_ids && source.tag_ids)
                ORDER BY visible.sort_time DESC, visible.id DESC
                LIMIT @CandidateWindow
            ), previous_row AS (
                SELECT visible.*
                FROM visible CROSS JOIN source
                WHERE visible.sort_time < source.sort_time
                   OR (visible.sort_time = source.sort_time AND visible.id < source.id)
                ORDER BY visible.sort_time DESC, visible.id DESC
                LIMIT 1
            ), next_row AS (
                SELECT visible.*
                FROM visible CROSS JOIN source
                WHERE visible.sort_time > source.sort_time
                   OR (visible.sort_time = source.sort_time AND visible.id > source.id)
                ORDER BY visible.sort_time, visible.id
                LIMIT 1
            ), projection AS (
                SELECT 0 AS kind, 0::bigint AS ordinal, source.* FROM source
                UNION ALL
                SELECT
                    1,
                    ROW_NUMBER() OVER (ORDER BY candidates.sort_time DESC, candidates.id DESC),
                    candidates.*
                FROM candidates
                UNION ALL
                SELECT 2, 0::bigint, previous_row.* FROM previous_row
                UNION ALL
                SELECT 3, 0::bigint, next_row.* FROM next_row
            )
            SELECT
                kind AS "Kind",
                id AS "Id",
                title AS "Title",
                summary AS "Summary",
                createtime AS "CreateTime",
                published_at AS "PublishedAt",
                categoryid AS "CategoryId",
                tag_ids AS "TagIds"
            FROM projection
            ORDER BY kind, ordinal;
            """;

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            sql,
            new SugarParameter[]
            {
                new SugarParameter("@ArticleId", articleId),
                new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published),
                new SugarParameter("@Now", now),
                new SugarParameter("@CandidateWindow", CandidateWindow)
            });

        RelatedArticleRow? source = null;
        var sourceTags = new HashSet<int>();
        var rows = new List<RelatedArticleRow>(CandidateWindow);
        var candidateTags = new Dictionary<int, HashSet<int>>();
        RelatedArticleRow? previous = null;
        RelatedArticleRow? next = null;
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            int kind = reader.GetInt32(reader.GetOrdinal("Kind"));
            RelatedArticleRow row = ReadRelatedArticleRow(reader);
            HashSet<int> tags = ReadRelatedArticleTags(reader);
            switch (kind)
            {
                case 0:
                    source = row;
                    sourceTags = tags;
                    break;
                case 1:
                    rows.Add(row);
                    candidateTags[row.Id] = tags;
                    break;
                case 2:
                    previous = row;
                    break;
                case 3:
                    next = row;
                    break;
                default:
                    throw new InvalidOperationException("related_reading_projection_kind_invalid");
            }
        }

        if (source is null)
        {
            return null;
        }

        return new RelatedReadingBuildData(
            source,
            sourceTags,
            new CandidateIndex(rows, candidateTags),
            previous,
            next);
    }

    private static HashSet<int> ReadRelatedArticleTags(DbDataReader reader)
    {
        int ordinal = reader.GetOrdinal("TagIds");
        return reader.IsDBNull(ordinal)
            ? []
            : reader.GetFieldValue<int[]>(ordinal).ToHashSet();
    }

    private static RelatedArticleRow ReadRelatedArticleRow(DbDataReader reader)
    {
        int publishedAt = reader.GetOrdinal("PublishedAt");
        int summary = reader.GetOrdinal("Summary");
        return new RelatedArticleRow
        {
            Id = reader.GetInt32(reader.GetOrdinal("Id")),
            Title = reader.IsDBNull(reader.GetOrdinal("Title")) ? string.Empty : reader.GetString(reader.GetOrdinal("Title")),
            Summary = reader.IsDBNull(summary) ? null : reader.GetString(summary),
            CreateTime = AsUtc(reader.GetDateTime(reader.GetOrdinal("CreateTime"))),
            PublishedAt = reader.IsDBNull(publishedAt) ? null : AsUtc(reader.GetDateTime(publishedAt)),
            CategoryId = reader.GetInt32(reader.GetOrdinal("CategoryId"))
        };
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

    private sealed record RelatedReadingBuildData(
        RelatedArticleRow Source,
        HashSet<int> SourceTags,
        CandidateIndex CandidateIndex,
        RelatedArticleRow? Previous,
        RelatedArticleRow? Next)
    {
        public CandidateIndex Candidates => CandidateIndex;
    }

    private readonly record struct ScoredRelatedArticle(RelatedArticleRow Row, int Score, int PublishedDistance, string Reason);
    private readonly record struct RelatedReadingScore(int Score, int PublishedDistance, string Reason);
}

internal readonly record struct RelatedReadingBenchmarkResult(int Score, int PublishedDistance, string Reason);
