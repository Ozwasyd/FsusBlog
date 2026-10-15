using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Frozen;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Globalization;
using System.IO.MemoryMappedFiles;
using System.Numerics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;

using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Win32.SafeHandles;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed partial class SearchIndexService
{
    private async Task<List<SearchSourceArticle>> LoadArticlesAsync(
        ISqlSugarClient db,
        int? expectedArticleId = null,
        long? expectedReleaseId = null,
        CancellationToken cancellationToken = default)
    {
        List<SearchArticleRow> articleRows = await LoadArticleRowsAsync(
            db,
            expectedArticleId,
            expectedReleaseId,
            cancellationToken).ConfigureAwait(false);
        if (expectedArticleId.HasValue && expectedReleaseId.HasValue)
        {
            long? currentReleaseId = await db.Queryable<Article>()
                .ClearFilter()
                .Where(article => article.Id == expectedArticleId.Value)
                .Select(article => article.CurrentPublicationId)
                .FirstAsync(cancellationToken);
            if (currentReleaseId != expectedReleaseId.Value)
            {
                throw new ArticleMutationSupersededException(
                    currentReleaseId.HasValue
                        ? $"superseded-by-release:{currentReleaseId.Value}"
                        : $"superseded-search-release:{expectedReleaseId.Value}");
            }
        }
        return await LoadSearchSourceArticlesAsync(db, articleRows).ConfigureAwait(false);
    }

    private async Task<List<SearchSourceArticle>> LoadSearchSourceArticlesAsync(ISqlSugarClient db, List<SearchArticleRow> articleRows)
    {
        if (articleRows.Count == 0)
        {
            return [];
        }

        int[] articleIds = articleRows.Select(it => it.Id).ToArray();
        Dictionary<int, int> commentMap = await LoadCommentCountMapAsync(db, articleIds);
        int[] allTagIds = articleRows
            .SelectMany(static row => FsusBlog.Server.Services.Authoring.AuthoringNormalization.ParseTagIds(row.TagIds))
            .Distinct()
            .ToArray();
        Dictionary<int, string> tagNames = allTagIds.Length == 0
            ? []
            : (await db.Queryable<Tag>().Where(tag => allTagIds.Contains(tag.Id)).ToListAsync())
                .ToDictionary(static tag => tag.Id, static tag => tag.Name);

        var list = new List<SearchSourceArticle>(articleRows.Count);
        foreach (SearchArticleRow row in articleRows)
        {
            if (string.IsNullOrWhiteSpace(row.ArticleBodyContent))
            {
                articleBodyRepairQueue.TrySchedule(row.Id, "search-index");
                logger.LogWarning("search_index_article_body_missing {ArticleId}", row.Id);
                FsusObservability.RecordOperation("article_body", "search_index", "missing", TimeSpan.Zero);
                continue;
            }

            string body = row.MarkdownContent;
            List<SearchTagItem> tags = FsusBlog.Server.Services.Authoring.AuthoringNormalization.ParseTagIds(row.TagIds)
                .Where(tagNames.ContainsKey)
                .Select(tagId => new SearchTagItem(tagId, tagNames[tagId]))
                .ToList();
            int docLength = Math.Max(CountVisibleTokenOccurrences(body) + 1, 1);
            list.Add(new SearchSourceArticle
            {
                Id = row.Id,
                Title = row.Title ?? string.Empty,
                Summary = NormalizeSummary(row.Summary, body),
                Body = body,
                CategoryId = row.CategoryId,
                CategoryName = string.IsNullOrWhiteSpace(row.CategoryName) ? "默认" : row.CategoryName,
                Tags = tags,
                Views = row.Views,
                CommentCount = commentMap.TryGetValue(row.Id, out int count) ? count : 0,
                CreateTime = NormalizeCreateTimeUtc(row.CreateTime),
                PublishedAt = NormalizeCreateTimeUtc(row.PublishedAt),
                DocLength = docLength,
                RevisionId = row.RevisionId,
                RevisionNo = row.RevisionNo,
                PublicationId = row.PublicationId,
                PublicationNo = row.PublicationNo
            });
        }

        return list;
    }

    private static DateTime NormalizeCreateTimeUtc(DateTime value)
        => value.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(value, DateTimeKind.Utc)
            : value.ToUniversalTime();

    private static int CountVisibleTokenOccurrences(string body)
    {
        body = TrimSearchBodyForTokenization(body);
        string plain = MdLinkRegex().Replace(body, m => m.Groups["text"].Value);
        plain = HtmlTagRegex().Replace(plain, string.Empty);
        plain = MdSymbolRegex().Replace(plain, " ");
        plain = WhiteSpaceRegex().Replace(plain, " ").Trim();
        if (plain.Length == 0)
        {
            return 0;
        }

        int count = 1;
        for (int i = 0; i < plain.Length; i++)
        {
            if (plain[i] == ' ')
            {
                count++;
            }
        }

        return count;
    }

    private static string TrimSearchBodyForTokenization(string body)
        => body.Length > MaxIndexedBodyChars ? body[..MaxIndexedBodyChars] : body;

    private static async Task<List<SearchArticleRow>> LoadArticleRowsAsync(
        ISqlSugarClient db,
        int? expectedArticleId,
        long? expectedReleaseId,
        CancellationToken cancellationToken)
    {
        DateTime now = DateTime.UtcNow;
        var rows = await db.Queryable<Article>()
            .InnerJoin<ArticlePublicationRecord>((article, publication) => article.CurrentPublicationId == publication.Id)
            .InnerJoin<ArticleRevision>((article, publication, revision) => publication.ArticleRevisionId == revision.Id)
            .LeftJoin<ArticleRevisionContentBlock>((article, publication, revision, block) => revision.ContentBlockId == block.Id)
            .LeftJoin<Category>((article, publication, revision, block, category) => revision.CategoryId == category.Id)
            .LeftJoin<ArticleBody>((article, publication, revision, block, category, body) => article.Id == body.ArticleId)
            .Where((article, publication, revision, block, category) => !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= now)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= now))
            .WhereIF(
                expectedArticleId.HasValue && expectedReleaseId.HasValue,
                (article, publication, revision, block, category) => article.Id != expectedArticleId.GetValueOrDefault()
                    || (article.CurrentPublicationId == expectedReleaseId.GetValueOrDefault()
                        && publication.Id == expectedReleaseId.GetValueOrDefault()))
            .OrderByDescending((article, publication, revision, block, category) => publication.PublishedAt)
            .Select((article, publication, revision, block, category, body) => new
            {
                Id = article.Id,
                Title = revision.Title,
                Summary = revision.Summary,
                CategoryId = revision.CategoryId,
                CategoryName = category.Name,
                Views = article.Views,
                CreateTime = article.CreateTime,
                MarkdownContent = block.MarkdownContent,
                revision.ContentBlockId,
                ResolvedContentBlockId = (long?)block.Id,
                ArticleBodyContent = body.MarkdownContent,
                TagIds = revision.TagIds,
                RevisionId = revision.Id,
                RevisionNo = revision.RevisionNo,
                PublicationId = publication.Id,
                PublicationNo = publication.PublicationNo,
                PublishedAt = publication.PublishedAt
            })
            .ToListAsync(cancellationToken);

        var articles = new List<SearchArticleRow>(rows.Count);
        foreach (var row in rows)
        {
            if (row.ContentBlockId <= 0
                || row.ResolvedContentBlockId != row.ContentBlockId
                || row.MarkdownContent is null)
            {
                throw new InvalidOperationException(
                    $"article_revision_content_block_missing:{row.RevisionId}:{row.ContentBlockId}");
            }

            articles.Add(new SearchArticleRow
            {
                Id = row.Id,
                Title = row.Title,
                Summary = row.Summary,
                CategoryId = row.CategoryId,
                CategoryName = row.CategoryName,
                Views = row.Views,
                CreateTime = row.CreateTime,
                MarkdownContent = row.MarkdownContent,
                ArticleBodyContent = row.ArticleBodyContent,
                TagIds = row.TagIds,
                RevisionId = row.RevisionId,
                RevisionNo = row.RevisionNo,
                PublicationId = row.PublicationId,
                PublicationNo = row.PublicationNo,
                PublishedAt = row.PublishedAt
            });
        }

        return articles;
    }

    private static async Task<Dictionary<int, string>> LoadBodyMapAsync(ISqlSugarClient db, int[] articleIds)
    {
        var rows = await db.Queryable<ArticleBody>()
            .Where(it => articleIds.Contains(it.ArticleId))
            .Select(it => new { it.ArticleId, it.MarkdownContent })
            .ToListAsync();

        var bodyMap = new Dictionary<int, string>(rows.Count);
        foreach (var row in rows)
        {
            bodyMap[row.ArticleId] = row.MarkdownContent ?? string.Empty;
        }

        return bodyMap;
    }

    private static async Task<Dictionary<int, List<SearchTagItem>>> LoadTagMapAsync(ISqlSugarClient db, int[] articleIds)
    {
        List<SearchTagRow> tagRows = await db.Queryable<ArticleTag, Tag>((at, t) => at.TagId == t.Id)
            .Where(at => articleIds.Contains(at.ArticleId))
            .Select((at, t) => new SearchTagRow
            {
                ArticleId = at.ArticleId,
                TagId = t.Id,
                TagName = t.Name
            })
            .ToListAsync();

        var tagMap = new Dictionary<int, List<SearchTagItem>>(Math.Min(articleIds.Length, tagRows.Count));
        foreach (SearchTagRow row in tagRows)
        {
            if (!tagMap.TryGetValue(row.ArticleId, out List<SearchTagItem>? tagsForArticle))
            {
                tagsForArticle = [];
                tagMap[row.ArticleId] = tagsForArticle;
            }

            tagsForArticle.Add(new SearchTagItem(row.TagId, row.TagName ?? string.Empty));
        }

        return tagMap;
    }

    private static async Task<Dictionary<int, int>> LoadCommentCountMapAsync(ISqlSugarClient db, int[] articleIds)
    {
        List<SearchCommentCountRow> commentRows = await db.Queryable<Comment>()
            .Where(c => articleIds.Contains(c.ArticleId) && !c.IsDeleted)
            .GroupBy(c => c.ArticleId)
            .Select(c => new SearchCommentCountRow
            {
                ArticleId = c.ArticleId,
                Count = SqlFunc.AggregateCount(c.Id)
            })
            .ToListAsync();

        var commentMap = new Dictionary<int, int>(commentRows.Count);
        foreach (SearchCommentCountRow row in commentRows)
        {
            commentMap[row.ArticleId] = row.Count;
        }

        return commentMap;
    }

    private static string NormalizeSummary(string? summary, string body)
        => ArticleSummaryProjection.Resolve(summary, body, MaxSummaryLength).Text;

    private static string BuildServerSearchSnippet(string keyword, string? title, string? summary, string? body)
    {
        string preferred = !string.IsNullOrWhiteSpace(summary) ? summary! : body ?? string.Empty;
        if (string.IsNullOrWhiteSpace(preferred))
        {
            return string.Empty;
        }

        string plain = NormalizeSnippetText(preferred);
        if (plain.Length == 0)
        {
            return string.Empty;
        }

        int hitIndex = plain.IndexOf(keyword, StringComparison.OrdinalIgnoreCase);
        if (hitIndex < 0)
        {
            return plain.Length <= MaxSummaryLength
                ? plain
                : string.Concat(plain.AsSpan(0, MaxSummaryLength), "...");
        }

        return CreateSnippetWindow(plain, hitIndex);
    }

    private static string BuildRuntimeSnippetWindow(string? summary, string? body)
    {
        string preferred = !string.IsNullOrWhiteSpace(summary) ? summary! : body ?? string.Empty;
        if (string.IsNullOrWhiteSpace(preferred))
        {
            return string.Empty;
        }

        string plain = NormalizeSnippetText(preferred);
        return plain.Length <= MaxSummaryLength
            ? plain
            : string.Concat(plain.AsSpan(0, MaxSummaryLength), "...");
    }

    private static string NormalizeSnippetText(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(Math.Min(value.Length, MaxSummaryLength * 2));
        bool pendingSpace = false;
        ReadOnlySpan<char> source = value.AsSpan();
        for (int i = 0; i < source.Length; i++)
        {
            char ch = source[i];

            if (ch == '<')
            {
                while (i + 1 < source.Length && source[i + 1] != '>')
                {
                    i++;
                }
                pendingSpace = true;
                continue;
            }

            if (ch == '[')
            {
                int close = source[i..].IndexOf("](".AsSpan());
                if (close > 0)
                {
                    AppendText(source.Slice(i + 1, close - 1), builder, ref pendingSpace);
                    int urlStart = i + close + 2;
                    int urlEnd = source[urlStart..].IndexOf(')');
                    i = urlEnd >= 0 ? urlStart + urlEnd : source.Length;
                    pendingSpace = true;
                    continue;
                }
            }

            if (char.IsWhiteSpace(ch) || ch is '`' or '#' or '>' or '*' or '_' or '~' or '-')
            {
                pendingSpace = true;
                continue;
            }

            if (pendingSpace && builder.Length > 0)
            {
                builder.Append(' ');
            }

            builder.Append(ch);
            pendingSpace = false;
        }

        return builder.ToString().Trim();
    }

    private static void AppendText(ReadOnlySpan<char> text, StringBuilder builder, ref bool pendingSpace)
    {
        for (int i = 0; i < text.Length; i++)
        {
            char ch = text[i];
            if (char.IsWhiteSpace(ch))
            {
                pendingSpace = true;
                continue;
            }

            if (pendingSpace && builder.Length > 0)
            {
                builder.Append(' ');
            }

            builder.Append(ch);
            pendingSpace = false;
        }
    }

    private static string CreateSnippetWindow(string plain, int hitIndex)
    {
        int start = Math.Max(0, hitIndex - 40);
        int length = Math.Min(MaxSummaryLength, plain.Length - start);
        return string.Concat(
            start > 0 ? "..." : string.Empty,
            plain.AsSpan(start, length),
            start + length < plain.Length ? "..." : string.Empty);
    }

    private static string CreateSnippetWindowFromRaw(string value, int hitIndex)
    {
        int start = Math.Max(0, hitIndex - 80);
        int length = Math.Min(MaxSummaryLength + 80, value.Length - start);
        string plain = NormalizeSnippetText(value.Substring(start, length));
        if (plain.Length <= MaxSummaryLength)
        {
            return string.Concat(
                start > 0 ? "..." : string.Empty,
                plain,
                start + length < value.Length ? "..." : string.Empty);
        }

        return string.Concat(
            start > 0 ? "..." : string.Empty,
            plain.AsSpan(0, MaxSummaryLength),
            "...");
    }

    private static uint[] BuildRuntimeQueryHashes(ISearchDictionaryLookup dictionary, string keyword)
    {
        string? normalized = NormalizeTokenForTests(keyword);
        if (normalized is null)
        {
            return [];
        }

        var hashes = new HashSet<uint>();
        EnumerateFieldTokens(
            dictionary,
            normalized,
            SearchFieldKind.Body,
            static (token, state) => state.Add(token.Hash),
            hashes);

        return [.. hashes];
    }

    private sealed class SearchRuntimeSnapshot
    {
        private readonly FrozenDictionary<uint, SearchRuntimePosting[]> _postingsByHash;
        private readonly FrozenDictionary<uint, SearchRuntimePostingBlock[]> _postingBlocksByHash;
        private readonly FrozenDictionary<int, SearchRuntimeDocument> _documentsById;
        private readonly ISearchDictionaryLookup _queryDictionary;

        public long EstimatedMemoryBytes
        {
            get;
        }

        public SearchRuntimeSnapshot(
            FrozenDictionary<uint, SearchRuntimePosting[]> postingsByHash,
            FrozenDictionary<uint, SearchRuntimePostingBlock[]> postingBlocksByHash,
            FrozenDictionary<int, SearchRuntimeDocument> documentsById,
            ISearchDictionaryLookup queryDictionary)
        {
            _postingsByHash = postingsByHash;
            _postingBlocksByHash = postingBlocksByHash;
            _documentsById = documentsById;
            _queryDictionary = queryDictionary;
            EstimatedMemoryBytes = EstimateMemoryBytes(postingsByHash, postingBlocksByHash, documentsById);
        }

        public static SearchRuntimeSnapshot Build(List<SearchSourceArticle> articles, SearchDictionaryRuntime dictionary)
        {
            var builder = new SearchRuntimeIndexBuilder(articles.Count);
            foreach (SearchSourceArticle article in articles)
            {
                builder.AddArticle(article, dictionary);
            }

            return builder.Build(dictionary.CreateSnapshot());
        }

        public List<Article> Search(string keyword)
        {
            uint[] hashes = BuildRuntimeQueryHashes(_queryDictionary, keyword);
            if (hashes.Length == 0)
            {
                return [];
            }

            var scores = new Dictionary<int, double>();
            foreach (uint hash in hashes)
            {
                if (!_postingsByHash.TryGetValue(hash, out SearchRuntimePosting[]? postings))
                {
                    continue;
                }

                foreach (SearchRuntimePosting posting in postings)
                {
                    scores.TryGetValue(posting.ArticleId, out double current);
                    scores[posting.ArticleId] = current + posting.Score;
                }
            }

            if (scores.Count == 0)
            {
                return [];
            }

            return SelectTopRuntimeCandidates(scores, _documentsById, 200)
                .Select(entry => new Article
                {
                    Id = entry.Document.Id,
                    Title = entry.Document.Title,
                    Content = BuildRuntimeSnippet(keyword, entry.Document)
                })
                .ToList();
        }

        private static SearchRuntimeCandidate[] SelectTopRuntimeCandidates(
            Dictionary<int, double> scores,
            FrozenDictionary<int, SearchRuntimeDocument> documentsById,
            int limit)
        {
            var heap = new PriorityQueue<SearchRuntimeCandidate, SearchRuntimeCandidatePriority>();
            foreach ((int articleId, double score) in scores)
            {
                SearchRuntimeDocument document = documentsById[articleId];
                var candidate = new SearchRuntimeCandidate(score, document);
                var priority = SearchRuntimeCandidatePriority.From(candidate);
                if (heap.Count < limit)
                {
                    heap.Enqueue(candidate, priority);
                    continue;
                }

                _ = heap.TryPeek(out _, out SearchRuntimeCandidatePriority worstPriority);
                if (priority.CompareTo(worstPriority) <= 0)
                {
                    continue;
                }

                _ = heap.Dequeue();
                heap.Enqueue(candidate, priority);
            }

            SearchRuntimeCandidate[] candidates = heap.UnorderedItems
                .Select(static item => item.Element)
                .ToArray();
            Array.Sort(candidates, static (left, right) => SearchRuntimeCandidate.CompareBestFirst(left, right));
            return candidates;
        }

        private static string BuildRuntimeSnippet(string keyword, SearchRuntimeDocument document)
        {
            int summaryHit = document.Summary.IndexOf(keyword, StringComparison.OrdinalIgnoreCase);
            if (summaryHit >= 0)
            {
                return CreateSnippetWindowFromRaw(document.Summary, summaryHit);
            }

            int bodyHit = document.SnippetWindow.IndexOf(keyword, StringComparison.OrdinalIgnoreCase);
            if (bodyHit >= 0)
            {
                return CreateSnippetWindowFromRaw(document.SnippetWindow, bodyHit);
            }

            if (!string.IsNullOrWhiteSpace(document.Summary))
            {
                return document.Summary.Length <= MaxSummaryLength
                    ? document.Summary
                    : string.Concat(document.Summary.AsSpan(0, MaxSummaryLength), "...");
            }

            return document.Title;
        }

        private static long EstimateMemoryBytes(
            FrozenDictionary<uint, SearchRuntimePosting[]> postingsByHash,
            FrozenDictionary<uint, SearchRuntimePostingBlock[]> postingBlocksByHash,
            FrozenDictionary<int, SearchRuntimeDocument> documentsById)
        {
            long bytes = 0;
            foreach (SearchRuntimePosting[] postings in postingsByHash.Values)
            {
                bytes += postings.Length * (sizeof(int) + sizeof(double));
            }

            foreach (SearchRuntimePostingBlock[] blocks in postingBlocksByHash.Values)
            {
                bytes += blocks.Length * (sizeof(int) + sizeof(int) + sizeof(double));
            }

            foreach (SearchRuntimeDocument document in documentsById.Values)
            {
                bytes += sizeof(int) * 3 + sizeof(long);
                bytes += (document.Title.Length + document.Summary.Length + document.SnippetWindow.Length) * sizeof(char);
            }

            return bytes;
        }
    }

    private sealed class SearchRuntimeIndexBuilder
    {
        private readonly Dictionary<uint, Dictionary<int, double>> _weightedTfByHash = [];
        private readonly Dictionary<uint, ulong> _fingerprintsByHash = [];
        private readonly Dictionary<int, SearchRuntimeDocument> _documentsById;

        public SearchRuntimeIndexBuilder(int documentCount)
        {
            _documentsById = new Dictionary<int, SearchRuntimeDocument>(documentCount);
        }

        public void AddArticle(SearchSourceArticle article, ISearchDictionaryLookup dictionary)
        {
            _documentsById[article.Id] = new SearchRuntimeDocument(
                article.Id,
                article.Title,
                article.Summary,
                BuildRuntimeSnippetWindow(article.Summary, article.Body),
                article.Views,
                article.CreateTime,
                Math.Max(article.DocLength, 1));

            AddField(dictionary, article, article.Title, SearchFieldKind.Title, 16);
            AddField(dictionary, article, article.Summary, SearchFieldKind.Summary, 8);
            AddField(dictionary, article, article.CategoryName, SearchFieldKind.Meta, 5);
            foreach (SearchTagItem tag in article.Tags)
            {
                AddField(dictionary, article, tag.Name, SearchFieldKind.Meta, 5);
            }

            AddField(dictionary, article, article.Body, SearchFieldKind.Body, 2);
        }

        public SearchRuntimeSnapshot Build(ISearchDictionaryLookup queryDictionary)
        {
            int documentCount = _documentsById.Count;
            double averageDocumentLength = documentCount == 0
                ? 1d
                : _documentsById.Values.Average(static document => Math.Max(document.DocLength, 1));

            Dictionary<uint, SearchRuntimePosting[]> postingMap = _weightedTfByHash
                .ToDictionary(
                    entry => entry.Key,
                    entry =>
                    {
                        int documentFrequency = entry.Value.Count;
                        return entry.Value
                        .Select(score => new SearchRuntimePosting(
                            score.Key,
                            SearchRuntimeScorer.ComputeBm25(
                                score.Value,
                                documentCount,
                                documentFrequency,
                                _documentsById[score.Key].DocLength,
                                averageDocumentLength)))
                        .OrderByDescending(static posting => posting.Score)
                        .ThenBy(static posting => posting.ArticleId)
                        .ToArray();
                    });
            FrozenDictionary<uint, SearchRuntimePostingBlock[]> postingBlocks = postingMap
                .ToDictionary(static entry => entry.Key, static entry => BuildRuntimePostingBlocks(entry.Value))
                .ToFrozenDictionary();
            FrozenDictionary<uint, SearchRuntimePosting[]> postings = postingMap.ToFrozenDictionary();

            return new SearchRuntimeSnapshot(postings, postingBlocks, _documentsById.ToFrozenDictionary(), queryDictionary);
        }

        private void AddField(
            ISearchDictionaryLookup dictionary,
            SearchSourceArticle article,
            string? text,
            SearchFieldKind field,
            int weight)
        {
            EnumerateFieldTokens(
                dictionary,
                text,
                field,
                static (token, state) => state.AddToken(token),
                new RuntimeFieldTokenConsumer(this, article.Id, weight));
        }

        private void AddToken(int articleId, uint hash, ulong fingerprint, int weight)
        {
            if (_fingerprintsByHash.TryGetValue(hash, out ulong existingFingerprint))
            {
                if (existingFingerprint != fingerprint)
                {
                    throw new InvalidDataException($"Search runtime token hash collision detected for hash {hash}.");
                }
            }
            else
            {
                _fingerprintsByHash[hash] = fingerprint;
            }

            if (!_weightedTfByHash.TryGetValue(hash, out Dictionary<int, double>? scoresByDocument))
            {
                scoresByDocument = [];
                _weightedTfByHash[hash] = scoresByDocument;
            }

            scoresByDocument.TryGetValue(articleId, out double current);
            scoresByDocument[articleId] = current + weight;
        }

        private readonly record struct RuntimeFieldTokenConsumer(SearchRuntimeIndexBuilder Builder, int ArticleId, int Weight)
        {
            public void AddToken(SearchToken token)
                => Builder.AddToken(ArticleId, token.Hash, token.Fingerprint, Weight);
        }
    }

    private sealed record SearchRuntimeDocument(
        int Id,
        string Title,
        string Summary,
        string SnippetWindow,
        int Views,
        DateTime CreateTime,
        int DocLength);

    private readonly record struct SearchRuntimePosting(int ArticleId, double Score);
    private readonly record struct SearchRuntimePostingBlock(int Start, int Length, double MaxScore);

    private static SearchRuntimePostingBlock[] BuildRuntimePostingBlocks(SearchRuntimePosting[] postings)
    {
        const int BlockSize = 64;
        if (postings.Length == 0)
        {
            return [];
        }

        var blocks = new SearchRuntimePostingBlock[(postings.Length + BlockSize - 1) / BlockSize];
        for (int start = 0, blockIndex = 0; start < postings.Length; start += BlockSize, blockIndex++)
        {
            int length = Math.Min(BlockSize, postings.Length - start);
            double maxScore = 0d;
            for (int i = start; i < start + length; i++)
            {
                maxScore = Math.Max(maxScore, postings[i].Score);
            }

            blocks[blockIndex] = new SearchRuntimePostingBlock(start, length, maxScore);
        }

        return blocks;
    }

    private static bool CanSkipRuntimePostingBlock(
        double topKThreshold,
        double accumulatedDocumentScore,
        double blockMaxScore,
        double remainingQueryMaxScore)
        => accumulatedDocumentScore + blockMaxScore + remainingQueryMaxScore <= topKThreshold;

    private readonly record struct SearchRuntimeCandidate(double Score, SearchRuntimeDocument Document)
    {
        public static int CompareBestFirst(SearchRuntimeCandidate left, SearchRuntimeCandidate right)
        {
            int score = right.Score.CompareTo(left.Score);
            if (score != 0)
            {
                return score;
            }

            int views = right.Document.Views.CompareTo(left.Document.Views);
            if (views != 0)
            {
                return views;
            }

            int createTime = right.Document.CreateTime.CompareTo(left.Document.CreateTime);
            if (createTime != 0)
            {
                return createTime;
            }

            return right.Document.Id.CompareTo(left.Document.Id);
        }
    }

    private readonly record struct SearchRuntimeCandidatePriority(double Score, int Views, DateTime CreateTime, int ArticleId)
        : IComparable<SearchRuntimeCandidatePriority>
    {
        public static SearchRuntimeCandidatePriority From(SearchRuntimeCandidate candidate)
            => new(
                candidate.Score,
                candidate.Document.Views,
                candidate.Document.CreateTime,
                candidate.Document.Id);

        public int CompareTo(SearchRuntimeCandidatePriority other)
        {
            int score = Score.CompareTo(other.Score);
            if (score != 0)
            {
                return score;
            }

            int views = Views.CompareTo(other.Views);
            if (views != 0)
            {
                return views;
            }

            int createTime = CreateTime.CompareTo(other.CreateTime);
            if (createTime != 0)
            {
                return createTime;
            }

            return ArticleId.CompareTo(other.ArticleId);
        }
    }

}
