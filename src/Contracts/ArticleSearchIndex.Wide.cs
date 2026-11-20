using System.Buffers;
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

    private static ArticleSearchIndex? BuildWide(IReadOnlyList<Article> articles, CancellationToken ct)
    {
        if (articles.Count > MaxWideDocuments) return null;

        var lengths = new int[articles.Count];
        var blocks = new WideBlock[(articles.Count + WideBlockDocuments - 1) / WideBlockDocuments];
        var builder = new PostingBuilder(MaxWideScannedChars);
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
        return new ArticleSearchIndex(Normalize(articles, lengths, builder.TotalLength, ct), [], [], blocks);
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
            ct.ThrowIfCancellationRequested();
            terms[index++] = new Term(hash, byteCount, bucket.Count);
            var previous = count;
            for (int entry = bucket.Head, i = 0; entry >= 0; entry = builder.Pending[entry].Previous, i++)
            {
                if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
                var posting = builder.Pending[entry].Value;
                byteCount += VarintWidth(previous - posting.Ordinal) + VarintWidth(posting.Weight);
                if (byteCount > availableBytes) return null;
                previous = posting.Ordinal;
            }
        }

        var bytes = new byte[byteCount];
        var offset = 0;
        foreach (var term in terms)
        {
            ct.ThrowIfCancellationRequested();
            var bucket = builder.Heads[term.Hash];
            var previous = count;
            for (int entry = bucket.Head, i = 0; entry >= 0; entry = builder.Pending[entry].Previous, i++)
            {
                if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
                var posting = builder.Pending[entry].Value;
                WriteVarint(bytes, ref offset, previous - posting.Ordinal);
                WriteVarint(bytes, ref offset, posting.Weight);
                previous = posting.Ordinal;
            }
        }
        Array.Sort(terms, Term.ByHash);
        return new WideBlock(first, count, terms, bytes);
    }

    private ArticleSearchPage SearchWide(WideBlock[] blocks, string query, ArticleSearchSort sort, int start, int window,
        CancellationToken ct)
    {
        var hashes = new HashSet<uint>();
        var terms = new List<(uint Hash, double Idf)>();
        foreach (var hash in ArticleSearchTokens.Hashes(query, ct))
        {
            if (!hashes.Add(hash)) continue;
            var frequency = 0;
            foreach (var block in blocks) frequency += FindTerm(block.Terms, hash).Count;
            if (frequency != 0) terms.Add((hash, InverseFrequency(frequency)));
        }
        if (terms.Count == 0) return new([], 0);

        var candidates = window == 0 ? null : new PriorityQueue<Article, SearchRank>(window);
        var total = 0;
        var buffer = ArrayPool<double>.Shared.Rent(WideBlockDocuments);
        try
        {
            foreach (var block in blocks)
            {
                ct.ThrowIfCancellationRequested();
                var scores = buffer.AsSpan(0, block.Count);
                var scored = false;
                foreach (var (hash, idf) in terms)
                {
                    var term = FindTerm(block.Terms, hash);
                    if (term.Count == 0) continue;
                    if (!scored)
                    {
                        scores.Clear();
                        scored = true;
                    }
                    var offset = term.Start;
                    var ordinal = block.Count;
                    for (var i = 0; i < term.Count; i++)
                    {
                        if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
                        ordinal -= ReadVarint(block.Postings, ref offset);
                        var weight = ReadVarint(block.Postings, ref offset);
                        scores[ordinal] += Score(weight, _documents[block.First + ordinal].Normalization, idf);
                    }
                }
                if (scored) Select(scores, block.First, candidates, sort, window, ref total, ct);
            }
        }
        finally
        {
            ArrayPool<double>.Shared.Return(buffer);
        }
        return new(Ordered(candidates, start), total);
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
