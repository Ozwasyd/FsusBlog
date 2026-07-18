using System.Buffers.Binary;
using System.Diagnostics.Metrics;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using StackExchange.Redis;
namespace FsusBlog.Server.Tests;

public sealed class PublicAotFileShellCacheTests
{
    private const string TestReleaseId = "public-aot-cache-tests";

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
            Document = document,
            HydrationSidecar = CreateSidecarReference()
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
        Assert.Equal(entry.HydrationSidecar.Url, restored.HydrationSidecar.Url);
        Assert.Equal(entry.HydrationSidecar.Sha256Hex, restored.HydrationSidecar.Sha256Hex);
        Assert.Equal(entry.HydrationSidecar.RelativePath, restored.HydrationSidecar.RelativePath);
        Assert.Equal("PACE", Encoding.ASCII.GetString(payload, 0, 4));
        Assert.Equal(3u, BinaryPrimitives.ReadUInt32LittleEndian(payload.AsSpan(4, 4)));
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
        Assert.True(restored.HydrationSidecar.IsEmpty);
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
        const string Input = "public:aot:v2:doc:2:article:42";

        string actual = PublicAotFileShellCache.ToHashForTests(Input);
        string expected = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(Input)));

        Assert.Equal(expected, actual);
    }

    [Fact]
    public async Task TryGetEntryAsync_UsesMemoryHitWithoutDiskStat()
    {
        using var temp = new TempDirectory();
        var entry = CreateEntry("public:aot:v2:doc:2:article:42");
        string path = ResolveEntryPath(
            ResolveTestCacheRoot(temp.Root, Environments.Development),
            entry.CacheKey);
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
        string legacyPath = ResolveEntryPath(
            ResolveTestCacheRoot(temp.Root, Environments.Production),
            entry.CacheKey);
        Directory.CreateDirectory(Path.GetDirectoryName(legacyPath)!);
        await File.WriteAllBytesAsync(legacyPath, PublicAotFileShellCache.SerializeEntryBytes(entry));
        var cache = BuildCache(temp.Root, Environments.Production);

        await cache.SetAsync(entry);
        await Task.Delay(100);

        string versionedPath = ResolveVersionedEntryPath(
            ResolveTestCacheRoot(temp.Root, Environments.Production),
            entry);
        Assert.True(File.Exists(versionedPath));
        Assert.False(File.Exists(legacyPath));

        PublicAotCacheEntry? restored = await cache.TryGetEntryAsync(entry.CacheKey, entry.FrontendAssetVersion);
        Assert.NotNull(restored);
        Assert.Equal(entry.Value, restored.Value);
    }

    [Fact]
    public async Task SetAsync_BindsConfiguredMemorySizeLimitAndEvictsWithoutDeletingFileArtifact()
    {
        using var temp = new TempDirectory();
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["PublicAot:MaxMemoryCacheBytes"] = "1",
                ["PublicAot:MaxMemoryCacheEntries"] = "1",
                ["PublicAot:MemoryCacheEntryDeadline"] = "00:01:00"
            })
            .Build();
        PublicAotCacheEntry entry = CreateEntry("public:aot:v2:doc:2:article:bounded");
        var cache = BuildCache(temp.Root, Environments.Development, configuration);

        await cache.SetAsync(entry);

        PublicAotMemoryCacheSnapshot snapshot = cache.MemoryCacheSnapshotForTests;
        Assert.Equal(0, snapshot.EntryCount);
        Assert.Equal(0, snapshot.ResidentBytes);
        Assert.Equal(1, snapshot.CapacityEvictionCount);
        Assert.True(File.Exists(ResolveVersionedEntryPath(
            ResolveTestCacheRoot(temp.Root, Environments.Development),
            entry)));
    }

    [Fact]
    public async Task SetAsync_ReleasePublisherKeepsPerArtifactPointersIndependentAndRetainsHotRollbackGeneration()
    {
        using var temp = new TempDirectory();
        var database = Substitute.For<IDatabase>();
        var subscriber = Substitute.For<ISubscriber>();
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        redis.GetSubscriber(Arg.Any<object?>()).Returns(subscriber);
        database.SetAddAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(true));
        database.SetRemoveAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue[]>(), Arg.Any<CommandFlags>())
            .Returns(call => Task.FromResult((long)call.ArgAt<RedisValue[]>(1).Length));
        subscriber.PublishAsync(Arg.Any<RedisChannel>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(1L));
        var publisher = new ReleaseDerivedArtifactPublisher(
            Path.Combine(temp.Root, "derived"),
            "release-20260712-public-aot");
        var secondPublisher = new ReleaseDerivedArtifactPublisher(
            Path.Combine(temp.Root, "derived"),
            "release-20260712-public-aot");
        var oldInstance = new PublicAotFileShellCache(
            new TestWebHostEnvironment(temp.Root, Environments.Development),
            redis,
            NullLogger<PublicAotFileShellCache>.Instance,
            publisher);
        var newInstance = new PublicAotFileShellCache(
            new TestWebHostEnvironment(temp.Root, Environments.Development),
            redis,
            NullLogger<PublicAotFileShellCache>.Instance,
            secondPublisher);
        PublicAotCacheEntry first = CreateEntry("public:aot:v2:doc:2:article:42");
        PublicAotCacheEntry firstUpdated = first with
        {
            GeneratedAtUtc = first.GeneratedAtUtc.AddSeconds(1),
            Value = "<article>new release-derived document</article>"
        };
        PublicAotCacheEntry second = CreateEntry(
            "public:aot:v2:doc:2:article:43",
            "article:43",
            PublicPageId.ArticleDetail);
        byte[] firstPayload = PublicAotFileShellCache.SerializeEntryBytes(first);
        byte[] firstUpdatedPayload = PublicAotFileShellCache.SerializeEntryBytes(firstUpdated);
        byte[] secondPayload = PublicAotFileShellCache.SerializeEntryBytes(second);

        await Task.WhenAll(oldInstance.SetAsync(first), newInstance.SetAsync(second));
        string cacheRoot = publisher.GetKindRoot("public-aot");
        string firstTargetPath = PublicAotFileShellCache.ResolveVersionedEntryPathInCacheRootForTests(
            cacheRoot,
            first.CacheKey,
            first.FrontendAssetVersion,
            first.PageId);
        string secondTargetPath = PublicAotFileShellCache.ResolveVersionedEntryPathInCacheRootForTests(
            cacheRoot,
            second.CacheKey,
            second.FrontendAssetVersion,
            second.PageId);
        string firstRelativePath = Path.GetRelativePath(cacheRoot, firstTargetPath);
        string secondRelativePath = Path.GetRelativePath(cacheRoot, secondTargetPath);
        string firstGeneration = PublicAotFileShellCache.BuildPublicationGenerationForTests(first.CacheKey, firstPayload);
        string secondGeneration = PublicAotFileShellCache.BuildPublicationGenerationForTests(second.CacheKey, secondPayload);
        string firstPointerPath = publisher.GetArtifactPointerPath("public-aot", firstRelativePath);
        string secondPointerPath = publisher.GetArtifactPointerPath("public-aot", secondRelativePath);
        Assert.Equal(firstPayload, await File.ReadAllBytesAsync(firstTargetPath));
        Assert.Equal(secondPayload, await File.ReadAllBytesAsync(secondTargetPath));
        Assert.Equal(
            firstPayload,
            await File.ReadAllBytesAsync(Path.Combine(
                publisher.GetArtifactGenerationRoot("public-aot", firstRelativePath, firstGeneration),
                firstRelativePath)));
        Assert.Contains(firstGeneration, await File.ReadAllTextAsync(firstPointerPath), StringComparison.Ordinal);
        string secondPointer = await File.ReadAllTextAsync(secondPointerPath);
        Assert.Contains(secondGeneration, secondPointer, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(cacheRoot, "current.json")));

        await newInstance.SetAsync(firstUpdated);
        string firstUpdatedGeneration = PublicAotFileShellCache.BuildPublicationGenerationForTests(
            firstUpdated.CacheKey,
            firstUpdatedPayload);
        Assert.Equal(firstUpdatedPayload, await File.ReadAllBytesAsync(firstTargetPath));
        Assert.Contains(
            firstUpdatedGeneration,
            await File.ReadAllTextAsync(firstPointerPath),
            StringComparison.Ordinal);
        Assert.Equal(secondPointer, await File.ReadAllTextAsync(secondPointerPath));
        Assert.Equal(secondPayload, await File.ReadAllBytesAsync(secondTargetPath));

        await publisher.ReactivateArtifactAsync(
            "public-aot",
            firstRelativePath,
            firstGeneration,
            CancellationToken.None);

        string rollbackPointer = await File.ReadAllTextAsync(firstPointerPath);
        Assert.Equal(firstPayload, await File.ReadAllBytesAsync(firstTargetPath));
        Assert.Contains(firstGeneration, rollbackPointer, StringComparison.Ordinal);
        Assert.DoesNotContain(firstUpdatedGeneration, rollbackPointer, StringComparison.Ordinal);
        Assert.True(Directory.Exists(publisher.GetArtifactGenerationRoot(
            "public-aot",
            firstRelativePath,
            firstUpdatedGeneration)));
        Assert.Equal(secondPointer, await File.ReadAllTextAsync(secondPointerPath));
        Assert.Equal(secondPayload, await File.ReadAllBytesAsync(secondTargetPath));
        Assert.Equal(first.Value, (await oldInstance.TryGetEntryAsync(first.CacheKey, first.FrontendAssetVersion))?.Value);

        await Assert.ThrowsAsync<InvalidOperationException>(() => publisher.PublishArtifactAndProjectAsync(
            "public-aot",
            firstRelativePath,
            firstGeneration,
            new byte[] { 99 }));
        Assert.Equal(firstPayload, await File.ReadAllBytesAsync(firstTargetPath));
        Assert.Equal(rollbackPointer, await File.ReadAllTextAsync(firstPointerPath));
        Assert.Equal(secondPointer, await File.ReadAllTextAsync(secondPointerPath));
        Assert.Equal(secondPayload, await File.ReadAllBytesAsync(secondTargetPath));

        string firstGenerationManifestPath = Path.Combine(
            publisher.GetArtifactGenerationRoot("public-aot", firstRelativePath, firstGeneration),
            "generation-manifest.json");
        ReleaseDerivedArtifactGeneration stored = JsonSerializer.Deserialize<ReleaseDerivedArtifactGeneration>(
            await File.ReadAllBytesAsync(firstGenerationManifestPath))!;
        await File.WriteAllBytesAsync(
            firstGenerationManifestPath,
            JsonSerializer.SerializeToUtf8Bytes(stored with
            {
                ReleaseId = "other-release"
            }));
        await Assert.ThrowsAsync<InvalidOperationException>(() => publisher.ReactivateArtifactAsync(
            "public-aot",
            firstRelativePath,
            firstGeneration));
        Assert.Equal(firstPayload, await File.ReadAllBytesAsync(firstTargetPath));
        Assert.Equal(rollbackPointer, await File.ReadAllTextAsync(firstPointerPath));
        Assert.Equal(secondPointer, await File.ReadAllTextAsync(secondPointerPath));
        Assert.Equal(secondPayload, await File.ReadAllBytesAsync(secondTargetPath));

        await newInstance.RemoveAsync(second.CacheKey);
        Assert.False(File.Exists(secondTargetPath));
        Assert.False(File.Exists(secondPointerPath));
        Assert.True(Directory.Exists(publisher.GetArtifactGenerationRoot(
            "public-aot",
            secondRelativePath,
            secondGeneration)));
        Assert.Equal(firstPayload, await File.ReadAllBytesAsync(firstTargetPath));
        Assert.Equal(rollbackPointer, await File.ReadAllTextAsync(firstPointerPath));
        Assert.Empty(Directory.EnumerateFiles(cacheRoot, "*.tmp", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task TryGetEntryAsync_RemovesExpiredEntryAndReturnsMiss()
    {
        using var temp = new TempDirectory();
        var entry = CreateEntry("public:aot:v2:doc:2:article:42") with
        {
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddSeconds(-10)
        };
        string path = ResolveVersionedEntryPath(
            ResolveTestCacheRoot(temp.Root, Environments.Production),
            entry);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllBytesAsync(path, PublicAotFileShellCache.SerializeEntryBytes(entry));

        var cache = BuildCache(temp.Root, Environments.Production);

        PublicAotCacheEntry? stale = await cache.TryGetEntryAsync(entry.CacheKey, entry.FrontendAssetVersion);

        Assert.Null(stale);
        Assert.False(File.Exists(path));
    }

    [Fact]
    public async Task TryGetEntryAsync_MissingHydrationSidecarTreatsDocumentAsMiss()
    {
        using var temp = new TempDirectory();
        PublicAotHydrationSidecarReference sidecar = CreateSidecarReference();
        var entry = CreateEntry("public:aot:v2:doc:2:article:42") with
        {
            Value = CreateHtmlWithSidecar(sidecar),
            HydrationSidecar = sidecar
        };
        string path = ResolveVersionedEntryPath(
            ResolveTestCacheRoot(temp.Root, Environments.Production),
            entry);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllBytesAsync(path, PublicAotFileShellCache.SerializeEntryBytes(entry));

        var cache = BuildCache(temp.Root, Environments.Production);

        PublicAotCacheEntry? restored = await cache.TryGetEntryAsync(entry.CacheKey, entry.FrontendAssetVersion);

        Assert.Null(restored);
        Assert.False(File.Exists(path));
    }

    [Fact]
    public async Task TryGetEntryAsync_HydrationSidecarHashMismatchTreatsDocumentAsMiss()
    {
        using var temp = new TempDirectory();
        PublicAotHydrationSidecarReference sidecar = CreateSidecarReference([1, 2, 3, 4]);
        var entry = CreateEntry("public:aot:v2:doc:2:article:42") with
        {
            Value = CreateHtmlWithSidecar(sidecar),
            HydrationSidecar = sidecar
        };
        string sidecarPath = Path.Combine(temp.WebRoot, sidecar.RelativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(sidecarPath)!);
        await File.WriteAllBytesAsync(sidecarPath, [9, 9, 9, 9]);
        string path = ResolveVersionedEntryPath(
            ResolveTestCacheRoot(temp.Root, Environments.Production),
            entry);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllBytesAsync(path, PublicAotFileShellCache.SerializeEntryBytes(entry));

        var cache = BuildCache(temp.Root, Environments.Production);

        PublicAotCacheEntry? restored = await cache.TryGetEntryAsync(entry.CacheKey, entry.FrontendAssetVersion);

        Assert.Null(restored);
        Assert.False(File.Exists(path));
        Assert.True(File.Exists(sidecarPath));
    }

    [Fact]
    public async Task TryGetEntryAsync_LegacyBase64UrlHydrationSidecarHash_TreatsDocumentAsMiss()
    {
        using var temp = new TempDirectory();
        byte[] sidecarBytes = [1, 2, 3, 4];
        PublicAotHydrationSidecarReference sidecar = CreateLegacySidecarReference(sidecarBytes);
        var entry = CreateEntry("public:aot:v2:doc:2:article:42") with
        {
            Value = CreateHtmlWithSidecar(sidecar),
            HydrationSidecar = sidecar
        };
        string sidecarPath = Path.Combine(temp.WebRoot, sidecar.RelativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(sidecarPath)!);
        await File.WriteAllBytesAsync(sidecarPath, sidecarBytes);
        string path = ResolveVersionedEntryPath(
            ResolveTestCacheRoot(temp.Root, Environments.Production),
            entry);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllBytesAsync(path, PublicAotFileShellCache.SerializeEntryBytes(entry));

        var cache = BuildCache(temp.Root, Environments.Production);

        PublicAotCacheEntry? restored = await cache.TryGetEntryAsync(entry.CacheKey, entry.FrontendAssetVersion);

        Assert.Null(restored);
        Assert.False(File.Exists(path));
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
    public async Task RemoveAsync_RemovesExactKey_AndPublishesSingleKeyInvalidation()
    {
        using CacheFixture fixture = BuildCacheFixture(Environments.Production);
        var first = CreateEntry("public:aot:v2:doc:2:article:42");
        var second = CreateEntry("public:aot:v2:doc:2:article:43", "article:43", PublicPageId.ArticleDetail);
        await fixture.Cache.SetAsync(first);
        await fixture.Cache.SetAsync(second);

        await fixture.Cache.RemoveAsync(first.CacheKey);

        Assert.False(File.Exists(ResolveVersionedEntryPath(fixture.CacheRoot, first)));
        Assert.True(File.Exists(ResolveVersionedEntryPath(fixture.CacheRoot, second)));
        Assert.Null(await fixture.Cache.TryGetEntryAsync(first.CacheKey, first.FrontendAssetVersion));
        Assert.NotNull(await fixture.Cache.TryGetEntryAsync(second.CacheKey, second.FrontendAssetVersion));
        await fixture.Subscriber.Received(1).PublishAsync(
            Arg.Any<RedisChannel>(),
            Arg.Is<RedisValue>(payload => PayloadContains(payload, "\"type\":\"key\"") && PayloadContains(payload, first.CacheKey)),
            Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task RemoveAsync_RetainsContentHashHydrationSidecarButRemovesHtmlDocument()
    {
        using CacheFixture fixture = BuildCacheFixture(Environments.Production);
        byte[] sidecarBytes = [1, 2, 3, 4];
        PublicAotHydrationSidecarReference sidecar = CreateSidecarReference(sidecarBytes);
        var entry = CreateEntry("public:aot:v2:doc:2:article:42") with
        {
            Value = CreateHtmlWithSidecar(sidecar),
            HydrationSidecar = sidecar
        };
        string sidecarPath = Path.Combine(fixture.Temp.WebRoot, sidecar.RelativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(sidecarPath)!);
        await File.WriteAllBytesAsync(sidecarPath, sidecarBytes);
        await fixture.Cache.SetAsync(entry);

        await fixture.Cache.RemoveAsync(entry.CacheKey);

        Assert.False(File.Exists(ResolveVersionedEntryPath(fixture.CacheRoot, entry)));
        Assert.True(File.Exists(sidecarPath));
        Assert.Null(await fixture.Cache.TryGetEntryAsync(entry.CacheKey, entry.FrontendAssetVersion));
    }

    [Fact]
    public async Task RemoveByPrefixAsync_RemovesRegistryMatches_AndPublishesOneScopedMessage()
    {
        using CacheFixture fixture = BuildCacheFixture(Environments.Production);
        const string Prefix = "public:aot:v2:doc:2:article:";
        var first = CreateEntry("public:aot:v2:doc:2:article:42");
        var second = CreateEntry("public:aot:v2:doc:2:article:43", "article:43", PublicPageId.ArticleDetail);
        var other = CreateEntry("public:aot:v2:doc:5:about", "about", PublicPageId.About);
        await fixture.Cache.SetAsync(first);
        await fixture.Cache.SetAsync(second);
        await fixture.Cache.SetAsync(other);
        ConfigureSetScan(
            fixture.Database,
            PublicAotCacheRegistry.BuildRouteRegistryKey(PublicPageId.ArticleDetail, "article"),
            first.CacheKey,
            second.CacheKey);

        await fixture.Cache.RemoveByPrefixAsync(Prefix);

        Assert.False(File.Exists(ResolveVersionedEntryPath(fixture.CacheRoot, first)));
        Assert.False(File.Exists(ResolveVersionedEntryPath(fixture.CacheRoot, second)));
        Assert.True(File.Exists(ResolveVersionedEntryPath(fixture.CacheRoot, other)));
        await fixture.Subscriber.Received(1).PublishAsync(
            Arg.Any<RedisChannel>(),
            Arg.Is<RedisValue>(payload => PayloadContains(payload, "\"type\":\"prefix\"") && PayloadContains(payload, Prefix)),
            Arg.Any<CommandFlags>());
        await fixture.Database.Received().SetRemoveAsync(
            Arg.Is<RedisKey>(key => key == (RedisKey)PublicAotCacheRegistry.GlobalRegistryKey),
            Arg.Is<RedisValue[]>(values => ContainsAll(values, first.CacheKey, second.CacheKey)),
            Arg.Any<CommandFlags>());
        await fixture.Database.Received().SetRemoveAsync(
            Arg.Is<RedisKey>(key => key == (RedisKey)PublicAotCacheRegistry.BuildPageRegistryKey(PublicPageId.ArticleDetail)),
            Arg.Is<RedisValue[]>(values => ContainsAll(values, first.CacheKey, second.CacheKey)),
            Arg.Any<CommandFlags>());
        await fixture.Database.Received().SetRemoveAsync(
            Arg.Is<RedisKey>(key => key == (RedisKey)PublicAotCacheRegistry.BuildRouteRegistryKey(PublicPageId.ArticleDetail, "article")),
            Arg.Is<RedisValue[]>(values => ContainsAll(values, first.CacheKey, second.CacheKey)),
            Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task ApplyRemoteInvalidationForTests_Prefix_RemovesSiblingLocalArtifactsWithoutPublishing()
    {
        using CacheFixture fixture = BuildCacheFixture(Environments.Production);
        const string Prefix = "public:aot:v2:doc:2:article:";
        var first = CreateEntry("public:aot:v2:doc:2:article:42");
        var second = CreateEntry("public:aot:v2:doc:2:article:43", "article:43", PublicPageId.ArticleDetail);
        var other = CreateEntry("public:aot:v2:doc:5:about", "about", PublicPageId.About);
        await fixture.Cache.SetAsync(first);
        await fixture.Cache.SetAsync(second);
        await fixture.Cache.SetAsync(other);

        PublicAotBatchInvalidationStats stats = fixture.Cache.ApplyRemoteInvalidationForTests(
            PublicAotInvalidationMessage.Prefix(Prefix));

        Assert.Equal(2, stats.InvalidatedKeys);
        Assert.Equal(2, stats.DeletedFiles);
        Assert.False(File.Exists(ResolveVersionedEntryPath(fixture.CacheRoot, first)));
        Assert.False(File.Exists(ResolveVersionedEntryPath(fixture.CacheRoot, second)));
        Assert.True(File.Exists(ResolveVersionedEntryPath(fixture.CacheRoot, other)));
        await fixture.Subscriber.DidNotReceive().PublishAsync(
            Arg.Any<RedisChannel>(),
            Arg.Any<RedisValue>(),
            Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task RemoveByPrefixAsync_HonorsCancellationBeforeMutation()
    {
        using CacheFixture fixture = BuildCacheFixture(Environments.Production);
        const string Prefix = "public:aot:v2:doc:2:article:";
        var entry = CreateEntry("public:aot:v2:doc:2:article:42");
        await fixture.Cache.SetAsync(entry);
        ConfigureSetScan(
            fixture.Database,
            PublicAotCacheRegistry.BuildRouteRegistryKey(PublicPageId.ArticleDetail, "article"),
            entry.CacheKey);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(() => fixture.Cache.RemoveByPrefixAsync(Prefix, cts.Token));

        Assert.True(File.Exists(ResolveVersionedEntryPath(fixture.CacheRoot, entry)));
        await fixture.Subscriber.DidNotReceive().PublishAsync(
            Arg.Any<RedisChannel>(),
            Arg.Any<RedisValue>(),
            Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task InvalidateAllAsync_RecordsRegistryCleanupFailure_WhenRedisDeleteFails()
    {
        using CacheFixture fixture = BuildCacheFixture(Environments.Production);
        var entry = CreateEntry("public:aot:v2:doc:2:article:42");
        await fixture.Cache.SetAsync(entry);
        fixture.Database.KeyDeleteAsync(Arg.Any<RedisKey[]>(), Arg.Any<CommandFlags>())
            .Returns<Task<long>>(_ => throw new InvalidOperationException("registry delete failed"));

        await fixture.Cache.InvalidateAllAsync();

        PublicAotRecordedInvalidation? invalidation = fixture.Cache.LastInvalidationForTests;
        Assert.NotNull(invalidation);
        Assert.Equal("all", invalidation.Value.Scope);
        Assert.Equal(PublicAotRegistryCleanupResult.FailedStatus, invalidation.Value.Stats.RegistryCleanupStatus);
        Assert.Equal(0, invalidation.Value.Stats.RegistryDeletedKeys);
        Assert.Contains("registry delete failed", invalidation.Value.Stats.RegistryCleanupError, StringComparison.Ordinal);
        Assert.False(File.Exists(ResolveVersionedEntryPath(fixture.CacheRoot, entry)));
        await fixture.Database.Received(1).KeyDeleteAsync(
            Arg.Is<RedisKey[]>(keys => keys.Length > 0 && keys.Contains((RedisKey)PublicAotCacheRegistry.GlobalRegistryKey)),
            Arg.Any<CommandFlags>());
        await fixture.Subscriber.Received(1).PublishAsync(
            Arg.Any<RedisChannel>(),
            Arg.Is<RedisValue>(payload => PayloadContains(payload, "\"type\":\"all\"")),
            Arg.Any<CommandFlags>());
    }

    [Fact]
    public void PublicAotInvalidationMessage_TryParse_AcceptsScopedAndLegacyPayloads()
    {
        Assert.True(PublicAotInvalidationMessage.TryParse(PublicAotInvalidationMessage.Prefix("prefix").ToPayload(), out PublicAotInvalidationMessage scoped));
        Assert.Equal(PublicAotInvalidationMessage.TypePrefix, scoped.Type);
        Assert.Equal("prefix", scoped.Value);

        Assert.True(PublicAotInvalidationMessage.TryParse("all", out PublicAotInvalidationMessage all));
        Assert.Equal(PublicAotInvalidationMessage.TypeAll, all.Type);

        Assert.True(PublicAotInvalidationMessage.TryParse("legacy-key", out PublicAotInvalidationMessage legacy));
        Assert.Equal(PublicAotInvalidationMessage.TypeKey, legacy.Type);
        Assert.Equal("legacy-key", legacy.Value);
    }

    [Fact]
    public async Task Runtime_UsesTrueAsyncReadHotPathDiagnosticsAndBatchedInvalidation()
    {
        MethodInfo readEntry = typeof(PublicAotFileShellCache).GetMethod(
            "TryReadEntryAsync",
            BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException("Public AOT file reader was not found.");
        MethodInfo readMoveNext = AsyncMoveNext(readEntry);
        MethodBase[] readCalls = ReadCalledMethods(readMoveNext).ToArray();
        Assert.Contains(readCalls, static method =>
            method.Name == nameof(Stream.ReadAsync)
            && method.DeclaringType is not null
            && typeof(Stream).IsAssignableFrom(method.DeclaringType));
        Assert.DoesNotContain(readCalls, static method =>
            method.DeclaringType == typeof(Task) && method.Name == nameof(Task.Run));

        string[] diagnostics = ReadStringLiterals(typeof(PublicAotFileShellCache)).ToArray();
        foreach (string token in new[]
        {
            "public_aot_cache_memory_hit",
            "public_aot_cache_file_hit",
            "public_aot_cache_miss",
            "public_aot_cache_file_read_ms {Path} {ElapsedMs}",
            "public_aot_cache_stale_removed",
            "public_aot_cache_sidecar_missing",
            "public_aot_cache_sidecar_hash_mismatch {CacheKey} {RouteKey} {SidecarUrl}",
            "public_aot_cache_read_error {Path}"
        })
        {
            Assert.Contains(token, diagnostics);
        }
        Assert.DoesNotContain(diagnostics, static token => token.Contains("public_aot_cache_stale_compatible", StringComparison.Ordinal));
        Assert.NotNull(typeof(PublicAotFileShellCache).GetMethod("ResolveVersionedEntryPathForTests", BindingFlags.NonPublic | BindingFlags.Static));
        Assert.NotNull(typeof(PublicAotFileShellCache).GetMethod("RemoveRegisteredKeysBatchAsync", BindingFlags.NonPublic | BindingFlags.Instance));
        Assert.NotNull(typeof(PublicAotFileShellCache).GetMethod("ApplyRemoteInvalidation", BindingFlags.NonPublic | BindingFlags.Instance));
        Assert.NotNull(typeof(PublicAotBatchInvalidationStats).GetProperty(nameof(PublicAotBatchInvalidationStats.RegistryCleanupStatus)));
        Assert.NotNull(typeof(PublicAotBatchInvalidationStats).GetProperty(nameof(PublicAotBatchInvalidationStats.RegistryDeletedKeys)));

        var measurements = new HashSet<string>(StringComparer.Ordinal);
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (instrument.Name.StartsWith("public_aot_", StringComparison.Ordinal))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.SetMeasurementEventCallback<double>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.Start();
        using CacheFixture fixture = BuildCacheFixture(Environments.Development);
        PublicAotCacheEntry entry = CreateEntry("public:aot:v2:runtime-metrics");
        await fixture.Cache.SetAsync(entry);
        await fixture.Cache.RemoveManyAsync([entry.CacheKey]);
        await fixture.Cache.InvalidateAllAsync();

        foreach (string metric in new[]
        {
            "public_aot_invalidation_scope",
            "public_aot_invalidated_keys",
            "public_aot_deleted_files",
            "public_aot_registry_removed_members",
            "public_aot_registry_cleanup_count",
            "public_aot_registry_deleted_keys",
            "public_aot_publish_count",
            "public_aot_invalidation_duration_ms"
        })
        {
            Assert.Contains(metric, measurements);
        }

        MethodInfo redisRemoveMany = typeof(PublicAotShellCache).GetMethod(nameof(IPublicAotShellCache.RemoveManyAsync))!;
        MethodBase[] redisCalls = ReadCalledMethods(AsyncMoveNext(redisRemoveMany)).ToArray();
        Assert.DoesNotContain(redisCalls, static method =>
            method.DeclaringType == typeof(PublicAotShellCache) && method.Name == nameof(IPublicAotShellCache.RemoveAsync));
    }

    private static MethodInfo AsyncMoveNext(MethodInfo method)
    {
        AsyncStateMachineAttribute stateMachine = method.GetCustomAttribute<AsyncStateMachineAttribute>()
            ?? throw new InvalidOperationException($"Async state machine missing: {method.DeclaringType?.Name}.{method.Name}");
        return stateMachine.StateMachineType.GetMethod("MoveNext", BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance)!;
    }

    private static IEnumerable<MethodBase> ReadCalledMethods(MethodInfo method)
    {
        byte[] il = method.GetMethodBody()?.GetILAsByteArray() ?? [];
        for (int offset = 0; offset <= il.Length - 5; offset++)
        {
            if (il[offset] is not (0x28 or 0x6F))
                continue;
            MethodBase? called = null;
            try
            {
                called = method.Module.ResolveMethod(
                    BitConverter.ToInt32(il, offset + 1),
                    method.DeclaringType?.GetGenericArguments(),
                    method.GetGenericArguments());
            }
            catch (ArgumentException)
            {
            }
            if (called is not null)
                yield return called;
        }
    }

    private static IEnumerable<string> ReadStringLiterals(Type type)
    {
        foreach (MethodInfo method in type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance))
        {
            MethodInfo runtimeMethod = method.GetCustomAttribute<AsyncStateMachineAttribute>() is { } stateMachine
                ? stateMachine.StateMachineType.GetMethod("MoveNext", BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance)!
                : method;
            byte[] il = runtimeMethod.GetMethodBody()?.GetILAsByteArray() ?? [];
            for (int offset = 0; offset <= il.Length - 5; offset++)
            {
                if (il[offset] != 0x72)
                    continue;
                string? literal = null;
                try
                {
                    literal = runtimeMethod.Module.ResolveString(BitConverter.ToInt32(il, offset + 1));
                }
                catch (ArgumentException)
                {
                }
                if (literal is not null)
                    yield return literal;
            }
        }
    }

    private static PublicAotCacheEntry CreateEntry(string cacheKey)
        => CreateEntry(cacheKey, "article:42", PublicPageId.ArticleDetail);

    private static PublicAotCacheEntry CreateEntry(string cacheKey, string routeKey, PublicPageId pageId)
        => new()
        {
            CacheKey = cacheKey,
            RouteKey = routeKey,
            PageId = pageId,
            Source = PublicAotWriteSource.ServerSsrBackfill,
            GeneratedAtUtc = DateTimeOffset.UtcNow.AddSeconds(-1),
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(30),
            RendererVersion = "renderer-v2",
            FrontendAssetVersion = "frontend-v2",
            Value = "<article>async cache</article>"
        };

    private static PublicAotHydrationSidecarReference CreateSidecarReference(byte[]? bytes = null)
    {
        string hash = Convert.ToHexStringLower(SHA256.HashData(bytes ?? [1, 2, 3, 4]));
        return new(
            $"/aot-cache/payloads/{hash[..2]}/{hash}.aeds",
            hash,
            $"aot-cache/payloads/{hash[..2]}/{hash}.aeds");
    }

    private static PublicAotHydrationSidecarReference CreateLegacySidecarReference(byte[] bytes)
    {
        string base64Url = Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        string hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.ASCII.GetBytes(base64Url)));
        return new(
            $"/aot-cache/payloads/{hash[..2]}/{hash}.aeds",
            hash,
            $"aot-cache/payloads/{hash[..2]}/{hash}.aeds");
    }

    private static string CreateHtmlWithSidecar(PublicAotHydrationSidecarReference sidecar)
        => $"""
<!doctype html>
<html>
<body>
<div id="fsus-aot-shell" data-public-hydration-kind="ArticleDetail"></div>
<script id="fsus-aot-hydration-props" type="application/octet-stream" data-aeds-src="{sidecar.Url}"></script>
</body>
</html>
""";

    private static PublicAotFileShellCache BuildCache(
        string root,
        string environmentName,
        IConfiguration? configuration = null)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());
        return new PublicAotFileShellCache(
            new TestWebHostEnvironment(root, environmentName),
            redis,
            NullLogger<PublicAotFileShellCache>.Instance,
            CreateDerivedPublisher(root, environmentName),
            configuration);
    }

    private static CacheFixture BuildCacheFixture(string environmentName)
        => new(environmentName);

    private static void ConfigureSetScan(IDatabase database, string registryKey, params string[] cacheKeys)
    {
        database.SetScan(
                Arg.Is<RedisKey>(key => key == (RedisKey)registryKey),
                Arg.Any<RedisValue>(),
                Arg.Any<int>(),
                Arg.Any<long>(),
                Arg.Any<int>(),
                Arg.Any<CommandFlags>())
            .Returns([.. cacheKeys.Select(static key => (RedisValue)key)]);
    }

    private static string ResolveEntryPath(string cacheRoot, string cacheKey)
    {
        string hash = PublicAotFileShellCache.ToHashForTests(cacheKey);
        return Path.Combine(cacheRoot, hash[..2], $"{hash}.aeds");
    }

    private static string ResolveVersionedEntryPath(string cacheRoot, PublicAotCacheEntry entry)
        => PublicAotFileShellCache.ResolveVersionedEntryPathInCacheRootForTests(
            cacheRoot,
            entry.CacheKey,
            entry.FrontendAssetVersion,
            entry.PageId);

    private static string ResolveTestCacheRoot(string root, string environmentName)
        => string.Equals(environmentName, Environments.Production, StringComparison.Ordinal)
            ? ReleaseStorageLayout.BuildReleaseDerivedPath(
                Path.Combine(root, "release-derived"),
                TestReleaseId,
                "public-aot")
            : Path.Combine(root, "wwwroot", "aot-cache");

    private static ReleaseDerivedArtifactPublisher? CreateDerivedPublisher(
        string root,
        string environmentName)
        => string.Equals(environmentName, Environments.Production, StringComparison.Ordinal)
            ? new ReleaseDerivedArtifactPublisher(Path.Combine(root, "release-derived"), TestReleaseId)
            : null;

    private static bool PayloadContains(RedisValue payload, string expected)
        => payload.ToString().Contains(expected, StringComparison.Ordinal);

    private static bool ContainsAll(RedisValue[] values, params string[] expected)
    {
        HashSet<string> actual = values.Select(static value => value.ToString()).ToHashSet(StringComparer.Ordinal);
        return expected.All(actual.Contains);
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

    private sealed class CacheFixture : IDisposable
    {
        public TempDirectory Temp { get; } = new();
        public IDatabase Database { get; } = Substitute.For<IDatabase>();
        public ISubscriber Subscriber { get; } = Substitute.For<ISubscriber>();
        public PublicAotFileShellCache Cache
        {
            get;
        }
        public string CacheRoot
        {
            get;
        }

        public CacheFixture(string environmentName)
        {
            var redis = Substitute.For<IConnectionMultiplexer>();
            redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Database);
            redis.GetSubscriber(Arg.Any<object?>()).Returns(Subscriber);
            Database.SetAddAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
                .Returns(Task.FromResult(true));
            Database.SetRemoveAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue[]>(), Arg.Any<CommandFlags>())
                .Returns(call => Task.FromResult((long)call.ArgAt<RedisValue[]>(1).Length));
            Subscriber.PublishAsync(Arg.Any<RedisChannel>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
                .Returns(Task.FromResult(1L));
            CacheRoot = ResolveTestCacheRoot(Temp.Root, environmentName);
            Cache = new PublicAotFileShellCache(
                new TestWebHostEnvironment(Temp.Root, environmentName),
                redis,
                NullLogger<PublicAotFileShellCache>.Instance,
                CreateDerivedPublisher(Temp.Root, environmentName));
        }

        public void Dispose()
        {
            Temp.Dispose();
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
