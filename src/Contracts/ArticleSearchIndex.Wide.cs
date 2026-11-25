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

    private sealed record WideIndex(WideBlock[] Blocks, WideAlias[] Aliases, byte[] NamePool, byte[] Sources)
    {
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
        private readonly record struct Source(SearchTermKey? Primary, SearchTermKey[] Aliases, int Previous);
        private readonly Dictionary<ulong, int> _heads = [];
        private readonly List<Source> _sources = [];
        private int _linkCount;

        internal uint? Resolve(SearchTermKey? primary, ReadOnlySpan<SearchTermKey> aliases)
        {
            var bucketHash = primary?.Hash64 ?? (aliases.Length > 0 ? aliases[0].Hash64 ^ 0x9E3779B97F4A7C15UL : 0UL);
            var previous = _heads.GetValueOrDefault(bucketHash, -1);
            for (var index = previous; index >= 0; index = _sources[index].Previous)
            {
                var existing = _sources[index];
                if (existing.Primary == primary && aliases.SequenceEqual(existing.Aliases)) return (uint)index;
            }

            var addedLinks = (primary.HasValue ? 1 : 0) + aliases.Length;
            if (_sources.Count == MaxTerms || _linkCount > MaxWideRetainedBytes - addedLinks)
                return null;

            var id = _sources.Count;
            _heads[bucketHash] = id;
            _sources.Add(new Source(primary, aliases.ToArray(), previous));
            _linkCount += addedLinks;
            return (uint)id;
        }

        internal WideIndex? Pack(WideBlock[] blocks, int availableBytes, CancellationToken ct)
        {
            if (_linkCount > availableBytes) return null;
            var references = new Dictionary<SearchTermKey, List<int>>();
            for (var id = 0; id < _sources.Count; id++)
            {
                ct.ThrowIfCancellationRequested();
                var source = _sources[id];
                if (source.Primary is { } p) Add(p, id * 2);
                foreach (var alias in source.Aliases) Add(alias, id * 2 + 1);
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
            return new WideIndex(blocks, aliases, namePool, sources);

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

    private sealed class WidePostingBuilder(long remainingChars, WideSources sources)
    {
        private readonly Dictionary<uint, int> _frequencies = [];
        internal readonly Dictionary<uint, Bucket> Heads = [];
        internal readonly List<PendingPosting> Pending = [];
        private readonly Dictionary<uint, int> _oddWeights = [];
        internal readonly Dictionary<int, int> OddWeights = [];
        internal long TotalLength { get; private set; }

        internal bool Collect(IReadOnlyList<Article> articles, int first, Span<int> lengths,
            int termLimit, int postingLimit, CancellationToken ct)
        {
            Heads.Clear();
            Pending.Clear();
            OddWeights.Clear();
            for (var ordinal = 0; ordinal < lengths.Length; ordinal++)
            {
                ct.ThrowIfCancellationRequested();
                var article = articles[first + ordinal];
                _frequencies.Clear();
                _oddWeights.Clear();
                if (!Index(article.Title, SearchFieldKind.Title, false, TitleWeight, out _) ||
                    !Index(article.Summary ?? "", SearchFieldKind.Summary, false, SummaryWeight, out _) ||
                    !Index(article.Category?.Name ?? "", SearchFieldKind.Taxonomy, false, TaxonomyWeight, out _))
                    return false;
                foreach (var tag in article.Tags ?? [])
                    if (!Index(tag.Name, SearchFieldKind.Taxonomy, false, TaxonomyWeight, out _)) return false;
                if (!Index(article.Body, SearchFieldKind.Body, true, BodyWeight, out var bodyLength)) return false;
                lengths[ordinal] = Math.Max(1, bodyLength);
                TotalLength += lengths[ordinal];

                if (_frequencies.Count > postingLimit - Pending.Count) return false;
                foreach (var (sourceId, weight) in _frequencies)
                {
                    ref var bucket = ref CollectionsMarshal.GetValueRefOrAddDefault(Heads, sourceId, out var found);
                    if (!found)
                    {
                        if (Heads.Count > termLimit) return false;
                        bucket = new Bucket(-1, 0);
                    }
                    if (_oddWeights.TryGetValue(sourceId, out var adjustment)) OddWeights.Add(Pending.Count, adjustment);
                    Pending.Add(new PendingPosting(new Posting(ordinal, weight), bucket.Head));
                    bucket = new Bucket(Pending.Count - 1, bucket.Count + 1);
                }
            }
            return true;

            bool Index(string text, SearchFieldKind field, bool isMarkdown, int weight, out int sourceLen)
            {
                sourceLen = 0;
                remainingChars -= text.Length;
                if (remainingChars < 0) return false;
                return ArticleSearchTokens.VisitFieldSources(text, field, isMarkdown, ct, (primary, aliases) =>
                {
                    var source = sources.Resolve(primary, aliases);
                    if (source is not { } key) return false;
                    if (weight % 2 != 0 && !aliases.IsEmpty)
                        CollectionsMarshal.GetValueRefOrAddDefault(_oddWeights, key, out _)++;
                    return Add(key, weight);
                }, out sourceLen);
            }

            bool Add(uint sourceId, int delta)
            {
                ref var frequency = ref CollectionsMarshal.GetValueRefOrAddDefault(_frequencies, sourceId, out _);
                if (frequency > int.MaxValue - delta) return false;
                frequency += delta;
                return _frequencies.Count <= termLimit;
            }
        }
    }

    private static ArticleSearchIndex? BuildWide(IReadOnlyList<Article> articles, CancellationToken ct)
    {
        if (articles.Count > MaxWideDocuments) return null;

        var lengths = new int[articles.Count];
        var blocks = new WideBlock[(articles.Count + WideBlockDocuments - 1) / WideBlockDocuments];
        var sources = new WideSources();
        var builder = new WidePostingBuilder(MaxWideScannedChars, sources);
        var remainingTerms = MaxTerms;
        var remainingPostings = MaxWidePostings;
        var remainingBytes = MaxWideRetainedBytes - lengths.Length * Unsafe.SizeOf<Document>();
        for (var index = 0; index < blocks.Length; index++)
        {
            var first = index * WideBlockDocuments;
            var count = Math.Min(WideBlockDocuments, articles.Count - first);
            if (!builder.Collect(articles, first, lengths.AsSpan(first, count), remainingTerms,
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
        var indexData = sources.Pack(blocks, remainingBytes, ct);
        return indexData is null ? null :
            new ArticleSearchIndex(Normalize(articles, lengths, builder.TotalLength, ct), [], [], indexData);
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
                var posting = builder.Pending[entry].Value;
                var adjustment = builder.OddWeights.GetValueOrDefault(entry);
                var delta = (previous - posting.Ordinal) * 2 + (adjustment != 0 ? 1 : 0);
                if (target.IsEmpty)
                {
                    pos += VarintWidth(delta) + VarintWidth(posting.Weight) + (adjustment != 0 ? VarintWidth(adjustment) : 0);
                    if (pos > limit) return false;
                }
                else
                {
                    WriteVarint(target, ref pos, delta);
                    WriteVarint(target, ref pos, posting.Weight);
                    if (adjustment != 0) WriteVarint(target, ref pos, adjustment);
                }
                previous = posting.Ordinal;
            }
            return true;
        }
    }

    private static WideTerm FindWideTerm(WideTerm[] terms, uint sourceId)
    {
        var position = Array.BinarySearch(terms, new WideTerm(sourceId, 0, 0), WideTerm.BySource);
        return position >= 0 ? terms[position] : default;
    }

    private sealed class WideQueryTerm
    {
        internal int Frequency;
        internal int Links;
        internal int DirectLink = -1;
        internal int[]? Weights;
    }

    private readonly record struct WideQueryUse(WideQueryTerm Term, bool Exact, int Previous);

    private Dictionary<SearchTermKey, WideQueryTerm> CollectWideTerms(WideIndex wide, AnalyzedQuery query, CancellationToken ct)
    {
        var terms = new Dictionary<SearchTermKey, WideQueryTerm>();
        var sources = new Dictionary<uint, int>();
        var uses = new List<WideQueryUse>();
        foreach (var token in query.Tokens)
        {
            var key = SearchTermKey.From(token);
            var term = new WideQueryTerm();
            if (!terms.TryAdd(key, term)) continue;

            foreach (var link in new WideLinks(wide.SourcesFor(key)))
            {
                ct.ThrowIfCancellationRequested();
                var source = (uint)(link / 2);
                var previous = sources.GetValueOrDefault(source, -1);
                sources[source] = uses.Count;
                uses.Add(new WideQueryUse(term, link % 2 == 0, previous));
                term.Links++;
            }
        }

        foreach (var (source, head) in sources)
        {
            ct.ThrowIfCancellationRequested();
            var first = uses[head];
            if (first.Previous < 0 && first.Term.Links == 1)
            {
                first.Term.DirectLink = (int)source * 2 + (first.Exact ? 0 : 1);
                foreach (var block in wide.Blocks) first.Term.Frequency += FindWideTerm(block.Terms, source).Count;
                continue;
            }

            foreach (var block in wide.Blocks)
            {
                foreach (var posting in new WidePostings(block, source, ct))
                {
                    var ordinal = block.First + posting.Ordinal;
                    for (var useId = head; useId >= 0; useId = uses[useId].Previous)
                    {
                        var use = uses[useId];
                        var weights = use.Term.Weights ??= new int[_documents.Length];
                        if (weights[ordinal] == 0) use.Term.Frequency++;
                        weights[ordinal] += use.Exact ? posting.Weight : posting.AliasWeight;
                    }
                }
            }
        }
        return terms;
    }

    private ArticleSearchPage SearchWide(WideIndex wide, AnalyzedQuery query, ArticleSearchSort sort, int start, int window,
        CancellationToken ct)
    {
        var collected = CollectWideTerms(wide, query, ct);
        var terms = collected.Values.Where(term => term.Frequency != 0)
            .Select(term => (Value: term, Idf: InverseFrequency(term.Frequency))).ToArray();
        var shortTerms = new List<(string Prefix, double Idf)>();
        if (query.ShortAsciiPrefixes.Count > 0)
        {
            foreach (var prefix in query.ShortAsciiPrefixes)
            {
                var prefixDf = 0;
                for (var ordinal = 0; ordinal < _documents.Length; ordinal++)
                {
                    if ((ordinal & 1023) == 0) ct.ThrowIfCancellationRequested();
                    if (ShortPrefixWeight(_documents[ordinal].Article, prefix) > 0) prefixDf++;
                }
                var exactDf = collected.GetValueOrDefault(SearchTermKey.From(prefix))?.Frequency ?? 0;
                if (prefixDf > 0)
                    shortTerms.Add((prefix, InverseFrequency(Math.Min(_documents.Length, exactDf + prefixDf))));
            }
        }
        if (terms.Length == 0 && shortTerms.Count == 0) return new([], 0);

        var candidates = window == 0 ? null : new PriorityQueue<Article, SearchRank>(window);
        var total = 0;
        var scoresBuffer = ArrayPool<double>.Shared.Rent(WideBlockDocuments);
        try
        {
            foreach (var block in wide.Blocks)
            {
                ct.ThrowIfCancellationRequested();
                var scores = scoresBuffer.AsSpan(0, block.Count);
                scores.Clear();
                foreach (var (term, idf) in terms)
                {
                    if (term.Weights is { } weights)
                    {
                        for (var ordinal = 0; ordinal < block.Count; ordinal++)
                        {
                            var weight = weights[block.First + ordinal];
                            if (weight != 0)
                                scores[ordinal] += Score(weight, _documents[block.First + ordinal].Normalization, idf);
                        }
                        continue;
                    }

                    var link = term.DirectLink;
                    foreach (var posting in new WidePostings(block, (uint)(link / 2), ct))
                        scores[posting.Ordinal] += Score(link % 2 == 0 ? posting.Weight : posting.AliasWeight,
                            _documents[block.First + posting.Ordinal].Normalization, idf);
                }
                foreach (var (prefix, idf) in shortTerms)
                {
                    for (var ordinal = 0; ordinal < block.Count; ordinal++)
                    {
                        if ((ordinal & 1023) == 0) ct.ThrowIfCancellationRequested();
                        var weight = ShortPrefixWeight(_documents[block.First + ordinal].Article, prefix);
                        if (weight != 0)
                            scores[ordinal] += Score(weight, _documents[block.First + ordinal].Normalization, idf);
                    }
                }
                Select(scores, block.First, candidates, sort, window, ref total, ct);
            }
        }
        finally { ArrayPool<double>.Shared.Return(scoresBuffer); }
        return new(Ordered(candidates, start), total);
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

    private readonly record struct WidePosting(int Ordinal, int Weight, int AliasWeight);

    private struct WidePostings
    {
        private readonly byte[] _bytes;
        private readonly CancellationToken _ct;
        private readonly int _count;
        private int _offset, _ordinal, _index;

        internal WidePostings(WideBlock block, uint source, CancellationToken ct)
        {
            var term = FindWideTerm(block.Terms, source);
            (_bytes, _ct, _count, _offset, _ordinal) = (block.Postings, ct, term.Count, term.Start, block.Count);
        }

        public readonly WidePostings GetEnumerator() => this;
        public WidePosting Current { readonly get; private set; }

        public bool MoveNext()
        {
            if (_index == _count) return false;
            if ((_index++ & 1023) == 0) _ct.ThrowIfCancellationRequested();
            var delta = ReadVarint(_bytes, ref _offset);
            _ordinal -= delta / 2;
            var weight = ReadVarint(_bytes, ref _offset);
            var adjustment = delta % 2 == 0 ? 0 : ReadVarint(_bytes, ref _offset);
            Current = new WidePosting(_ordinal, weight, (weight - adjustment) / 2);
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
