internal static class PublicArticleVectors
{
    public static void Run(string fixtures)
    {
        ArticleHotVectors.Run(fixtures);
        var article = new Article(
            42, 9_007_199_254_740_993, 9_007_199_254_741_001, 4, 2,
            "雪原 🐈", "第一行\nsecond line\n",
            DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_123),
            DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_001_234),
            DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_002_345),
            "摘要");

        AssertFixture("article-detail-ard5", PublicArticles.EncodeDetail(article));
        AssertFixture("article-list-cursor-v2", PublicArticles.EncodeList([article], 2, "v2_Ab-1"));
        AssertFixture("article-search-fas4", PublicArticles.EncodeSearch([article], 2));

        foreach (var invalid in new[]
        {
            article with { Revision = 0 },
            article with { PublicationNo = 0 },
            article with { Title = "padding\0title" },
            article with { Title = new string('雪', 86) }
        })
            ProtocolRejection.Assert(() => PublicArticles.EncodeDetail(invalid), "Invalid article accepted");

        void AssertFixture(string name, byte[] actual) =>
            VectorFixture.Equal(VectorFixture.Hex(fixtures, name + ".hex"), actual,
                $"Public article frame differs from independent fixture {name}");
    }
}
