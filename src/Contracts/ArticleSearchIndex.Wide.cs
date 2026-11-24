using System.Runtime.CompilerServices;

namespace FsusBlog.V2.Contracts;

public sealed partial class ArticleSearchIndex
{
    private const int WideBlockDocuments = 20_000;
    private const int MaxWideDocuments = 100_000;
    private const int MaxWideBlockPostings = 2_000_000;
    private const int MaxWidePostings = 8_000_000;
    private const long MaxWideScannedChars = 144 * 1024 * 1024;
    private const int MaxWideRetainedBytes = 32 * 1024 * 1024;

    private sealed record WideBlock(int First, int Count, Term[] Terms, byte[] Postings);
    private readonly record struct WideAlias(uint Hash, int Offset);

    private sealed record WideIndex(WideBlock[] Blocks, WideAlias[] Aliases, byte[] Sources)
    {
        internal ReadOnlySpan<byte> SourcesFor(uint hash)
        {
            var start = 0;
            var end = Aliases.Length;
            while (start < end)
            {
                var middle = start + (end - start) / 2;
                if (Aliases[middle].Hash < hash) start = middle + 1;
                else end = middle;
            }
            if (start == Aliases.Length || Aliases[start].Hash != hash) return [];
            var limit = start + 1 == Aliases.Length ? Sources.Length : Aliases[start + 1].Offset;
            return Sources.AsSpan(Aliases[start].Offset, limit - Aliases[start].Offset);
        }
    }

    private sealed class WideSources
    {
        private readonly record struct Source(uint Hash, uint[] Aliases, int Previous);
        private readonly Dictionary<uint, int> _heads = [];
        private readonly List<Source> _sources = [];
        private int _linkCount;

        internal uint? Resolve(uint hash, ReadOnlySpan<uint> aliases)
        {
            var previous = _heads.GetValueOrDefault(hash, -1);
            for (var index = previous; index >= 0; index = _sources[index].Previous)
                if (aliases.SequenceEqual(_sources[index].Aliases)) return (uint)index;

            if (_sources.Count == MaxTerms || _linkCount > MaxWideRetainedBytes - aliases.Length - 1)
                return null;

            var id = _sources.Count;
            _heads[hash] = id;
            _sources.Add(new Source(hash, aliases.ToArray(), previous));
            _linkCount += aliases.Length + 1;
            return (uint)id;
        }

        internal WideIndex? Pack(WideBlock[] blocks, int availableBytes, CancellationToken ct)
        {
            if (_linkCount > availableBytes) return null;
            var references = new Dictionary<uint, List<int>>();
            for (var id = 0; id < _sources.Count; id++)
            {
                ct.ThrowIfCancellationRequested();
                var source = _sources[id];
                Add(source.Hash, id * 2);
                foreach (var hash in source.Aliases) Add(hash, id * 2 + 1);
                if ((long)references.Count * Unsafe.SizeOf<WideAlias>() + _linkCount > availableBytes)
                    return null;
            }

            var byteCount = 0;
            foreach (var links in references.Values) EncodeDeltas(links, [], ref byteCount, ct);
            if ((long)references.Count * Unsafe.SizeOf<WideAlias>() + byteCount > availableBytes) return null;

            var sources = new byte[byteCount];
            var aliases = new WideAlias[references.Count];
            var offset = 0;
            var index = 0;
            foreach (var hash in references.Keys.Order())
            {
                aliases[index++] = new WideAlias(hash, offset);
                EncodeDeltas(references[hash], sources, ref offset, ct);
            }
            return new WideIndex(blocks, aliases, sources);

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

            void Add(uint hash, int link)
            {
                if (!references.TryGetValue(hash, out var links)) references.Add(hash, links = []);
                links.Add(link);
            }
        }
    }

    private static ArticleSearchIndex? BuildWide(IReadOnlyList<Article> articles, CancellationToken ct)
    {
        if (articles.Count > MaxWideDocuments) return null;

        var lengths = new int[articles.Count];
        var blocks = new WideBlock[(articles.Count + WideBlockDocuments - 1) / WideBlockDocuments];
        var sources = new WideSources();
        var builder = new PostingBuilder(MaxWideScannedChars, sources);
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
            remainingBytes -= builder.Heads.Count * Unsafe.SizeOf<Term>();
            var block = PackBlock(builder, first, count, remainingBytes, ct);
            if (block is null) return null;
            remainingBytes -= block.Postings.Length;
            blocks[index] = block;
        }
        var indexData = sources.Pack(blocks, remainingBytes, ct);
        return indexData is null ? null :
            new ArticleSearchIndex(Normalize(articles, lengths, builder.TotalLength, ct), [], [], indexData);
    }

    private static WideBlock? PackBlock(PostingBuilder builder, int first, int count, int availableBytes, CancellationToken ct)
    {
        if (availableBytes < 0) return null;
        var terms = new Term[builder.Heads.Count];
        var byteCount = 0;
        var index = 0;
        // Measure before allocating so the compressed byte budget also bounds the writer's output buffer.
        foreach (var (hash, bucket) in builder.Heads)
        {
            terms[index++] = new Term(hash, byteCount, bucket.Count);
            if (!EncodeBucket(builder, bucket, count, [], ref byteCount, availableBytes, ct)) return null;
        }

        var bytes = new byte[byteCount];
        var offset = 0;
        foreach (var term in terms) EncodeBucket(builder, builder.Heads[term.Hash], count, bytes, ref offset, byteCount, ct);
        Array.Sort(terms, Term.ByHash);
        return new WideBlock(first, count, terms, bytes);

        static bool EncodeBucket(PostingBuilder builder, Bucket bucket, int count, Span<byte> target,
            ref int pos, int limit, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            var previous = count;
            for (int entry = bucket.Head, i = 0; entry >= 0; entry = builder.Pending[entry].Previous, i++)
            {
                if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
                var posting = builder.Pending[entry].Value;
                // Only odd field weights need an adjustment when a source is used as an alias.
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

    private sealed class WideQueryTerm
    {
        internal int Frequency;
        internal int Links;
        internal int DirectLink = -1;
        internal int[]? Weights;
    }

    private readonly record struct WideQueryUse(WideQueryTerm Term, bool Exact, int Previous);

    private Dictionary<uint, WideQueryTerm> CollectWideTerms(WideIndex wide, string query, CancellationToken ct)
    {
        var terms = new Dictionary<uint, WideQueryTerm>();
        var sources = new Dictionary<uint, int>();
        var uses = new List<WideQueryUse>();
        foreach (var hash in ArticleSearchTokens.Hashes(query, ct))
        {
            var term = new WideQueryTerm();
            if (!terms.TryAdd(hash, term)) continue;

            foreach (var link in new WideLinks(wide.SourcesFor(hash)))
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
                foreach (var block in wide.Blocks) first.Term.Frequency += FindTerm(block.Terms, source).Count;
                continue;
            }

            // A source can support more than one query term. Decode it once and merge its per-document weights.
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

    private ArticleSearchPage SearchWide(WideIndex wide, string query, ArticleSearchSort sort, int start, int window,
        CancellationToken ct)
    {
        var collected = CollectWideTerms(wide, query, ct);
        var terms = collected.Values.Where(term => term.Frequency != 0)
            .Select(term => (Value: term, Idf: InverseFrequency(term.Frequency))).ToArray();
        var shortTerms = new List<(string Prefix, double Idf)>();
        if (ArticleSearchTokens.ShortAsciiPrefixes(query) is { Count: > 0 } shortPrefixes)
        {
            foreach (var (prefix, hash) in shortPrefixes)
            {
                var prefixDf = 0;
                for (var ordinal = 0; ordinal < _documents.Length; ordinal++)
                {
                    if ((ordinal & 1023) == 0) ct.ThrowIfCancellationRequested();
                    if (ShortPrefixWeight(_documents[ordinal].Article, prefix) > 0) prefixDf++;
                }
                var exactDf = collected.GetValueOrDefault(hash)?.Frequency ?? 0;
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
        finally
        {
            ArrayPool<double>.Shared.Return(scoresBuffer);
        }
        return new(Ordered(candidates, start), total);
    }

    private static void VisitWideIdentifierCandidates(WideIndex wide, string query, Action<int> match, CancellationToken ct)
    {
        var fewest = int.MaxValue;
        ReadOnlySpan<byte> anchor = [];
        var seen = new HashSet<uint>();
        foreach (var hash in ArticleSearchTokens.Hashes(query, ct))
        {
            if (!seen.Add(hash)) continue;
            var links = wide.SourcesFor(hash);
            if (links.IsEmpty) return;
            // Sum unmerged posting counts to choose an anchor without decoding candidates twice.
            var count = 0;
            foreach (var link in new WideLinks(links))
            {
                ct.ThrowIfCancellationRequested();
                foreach (var block in wide.Blocks) count += FindTerm(block.Terms, (uint)(link / 2)).Count;
            }
            if (count >= fewest) continue;
            fewest = count;
            anchor = links;
        }

        var candidates = new bool[WideBlockDocuments];
        foreach (var block in wide.Blocks)
        {
            ct.ThrowIfCancellationRequested();
            var ordinals = candidates.AsSpan(0, block.Count);
            ordinals.Clear();
            foreach (var link in new WideLinks(anchor))
            {
                ct.ThrowIfCancellationRequested();
                foreach (var posting in new WidePostings(block, (uint)(link / 2), ct))
                    ordinals[posting.Ordinal] = true;
            }
            for (var ordinal = 0; ordinal < ordinals.Length; ordinal++)
                if (ordinals[ordinal]) match(block.First + ordinal);
        }
    }

    private ref struct WideLinks
    {
        private readonly ReadOnlySpan<byte> _bytes;
        private int _offset;
        private int _link;

        internal WideLinks(ReadOnlySpan<byte> bytes) => _bytes = bytes;

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
        private int _offset;
        private int _ordinal;
        private int _index;

        internal WidePostings(WideBlock block, uint source, CancellationToken ct)
        {
            var term = FindTerm(block.Terms, source);
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
        while (value >= 128)
        {
            width++;
            value >>= 7;
        }
        return width;
    }

    private static void WriteVarint(Span<byte> bytes, ref int offset, int value)
    {
        while (value >= 128)
        {
            bytes[offset++] = (byte)((value & 127) | 128);
            value >>= 7;
        }
        bytes[offset++] = (byte)value;
    }

    private static int ReadVarint(ReadOnlySpan<byte> bytes, ref int offset)
    {
        var value = 0;
        var shift = 0;
        while (true)
        {
            var next = bytes[offset++];
            value |= (next & 127) << shift;
            if (next < 128) return value;
            shift += 7;
        }
    }
}
