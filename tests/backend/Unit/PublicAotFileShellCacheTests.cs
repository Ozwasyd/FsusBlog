using System.Text;
using System.Buffers.Binary;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using StackExchange.Redis;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotFileShellCacheTests
{
    [Fact]
    public void SerializeEntryBytes_RoundTripsEntry()
    {
        string html = string.Concat("<!doctype html><html><body>", new string('a', 4096), "</body></html>");
        PublicAotHtmlArtifact document = PublicAotHtmlArtifactFactory.FromHtml(
            html,
            "renderer-v1",
            "frontend-v1",
            minPrecompressedHtmlBytes: 1);
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
            Value = html,
            Document = document
        };

        byte[] payload = PublicAotFileShellCache.SerializeEntryBytes(entry);
        PublicAotCacheEntry? restored = PublicAotFileShellCache.DeserializeEntryBytes(payload);

        Assert.NotNull(restored);
        Assert.Equal(entry.CacheKey, restored.CacheKey);
        Assert.Equal(entry.RouteKey, restored.RouteKey);
        Assert.Equal(entry.PageId, restored.PageId);
        Assert.Equal(entry.Source, restored.Source);
        Assert.Equal(entry.RendererVersion, restored.RendererVersion);
        Assert.Equal(entry.FrontendAssetVersion, restored.FrontendAssetVersion);
        Assert.Equal(entry.Value, restored.Value);
        Assert.NotNull(restored.Document);
        Assert.Equal(document.ETag, restored.Document.Value.ETag);
        Assert.Equal(document.BrotliETag, restored.Document.Value.BrotliETag);
        Assert.Equal(document.GzipETag, restored.Document.Value.GzipETag);
        Assert.Equal(document.Utf8Bytes.ToArray(), restored.Document.Value.Utf8Bytes.ToArray());
        Assert.Equal(document.BrotliBytes.ToArray(), restored.Document.Value.BrotliBytes.ToArray());
        Assert.Equal(document.GzipBytes.ToArray(), restored.Document.Value.GzipBytes.ToArray());
        Assert.Equal("PACE", Encoding.ASCII.GetString(payload, 0, 4));
        Assert.Equal(2u, BinaryPrimitives.ReadUInt32LittleEndian(payload.AsSpan(4, 4)));
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
    public void DeserializeEntryBytes_UpgradesLegacyStringPayloadInMemory()
    {
        var entry = CreateEntry("public:aot:v2:doc:2:article:42");
        byte[] legacyPayload = PublicAotFileShellCache.SerializeLegacyEntryBytesForTests(entry);

        PublicAotCacheEntry? restored = PublicAotFileShellCache.DeserializeEntryBytes(legacyPayload);

        Assert.NotNull(restored);
        Assert.Equal(entry.Value, restored.Value);
        Assert.NotNull(restored.Document);
        Assert.Equal(Encoding.UTF8.GetBytes(entry.Value), restored.Document.Value.Utf8Bytes.ToArray());
        Assert.False(string.IsNullOrWhiteSpace(restored.Document.Value.ETag));
        Assert.Equal(1u, BinaryPrimitives.ReadUInt32LittleEndian(legacyPayload.AsSpan(4, 4)));
    }

    [Fact]
    public void HtmlArtifactFactory_StoresCompressedVariantsOnlyWhenSmallerAndAboveThreshold()
    {
        string html = string.Concat("<!doctype html><html><body>", new string('z', 4096), "</body></html>");

        PublicAotHtmlArtifact compressed = PublicAotHtmlArtifactFactory.FromHtml(
            html,
            "renderer-v2",
            "frontend-v2",
            minPrecompressedHtmlBytes: 1);
        PublicAotHtmlArtifact tiny = PublicAotHtmlArtifactFactory.FromHtml(
            "<p>tiny</p>",
            "renderer-v2",
            "frontend-v2",
            minPrecompressedHtmlBytes: 1024);

        Assert.False(compressed.BrotliBytes.IsEmpty);
        Assert.False(compressed.GzipBytes.IsEmpty);
        Assert.True(compressed.BrotliBytes.Length < compressed.Utf8Bytes.Length);
        Assert.True(compressed.GzipBytes.Length < compressed.Utf8Bytes.Length);
        Assert.True(tiny.BrotliBytes.IsEmpty);
        Assert.True(tiny.GzipBytes.IsEmpty);
    }

    [Fact]
    public void ToHashForTests_MatchesLegacyUtf8Sha256()
    {
        const string input = "public:aot:v2:doc:2:article:42";

        string actual = PublicAotFileShellCache.ToHashForTests(input);
        string expected = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(input)));

        Assert.Equal(expected, actual);
    }

    [Fact]
    public async Task TryGetEntryAsync_UsesMemoryHitWithoutDiskStat()
    {
        using var temp = new TempDirectory();
        var entry = CreateEntry("public:aot:v2:doc:2:article:42");
        string path = ResolveEntryPath(temp.WebRoot, entry.CacheKey);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllBytesAsync(path, PublicAotFileShellCache.SerializeEntryBytes(entry));

        var cache = BuildCache(temp.Root, Environments.Development);

        PublicAotCacheEntry? fileHit = await cache.TryGetEntryAsync(entry.CacheKey);
        Assert.NotNull(fileHit);
        Assert.Equal(entry.Value, fileHit.Value);

        File.Delete(path);
        PublicAotCacheEntry? memoryHit = await cache.TryGetEntryAsync(entry.CacheKey);

        Assert.NotNull(memoryHit);
        Assert.Equal(entry.Value, memoryHit.Value);
    }

    [Fact]
    public async Task SetAsync_WritesVersionedArtifactPath_AndRemovesLegacyCopy()
    {
        using var temp = new TempDirectory();
        var entry = CreateEntry("public:aot:v2:doc:2:article:42");
        string legacyPath = ResolveEntryPath(temp.WebRoot, entry.CacheKey);
        Directory.CreateDirectory(Path.GetDirectoryName(legacyPath)!);
        await File.WriteAllBytesAsync(legacyPath, PublicAotFileShellCache.SerializeEntryBytes(entry));
        var cache = BuildCache(temp.Root, Environments.Production);

        await cache.SetAsync(entry);
        await Task.Delay(100);

        string versionedPath = PublicAotFileShellCache.ResolveVersionedEntryPathForTests(
            temp.WebRoot,
            entry.CacheKey,
            entry.FrontendAssetVersion,
            entry.PageId);
        Assert.True(File.Exists(versionedPath));
        Assert.False(File.Exists(legacyPath));

        PublicAotCacheEntry? restored = await cache.TryGetEntryAsync(entry.CacheKey, entry.FrontendAssetVersion);
        Assert.NotNull(restored);
        Assert.Equal(entry.Value, restored.Value);
    }

    [Fact]
    public async Task TryGetEntryAsync_ReturnsExpiredCompatibleEntryForSwr()
    {
        using var temp = new TempDirectory();
        var entry = CreateEntry("public:aot:v2:doc:2:article:42") with
        {
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddSeconds(-10)
        };
        string path = PublicAotFileShellCache.ResolveVersionedEntryPathForTests(
            temp.WebRoot,
            entry.CacheKey,
            entry.FrontendAssetVersion,
            entry.PageId);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllBytesAsync(path, PublicAotFileShellCache.SerializeEntryBytes(entry));

        var cache = BuildCache(temp.Root, Environments.Production);

        PublicAotCacheEntry? stale = await cache.TryGetEntryAsync(entry.CacheKey, entry.FrontendAssetVersion);

        Assert.NotNull(stale);
        Assert.True(stale.ExpiresAtUtc <= DateTimeOffset.UtcNow);
        Assert.Equal(entry.Value, stale.Value);
    }

    [Fact]
    public async Task TryGetEntryAsync_HonorsCancellationToken()
    {
        using var temp = new TempDirectory();
        var cache = BuildCache(temp.Root, Environments.Production);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(() => cache.TryGetEntryAsync("public:aot:v2:home", cts.Token));
    }

    [Fact]
    public void Source_UsesTrueAsyncReadAndHotPathMetrics()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src/backend/Infrastructure/PublicAot/PublicAotFileShellCache.cs"));

        Assert.Contains("FileOptions.Asynchronous", source);
        Assert.Contains("ReadAsync", source);
        Assert.DoesNotContain(".GetAwaiter().GetResult()", source);
        Assert.DoesNotContain("stream.Read(", source);
        Assert.Contains("public_aot_cache_memory_hit", source);
        Assert.Contains("public_aot_cache_file_hit", source);
        Assert.Contains("public_aot_cache_miss", source);
        Assert.Contains("public_aot_cache_file_read_ms", source);
        Assert.Contains("public_aot_cache_stale_removed", source);
        Assert.Contains("public_aot_cache_stale_compatible", source);
        Assert.Contains("public_aot_cache_read_error", source);
        Assert.Contains("ResolveVersionedEntryPathForTests", source);
    }

    private static PublicAotCacheEntry CreateEntry(string cacheKey)
        => new()
        {
            CacheKey = cacheKey,
            RouteKey = "article:42",
            PageId = PublicPageId.ArticleDetail,
            Source = PublicAotWriteSource.ServerSsrBackfill,
            GeneratedAtUtc = DateTimeOffset.UtcNow.AddSeconds(-1),
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(30),
            RendererVersion = "renderer-v2",
            FrontendAssetVersion = "frontend-v2",
            Value = "<article>async cache</article>"
        };

    private static PublicAotFileShellCache BuildCache(string root, string environmentName)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());
        return new PublicAotFileShellCache(
            new TestWebHostEnvironment(root, environmentName),
            redis,
            NullLogger<PublicAotFileShellCache>.Instance);
    }

    private static string ResolveEntryPath(string webRoot, string cacheKey)
    {
        string hash = PublicAotFileShellCache.ToHashForTests(cacheKey);
        return Path.Combine(webRoot, "aot-cache", hash[..2], $"{hash}.aeds");
    }

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")) ||
                File.Exists(Path.Combine(current, "src", "backend", "Infrastructure", "PublicAot", "PublicAotFileShellCache.cs")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }

    private sealed class TempDirectory : IDisposable
    {
        public string Root { get; } = Path.Combine(System.IO.Path.GetTempPath(), $"fsus-aot-file-cache-{Guid.NewGuid():N}");
        public string WebRoot => Path.Combine(Root, "wwwroot");

        public TempDirectory()
        {
            Directory.CreateDirectory(WebRoot);
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(Root, recursive: true);
            }
            catch
            {
            }
        }
    }

    private sealed class TestWebHostEnvironment(string root, string environmentName) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.Tests";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = root;
        public string EnvironmentName { get; set; } = environmentName;
    }
}
