using System.Buffers.Binary;
using FsusBlog.V2.Contracts;

internal static class LocalSearchVectors
{
    internal static void Run(string fixtures)
    {
        var date = DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_002_345);
        var article = new Article(42, 9_007_199_254_740_993, 9_007_199_254_741_001, 4, 2,
            "Title", "ＮＥＥＤＬＥ 雪 needle", date, date, date, "note", new(7, "Lab"), [new(11, "雪")]);
        var first = LocalSearchCorpus.Build([article]);
        if (first is not { Count: 1 })
            throw new InvalidOperationException("Local search did not produce one complete FSPK page");

        var expected = Convert.FromHexString(File.ReadAllText(Path.Combine(fixtures, "search-fspk-v4.hex")).Trim());
        if (!first[0].AsSpan().SequenceEqual(expected))
            throw new InvalidOperationException("FSPK writer differs from the independently constructed search corpus");

        // Independent Murmur3 vectors include every tail width, NFKC and four-byte UTF-8.
        var tokenArticle = article with { Title = "A aB ABc ＡＢＣＤ abcDE ABCDEFGHI é 雪 𠀀 29",
            Body = "", Summary = null, Category = null, Tags = [] };
        var tokenShard = LocalSearchCorpus.Build([tokenArticle])![0].AsSpan(WireLayouts.SearchPackagePayloadOffset);
        uint[] hashes = [0x10110787, 0x3c2569b2, 0x3ff6e96a, 0x421406f0, 0x43ed676a,
            0x57f73152, 0x88cf0092, 0x9bbfd75f, 0xb3dd93fa, 0xe89b9af6];
        var termCount = BinaryPrimitives.ReadInt32LittleEndian(tokenShard[16..]);
        var termOffset = BinaryPrimitives.ReadInt32LittleEndian(tokenShard[36..]);
        if (termCount != hashes.Length) throw new InvalidOperationException("FSPK tokenizer produced an unexpected term count");
        for (var i = 0; i < hashes.Length; i++)
            if (BinaryPrimitives.ReadUInt32LittleEndian(tokenShard[(termOffset + i * WireLayouts.SearchTermRecordSize)..]) != hashes[i])
                throw new InvalidOperationException("FSPK token hash differs from independent Murmur3 vectors");

        var articlePage = Enumerable.Range(1, WireLimits.SearchIndexPageSize + 1)
            .Select(id => article with { Id = id }).ToArray();
        var split = LocalSearchCorpus.Build(articlePage);
        if (split is not { Count: 2 })
            throw new InvalidOperationException("Local search did not split its bounded corpus pages");
        var last = LocalSearchCorpus.Build([articlePage[^1]])![0];
        if (!split[1].AsSpan().SequenceEqual(last))
            throw new InvalidOperationException("A short FSPK page retained bytes from the preceding full page");

        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        try
        {
            LocalSearchCorpus.Build(articlePage, cancelled.Token);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        throw new InvalidOperationException("Local search did not observe cancellation");
    }
}
