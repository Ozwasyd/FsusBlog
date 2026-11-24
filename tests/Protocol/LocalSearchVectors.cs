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

        VectorFixture.Equal(VectorFixture.Hex(fixtures, "search-fspk-v4.hex"), first[0],
            "FSPK writer differs from the independently constructed search corpus");

        // Independent Murmur3 vectors include every tail width, NFKC, four-byte UTF-8, and ASCII prefix/camelCase subwords.
        var tokenArticle = article with { Title = "A aB ABc ＡＢＣＤ abcDE ABCDEFGHI é 雪 𠀀 29",
            Body = "", Summary = null, Category = null, Tags = [] };
        var tokenShard = LocalSearchCorpus.Build([tokenArticle])![0].AsSpan(WireLayouts.SearchPackagePayloadOffset);
        uint[] hashes = [0x10110787, 0x20617ba6, 0x3c2569b2, 0x3ff6e96a, 0x421406f0,
            0x43ed676a, 0x49ddccc4, 0x4f31114c, 0x57f73152, 0x6181c085,
            0x883c9b06, 0x88cf0092, 0x9bbfd75f, 0xb3dd93fa, 0xe89b9af6];
        var termCount = BinaryPrimitives.ReadInt32LittleEndian(tokenShard[16..]);
        var termOffset = BinaryPrimitives.ReadInt32LittleEndian(tokenShard[36..]);
        if (termCount != hashes.Length) throw new InvalidOperationException("FSPK tokenizer produced an unexpected term count");
        for (var i = 0; i < hashes.Length; i++)
            if (BinaryPrimitives.ReadUInt32LittleEndian(tokenShard[(termOffset + i * WireLayouts.SearchTermRecordSize)..]) != hashes[i])
                throw new InvalidOperationException("FSPK token hash differs from independent Murmur3 vectors");

        var asciiSubwordArticle = tokenArticle with { Title = "FsusBlog FsusUI PostgreSQL" };
        var asciiShard = LocalSearchCorpus.Build([asciiSubwordArticle])![0].AsSpan(WireLayouts.SearchPackagePayloadOffset);
        var asciiDocOffset = BinaryPrimitives.ReadInt32LittleEndian(asciiShard[40..]);
        if (BinaryPrimitives.ReadInt32LittleEndian(asciiShard[(asciiDocOffset + 20)..]) != 3)
            throw new InvalidOperationException("FSPK ASCII subwords must not inflate document length");
        var asciiTermCount = BinaryPrimitives.ReadInt32LittleEndian(asciiShard[16..]);
        var asciiTermOffset = BinaryPrimitives.ReadInt32LittleEndian(asciiShard[36..]);
        var asciiHashes = new HashSet<uint>(asciiTermCount);
        for (var i = 0; i < asciiTermCount; i++)
            asciiHashes.Add(BinaryPrimitives.ReadUInt32LittleEndian(asciiShard[(asciiTermOffset + i * WireLayouts.SearchTermRecordSize)..]));
        // fsu, blog, ui, post, sql, fsusblog, fsusui, postgresql
        foreach (var expectedHash in (uint[])[0x0c2f3a3b, 0xfea39fc2, 0xb291ae90, 0x97e96e58, 0x95dd7f4c, 0x579fce26, 0x25e32459, 0x3fa414a9])
            if (!asciiHashes.Contains(expectedHash))
                throw new InvalidOperationException($"FSPK missed expected ASCII prefix/subword hash 0x{expectedHash:x8}");

        var dictionaryArticle = tokenArticle with { Title = "ABC", Body = "博客搜索的公开页" };
        var dictionary = LocalSearchCorpus.Build([dictionaryArticle])![0];
        VectorFixture.Equal(VectorFixture.Hex(fixtures, "search-cjk-v4.hex"), dictionary,
            "FSPK dictionary frequencies or positions differ from the independent fixture");

        VerifyLongCjkPostings(dictionaryArticle);

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

    private static void VerifyLongCjkPostings(Article article)
    {
        Article[] articles =
        [
            article with { Id = 42, Body = "博客" + new string('雪', 4094) },
            article with { Id = 43, Body = "博客" + new string('雪', 4095) },
            article with { Id = 44, Body = new string('雪', 4095) + "博客" },
            article with { Id = 45, Body = "博雪客" + new string('雪', 4094) },
        ];
        var pages = LocalSearchCorpus.Build(articles);
        if (pages is not { Count: 1 })
            throw new InvalidOperationException("The CJK boundary articles did not fit one FSPK page");

        var shard = pages[0].AsSpan(WireLayouts.SearchPackagePayloadOffset);
        if (BinaryPrimitives.ReadInt32LittleEndian(shard[20..]) != articles.Length)
            throw new InvalidOperationException("FSPK lost a CJK boundary article");
        var documentOffset = BinaryPrimitives.ReadInt32LittleEndian(shard[40..]);
        int[] lengths = [4097, 4098, 4098, 4098]; // One ASCII title token plus the body scalars.
        for (var i = 0; i < articles.Length; i++)
        {
            var row = shard[(documentOffset + i * WireLayouts.SearchDocumentRecordSize)..];
            if (BinaryPrimitives.ReadInt32LittleEndian(row) != articles[i].Id ||
                BinaryPrimitives.ReadInt32LittleEndian(row[20..]) != lengths[i])
                throw new InvalidOperationException("FSPK changed the document length at the CJK boundary");
        }

        // Three docs, ID deltas 42/1/1, one body occurrence at offsets 0/0/4095.
        ReadOnlySpan<byte> expected =
        [
            3,
            42, 0, 0, 1, 1, 0, 2, 4,
            1, 0, 0, 1, 1, 0, 2, 4,
            1, 0, 0, 1, 1, 0xff, 0x1f, 2, 4,
        ];
        var termCount = BinaryPrimitives.ReadInt32LittleEndian(shard[16..]);
        var termOffset = BinaryPrimitives.ReadInt32LittleEndian(shard[36..]);
        var postingOffset = BinaryPrimitives.ReadInt32LittleEndian(shard[60..]);
        for (var i = 0; i < termCount; i++)
        {
            var term = shard[(termOffset + i * WireLayouts.SearchTermRecordSize)..];
            if (BinaryPrimitives.ReadUInt32LittleEndian(term) != 0xfa0b7541u) continue; // 博客
            var start = postingOffset + BinaryPrimitives.ReadInt32LittleEndian(term[8..]);
            var size = BinaryPrimitives.ReadInt32LittleEndian(term[12..]);
            if (BinaryPrimitives.ReadInt32LittleEndian(term[16..]) != 1 || !shard.Slice(start, size).SequenceEqual(expected))
                throw new InvalidOperationException("FSPK dictionary postings differ at the long CJK boundary");
            return;
        }
        throw new InvalidOperationException("FSPK lost the dictionary term at the long CJK boundary");
    }
}
