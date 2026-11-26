using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace FsusBlog.V2.Contracts;

public sealed partial class ArticleSearchIndex
{
    private const int WideBlockDocuments = 20_000;
    private const int MaxWideDocuments = 100_000;
    private const int MaxWideBlockPostings = 2_000_000;
    private const int MaxWidePostings = 8_000_000;
    private const long MaxWideScannedChars = 144 * 1024 * 1024;
    private const int MaxWideRetainedBytes = 32 * 1024 * 1024;

    private readonly record struct WideTerm(uint SourceId, int Start, int Count)
    {
        internal static readonly IComparer<WideTerm> BySource =
            Comparer<WideTerm>.Create(static (left, right) => left.SourceId.CompareTo(right.SourceId));
    }

    private sealed record WideBlock(int First, int Count, WideTerm[] Terms, byte[] Postings);

    /// <summary>Collision-safe alias entry: 64-bit hash + UTF-8 term bytes slice in NamePool + source links offset.</summary>
    private readonly record struct WideAlias(ulong Hash64, int NameOffset, ushort NameLength, int Offset);

    private readonly record struct WideDocument(Article Article, int TitleLen, int HeadingLen, int SummaryLen, int TaxonomyLen, int BodyLen)
    {
        internal void CopyLengths(Span<int> target)
        {
            target[0] = TitleLen;
            target[1] = HeadingLen;
            target[2] = SummaryLen;
            target[3] = TaxonomyLen;
            target[4] = BodyLen;
        }
    }

    private sealed record WideIndex(WideDocument[] Documents, WideBlock[] Blocks, WideAlias[] Aliases, byte[] NamePool, byte[] Sources)
    {
        internal long EstimatedBytes =>
            (long)Documents.Length * Unsafe.SizeOf<WideDocument>()
            + (long)Aliases.Length * Unsafe.SizeOf<WideAlias>()
            + NamePool.Length + Sources.Length
            + Blocks.Sum(static b => (long)b.Terms.Length * Unsafe.SizeOf<WideTerm>() + b.Postings.Length);

        internal ReadOnlySpan<byte> SourcesFor(SearchTermKey key)
        {
            var utf8Len = Encoding.UTF8.GetByteCount(key.Term);
            byte[]? rented = null;
            Span<byte> termBytes = utf8Len <= 256 ? stackalloc byte[utf8Len] : (rented = ArrayPool<byte>.Shared.Rent(utf8Len)).AsSpan(0, utf8Len);
            try
            {
                Encoding.UTF8.GetBytes(key.Term, termBytes);
                var start = 0;
                var end = Aliases.Length;
                while (start < end)
                {
                    var middle = start + (end - start) / 2;
                    var cmp = CompareAlias(Aliases[middle], key.Hash64, termBytes);
                    if (cmp < 0) start = middle + 1;
                    else end = middle;
                }
                if (start == Aliases.Length || CompareAlias(Aliases[start], key.Hash64, termBytes) != 0) return [];
                var limit = start + 1 == Aliases.Length ? Sources.Length : Aliases[start + 1].Offset;
                return Sources.AsSpan(Aliases[start].Offset, limit - Aliases[start].Offset);
            }
            finally
            {
                if (rented is not null) ArrayPool<byte>.Shared.Return(rented);
            }
        }

        private int CompareAlias(WideAlias alias, ulong hash64, ReadOnlySpan<byte> termBytes)
        {
            var cmp = alias.Hash64.CompareTo(hash64);
            if (cmp != 0) return cmp;
            return NamePool.AsSpan(alias.NameOffset, alias.NameLength).SequenceCompareTo(termBytes);
        }
    }

    private sealed class WideSources
    {
        private readonly record struct Source(
            SearchTermKey? Primary,
            SearchTermKey[] ScriptAliases,
            SearchTermKey[] DerivedAliases,
            int Previous);

        private readonly Dictionary<ulong, int> _heads = [];
        private readonly List<Source> _sources = [];
        private int _linkCount;

        internal uint? Resolve(SearchTermKey? primary, ReadOnlySpan<SearchTermKey> scriptAliases, ReadOnlySpan<SearchTermKey> derivedAliases)
        {
            var bucketHash = primary?.Hash64
                ?? (scriptAliases.Length > 0 ? scriptAliases[0].Hash64 ^ 0x9E3779B97F4A7C15UL
                : derivedAliases.Length > 0 ? derivedAliases[0].Hash64 ^ 0xBF58476D1CE4E5B9UL : 0UL);
            var previous = _heads.GetValueOrDefault(bucketHash, -1);
            for (var index = previous; index >= 0; index = _sources[index].Previous)
            {
                var existing = _sources[index];
                if (existing.Primary == primary &&
                    scriptAliases.SequenceEqual(existing.ScriptAliases) &&
                    derivedAliases.SequenceEqual(existing.DerivedAliases))
                    return (uint)index;
            }

            var addedLinks = (primary.HasValue ? 1 : 0) + scriptAliases.Length + derivedAliases.Length;
            if (_sources.Count == MaxTerms || _linkCount > MaxWideRetainedBytes - addedLinks)
                return null;

            var id = _sources.Count;
            _heads[bucketHash] = id;
            _sources.Add(new Source(primary, scriptAliases.ToArray(), derivedAliases.ToArray(), previous));
            _linkCount += addedLinks;
            return (uint)id;
        }

        internal WideIndex? Pack(WideDocument[] documents, WideBlock[] blocks, int availableBytes, CancellationToken ct)
        {
            if (_linkCount > availableBytes) return null;
            var references = new Dictionary<SearchTermKey, List<int>>();
            for (var id = 0; id < _sources.Count; id++)
            {
                ct.ThrowIfCancellationRequested();
                var source = _sources[id];
                // link = id * 3 + role (0=PrimaryExact +2 exact, 1=ScriptOrStandalone +2 non-exact, 2=Derived +1 non-exact)
                if (source.Primary is { } p) Add(p, id * 3);
                foreach (var sa in source.ScriptAliases) Add(sa, id * 3 + 1);
                foreach (var da in source.DerivedAliases) Add(da, id * 3 + 2);
                if ((long)references.Count * Unsafe.SizeOf<WideAlias>() + _linkCount > availableBytes)
                    return null;
            }

            var byteCount = 0;
            var nameBytesTotal = 0;
            foreach (var (key, links) in references)
            {
                nameBytesTotal += Encoding.UTF8.GetByteCount(key.Term);
                EncodeDeltas(links, [], ref byteCount, ct);
            }
            if ((long)references.Count * Unsafe.SizeOf<WideAlias>() + nameBytesTotal + byteCount > availableBytes)
                return null;

            var orderedKeys = references.Keys.ToArray();
            Array.Sort(orderedKeys, static (left, right) =>
            {
                var cmp = left.Hash64.CompareTo(right.Hash64);
                if (cmp != 0) return cmp;
                return Encoding.UTF8.GetBytes(left.Term).AsSpan().SequenceCompareTo(Encoding.UTF8.GetBytes(right.Term));
            });

            var namePool = new byte[nameBytesTotal];
            var sources = new byte[byteCount];
            var aliases = new WideAlias[orderedKeys.Length];
            var namePos = 0;
            var offset = 0;
            for (var index = 0; index < orderedKeys.Length; index++)
            {
                var key = orderedKeys[index];
                var nLen = Encoding.UTF8.GetBytes(key.Term, namePool.AsSpan(namePos));
                aliases[index] = new WideAlias(key.Hash64, namePos, checked((ushort)nLen), offset);
                namePos += nLen;
                EncodeDeltas(references[key], sources, ref offset, ct);
            }
            return new WideIndex(documents, blocks, aliases, namePool, sources);

            static void EncodeDeltas(List<int> links, Span<byte> target, ref int pos, CancellationToken ct)
            {
                ct.ThrowIfCancellationRequested();
                var previous = 0;
                for (var i = 0; i < links.Count; i++)
                {
                    if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
                    var delta = links[i] - previous;
                    previous = links[i];
                    if (target.IsEmpty) pos += VarintWidth(delta);
                    else WriteVarint(target, ref pos, delta);
                }
            }

            void Add(SearchTermKey key, int link)
            {
                if (!references.TryGetValue(key, out var links)) references.Add(key, links = []);
                links.Add(link);
            }
        }
    }

    private readonly record struct WideCounts(int Ordinal, byte C0, byte C1, byte C2, byte C3, byte C4);
    private readonly record struct PendingWidePosting(WideCounts Value, int Previous);

    private sealed class WidePostingBuilder(long remainingChars, WideSources sources)
    {
        private struct SourceCounts
        {
            internal byte C0, C1, C2, C3, C4;
            internal void Increment(int field)
            {
                switch (field)
                {
                    case 0: if (C0 < 254) C0++; break;
                    case 1: if (C1 < 254) C1++; break;
                    case 2: if (C2 < 254) C2++; break;
                    case 3: if (C3 < 254) C3++; break;
                    default: if (C4 < 254) C4++; break;
                }
            }
        }

        private readonly Dictionary<uint, SourceCounts> _docSources = [];
        internal readonly Dictionary<uint, Bucket> Heads = [];
        internal readonly List<PendingWidePosting> Pending = [];

        internal bool Collect(IReadOnlyList<Article> articles, int first, int count, WideDocument[] documents, long[] totalFieldLengths,
            int termLimit, int postingLimit, CancellationToken ct)
        {
            Heads.Clear();
            Pending.Clear();
            for (var ordinal = 0; ordinal < count; ordinal++)
            {
                ct.ThrowIfCancellationRequested();
                var article = articles[first + ordinal];
                _docSources.Clear();

                if (!ChargeChars(article.Title.Length)) return false;
                var titleRes = SearchTextAnalyzer.AnalyzePlainField(article.Title, SearchFieldKind.Title, SearchAnalysisMode.Index, 0, ct);
                if (!RecordField(titleRes.Tokens, 0, termLimit, ct)) return false;
                var titleLen = Math.Max(1, titleRes.SourceLength);

                var summaryText = article.Summary ?? "";
                if (!ChargeChars(summaryText.Length)) return false;
                var sumRes = SearchTextAnalyzer.AnalyzePlainField(summaryText, SearchFieldKind.Summary, SearchAnalysisMode.Index, 0, ct);
                if (!RecordField(sumRes.Tokens, 2, termLimit, ct)) return false;
                var sumLen = Math.Max(1, sumRes.SourceLength);

                var taxLen = 0;
                if (article.Category is { Name.Length: > 0 } cat)
                {
                    if (!ChargeChars(cat.Name.Length)) return false;
                    var catRes = SearchTextAnalyzer.AnalyzePlainField(cat.Name, SearchFieldKind.Taxonomy, SearchAnalysisMode.Index, 0, ct);
                    if (!RecordField(catRes.Tokens, 3, termLimit, ct)) return false;
                    taxLen += catRes.SourceLength;
                }
                foreach (var tag in article.Tags ?? [])
                {
                    if (string.IsNullOrEmpty(tag.Name)) continue;
                    if (!ChargeChars(tag.Name.Length)) return false;
                    var tagRes = SearchTextAnalyzer.AnalyzePlainField(tag.Name, SearchFieldKind.Taxonomy, SearchAnalysisMode.Index, 0, ct);
                    if (!RecordField(tagRes.Tokens, 3, termLimit, ct)) return false;
                    taxLen += tagRes.SourceLength;
                }
                taxLen = Math.Max(1, taxLen);

                var bodyText = article.Body ?? "";
                if (!ChargeChars(bodyText.Length)) return false;
                var (headings, prose, code) = SearchTextAnalyzer.AnalyzeMarkdownBody(bodyText, ct);
                if (!RecordField(headings.Tokens, 1, termLimit, ct) ||
                    !RecordField(prose.Tokens, 4, termLimit, ct) ||
                    !RecordField(code.Tokens, 4, termLimit, ct))
                    return false;
                var headingLen = Math.Max(1, headings.SourceLength);
                var bodyLen = Math.Max(1, prose.SourceLength + code.SourceLength);

                documents[first + ordinal] = new WideDocument(article, titleLen, headingLen, sumLen, taxLen, bodyLen);
                totalFieldLengths[0] += titleLen;
                totalFieldLengths[1] += headingLen;
                totalFieldLengths[2] += sumLen;
                totalFieldLengths[3] += taxLen;
                totalFieldLengths[4] += bodyLen;

                if (_docSources.Count > postingLimit - Pending.Count) return false;
                foreach (var (sourceId, counts) in _docSources)
                {
                    ref var bucket = ref CollectionsMarshal.GetValueRefOrAddDefault(Heads, sourceId, out var found);
                    if (!found)
                    {
                        if (Heads.Count > termLimit) return false;
                        bucket = new Bucket(-1, 0);
                    }
                    Pending.Add(new PendingWidePosting(
                        new WideCounts(ordinal, counts.C0, counts.C1, counts.C2, counts.C3, counts.C4),
                        bucket.Head));
                    bucket = new Bucket(Pending.Count - 1, bucket.Count + 1);
                }
            }
            return true;
        }

        private bool ChargeChars(int count)
        {
            remainingChars -= count;
            return remainingChars >= 0;
        }

        private bool RecordField(IReadOnlyList<SearchToken> tokens, int fieldIdx, int termLimit, CancellationToken ct) =>
            ArticleSearchTokens.VisitTokensAsRoleGroups(tokens, (primary, scriptAliases, derivedAliases) =>
            {
                var source = sources.Resolve(primary, scriptAliases, derivedAliases);
                if (source is not { } sid) return false;
                ref var counts = ref CollectionsMarshal.GetValueRefOrAddDefault(_docSources, sid, out var exists);
                if (!exists && _docSources.Count > termLimit) return false;
                counts.Increment(fieldIdx);
                return true;
            }, ct);
    }

    private static ArticleSearchIndex? BuildWide(IReadOnlyList<Article> articles, CancellationToken ct)
    {
        if (articles.Count > MaxWideDocuments) return null;

        var documents = new WideDocument[articles.Count];
        var totalFieldLengths = new long[SearchScoringProfile.FieldCount];
        var blocks = new WideBlock[(articles.Count + WideBlockDocuments - 1) / WideBlockDocuments];
        var sources = new WideSources();
        var builder = new WidePostingBuilder(MaxWideScannedChars, sources);
        var remainingTerms = MaxTerms;
        var remainingPostings = MaxWidePostings;
        var remainingBytes = MaxWideRetainedBytes - documents.Length * Unsafe.SizeOf<WideDocument>();
        for (var index = 0; index < blocks.Length; index++)
        {
            var first = index * WideBlockDocuments;
            var count = Math.Min(WideBlockDocuments, articles.Count - first);
            if (!builder.Collect(articles, first, count, documents, totalFieldLengths, remainingTerms,
                    Math.Min(remainingPostings, MaxWideBlockPostings), ct))
                return null;

            remainingTerms -= builder.Heads.Count;
            remainingPostings -= builder.Pending.Count;
            remainingBytes -= builder.Heads.Count * Unsafe.SizeOf<WideTerm>();
            var block = PackBlock(builder, first, count, remainingBytes, ct);
            if (block is null) return null;
            remainingBytes -= block.Postings.Length;
            blocks[index] = block;
        }
        var indexData = sources.Pack(documents, blocks, remainingBytes, ct);
        return indexData is null ? null :
            new ArticleSearchIndex(
                [],
                [],
                [],
                new Dictionary<int, (int SegmentIndex, int LocalOrdinal)>(0),
                new Dictionary<int, Article>(0),
                fallbackArticles: null,
                liveDocumentCount: articles.Count,
                deadDocumentSlots: 0,
                totalFieldLengths,
                ComputeAvgFieldLengths(totalFieldLengths, articles.Count),
                liveScannedChars: 0,
                globalLiveDf: null,
                globalShortPrefixLiveDf: null,
                SearchTextAnalyzer.Version,
                SearchScoringProfile.ProfileVersion,
                indexData);
    }

    private static WideBlock? PackBlock(WidePostingBuilder builder, int first, int count, int availableBytes, CancellationToken ct)
    {
        if (availableBytes < 0) return null;
        var terms = new WideTerm[builder.Heads.Count];
        var byteCount = 0;
        var index = 0;
        foreach (var (sourceId, bucket) in builder.Heads)
        {
            terms[index++] = new WideTerm(sourceId, byteCount, bucket.Count);
            if (!EncodeBucket(builder, bucket, count, [], ref byteCount, availableBytes, ct)) return null;
        }

        var bytes = new byte[byteCount];
        var offset = 0;
        foreach (var term in terms) EncodeBucket(builder, builder.Heads[term.SourceId], count, bytes, ref offset, byteCount, ct);
        Array.Sort(terms, WideTerm.BySource);
        return new WideBlock(first, count, terms, bytes);

        static bool EncodeBucket(WidePostingBuilder builder, Bucket bucket, int count, Span<byte> target,
            ref int pos, int limit, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            var previous = count;
            for (int entry = bucket.Head, i = 0; entry >= 0; entry = builder.Pending[entry].Previous, i++)
            {
                if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
                var p = builder.Pending[entry].Value;
                byte mask = 0;
                var singleField = -1;
                byte singleCount = 0;
                if (p.C0 != 0) { mask |= 1; singleField = 0; singleCount = p.C0; }
                if (p.C1 != 0) { mask |= 2; singleField = singleField < 0 ? 1 : 99; singleCount = p.C1; }
                if (p.C2 != 0) { mask |= 4; singleField = singleField < 0 ? 2 : 99; singleCount = p.C2; }
                if (p.C3 != 0) { mask |= 8; singleField = singleField < 0 ? 3 : 99; singleCount = p.C3; }
                if (p.C4 != 0) { mask |= 16; singleField = singleField < 0 ? 4 : 99; singleCount = p.C4; }

                var isMulti = singleField == 99;
                var delta = (previous - p.Ordinal) * 2 + (isMulti ? 1 : 0);
                if (target.IsEmpty)
                {
                    pos += VarintWidth(delta);
                    if (!isMulti)
                    {
                        pos += 1 + (singleCount <= 31 ? 0 : VarintWidth(singleCount));
                    }
                    else
                    {
                        pos += 1;
                        if (p.C0 != 0) pos += VarintWidth(p.C0);
                        if (p.C1 != 0) pos += VarintWidth(p.C1);
                        if (p.C2 != 0) pos += VarintWidth(p.C2);
                        if (p.C3 != 0) pos += VarintWidth(p.C3);
                        if (p.C4 != 0) pos += VarintWidth(p.C4);
                    }
                    if (pos > limit) return false;
                }
                else
                {
                    WriteVarint(target, ref pos, delta);
                    if (!isMulti)
                    {
                        if (singleCount <= 31)
                        {
                            target[pos++] = (byte)((singleField << 5) | singleCount);
                        }
                        else
                        {
                            target[pos++] = (byte)(singleField << 5);
                            WriteVarint(target, ref pos, singleCount);
                        }
                    }
                    else
                    {
                        target[pos++] = mask;
                        if (p.C0 != 0) WriteVarint(target, ref pos, p.C0);
                        if (p.C1 != 0) WriteVarint(target, ref pos, p.C1);
                        if (p.C2 != 0) WriteVarint(target, ref pos, p.C2);
                        if (p.C3 != 0) WriteVarint(target, ref pos, p.C3);
                        if (p.C4 != 0) WriteVarint(target, ref pos, p.C4);
                    }
                }
                previous = p.Ordinal;
            }
            return true;
        }
    }

    private static WideTerm FindWideTerm(WideTerm[] terms, uint sourceId)
    {
        var position = Array.BinarySearch(terms, new WideTerm(sourceId, 0, 0), WideTerm.BySource);
        return position >= 0 ? terms[position] : default;
    }

    private struct WideTermDocData
    {
        internal byte Tf0, Tf1, Tf2, Tf3, Tf4;
        internal byte ExactFlags;

        internal void Add(WideCounts counts, int role)
        {
            var mult = role <= 1 ? 2 : 1;
            if (counts.C0 != 0) Tf0 = (byte)Math.Min(254, Tf0 + counts.C0 * mult);
            if (counts.C1 != 0) Tf1 = (byte)Math.Min(254, Tf1 + counts.C1 * mult);
            if (counts.C2 != 0) Tf2 = (byte)Math.Min(254, Tf2 + counts.C2 * mult);
            if (counts.C3 != 0) Tf3 = (byte)Math.Min(254, Tf3 + counts.C3 * mult);
            if (counts.C4 != 0) Tf4 = (byte)Math.Min(254, Tf4 + counts.C4 * mult);
            if (role == 0) ExactFlags |= ExactFlagBit;
        }

        internal readonly double FieldTf(int field) => (field switch
        {
            0 => Tf0,
            1 => Tf1,
            2 => Tf2,
            3 => Tf3,
            _ => Tf4
        }) * 0.5;
    }

    private sealed class WideResolvedTerm
    {
        internal int DocFreq => Docs?.Count ?? 0;
        internal Dictionary<int, WideTermDocData>? Docs;
    }

    private struct WidePositionCache(Article article, HashSet<SearchTermKey>? keys, CancellationToken ct)
    {
        private Dictionary<SearchTermKey, List<uint>>? _positions;

        internal Dictionary<SearchTermKey, List<uint>> Get(ref SearchExecutionStats stats)
        {
            if (_positions is null)
            {
                _positions = ExtractWideCandidatePositions(article, keys!, ct);
                stats.PositionsRead++;
            }
            return _positions;
        }
    }

    private CompactSearchOutcome ExecuteWideSearch(
        WideIndex wide,
        SearchQueryPlan plan,
        ArticleSearchSort sort,
        int primaryNeed,
        int relaxedNeedCap,
        SearchCursorPosition? afterCursor,
        int returnedSoFar,
        int pageTake,
        int workBudget,
        CancellationToken ct,
        out SearchExecutionStats stats)
    {
        stats = new SearchExecutionStats { Path = SearchExecutionPath.WideIndex };
        var wideDocs = wide.Documents;
        var n = wideDocs.Length;
        var concepts = plan.ContentConcepts;

        // Collect every unique SearchTermKey referenced by the query plan (bounded by <= 128 query chars!)
        var uniqueKeys = new HashSet<SearchTermKey>();
        foreach (var phrase in plan.QuotedPhrases)
            foreach (var st in phrase.Steps) uniqueKeys.Add(st.CanonicalKey);
        foreach (var c in concepts)
        {
            foreach (var st in c.Steps)
            {
                uniqueKeys.Add(st.CanonicalKey);
                if (st.DiffersFromExactForm) uniqueKeys.Add(st.ExactFormKey);
            }
        }
        foreach (var st in plan.OrderedQuerySequence) uniqueKeys.Add(st.CanonicalKey);

        // Decode every referenced WideSources posting list ONCE across all blocks into per-term maps
        var termMaps = new Dictionary<SearchTermKey, WideResolvedTerm>(uniqueKeys.Count);
        var sourceUses = new Dictionary<uint, List<(WideResolvedTerm Term, int Role)>>();
        foreach (var key in uniqueKeys)
        {
            ct.ThrowIfCancellationRequested();
            var rt = new WideResolvedTerm();
            termMaps[key] = rt;
            foreach (var link in new WideLinks(wide.SourcesFor(key)))
            {
                var sid = (uint)(link / 3);
                var role = link % 3;
                if (!sourceUses.TryGetValue(sid, out var list)) sourceUses[sid] = list = [];
                list.Add((rt, role));
            }
        }

        Span<WideTerm> sourceTerms = stackalloc WideTerm[wide.Blocks.Length];
        foreach (var (sid, uses) in sourceUses)
        {
            ct.ThrowIfCancellationRequested();
            // A source has one posting per matching document, and blocks cover disjoint documents.
            var sourceCount = 0;
            for (var b = 0; b < sourceTerms.Length; b++)
            {
                sourceTerms[b] = FindWideTerm(wide.Blocks[b].Terms, sid);
                sourceCount += sourceTerms[b].Count;
            }
            for (var b = 0; b < sourceTerms.Length; b++)
            {
                var block = wide.Blocks[b];
                var visited = false;
                foreach (var p in new WidePostings(block, sourceTerms[b], ct))
                {
                    if (!visited) { stats.BlocksVisited++; visited = true; }
                    stats.PostingsDecoded++;
                    var absOrd = block.First + p.Ordinal;
                    for (var u = 0; u < uses.Count; u++)
                    {
                        var (rt, role) = uses[u];
                        var map = rt.Docs ??= new(sourceCount);
                        ref var data = ref CollectionsMarshal.GetValueRefOrAddDefault(map, absOrd, out _);
                        data.Add(p, role);
                    }
                }
            }
        }

        foreach (var phrase in plan.QuotedPhrases)
            foreach (var st in phrase.Steps)
                if (termMaps[st.CanonicalKey].DocFreq == 0) return new([], 0, [], 0, false);

        var allowsRelaxation = SearchScoringProfile.AllowsRelaxation(plan);
        var minRelaxed = SearchScoringProfile.MinRelaxedConcepts(concepts.Length);
        var minRelaxedRatio = SearchScoringProfile.MinRelaxedIdfRatio(concepts.Length);

        var conceptIdfs = new double[concepts.Length];
        var shortPrefixIdfs = new double[concepts.Length];
        var shortPrefixMaps = new Dictionary<int, int>?[concepts.Length];
        var totalQueryIdf = 0.0;
        var possibleConcepts = 0;
        var possibleIdfSum = 0.0;

        for (var c = 0; c < concepts.Length; c++)
        {
            ct.ThrowIfCancellationRequested();
            var concept = concepts[c];
            double idf;
            var canMatch = false;
            switch (concept.Kind)
            {
                case SearchConceptKind.CjkSequence:
                {
                    var maxIdf = 0.0;
                    var allPresent = true;
                    foreach (var st in concept.Steps)
                    {
                        var df = termMaps[st.CanonicalKey].DocFreq;
                        if (df == 0) allPresent = false;
                        var stIdf = SearchScoringProfile.InverseDocumentFrequency(n, df);
                        if (stIdf > maxIdf) maxIdf = stIdf;
                    }
                    idf = maxIdf;
                    canMatch = allPresent;
                    break;
                }
                case SearchConceptKind.CompoundHyphen:
                {
                    var exactDf = termMaps[concept.Steps[0].CanonicalKey].DocFreq;
                    var minSubDf = n;
                    var allSubs = concept.Steps.Length > 1;
                    for (var i = 1; i < concept.Steps.Length; i++)
                    {
                        var d = termMaps[concept.Steps[i].CanonicalKey].DocFreq;
                        if (d == 0) allSubs = false;
                        if (d < minSubDf) minSubDf = d;
                    }
                    var combinedDf = Math.Min(n, Math.Max(exactDf, allSubs ? minSubDf : 0));
                    idf = SearchScoringProfile.InverseDocumentFrequency(n, combinedDf);
                    canMatch = exactDf > 0 || allSubs;
                    break;
                }
                default:
                {
                    var df = termMaps[concept.Steps[0].CanonicalKey].DocFreq;
                    idf = SearchScoringProfile.InverseDocumentFrequency(n, df);
                    canMatch = df > 0;
                    if (concept.ShortAsciiPrefix is { } prefix)
                    {
                        Dictionary<int, int>? map = null;
                        for (var ord = 0; ord < n; ord++)
                        {
                            if ((ord & 1023) == 0) ct.ThrowIfCancellationRequested();
                            var p = PackShortPrefixHits(wideDocs[ord].Article, prefix);
                            if (p != 0) (map ??= [])[ord] = p;
                        }
                        if (map is { Count: > 0 })
                        {
                            shortPrefixMaps[c] = map;
                            shortPrefixIdfs[c] = SearchScoringProfile.InverseDocumentFrequency(n, Math.Min(n, df + map.Count));
                            canMatch = true;
                        }
                    }
                    break;
                }
            }

            conceptIdfs[c] = idf;
            totalQueryIdf += idf;
            if (!canMatch)
            {
                if (concept.IsStrictIdentifier || !allowsRelaxation) return new([], 0, [], 0, false);
            }
            else
            {
                possibleConcepts++;
                possibleIdfSum += idf;
            }
        }

        if (possibleConcepts < minRelaxed || (totalQueryIdf > 0.0 && possibleIdfSum / totalQueryIdf < minRelaxedRatio))
            return new([], 0, [], 0, false);

        // Select smallest driver or union of candidates
        var candidates = CollectWideCandidates(plan, concepts, termMaps, shortPrefixMaps, allowsRelaxation, ct);
        if (candidates.Count == 0) return new([], 0, [], 0, false);

        // Identify keys that require positional extraction on candidates
        HashSet<SearchTermKey>? positionalKeys = null;
        if (plan.QuotedPhrases.Length > 0 || plan.OrderedQuerySequence.Length >= 2 ||
            concepts.Any(static c => c.Kind == SearchConceptKind.CjkSequence))
        {
            positionalKeys = [];
            foreach (var phrase in plan.QuotedPhrases)
                foreach (var st in phrase.Steps) positionalKeys.Add(st.CanonicalKey);
            foreach (var c in concepts)
                if (c.Kind == SearchConceptKind.CjkSequence)
                    foreach (var st in c.Steps) positionalKeys.Add(st.CanonicalKey);
            foreach (var st in plan.OrderedQuerySequence) positionalKeys.Add(st.CanonicalKey);
        }

        var effPrimaryNeed = afterCursor is { Tier: SearchMatchTier.Relaxed } ? 0 : primaryNeed;
        var effRelaxedNeed = allowsRelaxation
            ? Math.Min(SearchScoringProfile.MaxRelaxedResults, Math.Max(0, relaxedNeedCap))
            : 0;
        using var primaryHeap = new SearchTopKHeap(effPrimaryNeed, sort);
        using var relaxedHeap = new SearchTopKHeap(effRelaxedNeed, sort);
        var primaryObserved = 0;
        var relaxedObserved = 0;

        Span<double> tfs = stackalloc double[SearchScoringProfile.FieldCount];
        Span<int> docLens = stackalloc int[SearchScoringProfile.FieldCount];
        var hasCursor = afterCursor.HasValue;
        var cursorVal = hasCursor ? afterCursor!.Value : default;
        var cursorScore = hasCursor ? BitConverter.Int64BitsToDouble(cursorVal.ScoreBits) : 0.0;

        var scoredCandidates = 0;
        foreach (var ordinal in candidates)
        {
            ct.ThrowIfCancellationRequested();
            if (++scoredCandidates > workBudget)
                throw new SearchBudgetExceededException();
            var doc = wideDocs[ordinal];

            // Fast pre-check before extracting positions: every quoted phrase step must be present
            var preOk = true;
            foreach (var phrase in plan.QuotedPhrases)
            {
                foreach (var st in phrase.Steps)
                {
                    if (termMaps[st.CanonicalKey].Docs is not { } d || !d.ContainsKey(ordinal)) { preOk = false; break; }
                }
                if (!preOk) break;
            }
            if (!preOk) continue;

            var positions = new WidePositionCache(doc.Article, positionalKeys, ct);
            // 1. Verify strict quoted phrases
            foreach (var phrase in plan.QuotedPhrases)
            {
                if (!WideMatchesExactSequence(positions.Get(ref stats), phrase.Steps, out _)) { preOk = false; break; }
            }
            if (!preOk) continue;

            doc.CopyLengths(docLens);
            var matchedCount = 0;
            var matchedIdfSum = 0.0;
            var strictOk = true;
            var score = 0.0;

            for (var c = 0; c < concepts.Length; c++)
            {
                var concept = concepts[c];
                tfs.Clear();
                var matched = EvaluateWideConcept(ordinal, concept, termMaps, shortPrefixMaps[c], ref positions, tfs, ref stats,
                    out var exactFormHit, out var usedShortPrefixOnly);
                if (!matched)
                {
                    if (concept.IsStrictIdentifier) { strictOk = false; break; }
                    continue;
                }
                matchedCount++;
                matchedIdfSum += conceptIdfs[c];
                var activeIdf = usedShortPrefixOnly ? shortPrefixIdfs[c] : conceptIdfs[c];
                score += SearchScoringProfile.ScoreConceptBm25F(activeIdf, tfs, docLens, _avgFieldLengths);
                if (exactFormHit)
                    score += SearchScoringProfile.ExactFormBonusFactor * activeIdf;
            }
            if (!strictOk || matchedCount == 0) continue;

            var isPrimary = matchedCount == concepts.Length;
            var isRelaxed = !isPrimary && allowsRelaxation &&
                            primaryObserved < SearchScoringProfile.RelaxationTriggerPrimaryCount &&
                            matchedCount >= minRelaxed &&
                            totalQueryIdf > 0.0 &&
                            (matchedIdfSum / totalQueryIdf) >= minRelaxedRatio;
            if (!isPrimary && !isRelaxed) continue;

            stats.CandidatesScored++;
            if (isPrimary) primaryObserved++;
            else relaxedObserved++;

            var targetNeed = isPrimary ? effPrimaryNeed : effRelaxedNeed;
            if (targetNeed == 0) continue;

            // Exact lazy position check before phrase/proximity extraction on Wide candidates
            var needsBonus = plan.QuotedPhrases.Length > 0 || (isPrimary && plan.OrderedQuerySequence.Length >= 2);
            var maxBonus = needsBonus
                ? SearchScoringProfile.TitleOrHeadingPhraseBonusFactor * matchedIdfSum * (1.0 + 1e-11) + 1e-11
                : 0.0;
            var docPubTicks = doc.Article.PublishedAt.UtcTicks;
            var tier = isPrimary ? SearchMatchTier.Primary : SearchMatchTier.Relaxed;

            var skipForCursorOrHeap = false;
            if (hasCursor)
            {
                if (tier < cursorVal.Tier)
                    skipForCursorOrHeap = true;
                else if (tier == cursorVal.Tier)
                {
                    if (sort == ArticleSearchSort.Latest && docPubTicks > cursorVal.PublishedAtTicks)
                        skipForCursorOrHeap = true;
                    else if (sort == ArticleSearchSort.Relevance && score > cursorScore)
                        skipForCursorOrHeap = true;
                }
            }
            if (!skipForCursorOrHeap)
            {
                var isFull = isPrimary ? primaryHeap.IsFull : relaxedHeap.IsFull;
                if (isFull)
                {
                    var worst = isPrimary ? primaryHeap.Worst : relaxedHeap.Worst;
                    if (sort == ArticleSearchSort.Latest)
                    {
                        var worstPub = worst.PublishedAtTicks;
                        if (docPubTicks < worstPub || (docPubTicks == worstPub && score + maxBonus < worst.Score))
                            skipForCursorOrHeap = true;
                    }
                    else if (score + maxBonus < worst.Score)
                    {
                        skipForCursorOrHeap = true;
                    }
                }
            }

            if (skipForCursorOrHeap)
            {
                if (needsBonus) stats.PositionSkipsByBound++;
                continue;
            }

            if (needsBonus)
            {
                var seq = plan.QuotedPhrases.Length > 0 ? plan.QuotedPhrases[0].Steps : plan.OrderedQuerySequence;
                var allSeqPresent = true;
                foreach (var st in seq)
                {
                    if (termMaps[st.CanonicalKey].Docs is not { } d || !d.ContainsKey(ordinal)) { allSeqPresent = false; break; }
                }
                if (allSeqPresent)
                {
                    var posMap = positions.Get(ref stats);
                    if (WideMatchesExactSequence(posMap, seq, out var matchField))
                    {
                        var factor = matchField is SearchScoreField.Title or SearchScoreField.Heading
                            ? SearchScoringProfile.TitleOrHeadingPhraseBonusFactor
                            : SearchScoringProfile.BodyPhraseBonusFactor;
                        score += factor * matchedIdfSum;
                    }
                    else if (isPrimary && concepts.Length >= 2 &&
                             WideMatchesTightProximity(posMap, plan.OrderedQuerySequence, 2 * concepts.Length + 4))
                    {
                        score += SearchScoringProfile.TightProximityBonusFactor * matchedIdfSum;
                    }
                }
            }

            var hit = new HeapHit(doc.Article.Id, ordinal, tier, score, docPubTicks, doc.Article.CreatedAt.UtcTicks);
            if (hasCursor && CompareHeapHitToCursor(hit, cursorVal, sort) <= 0)
                continue;
            if (isPrimary) primaryHeap.TryPush(hit);
            else relaxedHeap.TryPush(hit);
        }

        var includeRelaxed = allowsRelaxation &&
                             primaryObserved < SearchScoringProfile.RelaxationTriggerPrimaryCount &&
                             relaxedObserved > 0;
        var finalRelaxedCount = includeRelaxed ? Math.Min(relaxedObserved, SearchScoringProfile.MaxRelaxedResults) : 0;
        ArticleSearchHit[] finalRelaxedHits = [];
        if (includeRelaxed)
        {
            var drainedRelaxed = relaxedHeap.DrainSorted();
            if (afterCursor is { Tier: SearchMatchTier.Relaxed })
            {
                var returnedRelaxedSoFar = Math.Max(0, returnedSoFar - primaryObserved);
                var remainingRelaxedCap = Math.Max(0, SearchScoringProfile.MaxRelaxedResults - returnedRelaxedSoFar);
                if (drainedRelaxed.Length > remainingRelaxedCap)
                    drainedRelaxed = drainedRelaxed[..remainingRelaxedCap];
            }
            else if (drainedRelaxed.Length > SearchScoringProfile.MaxRelaxedResults)
            {
                drainedRelaxed = drainedRelaxed[..SearchScoringProfile.MaxRelaxedResults];
            }
            finalRelaxedHits = MaterializeWideHits(wideDocs, drainedRelaxed);
        }

        return new(MaterializeWideHits(wideDocs, primaryHeap.DrainSorted()), primaryObserved, finalRelaxedHits, finalRelaxedCount, false);

        static ArticleSearchHit[] MaterializeWideHits(WideDocument[] docs, HeapHit[] sorted)
        {
            if (sorted.Length == 0) return [];
            var result = new ArticleSearchHit[sorted.Length];
            for (var i = 0; i < sorted.Length; i++)
                result[i] = new ArticleSearchHit(docs[sorted[i].FallbackOrdinal].Article, sorted[i].Tier, sorted[i].Score);
            return result;
        }
    }

    private static List<int> CollectWideCandidates(
        SearchQueryPlan plan,
        SearchConcept[] concepts,
        Dictionary<SearchTermKey, WideResolvedTerm> termMaps,
        Dictionary<int, int>?[] shortPrefixMaps,
        bool allowsRelaxation,
        CancellationToken ct)
    {
        WideResolvedTerm? smallestDriver = null;
        void Consider(WideResolvedTerm t)
        {
            if (smallestDriver is null || t.DocFreq < smallestDriver.DocFreq)
                smallestDriver = t;
        }

        foreach (var phrase in plan.QuotedPhrases)
            foreach (var st in phrase.Steps) Consider(termMaps[st.CanonicalKey]);

        foreach (var c in concepts)
        {
            if (c.IsStrictIdentifier)
            {
                Consider(termMaps[c.Steps[0].CanonicalKey]);
            }
            else if (!allowsRelaxation)
            {
                if (c.Kind == SearchConceptKind.Term && c.ShortAsciiPrefix is null)
                    Consider(termMaps[c.Steps[0].CanonicalKey]);
                else if (c.Kind == SearchConceptKind.CjkSequence)
                    foreach (var st in c.Steps) Consider(termMaps[st.CanonicalKey]);
            }
        }

        if (smallestDriver is { } driver)
        {
            if (driver.Docs is null) return [];
            var result = new List<int>(driver.Docs.Count);
            foreach (var ord in driver.Docs.Keys) result.Add(ord);
            return result;
        }

        var union = new HashSet<int>();
        for (var c = 0; c < concepts.Length; c++)
        {
            ct.ThrowIfCancellationRequested();
            var concept = concepts[c];
            if (concept.Kind == SearchConceptKind.CjkSequence)
            {
                var rarest = termMaps[concept.Steps[0].CanonicalKey];
                for (var s = 1; s < concept.Steps.Length; s++)
                {
                    var t = termMaps[concept.Steps[s].CanonicalKey];
                    if (t.DocFreq < rarest.DocFreq) rarest = t;
                }
                if (rarest.Docs is not null)
                    foreach (var ord in rarest.Docs.Keys) union.Add(ord);
            }
            else if (concept.Kind == SearchConceptKind.CompoundHyphen)
            {
                if (termMaps[concept.Steps[0].CanonicalKey].Docs is { } ex)
                    foreach (var ord in ex.Keys) union.Add(ord);
                if (concept.Steps.Length > 1)
                {
                    var rarest = termMaps[concept.Steps[1].CanonicalKey];
                    for (var s = 2; s < concept.Steps.Length; s++)
                    {
                        var t = termMaps[concept.Steps[s].CanonicalKey];
                        if (t.DocFreq < rarest.DocFreq) rarest = t;
                    }
                    if (rarest.Docs is not null)
                        foreach (var ord in rarest.Docs.Keys) union.Add(ord);
                }
            }
            else
            {
                if (termMaps[concept.Steps[0].CanonicalKey].Docs is { } d)
                    foreach (var ord in d.Keys) union.Add(ord);
                if (shortPrefixMaps[c] is { } sp)
                    foreach (var ord in sp.Keys) union.Add(ord);
            }
        }
        return [.. union];
    }

    private static bool EvaluateWideConcept(
        int ordinal,
        SearchConcept concept,
        Dictionary<SearchTermKey, WideResolvedTerm> termMaps,
        Dictionary<int, int>? shortPrefixMap,
        ref WidePositionCache positions,
        Span<double> tfs,
        ref SearchExecutionStats stats,
        out bool exactFormHit,
        out bool usedShortPrefixOnly)
    {
        exactFormHit = false;
        usedShortPrefixOnly = false;

        switch (concept.Kind)
        {
            case SearchConceptKind.CjkSequence:
            {
                foreach (var st in concept.Steps)
                    if (termMaps[st.CanonicalKey].Docs is not { } d || !d.ContainsKey(ordinal)) return false;
                if (!WideMatchesExactSequence(positions.Get(ref stats), concept.Steps, out _)) return false;
                for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
                {
                    var minTf = double.MaxValue;
                    foreach (var st in concept.Steps)
                    {
                        var tf = termMaps[st.CanonicalKey].Docs![ordinal].FieldTf(f);
                        if (tf < minTf) minTf = tf;
                    }
                    tfs[f] = minTf == double.MaxValue ? 0 : minTf;
                }
                exactFormHit = true;
                foreach (var st in concept.Steps)
                {
                    if (termMaps[st.ExactFormKey].Docs is not { } exMap ||
                        !exMap.TryGetValue(ordinal, out var ex) ||
                        (ex.ExactFlags & ExactFlagBit) == 0)
                    {
                        exactFormHit = false;
                        break;
                    }
                }
                return true;
            }
            case SearchConceptKind.CompoundHyphen:
            {
                WideTermDocData exactData = default;
                var hasExact = termMaps[concept.Steps[0].CanonicalKey].Docs is { } exMap && exMap.TryGetValue(ordinal, out exactData);
                var hasAllSub = concept.Steps.Length > 1;
                for (var i = 1; i < concept.Steps.Length; i++)
                {
                    if (termMaps[concept.Steps[i].CanonicalKey].Docs is not { } d || !d.ContainsKey(ordinal))
                    {
                        hasAllSub = false;
                        break;
                    }
                }
                if (!hasExact && !hasAllSub) return false;

                for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
                {
                    var tf = hasExact ? exactData.FieldTf(f) : 0.0;
                    if (hasAllSub)
                    {
                        var minSub = double.MaxValue;
                        for (var i = 1; i < concept.Steps.Length; i++)
                        {
                            var stf = termMaps[concept.Steps[i].CanonicalKey].Docs![ordinal].FieldTf(f);
                            if (stf < minSub) minSub = stf;
                        }
                        if (minSub != double.MaxValue && minSub > tf) tf = minSub;
                    }
                    tfs[f] = tf;
                }
                exactFormHit = hasExact && (exactData.ExactFlags & ExactFlagBit) != 0;
                return true;
            }
            default:
            {
                var step = concept.Steps[0];
                if (termMaps[step.CanonicalKey].Docs is { } dMap && dMap.TryGetValue(ordinal, out var data))
                {
                    for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
                        tfs[f] = data.FieldTf(f);
                    exactFormHit = step.DiffersFromExactForm
                        ? (termMaps[step.ExactFormKey].Docs is { } eMap && eMap.TryGetValue(ordinal, out var ex) && (ex.ExactFlags & ExactFlagBit) != 0)
                        : (data.ExactFlags & ExactFlagBit) != 0;
                    return true;
                }
                if (shortPrefixMap is not null && shortPrefixMap.TryGetValue(ordinal, out var packed) && packed != 0)
                {
                    UnpackShortPrefixTfs(packed, tfs);
                    usedShortPrefixOnly = true;
                    return true;
                }
                return false;
            }
        }
    }

    private static Dictionary<SearchTermKey, List<uint>> ExtractWideCandidatePositions(Article article,
        HashSet<SearchTermKey> neededKeys, CancellationToken ct)
    {
        var result = new Dictionary<SearchTermKey, List<uint>>();
        void Collect(IReadOnlyList<SearchToken> tokens, SearchScoreField field, int posShift)
        {
            foreach (var tok in tokens)
            {
                if (tok.Kind is not (SearchTokenKind.Exact or SearchTokenKind.CjkBigram or SearchTokenKind.Subword or SearchTokenKind.ScriptAlias))
                    continue;
                var key = SearchTermKey.From(tok);
                if (!neededKeys.Contains(key)) continue;
                if (!result.TryGetValue(key, out var list)) result[key] = list = [];
                list.Add(SearchScoringProfile.PackPosition(field, tok.Position + posShift, tok.Width));
            }
        }

        var title = SearchTextAnalyzer.AnalyzePlainField(article.Title, SearchFieldKind.Title, SearchAnalysisMode.Index, 0, ct);
        Collect(title.Tokens, SearchScoreField.Title, 0);
        var summary = SearchTextAnalyzer.AnalyzePlainField(article.Summary ?? "", SearchFieldKind.Summary, SearchAnalysisMode.Index, 0, ct);
        Collect(summary.Tokens, SearchScoreField.Summary, 0);
        var taxPos = 0;
        if (article.Category is { Name.Length: > 0 } cat)
        {
            var catRes = SearchTextAnalyzer.AnalyzePlainField(cat.Name, SearchFieldKind.Taxonomy, SearchAnalysisMode.Index, taxPos, ct);
            Collect(catRes.Tokens, SearchScoreField.Taxonomy, 0);
            taxPos = catRes.EndPosition + SearchTextAnalyzer.BlockPositionGap;
        }
        foreach (var tag in article.Tags ?? [])
        {
            if (string.IsNullOrEmpty(tag.Name)) continue;
            var tagRes = SearchTextAnalyzer.AnalyzePlainField(tag.Name, SearchFieldKind.Taxonomy, SearchAnalysisMode.Index, taxPos, ct);
            Collect(tagRes.Tokens, SearchScoreField.Taxonomy, 0);
            taxPos = tagRes.EndPosition + SearchTextAnalyzer.BlockPositionGap;
        }
        var (headings, prose, code) = SearchTextAnalyzer.AnalyzeMarkdownBody(article.Body ?? "", ct);
        Collect(headings.Tokens, SearchScoreField.Heading, 0);
        var codeShift = prose.EndPosition > 0 ? prose.EndPosition + SearchTextAnalyzer.BlockPositionGap : 0;
        Collect(prose.Tokens, SearchScoreField.Body, 0);
        Collect(code.Tokens, SearchScoreField.Body, codeShift);

        foreach (var list in result.Values)
        {
            if (list.Count > 1)
            {
                list.Sort();
                var write = 1;
                for (var r = 1; r < list.Count; r++)
                    if (list[r] != list[r - 1]) list[write++] = list[r];
                if (write < list.Count) list.RemoveRange(write, list.Count - write);
            }
        }
        return result;
    }

    private static bool WideMatchesExactSequence(Dictionary<SearchTermKey, List<uint>> posMap, SearchConceptStep[] steps,
        out SearchScoreField bestField)
    {
        bestField = SearchScoreField.Body;
        if (steps.Length == 0) return false;
        var lists = new IReadOnlyList<uint>[steps.Length];
        for (var i = 0; i < steps.Length; i++)
        {
            if (!posMap.TryGetValue(steps[i].CanonicalKey, out var list) || list.Count == 0) return false;
            lists[i] = list;
        }
        return ExhaustiveSearchOracle.MatchPositionsExactSequence(lists, steps, out bestField);
    }

    private static bool WideMatchesTightProximity(Dictionary<SearchTermKey, List<uint>> posMap, SearchConceptStep[] steps, int maxSpan)
    {
        if (steps.Length < 2) return false;
        var lists = new IReadOnlyList<uint>[steps.Length];
        for (var i = 0; i < steps.Length; i++)
        {
            if (!posMap.TryGetValue(steps[i].CanonicalKey, out var list) || list.Count == 0) return false;
            lists[i] = list;
        }
        return ExhaustiveSearchOracle.MatchPositionsTightProximity(lists, maxSpan);
    }

    private ref struct WideLinks(ReadOnlySpan<byte> bytes)
    {
        private readonly ReadOnlySpan<byte> _bytes = bytes;
        private int _offset, _link;

        public readonly WideLinks GetEnumerator() => this;
        public readonly int Current => _link;

        public bool MoveNext()
        {
            if (_offset == _bytes.Length) return false;
            _link += ReadVarint(_bytes, ref _offset);
            return true;
        }
    }

    private struct WidePostings
    {
        private readonly byte[] _bytes;
        private readonly CancellationToken _ct;
        private readonly int _count;
        private int _offset, _ordinal, _index;

        internal WidePostings(WideBlock block, WideTerm term, CancellationToken ct)
        {
            (_bytes, _ct, _count, _offset, _ordinal) = (block.Postings, ct, term.Count, term.Start, block.Count);
        }

        public readonly WidePostings GetEnumerator() => this;
        public WideCounts Current { readonly get; private set; }

        public bool MoveNext()
        {
            if (_index == _count) return false;
            if ((_index++ & 1023) == 0) _ct.ThrowIfCancellationRequested();
            var delta = ReadVarint(_bytes, ref _offset);
            _ordinal -= delta / 2;
            byte c0 = 0, c1 = 0, c2 = 0, c3 = 0, c4 = 0;
            if ((delta & 1) == 0)
            {
                var header = _bytes[_offset++];
                var field = header >> 5;
                var val = (byte)(header & 31);
                if (val == 0) val = (byte)Math.Min(254, ReadVarint(_bytes, ref _offset));
                switch (field)
                {
                    case 0: c0 = val; break;
                    case 1: c1 = val; break;
                    case 2: c2 = val; break;
                    case 3: c3 = val; break;
                    default: c4 = val; break;
                }
            }
            else
            {
                var mask = _bytes[_offset++];
                if ((mask & 1) != 0) c0 = (byte)Math.Min(254, ReadVarint(_bytes, ref _offset));
                if ((mask & 2) != 0) c1 = (byte)Math.Min(254, ReadVarint(_bytes, ref _offset));
                if ((mask & 4) != 0) c2 = (byte)Math.Min(254, ReadVarint(_bytes, ref _offset));
                if ((mask & 8) != 0) c3 = (byte)Math.Min(254, ReadVarint(_bytes, ref _offset));
                if ((mask & 16) != 0) c4 = (byte)Math.Min(254, ReadVarint(_bytes, ref _offset));
            }
            Current = new WideCounts(_ordinal, c0, c1, c2, c3, c4);
            return true;
        }
    }

    private static int VarintWidth(int value)
    {
        var width = 1;
        for (; value >= 128; value >>= 7) width++;
        return width;
    }

    private static void WriteVarint(Span<byte> bytes, ref int offset, int value)
    {
        for (; value >= 128; value >>= 7) bytes[offset++] = (byte)((value & 127) | 128);
        bytes[offset++] = (byte)value;
    }

    private static int ReadVarint(ReadOnlySpan<byte> bytes, ref int offset)
    {
        int value = 0, shift = 0;
        for (; ; shift += 7)
        {
            var next = bytes[offset++];
            value |= (next & 127) << shift;
            if (next < 128) return value;
        }
    }
}
