using System.Numerics;


namespace FsusBlog.V2.Contracts;

public readonly record struct LocalSearchCorpusPage(int Number, int DocumentCount, int FirstArticleId, int LastArticleId, byte[] Bytes);

/// <summary>Immutable FSPK v4 corpus pages paired with complete per-page input identities and pagination estimates.</summary>
public sealed class LocalSearchCorpusSnapshot
{
    private readonly LocalSearchCorpus.PageState[] _pages;
    private readonly byte[][] _pageBytes;
    private readonly int[] _reusedFromPageIndex;
    private readonly Dictionary<int, int>? _pageIndexByFirstArticleId;

    internal LocalSearchCorpusSnapshot(LocalSearchCorpus.PageState[] pages, int[] reusedFromPageIndex)
    {
        _pages = pages;
        _reusedFromPageIndex = reusedFromPageIndex;
        _pageBytes = new byte[pages.Length][];
        var reused = 0;
        Dictionary<int, int>? byFirst = null;
        for (var i = 0; i < pages.Length; i++)
        {
            _pageBytes[i] = pages[i].Bytes;
            if (reusedFromPageIndex[i] >= 0) reused++;
            if (pages[i].Documents.Length > 0) (byFirst ??= new(pages.Length)).Add(pages[i].Documents[0].Id, i);
        }
        _pageIndexByFirstArticleId = byFirst;
        Pages = Array.AsReadOnly(_pageBytes);
        ReusedPageCount = reused;
    }

    public IReadOnlyList<byte[]> Pages { get; }
    public int ReusedPageCount { get; }

    public int ReusedFromPageIndex(int pageIndex) => _reusedFromPageIndex[pageIndex];

    internal int PageCount => _pages.Length;
    internal LocalSearchCorpus.PageState PageAt(int index) => _pages[index];

    internal bool TryFindPageByFirstArticleId(int firstArticleId, out int pageIndex)
    {
        if (_pageIndexByFirstArticleId is not null) return _pageIndexByFirstArticleId.TryGetValue(firstArticleId, out pageIndex);
        pageIndex = -1;
        return false;
    }
}

/// <summary>Builds bounded FSPK v4 pages from the current public article projection.</summary>
public static class LocalSearchCorpus
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private const int PageBytes = WireLimits.SearchCorpusPageBytes;
    private const int MaxStagedPages = 512;
    private const int MaxStagedAggregateBytes = 256 * 1024 * 1024;
    private const int PostingBudgetBytes = 40;
    private const int PositionBudgetBytes = 7;
    private const byte TitleField = 1;
    private const byte BodyField = 4;

    private static bool ValidateBuildArgs(IReadOnlyList<Article> articles, int maxPages, int maxAggregateBytes, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(articles);
        if (maxPages is < 1 or > MaxStagedPages) throw new ArgumentOutOfRangeException(nameof(maxPages));
        if (maxAggregateBytes is < 1 or > MaxStagedAggregateBytes) throw new ArgumentOutOfRangeException(nameof(maxAggregateBytes));
        ct.ThrowIfCancellationRequested();
        // Every page holds at most this many documents even when the byte budget would fit more.
        return articles.Count <= checked(maxPages * WireLimits.SearchIndexPageSize);
    }

    private static bool ShouldSplitPage(int docCount, int projectedBytes, int nextEstimate) =>
        docCount != 0 && (projectedBytes + nextEstimate > PageBytes - 512 || docCount >= WireLimits.SearchIndexPageSize);

    private static void CheckIncreasingId(int id, int lastId)
    {
        if (id <= lastId) throw new ProtocolException("Invalid or duplicate search corpus article ID");
    }

    public static IReadOnlyList<byte[]>? Build(IReadOnlyList<Article> articles, CancellationToken ct = default)
    {
        var pages = new List<byte[]>();
        return TryStagePages(articles, WireLimits.SearchCorpusMaxPages, WireLimits.SearchCorpusTotalBytes, page =>
        {
            pages.Add(page.Bytes);
            return true;
        }, ct) ? pages.AsReadOnly() : null;
    }

    /// <summary>Builds bounded FSPK v4 pages, skipping encoding and reusing immutable pages from <paramref name="previous"/>
    /// whenever the complete corpus inputs and actual pagination boundaries match.</summary>
    public static LocalSearchCorpusSnapshot? BuildSnapshot(IReadOnlyList<Article> articles,
        LocalSearchCorpusSnapshot? previous = null, CancellationToken ct = default) =>
        BuildSnapshot(articles, previous, WireLimits.SearchCorpusMaxPages, WireLimits.SearchCorpusTotalBytes, ct);

    public static LocalSearchCorpusSnapshot? BuildSnapshot(IReadOnlyList<Article> articles,
        LocalSearchCorpusSnapshot? previous, int maxPages, int maxAggregateBytes, CancellationToken ct = default)
    {
        if (!ValidateBuildArgs(articles, maxPages, maxAggregateBytes, ct)) return null;
        if (articles.Count == 0)
        {
            if (previous is { PageCount: 1 } && previous.PageAt(0) is { Documents.Length: 0 } priorEmpty)
                return priorEmpty.Bytes.Length > maxAggregateBytes ? null : new LocalSearchCorpusSnapshot([priorEmpty], [0]);
            using var emptyPostings = new MemoryStream();
            using var emptyStrings = new MemoryStream();
            return Package([], emptyPostings, emptyStrings, maxAggregateBytes, ct) is { } emptyPage
                ? new LocalSearchCorpusSnapshot([new PageState(emptyPage, 0, [])], [-1]) : null;
        }

        var sorted = SortArticlesById(articles, ct);
        var resultPages = new List<PageState>();
        var reusedIndices = new List<int>();
        var docs = new List<Document>();
        MemoryStream? postingBytes = null, strings = null;
        int projectedBytes = 0, byteCount = 0, lastId = 0, pendingIndex = -1;
        Document? pendingDoc = null;

        try
        {
            for (var cursor = 0; cursor < sorted.Length;)
            {
                ct.ThrowIfCancellationRequested();
                if (docs.Count == 0 && pendingIndex != cursor && previous is not null)
                {
                    CheckIncreasingId(sorted[cursor].Id, lastId);
                    if (TryReusePage(sorted, cursor, previous, resultPages.Count, maxPages, maxAggregateBytes, byteCount,
                            ref lastId, ref pendingIndex, ref pendingDoc, ct, out var reusedPage, out var reusedFromIndex, out var budgetRejected))
                    {
                        resultPages.Add(reusedPage!);
                        reusedIndices.Add(reusedFromIndex);
                        byteCount += reusedPage!.Bytes.Length;
                        cursor += reusedPage.Documents.Length;
                        continue;
                    }
                    if (budgetRejected) return null;
                }

                var article = sorted[cursor];
                Document? doc;
                if (pendingIndex == cursor)
                {
                    (doc, pendingIndex, pendingDoc, lastId) = (pendingDoc!, -1, null, article.Id);
                }
                else
                {
                    CheckIncreasingId(article.Id, lastId);
                    if (docs.Count != 0 && previous is not null &&
                        TryMatchKnownPageStartEstimate(article, previous, out var nextEstimate) &&
                        ShouldSplitPage(docs.Count, projectedBytes, nextEstimate))
                    {
                        if (!EmitCurrentPage()) return null;
                        continue;
                    }
                    lastId = article.Id;
                    if ((doc = Index(article, ct)) is null) return null;
                }

                var estimate = doc.EstimatedBytes;
                if (ShouldSplitPage(docs.Count, projectedBytes, estimate) && !EmitCurrentPage()) return null;
                docs.Add(doc);
                projectedBytes += estimate;
                cursor++;
            }

            if (docs.Count != 0 && !EmitCurrentPage()) return null;
            return new LocalSearchCorpusSnapshot([.. resultPages], [.. reusedIndices]);
        }
        finally { postingBytes?.Dispose(); strings?.Dispose(); }

        bool EmitCurrentPage()
        {
            ct.ThrowIfCancellationRequested();
            if (resultPages.Count >= maxPages) return false;
            (postingBytes ??= new()).SetLength(0);
            (strings ??= new()).SetLength(0);
            if (Package(docs, postingBytes, strings, maxAggregateBytes - byteCount, ct) is not { } page) return false;
            byteCount += page.Length;
            var inputs = new ArticleInput[docs.Count];
            for (var i = 0; i < docs.Count; i++) inputs[i] = ArticleInput.Capture(docs[i].Article, docs[i].EstimatedBytes);
            resultPages.Add(new PageState(page, projectedBytes, inputs));
            reusedIndices.Add(-1);
            docs.Clear();
            projectedBytes = 0;
            return true;
        }
    }

    /// <summary>Emits consecutive encoded pages to an unpublished stage. A rejected page stops the build.
    /// Discard the stage if the method returns false or throws.</summary>
    public static bool TryStagePages(IReadOnlyList<Article> articles, int maxPages, int maxAggregateBytes,
        Func<LocalSearchCorpusPage, bool> stage, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(stage);
        if (!ValidateBuildArgs(articles, maxPages, maxAggregateBytes, ct)) return false;

        var docs = new List<Document>();
        using var postingBytes = new MemoryStream();
        using var strings = new MemoryStream();
        int projectedBytes = 0, byteCount = 0, pageCount = 0, lastId = 0;

        foreach (var article in SortArticlesById(articles, ct))
        {
            ct.ThrowIfCancellationRequested();
            CheckIncreasingId(article.Id, lastId);
            lastId = article.Id;
            if (Index(article, ct) is not { } doc) return false;
            // Bound both the exact encoded size and the construction before merging term dictionaries.
            var estimate = doc.EstimatedBytes;
            if (ShouldSplitPage(docs.Count, projectedBytes, estimate))
            {
                if (!StagePage()) return false;
                docs.Clear();
                projectedBytes = 0;
            }
            docs.Add(doc);
            projectedBytes += estimate;
        }
        return StagePage();

        bool StagePage()
        {
            ct.ThrowIfCancellationRequested();
            if (pageCount >= maxPages) return false;
            postingBytes.SetLength(0);
            strings.SetLength(0);
            if (Package(docs, postingBytes, strings, maxAggregateBytes - byteCount, ct) is not { } page) return false;
            byteCount += page.Length;
            var staged = stage(new LocalSearchCorpusPage(++pageCount, docs.Count,
                docs.Count == 0 ? 0 : docs[0].Article.Id, docs.Count == 0 ? 0 : docs[^1].Article.Id, page));
            ct.ThrowIfCancellationRequested();
            return staged;
        }
    }

    internal sealed class PageState(byte[] bytes, int projectedBytes, ArticleInput[] documents)
    {
        internal byte[] Bytes { get; } = bytes;
        internal int ProjectedBytes { get; } = projectedBytes;
        internal ArticleInput[] Documents { get; } = documents;
    }

    internal readonly struct ArticleInput(Article article, TaxonomyName[] tags, int estimatedBytes)
    {
        internal readonly int Id = article.Id;
        internal readonly long Revision = article.Revision;
        internal readonly long Publication = article.Publication;
        internal readonly int RevisionNo = article.RevisionNo;
        internal readonly int PublicationNo = article.PublicationNo;
        internal readonly long PublishedAtMs = article.PublishedAt.ToUnixTimeMilliseconds();
        internal readonly string Title = article.Title;
        internal readonly string Summary = article.Summary ?? string.Empty;
        internal readonly string Body = article.Body;
        internal readonly TaxonomyName? Category = article.Category;
        internal readonly TaxonomyName[] Tags = tags;
        internal readonly int EstimatedBytes = estimatedBytes;

        internal static ArticleInput Capture(Article article, int estimatedBytes) =>
            new(article, article.Tags is { Count: > 0 } source ? [.. source] : [], estimatedBytes);

        internal bool Matches(Article candidate, out bool sameReferences)
        {
            sameReferences = false;
            var candidateSummary = candidate.Summary ?? string.Empty;
            var candidateTags = candidate.Tags;
            if (Id != candidate.Id || Revision != candidate.Revision || Publication != candidate.Publication ||
                RevisionNo != candidate.RevisionNo || PublicationNo != candidate.PublicationNo ||
                PublishedAtMs != candidate.PublishedAt.ToUnixTimeMilliseconds() || Category != candidate.Category ||
                Tags.Length != (candidateTags?.Count ?? 0) ||
                !string.Equals(Title, candidate.Title, StringComparison.Ordinal) ||
                !string.Equals(Summary, candidateSummary, StringComparison.Ordinal) ||
                !string.Equals(Body, candidate.Body, StringComparison.Ordinal))
                return false;
            var tagsSameRef = true;
            for (var i = 0; i < Tags.Length; i++)
            {
                var nextTag = candidateTags![i];
                if (nextTag is null || Tags[i].Id != nextTag.Id || !string.Equals(Tags[i].Name, nextTag.Name, StringComparison.Ordinal))
                    return false;
                tagsSameRef &= ReferenceEquals(Tags[i], nextTag);
            }
            sameReferences = ReferenceEquals(Category, candidate.Category) && tagsSameRef &&
                ReferenceEquals(Title, candidate.Title) && ReferenceEquals(Summary, candidateSummary) &&
                ReferenceEquals(Body, candidate.Body);
            return true;
        }
    }

    private static Article[] SortArticlesById(IReadOnlyList<Article> articles, CancellationToken ct)
    {
        var count = articles.Count;
        if (count <= 1) return [.. articles];
        bool ascending = true, descending = true;
        var previousId = articles[0].Id;
        for (var i = 1; i < count && (ascending || descending); i++)
        {
            if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
            var currentId = articles[i].Id;
            if (currentId <= previousId) ascending = false;
            if (currentId >= previousId) descending = false;
            previousId = currentId;
        }
        if (ascending) return [.. articles];
        if (!descending) return [.. articles.OrderBy(static article => article.Id)];
        Article[] reversed = [.. articles];
        Array.Reverse(reversed);
        return reversed;
    }

    private static bool TryReusePage(Article[] sorted, int cursor, LocalSearchCorpusSnapshot previous, int currentPageCount,
        int maxPages, int maxAggregateBytes, int byteCount, ref int lastId, ref int pendingIndex, ref Document? pendingDoc,
        CancellationToken ct, out PageState? reusedPage, out int reusedFromIndex, out bool budgetRejected)
    {
        (reusedPage, reusedFromIndex, budgetRejected) = (null, -1, false);
        if (!previous.TryFindPageByFirstArticleId(sorted[cursor].Id, out var candidateIndex)) return false;
        var prior = previous.PageAt(candidateIndex);
        var count = prior.Documents.Length;
        if (count == 0 || cursor + count > sorted.Length) return false;

        var allSameRefs = true;
        for (var i = 0; i < count; i++)
        {
            if ((i & 31) == 0) ct.ThrowIfCancellationRequested();
            if (!prior.Documents[i].Matches(sorted[cursor + i], out var sameRefs)) return false;
            allSameRefs &= sameRefs;
        }

        var pageLastId = prior.Documents[count - 1].Id;
        var nextCursor = cursor + count;
        var overBudget = currentPageCount >= maxPages || prior.Bytes.Length > maxAggregateBytes - byteCount;
        if (nextCursor < sorted.Length)
        {
            var nextArticle = sorted[nextCursor];
            CheckIncreasingId(nextArticle.Id, pageLastId);
            if (count < WireLimits.SearchIndexPageSize)
            {
                if (TryMatchKnownPageStartEstimate(nextArticle, previous, out var nextEstimate))
                {
                    if (prior.ProjectedBytes + nextEstimate <= PageBytes - 512) return false;
                }
                else
                {
                    var indexedNext = Index(nextArticle, ct);
                    if (indexedNext is null) { budgetRejected = true; return false; }
                    (pendingIndex, pendingDoc) = (nextCursor, indexedNext);
                    if (prior.ProjectedBytes + indexedNext.EstimatedBytes <= PageBytes - 512) return false;
                }
            }
            else if (overBudget)
            {
                if (!TryMatchKnownPageStartEstimate(nextArticle, previous, out _)) _ = Index(nextArticle, ct);
                budgetRejected = true;
                return false;
            }
        }
        if (overBudget) { budgetRejected = true; return false; }

        (lastId, reusedFromIndex) = (pageLastId, candidateIndex);
        if (allSameRefs) { reusedPage = prior; return true; }
        var refreshed = new ArticleInput[count];
        for (var i = 0; i < count; i++) refreshed[i] = ArticleInput.Capture(sorted[cursor + i], prior.Documents[i].EstimatedBytes);
        reusedPage = new PageState(prior.Bytes, prior.ProjectedBytes, refreshed);
        return true;
    }

    private static bool TryMatchKnownPageStartEstimate(Article article, LocalSearchCorpusSnapshot previous, out int estimatedBytes)
    {
        if (previous.TryFindPageByFirstArticleId(article.Id, out var nextPageIndex) &&
            previous.PageAt(nextPageIndex).Documents is { Length: > 0 } docs && docs[0].Matches(article, out _))
        {
            estimatedBytes = docs[0].EstimatedBytes;
            return true;
        }
        estimatedBytes = 0;
        return false;
    }

    private sealed record Document(Article Article, Dictionary<uint, Frequencies> Terms, int Length, int EstimatedBytes);
    private record struct Frequencies(int Title, int Meta, int Body, List<Position>? Positions);
    private readonly record struct Position(int Offset, byte Field, int Width);
    private readonly record struct Posting(int ArticleId, Frequencies Tf);
    private readonly record struct Term(uint Hash, float Idf, int Offset, int Length, bool HasPositions);
    private readonly record struct TextSlice(int Offset, int Length);
    private readonly record struct Taxon(int Id, TextSlice Name);

    private static Document? Index(Article article, CancellationToken ct)
    {
        if (article.Revision <= 0 || article.RevisionNo <= 0 || article.Publication <= 0 ||
            article.PublicationNo <= 0 || article.PublishedAt.ToUnixTimeMilliseconds() == 0)
            throw new ProtocolException("Search corpus requires a current published article");

        var tags = article.Tags ?? [];
        var summary = article.Summary ?? string.Empty;
        var textBytes = Utf8.GetByteCount(article.Title) + Utf8.GetByteCount(summary) +
                        (article.Category is { } category ? SearchDictionaryRecordSize + Utf8.GetByteCount(category.Name) : 0) +
                        tags.Sum(tag => SearchDictionaryRecordSize + 2 + Utf8.GetByteCount(tag.Name));
        if (article.Title.Length == 0 || article.Title.Contains('\0') || Utf8.GetByteCount(article.Title) > WireLimits.TitleBytes ||
            Utf8.GetByteCount(summary) > 2048 || Utf8.GetByteCount(article.Body) > WireLimits.BodyBytes ||
            tags.Count > WireLimits.TaxonomyTagCount ||
            tags.Any(tag => tag.Id <= 0 || Utf8.GetByteCount(tag.Name) > WireLimits.TaxonomyNameBytes) ||
            article.Category is { } value && (value.Id <= 0 || Utf8.GetByteCount(value.Name) > WireLimits.TaxonomyNameBytes))
            throw new ProtocolException("Search corpus text exceeds its limits");

        var terms = new Dictionary<uint, Frequencies>();
        var length = 0;
        var maxPositionEnd = 0;
        var positions = 0;
        var tokens = 0;
        if (!PlainField(article.Title, SearchFieldKind.Title, TitleField) ||
            !PlainField(summary, SearchFieldKind.Summary, 0) ||
            !PlainField(article.Category?.Name ?? string.Empty, SearchFieldKind.Taxonomy, 0) ||
            tags.Any(tag => !PlainField(tag.Name, SearchFieldKind.Taxonomy, 0)) ||
            !MarkdownBodyField(article.Body))
            return null;

        return new Document(article, terms, Math.Max(1, Math.Max(length, maxPositionEnd)), Estimate());

        int Estimate() => SearchDocumentRecordSize + textBytes +
            terms.Count * PostingBudgetBytes + positions * PositionBudgetBytes;

        bool RecordTokens(IReadOnlyList<SearchToken> list, byte field)
        {
            for (var i = 0; i < list.Count; i++)
            {
                if ((tokens++ & 1023) == 0) ct.ThrowIfCancellationRequested();
                var token = list[i];
                terms.TryGetValue(token.Hash32, out var old);
                var keepPosition = !token.IsStopword &&
                    (field is TitleField or BodyField) &&
                    token.Kind is SearchTokenKind.Exact or SearchTokenKind.CjkBigram or SearchTokenKind.Subword or SearchTokenKind.ScriptAlias;
                if (keepPosition)
                {
                    var pos = token.Position;
                    (old.Positions ??= []).Add(new Position(pos, field, token.Width));
                    if (pos + token.Width > maxPositionEnd) maxPositionEnd = pos + token.Width;
                    positions++;
                }
                terms[token.Hash32] = field switch
                {
                    TitleField => old with { Title = old.Title + 1 },
                    BodyField => old with { Body = old.Body + 1 },
                    _ => old with { Meta = old.Meta + 1 }
                };
                if (Estimate() > PageBytes - 512) return false;
            }
            return true;
        }

        bool PlainField(string text, SearchFieldKind fieldKind, byte wireField)
        {
            var analyzed = SearchTextAnalyzer.AnalyzePlainField(text, fieldKind, SearchAnalysisMode.Index, 0, ct);
            if (!RecordTokens(analyzed.Tokens, wireField)) return false;
            length += analyzed.SourceLength;
            return true;
        }

        bool MarkdownBodyField(string markdown)
        {
            // FSPK v4 uses one inter-block slot in visible reading order across all Markdown fields.
            var visible = SearchMarkdownExtractor.Extract(markdown, ct);
            var bodyPos = 0;
            var scratch = new List<SearchToken>();
            foreach (var span in visible)
            {
                ct.ThrowIfCancellationRequested();
                if (span.StartsNewBlock && bodyPos > 0) bodyPos++;
                var startPosition = bodyPos;
                scratch.Clear();
                var slice = markdown.Substring(span.SourceStart, span.SourceEnd - span.SourceStart);
                var sourceLength = SearchTextAnalyzer.AnalyzeSpanInto(slice, span.SourceStart, SearchAnalysisMode.Index,
                    scratch, ref bodyPos, null, ct);
                if (scratch.Count == SearchTextAnalyzer.MaxTokensPerField)
                {
                    // Give the recorder each token once, with the same starting coordinate on replay.
                    scratch.Clear();
                    bodyPos = startPosition;
                    if (!SearchTextAnalyzer.ReplayIndexSpan(slice, span.SourceStart, ref bodyPos,
                        list => RecordTokens(list, BodyField), ct, out sourceLength))
                        return false;
                }
                else if (!RecordTokens(scratch, BodyField)) return false;
                length += sourceLength;
            }
            return true;
        }
    }

    private static byte[]? Package(IReadOnlyList<Document> docs, MemoryStream postingBytes, MemoryStream strings,
        int remainingBytes, CancellationToken ct)
    {
        var index = new SortedDictionary<uint, List<Posting>>();
        foreach (var doc in docs)
        {
            ct.ThrowIfCancellationRequested();
            foreach (var (hash, frequency) in doc.Terms)
            {
                if (!index.TryGetValue(hash, out var postings)) index.Add(hash, postings = []);
                postings.Add(new Posting(doc.Article.Id, frequency));
            }
        }

        var terms = new List<Term>(index.Count);
        foreach (var (hash, postings) in index)
        {
            ct.ThrowIfCancellationRequested();
            var start = checked((int)postingBytes.Position);
            Varint(postingBytes, postings.Count);
            var previous = 0;
            var hasPositions = false;
            foreach (var posting in postings)
            {
                Varint(postingBytes, posting.ArticleId - previous);
                previous = posting.ArticleId;
                postingBytes.WriteByte(Quantize(posting.Tf.Title));
                postingBytes.WriteByte(Quantize(posting.Tf.Meta));
                postingBytes.WriteByte(Quantize(posting.Tf.Body));
                var positions = posting.Tf.Positions;
                if (positions is not { Count: > 0 })
                {
                    Varint(postingBytes, 0);
                    continue;
                }
                hasPositions = true;
                positions.Sort(static (first, second) => (first.Offset, first.Field, first.Width)
                    .CompareTo((second.Offset, second.Field, second.Width)));
                var distinct = 1;
                for (var i = 1; i < positions.Count; i++)
                    if (positions[i] != positions[i - 1]) distinct++;
                Varint(postingBytes, distinct);
                var priorPosition = 0;
                for (var i = 0; i < positions.Count; i++)
                {
                    ct.ThrowIfCancellationRequested();
                    var position = positions[i];
                    if (i > 0 && position == positions[i - 1]) continue;
                    Varint(postingBytes, position.Offset - priorPosition);
                    Varint(postingBytes, position.Width);
                    Varint(postingBytes, position.Field);
                    priorPosition = position.Offset;
                }
            }
            var idf = (float)Math.Log(1 + (docs.Count - postings.Count + 0.5) / (postings.Count + 0.5));
            terms.Add(new Term(hash, idf, start, checked((int)postingBytes.Position - start), hasPositions));
        }

        var categories = DictionaryEntries(docs.Select(d => d.Article.Category).OfType<TaxonomyName>(), strings);
        var tags = DictionaryEntries(docs.SelectMany(d => d.Article.Tags ?? []), strings);
        if (categories.Count >= ushort.MaxValue || tags.Count >= ushort.MaxValue) return null;
        var categoryIndex = categories.Select((entry, i) => (entry.Id, i)).ToDictionary(x => x.Id, x => x.i);
        var tagIndex = tags.Select((entry, i) => (entry.Id, i)).ToDictionary(x => x.Id, x => x.i);

        var metadata = new (TextSlice Title, TextSlice Summary)[docs.Count];
        var tagRefs = new List<ushort>();
        for (var i = 0; i < docs.Count; i++)
        {
            var article = docs[i].Article;
            metadata[i] = (Append(strings, article.Title), Append(strings, article.Summary ?? string.Empty));
            foreach (var tag in article.Tags ?? []) tagRefs.Add((ushort)tagIndex[tag.Id]);
        }

        const int termStart = SearchShardHeaderSize;
        var docStart = Align(termStart + terms.Count * SearchTermRecordSize);
        var categoryStart = Align(docStart + docs.Count * SearchDocumentRecordSize);
        var tagStart = Align(categoryStart + categories.Count * SearchDictionaryRecordSize);
        var tagRefStart = Align(tagStart + tags.Count * SearchDictionaryRecordSize);
        var stringStart = Align(tagRefStart + tagRefs.Count * 2);
        var postingStart = Align(checked(stringStart + (int)strings.Length));
        var shardSize = checked(postingStart + (int)postingBytes.Length);
        if (shardSize > Math.Min(PageBytes, remainingBytes) - SearchPackagePayloadOffset) return null;

        var package = new byte[SearchPackagePayloadOffset + shardSize];
        I32(package, 0, SearchPackageMagic); I32(package, 4, SearchArtifactVersion); I32(package, 8, 1);
        I32(package, SearchPackageEntryOffset + 8, SearchPackagePayloadOffset);
        I32(package, SearchPackageEntryOffset + 12, shardSize);

        var shard = package.AsSpan(SearchPackagePayloadOffset);
        ReadOnlySpan<int> fields =
        [
            SearchShardMagic, SearchArtifactVersion, 0, 1, terms.Count, docs.Count, categories.Count,
            tags.Count, tagRefs.Count, termStart, docStart, categoryStart, tagStart, tagRefStart,
            stringStart, postingStart, checked((int)postingBytes.Length)
        ];
        for (var i = 0; i < fields.Length; i++) I32(shard, i * 4, fields[i]);
        F32(shard, 68, docs.Count == 0 ? 1 : (float)docs.Average(doc => (double)doc.Length));

        for (var i = 0; i < terms.Count; i++)
        {
            var row = shard[(termStart + i * SearchTermRecordSize)..];
            var term = terms[i];
            I32(row, 0, unchecked((int)term.Hash)); F32(row, 4, term.Idf);
            I32(row, 8, term.Offset); I32(row, 12, term.Length); I32(row, 16, term.HasPositions ? 1 : 0);
        }

        var tagOffset = 0;
        for (var i = 0; i < docs.Count; i++)
        {
            var row = shard[(docStart + i * SearchDocumentRecordSize)..];
            var (doc, value) = (docs[i], docs[i].Article);
            var tagCount = value.Tags?.Count ?? 0;
            I32(row, 0, value.Id);
            U16(row, 4, value.Category is { } category ? categoryIndex[category.Id] : ushort.MaxValue);
            U16(row, 6, tagCount); I32(row, 8, tagOffset); I32(row, 20, doc.Length);
            I64(row, 24, value.PublishedAt.ToUnixTimeMilliseconds());
            WriteString(row, 32, metadata[i].Title); WriteString(row, 40, metadata[i].Summary);
            I64(row, 52, value.Revision); I32(row, 60, value.RevisionNo);
            I64(row, 64, value.Publication); I32(row, 72, value.PublicationNo);
            tagOffset += tagCount;
        }

        WriteDictionary(shard, categoryStart, categories);
        WriteDictionary(shard, tagStart, tags);
        for (var i = 0; i < tagRefs.Count; i++) U16(shard, tagRefStart + i * 2, tagRefs[i]);
        strings.GetBuffer().AsSpan(0, checked((int)strings.Length)).CopyTo(shard[stringStart..]);
        postingBytes.GetBuffer().AsSpan(0, checked((int)postingBytes.Length)).CopyTo(shard[postingStart..]);
        return package;
    }

    private static List<Taxon> DictionaryEntries(IEnumerable<TaxonomyName> items, MemoryStream strings)
    {
        var result = new List<Taxon>();
        foreach (var group in items.GroupBy(item => item.Id).OrderBy(group => group.Key))
        {
            var first = group.First();
            if (group.Any(item => item.Name != first.Name)) throw new ProtocolException("Conflicting public taxonomy names");
            result.Add(new Taxon(first.Id, Append(strings, first.Name)));
        }
        return result;
    }

    private static TextSlice Append(MemoryStream strings, string value)
    {
        var length = Utf8.GetByteCount(value);
        if (length == 0) return default;
        var offset = checked((int)strings.Position);
        strings.SetLength(checked(offset + length));
        Utf8.GetBytes(value.AsSpan(), strings.GetBuffer().AsSpan(offset, length));
        strings.Position = offset + length;
        return new TextSlice(offset, length);
    }

    private static void WriteDictionary(Span<byte> shard, int start, List<Taxon> entries)
    {
        for (var i = 0; i < entries.Count; i++)
        {
            var row = shard[(start + i * SearchDictionaryRecordSize)..];
            I32(row, 0, entries[i].Id); WriteString(row, 4, entries[i].Name);
        }
    }

    private static void WriteString(Span<byte> row, int offset, TextSlice value) { I32(row, offset, value.Offset); U16(row, offset + 4, value.Length); }

    private static void Varint(Stream stream, int value)
    {
        for (; value >= 128; value >>= 7) stream.WriteByte((byte)(value | 128));
        stream.WriteByte((byte)value);
    }

    private static byte Quantize(int value) => (byte)(value switch
    {
        <= 10 => value, <= 12 => 11, <= 15 => 12, <= 20 => 13,
        <= 30 => 14, <= 50 => 15, <= 100 => 16, _ => 17
    });

    internal static uint HashUtf8Bytes(ReadOnlySpan<byte> bytes) => HashBytes(bytes);

    private static uint HashBytes(ReadOnlySpan<byte> bytes)
    {
        uint hash = 0;
        var offset = 0;
        for (; bytes.Length - offset >= 4; offset += 4)
            hash = MixWord(hash, BinaryPrimitives.ReadUInt32LittleEndian(bytes[offset..]));
        uint tail = 0;
        for (var i = 0; offset + i < bytes.Length; i++) tail |= (uint)bytes[offset + i] << (8 * i);
        return FinishHash(hash, tail, bytes.Length);
    }

    private static uint MixWord(uint hash, uint word) => BitOperations.RotateLeft(hash ^ Mix(word), 13) * 5 + 0xe6546b64;

    private static uint FinishHash(uint hash, uint tail, int length)
    {
        hash ^= Mix(tail) ^ (uint)length;
        hash = (hash ^ (hash >> 16)) * 0x85ebca6b;
        hash = (hash ^ (hash >> 13)) * 0xc2b2ae35;
        return hash ^ (hash >> 16);
    }

    private static uint Mix(uint value) => BitOperations.RotateLeft(value * 0xcc9e2d51, 15) * 0x1b873593;
    private static int Align(int value) => (value + 7) & ~7;
    private static void I32(Span<byte> b, int offset, int v) => BinaryPrimitives.WriteInt32LittleEndian(b[offset..], v);
    private static void I64(Span<byte> b, int offset, long v) => BinaryPrimitives.WriteInt64LittleEndian(b[offset..], v);
    private static void U16(Span<byte> b, int offset, int v) => BinaryPrimitives.WriteUInt16LittleEndian(b[offset..], checked((ushort)v));
    private static void F32(Span<byte> b, int offset, float v) => BinaryPrimitives.WriteSingleLittleEndian(b[offset..], v);
}
