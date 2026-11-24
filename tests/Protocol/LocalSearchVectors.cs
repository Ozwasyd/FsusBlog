internal static class LocalSearchVectors
{
    internal static void Run(string fixtures)
    {
        var date = DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_002_345);
        var article = new Article(42, 9_007_199_254_740_993, 9_007_199_254_741_001, 4, 2,
            "Title", "ＮＥＥＤＬＥ 雪 needle", date, date, date, "note", new(7, "Lab"), [new(11, "雪")]);
        var first = LocalSearchCorpus.Build([article]);
        Require(first is { Count: 1 }, "Local search did not produce one complete FSPK page");
        CheckHex(fixtures, "search-fspk-v4.hex", first![0], "FSPK writer differs from independent corpus");

        var tokenArticle = article with { Title = "A aB ABc ＡＢＣＤ abcDE ABCDEFGHI é 雪 𠀀 29", Body = "", Summary = null, Category = null, Tags = [] };
        var tokenShard = LocalSearchCorpus.Build([tokenArticle])![0].AsSpan(WireLayouts.SearchPackagePayloadOffset);
        uint[] hashes = [0x10110787, 0x20617ba6, 0x3c2569b2, 0x3ff6e96a, 0x421406f0,
            0x43ed676a, 0x49ddccc4, 0x4f31114c, 0x57f73152, 0x6181c085, 0x883c9b06, 0x88cf0092, 0x9bbfd75f, 0xb3dd93fa, 0xe89b9af6];
        Require(ReadTermHashes(tokenShard).SequenceEqual(hashes), "FSPK token hashes differ from independent Murmur3 vectors");

        var asciiShard = LocalSearchCorpus.Build([tokenArticle with { Title = "FsusBlog FsusUI PostgreSQL" }])![0].AsSpan(WireLayouts.SearchPackagePayloadOffset);
        Require(BinaryPrimitives.ReadInt32LittleEndian(asciiShard[(BinaryPrimitives.ReadInt32LittleEndian(asciiShard[40..]) + 20)..]) == 3,
            "FSPK ASCII subwords must not inflate document length");
        var asciiHashes = ReadTermHashes(asciiShard).ToHashSet();
        foreach (var expectedHash in (uint[])[0x0c2f3a3b, 0xfea39fc2, 0xb291ae90, 0x97e96e58, 0x95dd7f4c, 0x579fce26, 0x25e32459, 0x3fa414a9])
            Require(asciiHashes.Contains(expectedHash), $"FSPK missed expected ASCII prefix/subword hash 0x{expectedHash:x8}");

        var dictionaryArticle = tokenArticle with { Title = "ABC", Body = "博客搜索的公开页" };
        CheckHex(fixtures, "search-cjk-v4.hex", LocalSearchCorpus.Build([dictionaryArticle])![0], "FSPK dictionary mismatch");

        VerifyLongCjkPostings(dictionaryArticle);

        var articlePage = Enumerable.Range(1, WireLimits.SearchIndexPageSize + 1).Select(id => article with { Id = id }).ToArray();
        var split = LocalSearchCorpus.Build(articlePage);
        Require(split is { Count: 2 }, "Local search did not split its bounded corpus pages");
        Equal(LocalSearchCorpus.Build([articlePage[^1]])![0], split![1], "A short FSPK page retained bytes from the preceding full page");

        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Reject<OperationCanceledException>(() => LocalSearchCorpus.Build(articlePage, cancelled.Token), "Local search did not observe cancellation");
    }

    private static uint[] ReadTermHashes(ReadOnlySpan<byte> shard)
    {
        var count = BinaryPrimitives.ReadInt32LittleEndian(shard[16..]);
        var offset = BinaryPrimitives.ReadInt32LittleEndian(shard[36..]);
        var hashes = new uint[count];
        for (var i = 0; i < count; i++) hashes[i] = BinaryPrimitives.ReadUInt32LittleEndian(shard[(offset + i * WireLayouts.SearchTermRecordSize)..]);
        return hashes;
    }

    private static void VerifyLongCjkPostings(Article article)
    {
        Article[] articles = [
            article with { Id = 42, Body = "博客" + new string('雪', 4094) },
            article with { Id = 43, Body = "博客" + new string('雪', 4095) },
            article with { Id = 44, Body = new string('雪', 4095) + "博客" },
            article with { Id = 45, Body = "博雪客" + new string('雪', 4094) },
        ];
        var pages = LocalSearchCorpus.Build(articles);
        Require(pages is { Count: 1 }, "The CJK boundary articles did not fit one FSPK page");

        var shard = pages![0].AsSpan(WireLayouts.SearchPackagePayloadOffset);
        Require(BinaryPrimitives.ReadInt32LittleEndian(shard[20..]) == articles.Length, "FSPK lost a CJK boundary article");
        var documentOffset = BinaryPrimitives.ReadInt32LittleEndian(shard[40..]);
        int[] lengths = [4097, 4098, 4098, 4098];
        for (var i = 0; i < articles.Length; i++)
        {
            var row = shard[(documentOffset + i * WireLayouts.SearchDocumentRecordSize)..];
            Require(BinaryPrimitives.ReadInt32LittleEndian(row) == articles[i].Id && BinaryPrimitives.ReadInt32LittleEndian(row[20..]) == lengths[i],
                "FSPK changed the document length at the CJK boundary");
        }

        ReadOnlySpan<byte> expected = [3, 42, 0, 0, 1, 1, 0, 2, 4, 1, 0, 0, 1, 1, 0, 2, 4, 1, 0, 0, 1, 1, 0xff, 0x1f, 2, 4];
        var termCount = BinaryPrimitives.ReadInt32LittleEndian(shard[16..]);
        var termOffset = BinaryPrimitives.ReadInt32LittleEndian(shard[36..]);
        var postingOffset = BinaryPrimitives.ReadInt32LittleEndian(shard[60..]);
        for (var i = 0; i < termCount; i++)
        {
            var term = shard[(termOffset + i * WireLayouts.SearchTermRecordSize)..];
            if (BinaryPrimitives.ReadUInt32LittleEndian(term) != 0xfa0b7541u) continue;
            var start = postingOffset + BinaryPrimitives.ReadInt32LittleEndian(term[8..]);
            var size = BinaryPrimitives.ReadInt32LittleEndian(term[12..]);
            Require(BinaryPrimitives.ReadInt32LittleEndian(term[16..]) == 1 && shard.Slice(start, size).SequenceEqual(expected),
                "FSPK dictionary postings differ at the long CJK boundary");
            return;
        }
        throw new InvalidOperationException("FSPK lost the dictionary term at the long CJK boundary");
    }
}
