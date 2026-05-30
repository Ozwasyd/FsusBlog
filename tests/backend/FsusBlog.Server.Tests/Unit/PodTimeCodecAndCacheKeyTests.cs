using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Unit tests for PodTimeCodec (DateTime ↔ Unix-ms) and CacheKeyBuilder (deterministic key strings).
/// Both are pure static classes with zero external dependencies.
/// </summary>
public sealed class PodTimeCodecAndCacheKeyTests
{
    // ─── PodTimeCodec ─────────────────────────────────────────────────────

    [Fact]
    public void ToUnixMs_KnownUtcDatetime_ReturnsExpectedMilliseconds()
    {
        // 2024-01-01 00:00:00 UTC → known milliseconds
        var dt = new DateTime(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        long expected = new DateTimeOffset(dt).ToUnixTimeMilliseconds();

        long result = PodTimeCodec.ToUnixMs(dt);

        Assert.Equal(expected, result);
    }

    [Fact]
    public void FromUnixMs_ReturnsUtcDateTime()
    {
        long ms = new DateTimeOffset(new DateTime(2023, 6, 15, 8, 0, 0, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
        DateTime result = PodTimeCodec.FromUnixMs(ms);
        Assert.Equal(DateTimeKind.Utc, result.Kind);
    }

    [Fact]
    public void ToUnixMs_FromUnixMs_RoundTrip()
    {
        var original = new DateTime(2025, 3, 14, 15, 9, 26, DateTimeKind.Utc);
        long ms = PodTimeCodec.ToUnixMs(original);
        DateTime recovered = PodTimeCodec.FromUnixMs(ms);
        Assert.Equal(original, recovered);
    }

    [Fact]
    public void ToUnixMs_EpochZero_ReturnsZero()
    {
        var epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        Assert.Equal(0L, PodTimeCodec.ToUnixMs(epoch));
    }

    [Fact]
    public void FromUnixMs_Zero_ReturnsEpoch()
    {
        DateTime result = PodTimeCodec.FromUnixMs(0);
        Assert.Equal(new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc), result);
    }

    // ─── CacheKeyBuilder ──────────────────────────────────────────────────

    [Fact]
    public void ArticleDetail_ReturnsStableKey()
    {
        string key = CacheKeyBuilder.ArticleDetail(7);
        Assert.Equal("pod:v1:article:detail:7", key);
    }

    [Fact]
    public void ArticleHot_ReturnsStableKey()
    {
        string key = CacheKeyBuilder.ArticleHot(10);
        Assert.Equal("pod:v1:article:hot:10", key);
    }

    [Fact]
    public void ArticleSearch_ReturnsStableKey()
    {
        string key = CacheKeyBuilder.ArticleSearch("dotnet");
        Assert.Equal("pod:v1:article:search:dotnet", key);
    }

    [Fact]
    public void AdminStats_ReturnsStableKey()
    {
        string key = CacheKeyBuilder.AdminStats();
        Assert.Equal("pod:v1:stats:admin", key);
    }

    [Fact]
    public void ArticleList_WithNullFilters_UsesZeroPlaceholders()
    {
        string key = CacheKeyBuilder.ArticleList(1, 10, null, null, false);
        Assert.Contains(":0:0:", key);
    }

    [Fact]
    public void ArticleList_WithFilters_EncodesThem()
    {
        string key = CacheKeyBuilder.ArticleList(2, 20, 3, 5, true);
        // should contain category=3, tag=5, deleted=1
        Assert.Contains(":3:", key);
        Assert.Contains(":5:", key);
        Assert.EndsWith(":1", key);
    }

    [Fact]
    public void ArticleList_DifferentPages_ProduceDifferentKeys()
    {
        string k1 = CacheKeyBuilder.ArticleList(1, 10, null, null, false);
        string k2 = CacheKeyBuilder.ArticleList(2, 10, null, null, false);
        Assert.NotEqual(k1, k2);
    }

    [Fact]
    public void CommentCursor_WithCursor_EncodesIt()
    {
        string key = CacheKeyBuilder.CommentCursor(99, 1234567L, 20);
        Assert.Contains(":99:", key);
        Assert.Contains(":1234567:", key);
        Assert.EndsWith(":20", key);
    }

    [Fact]
    public void CommentCursor_NullCursor_UsesZero()
    {
        string key = CacheKeyBuilder.CommentCursor(10, null, 10);
        Assert.Contains(":0:", key);
    }

    [Fact]
    public void UserCommentCursor_ReturnsStableKey()
    {
        string key = CacheKeyBuilder.UserCommentCursor(5, null, 15);
        Assert.StartsWith("pod:v1:comment:user:5:", key);
    }

    [Fact]
    public void PublicAotShell_ReturnsStableKey()
    {
        string key = CacheKeyBuilder.PublicAotShell(PublicPageId.Home, "index");
        Assert.StartsWith("public:aot:v2:", key);
        Assert.Contains("index", key);
    }

    [Fact]
    public void PublicAotDocument_ReturnsStableKey()
    {
        string key = CacheKeyBuilder.PublicAotDocument(PublicPageId.Home, "doc-key");
        Assert.Contains("doc:", key);
        Assert.Contains("doc-key", key);
    }

    [Fact]
    public void ArticleDetail_DifferentIds_ProduceDifferentKeys()
    {
        Assert.NotEqual(CacheKeyBuilder.ArticleDetail(1), CacheKeyBuilder.ArticleDetail(2));
    }
}
