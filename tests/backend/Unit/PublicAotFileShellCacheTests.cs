using System.Text;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotFileShellCacheTests
{
    [Fact]
    public void SerializeEntryBytes_RoundTripsEntry()
    {
        var entry = new PublicAotCacheEntry
        {
            CacheKey = "public:aot:v2:article:1",
            RouteKey = "article:1",
            PageId = PublicPageId.ArticleDetail,
            Source = PublicAotWriteSource.ServerSsrBackfill,
            GeneratedAtUtc = DateTimeOffset.UtcNow.AddMinutes(-1),
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(10),
            RendererVersion = "renderer-v1",
            FrontendAssetVersion = "frontend-v1",
            Value = "<article>content</article>"
        };

        byte[] payload = PublicAotFileShellCache.SerializeEntryBytes(entry);
        PublicAotCacheEntry? restored = PublicAotFileShellCache.DeserializeEntryBytes(payload);

        Assert.NotNull(restored);
        Assert.Equal(entry, restored);
        Assert.Equal("PACE", Encoding.ASCII.GetString(payload, 0, 4));
    }

    [Fact]
    public void SerializeEntryBytes_PreservesBucketRelevantPageAndRouteData()
    {
        var entry = new PublicAotCacheEntry
        {
            CacheKey = "public:aot:v2:doc:2:article:42",
            RouteKey = "article:42",
            PageId = PublicPageId.ArticleDetail,
            Source = PublicAotWriteSource.ServerSsrBackfill,
            GeneratedAtUtc = DateTimeOffset.UtcNow,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(30),
            RendererVersion = "renderer-v2",
            FrontendAssetVersion = "frontend-v2",
            Value = "<article>bucketed</article>"
        };

        byte[] payload = PublicAotFileShellCache.SerializeEntryBytes(entry);
        PublicAotCacheEntry? restored = PublicAotFileShellCache.DeserializeEntryBytes(payload);

        Assert.NotNull(restored);
        Assert.Equal(PublicPageId.ArticleDetail, restored.PageId);
        Assert.Equal("article:42", restored.RouteKey);
        Assert.Equal("frontend-v2", restored.FrontendAssetVersion);
    }

    [Fact]
    public void DeserializeEntryBytes_RejectsMalformedPayloads()
    {
        var entry = new PublicAotCacheEntry
        {
            CacheKey = "public:aot:v2:home",
            RouteKey = "home",
            PageId = PublicPageId.Home,
            Source = PublicAotWriteSource.ServerSsrBackfill,
            GeneratedAtUtc = DateTimeOffset.UtcNow,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(30),
            RendererVersion = "renderer-v2",
            FrontendAssetVersion = "frontend-v2",
            Value = "<main>home</main>"
        };
        byte[] payload = PublicAotFileShellCache.SerializeEntryBytes(entry);
        byte[] invalidMagic = payload.ToArray();
        invalidMagic[0] = 0;

        Assert.Null(PublicAotFileShellCache.DeserializeEntryBytes(ReadOnlyMemory<byte>.Empty));
        Assert.Null(PublicAotFileShellCache.DeserializeEntryBytes(payload.AsMemory(0, payload.Length - 1)));
        Assert.Null(PublicAotFileShellCache.DeserializeEntryBytes(invalidMagic));
    }

    [Fact]
    public void ToHashForTests_MatchesLegacyUtf8Sha256()
    {
        const string input = "public:aot:v2:doc:2:article:42";

        string actual = PublicAotFileShellCache.ToHashForTests(input);
        string expected = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(input)));

        Assert.Equal(expected, actual);
    }
}
