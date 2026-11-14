using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Content;

public sealed class PublicArticleCacheTests
{
    [Fact]
    public async Task ColdHtmlAndAedsWaitersShareOneEncodingAndHotReadsReuseBytes()
    {
        var now = DateTimeOffset.UtcNow;
        var article = new Article(1, 1, 1, 1, 1, "Cold detail", "## Cold payload", now, now, now);
        var cache = new PublicArticleCache(new Dictionary<int, Article> { [article.Id] = article },
            new WebPages("<title>Fsu's Blog</title><!--fsus-public-content-->"));
        var concurrent = Enumerable.Range(0, 64).Select(_ => cache.Read(article.Id, CancellationToken.None).AsTask());
        var results = await Task.WhenAll(concurrent);

        Assert.NotNull(results[0]);
        foreach (var result in results) Assert.Same(results[0], result);
        Assert.Equal(1, cache.ColdStarts);
        Assert.Same(results[0], await cache.Read(article.Id, CancellationToken.None));
        Assert.Null(await cache.Read(2, CancellationToken.None));
        Assert.Equal(1, cache.ColdStarts);
        Assert.Contains("<h2>Cold payload</h2>", System.Text.Encoding.UTF8.GetString(results[0]!.Html));
        _ = Aeds.Decode(results[0]!.Wire, FrameType.ArticleDetail).Length;
    }
}
