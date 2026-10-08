using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests;

public sealed class ReleaseStorageLifecycleTests
{
    [Theory]
    [InlineData("20260712000006-abcdef123456/sw.js?build=20260712000006-abcdef123456", true)]
    [InlineData("20260712000006-abcdef123456/sw.js", false)]
    [InlineData("20260712000006-abcdef123456/sw.js?build=20260712000006-aaaaaaaaaaaa", false)]
    [InlineData("20260712000006-abcdef123456/sw.js?build=20260712000006-abcdef123456&build=20260712000006-abcdef123456", false)]
    [InlineData("20260712000006-abcdef123456/sw.js?build=20260712000006-abcdef123456&extra=value", false)]
    [InlineData("20260712000006-abcdef123456/assets/sw.js?build=20260712000006-abcdef123456", false)]
    [InlineData("latest/sw.js?build=latest", false)]
    [InlineData("20260230000006-abcdef123456/sw.js?build=20260230000006-abcdef123456", false)]
    public async Task ReleaseStaticWorker_GrantsRootScopeOnlyForExactCanonicalBuildRequest(string request, bool rootScope)
    {
        string root = CreateTempDirectory();
        try
        {
            string relativeFile = request.Split('?')[0];
            string file = Path.Combine(root, relativeFile);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            await File.WriteAllTextAsync(file, "self.addEventListener('install', () => {});");
            WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
            {
                ContentRootPath = root
            });
            builder.Configuration["AllowedHosts"] = "localhost";
            builder.WebHost.UseTestServer();
            await using WebApplication app = builder.Build();
            app.UseFsusReleaseAssets(root);
            await app.StartAsync();
            using HttpClient client = app.GetTestClient();
            using HttpResponseMessage response = await client.GetAsync($"/release-assets/{request}");
            Assert.Equal(System.Net.HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(rootScope, response.Headers.Contains("Service-Worker-Allowed"));
            if (rootScope)
            {
                Assert.Equal("/", Assert.Single(response.Headers.GetValues("Service-Worker-Allowed")));
            }
            Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
            Assert.Contains("no-store", response.Headers.CacheControl!.ToString(), StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Layout_SeparatesSharedDerivedImmutableAndInstanceState()
    {
        string root = CreateTempDirectory();
        try
        {
            var layout = new ReleaseStorageLayout(
                Path.Combine(root, "shared"),
                Path.Combine(root, "derived"),
                Path.Combine(root, "assets"),
                Path.Combine(root, "instances"),
                "20260711000000-abcdef123456",
                "green",
                "generation-42");
            var siblingInstance = new ReleaseStorageLayout(
                Path.Combine(root, "shared"),
                Path.Combine(root, "derived"),
                Path.Combine(root, "assets"),
                Path.Combine(root, "instances"),
                "20260711000000-abcdef123456",
                "green",
                "generation-43");

            Assert.EndsWith(Path.Combine("shared", "assets", "public"), layout.Paths.PublicAssetRoot, StringComparison.Ordinal);
            Assert.EndsWith(Path.Combine("shared", "assets", "private"), layout.Paths.PrivateAssetRoot, StringComparison.Ordinal);
            Assert.EndsWith(
                Path.Combine("instances", "green", layout.ReleaseId, "generation-42", "upload-sessions"),
                layout.Paths.UploadSessionRoot,
                StringComparison.Ordinal);
            Assert.EndsWith(
                Path.Combine("instances", "green", layout.ReleaseId, "generation-42", "upload-commit"),
                layout.Paths.UploadCommitRoot,
                StringComparison.Ordinal);
            Assert.EndsWith(Path.Combine("shared", "data-protection", "keyring"), layout.Paths.DataProtectionKeyRingRoot, StringComparison.Ordinal);
            Assert.EndsWith(Path.Combine("derived", layout.ReleaseId, "search"), layout.Paths.SearchRoot, StringComparison.Ordinal);
            Assert.EndsWith(Path.Combine("assets", layout.ReleaseId), layout.Paths.ImmutableAssetRoot, StringComparison.Ordinal);
            Assert.EndsWith(
                Path.Combine("instances", "green", layout.ReleaseId, "generation-42", "tmp"),
                layout.Paths.TempRoot,
                StringComparison.Ordinal);
            Assert.Equal(layout.Paths.SearchRoot, siblingInstance.Paths.SearchRoot);
            Assert.Equal(layout.Paths.PublicAssetRoot, siblingInstance.Paths.PublicAssetRoot);
            Assert.Equal(layout.Paths.PrivateAssetRoot, siblingInstance.Paths.PrivateAssetRoot);
            Assert.NotEqual(layout.Paths.UploadSessionRoot, siblingInstance.Paths.UploadSessionRoot);
            Assert.NotEqual(layout.Paths.UploadCommitRoot, siblingInstance.Paths.UploadCommitRoot);
            Assert.NotEqual(layout.Paths.LogRoot, siblingInstance.Paths.LogRoot);
            Assert.NotEqual(layout.Paths.TempRoot, siblingInstance.Paths.TempRoot);
            Assert.NotEqual(layout.Paths.RuntimeSnapshotRoot, siblingInstance.Paths.RuntimeSnapshotRoot);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Layout_CleanupGuardCannotAddressActiveOrSiblingRelease()
    {
        string root = CreateTempDirectory();
        try
        {
            var candidate = new ReleaseStorageLayout(
                Path.Combine(root, "shared"),
                Path.Combine(root, "derived"),
                Path.Combine(root, "assets"),
                Path.Combine(root, "instances"),
                "20260711000001-abcdef123456",
                "green",
                "instance-1");

            candidate.EnsureReleaseDerivedCleanupTarget(candidate.Paths.SearchRoot);
            Assert.Throws<InvalidOperationException>(() => candidate.EnsureReleaseDerivedCleanupTarget(Path.Combine(root, "derived")));
            Assert.Throws<InvalidOperationException>(() => candidate.EnsureReleaseDerivedCleanupTarget(
                Path.Combine(root, "derived", "active-20260710", "search")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ImmutableAssets_AreReleaseAddressedAndConflictsFailClosed()
    {
        string hash = new('a', 64);

        string url = ReleaseStorageLayout.BuildReleaseAssetUrl("20260711000002-abcdef123456", "wasm/aeds_decoder.wasm");
        ReleaseStorageLayout.EnsureAppendOnlyHash(url, hash, $"sha256:{hash}");

        Assert.Equal("/release-assets/20260711000002-abcdef123456/wasm/aeds_decoder.wasm", url);
        Assert.Equal("public,max-age=31536000,immutable", ReleaseStorageLayout.CacheControlFor(immutable: true));
        Assert.Equal("no-store,max-age=0,must-revalidate", ReleaseStorageLayout.CacheControlFor(immutable: false));
        Assert.Equal(
            "20260711000002-abcdef123456",
            ReleaseAssetStaticFileExtensions.ResolveBuildId(new PathString("/release-assets/20260711000002-abcdef123456/assets/app.js")));
        Assert.Equal(
            "unknown",
            ReleaseAssetStaticFileExtensions.ResolveBuildId(new PathString("/release-assets/../active/app.js")));
        Assert.Throws<InvalidOperationException>(() => ReleaseStorageLayout.EnsureAppendOnlyHash(url, hash, new string('b', 64)));
        Assert.Throws<ArgumentException>(() => ReleaseStorageLayout.BuildReleaseAssetUrl("20260711000002-abcdef123456", "../active/index.html"));
    }

    [Fact]
    public async Task DerivedArtifacts_PublishByAtomicGenerationAndRetainRollbackGeneration()
    {
        string root = CreateTempDirectory();
        try
        {
            var layout = new ReleaseStorageLayout(
                Path.Combine(root, "shared"),
                Path.Combine(root, "derived"),
                Path.Combine(root, "assets"),
                Path.Combine(root, "instances"),
                "20260711000003-abcdef123456",
                "green",
                "instance-1");
            var publisher = new ReleaseDerivedArtifactPublisher(layout);

            await publisher.PublishGenerationAsync("search", "search-v1", new Dictionary<string, ReadOnlyMemory<byte>>
            {
                ["index.bin"] = new byte[] { 1, 2, 3 },
                ["shards/core.bin"] = new byte[] { 4, 5, 6 }
            });
            await publisher.PublishGenerationAsync("search", "search-v2", new Dictionary<string, ReadOnlyMemory<byte>>
            {
                ["index.bin"] = new byte[] { 7, 8, 9 },
                ["shards/core.bin"] = new byte[] { 10, 11, 12 }
            });

            Assert.True(Directory.Exists(Path.Combine(layout.Paths.SearchRoot, "generations", "search-v1")));
            Assert.True(Directory.Exists(Path.Combine(layout.Paths.SearchRoot, "generations", "search-v2")));
            string pointer = await File.ReadAllTextAsync(Path.Combine(layout.Paths.SearchRoot, "current.json"));
            Assert.Contains("search-v2", pointer, StringComparison.Ordinal);
            Assert.Empty(Directory.EnumerateDirectories(layout.Paths.SearchRoot, ".staging-*"));

            await Assert.ThrowsAsync<InvalidOperationException>(() => publisher.PublishGenerationAsync(
                "search",
                "search-v2",
                new Dictionary<string, ReadOnlyMemory<byte>> { ["index.bin"] = new byte[] { 99 } }));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task SearchDerivedPublication_KeepsLegacyUrlsAndGenerationPointerConsistentDuringReactivation()
    {
        string root = CreateTempDirectory();
        try
        {
            var publisher = new ReleaseDerivedArtifactPublisher(
                Path.Combine(root, "derived"),
                "20260712000000-abcdef123456");
            var first = new Dictionary<string, ReadOnlyMemory<byte>>(StringComparer.Ordinal)
            {
                ["index.core.v1.bin"] = new byte[] { 1, 2, 3 },
                ["index.bin"] = new byte[] { 4, 5, 6 },
                ["index.manifest.aeds"] = new byte[] { 7, 8, 9 }
            };
            var second = new Dictionary<string, ReadOnlyMemory<byte>>(StringComparer.Ordinal)
            {
                ["index.core.v2.bin"] = new byte[] { 10, 11, 12 },
                ["index.bin"] = new byte[] { 13, 14, 15 },
                ["index.manifest.aeds"] = new byte[] { 16, 17, 18 }
            };

            ReleaseDerivedArtifactGeneration firstGeneration =
                await SearchIndexService.PublishReleaseDerivedArtifactsAsync(publisher, first);
            ReleaseDerivedArtifactGeneration secondGeneration =
                await SearchIndexService.PublishReleaseDerivedArtifactsAsync(publisher, second);

            string searchRoot = publisher.GetKindRoot("search");
            Assert.Equal(
                second["index.manifest.aeds"].ToArray(),
                await File.ReadAllBytesAsync(Path.Combine(searchRoot, "index.manifest.aeds")));
            Assert.Equal(
                second["index.manifest.aeds"].ToArray(),
                await File.ReadAllBytesAsync(Path.Combine(
                    searchRoot,
                    "generations",
                    secondGeneration.Generation,
                    "index.manifest.aeds")));
            Assert.Contains(
                secondGeneration.Generation,
                await File.ReadAllTextAsync(Path.Combine(searchRoot, "current.json")),
                StringComparison.Ordinal);

            await publisher.ReactivateGenerationAsync(
                "search",
                firstGeneration.Generation,
                ["index.manifest.aeds"]);

            Assert.Equal(
                first["index.manifest.aeds"].ToArray(),
                await File.ReadAllBytesAsync(Path.Combine(searchRoot, "index.manifest.aeds")));
            Assert.Equal(
                first["index.manifest.aeds"].ToArray(),
                await File.ReadAllBytesAsync(Path.Combine(
                    searchRoot,
                    "generations",
                    firstGeneration.Generation,
                    "index.manifest.aeds")));
            string reactivatedPointer = await File.ReadAllTextAsync(Path.Combine(searchRoot, "current.json"));
            Assert.Contains(firstGeneration.Generation, reactivatedPointer, StringComparison.Ordinal);
            Assert.DoesNotContain(secondGeneration.Generation, reactivatedPointer, StringComparison.Ordinal);
            Assert.True(Directory.Exists(Path.Combine(searchRoot, "generations", secondGeneration.Generation)));

            var conflictingFirst = first.ToDictionary(static pair => pair.Key, static pair => pair.Value, StringComparer.Ordinal);
            conflictingFirst["index.manifest.aeds"] = new byte[] { 99 };
            await Assert.ThrowsAsync<InvalidOperationException>(() => publisher.PublishGenerationAndProjectAsync(
                "search",
                firstGeneration.Generation,
                conflictingFirst,
                ["index.manifest.aeds"]));

            Assert.Equal(
                first["index.manifest.aeds"].ToArray(),
                await File.ReadAllBytesAsync(Path.Combine(searchRoot, "index.manifest.aeds")));
            Assert.Equal(
                reactivatedPointer,
                await File.ReadAllTextAsync(Path.Combine(searchRoot, "current.json")));
            Assert.Empty(Directory.EnumerateFiles(searchRoot, "*.tmp", SearchOption.AllDirectories));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task DerivedArtifacts_TwoPublisherInstancesSerializeAliasesAndPointerToOneGeneration()
    {
        string root = CreateTempDirectory();
        try
        {
            string derivedRoot = Path.Combine(root, "derived");
            const string ReleaseId = "20260712000001-abcdef123456";
            var firstPublisher = new ReleaseDerivedArtifactPublisher(derivedRoot, ReleaseId);
            var secondPublisher = new ReleaseDerivedArtifactPublisher(derivedRoot, ReleaseId);
            var first = new Dictionary<string, ReadOnlyMemory<byte>>(StringComparer.Ordinal)
            {
                ["index.bin"] = Encoding.UTF8.GetBytes("first-index"),
                ["index.manifest.aeds"] = Encoding.UTF8.GetBytes("first-manifest")
            };
            var second = new Dictionary<string, ReadOnlyMemory<byte>>(StringComparer.Ordinal)
            {
                ["index.bin"] = Encoding.UTF8.GetBytes("second-index"),
                ["index.manifest.aeds"] = Encoding.UTF8.GetBytes("second-manifest")
            };

            await Task.WhenAll(
                firstPublisher.PublishGenerationAndProjectAsync(
                    "search",
                    "concurrent-first",
                    first,
                    ["index.manifest.aeds"]),
                secondPublisher.PublishGenerationAndProjectAsync(
                    "search",
                    "concurrent-second",
                    second,
                    ["index.manifest.aeds"]));

            string searchRoot = firstPublisher.GetKindRoot("search");
            using JsonDocument pointer = JsonDocument.Parse(await File.ReadAllBytesAsync(Path.Combine(searchRoot, "current.json")));
            string currentGeneration = pointer.RootElement.GetProperty("Generation").GetString()!;
            IReadOnlyDictionary<string, ReadOnlyMemory<byte>> expected = currentGeneration switch
            {
                "concurrent-first" => first,
                "concurrent-second" => second,
                _ => throw new InvalidOperationException($"Unexpected current generation: {currentGeneration}")
            };

            Assert.Equal(expected["index.bin"].ToArray(), await File.ReadAllBytesAsync(Path.Combine(searchRoot, "index.bin")));
            Assert.Equal(
                expected["index.manifest.aeds"].ToArray(),
                await File.ReadAllBytesAsync(Path.Combine(searchRoot, "index.manifest.aeds")));
            Assert.Equal(
                expected["index.bin"].ToArray(),
                await File.ReadAllBytesAsync(Path.Combine(searchRoot, "generations", currentGeneration, "index.bin")));
            Assert.Equal(
                expected["index.manifest.aeds"].ToArray(),
                await File.ReadAllBytesAsync(Path.Combine(
                    searchRoot,
                    "generations",
                    currentGeneration,
                    "index.manifest.aeds")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task DerivedArtifacts_RemoveMissingArtifactProjectionIsIdempotentBeforeFirstPublication()
    {
        string root = CreateTempDirectory();
        try
        {
            var publisher = new ReleaseDerivedArtifactPublisher(
                Path.Combine(root, "derived"),
                "20260712000000-abcdef123456");

            bool removed = await publisher.RemoveArtifactProjectionAsync(
                "public-aot",
                "frontend/missing.aeds");

            Assert.False(removed);
            Assert.False(File.Exists(publisher.GetArtifactPointerPath(
                "public-aot",
                "frontend/missing.aeds")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task DerivedArtifacts_PublicationLockTimeoutLeavesAliasesAndPointerUnchanged()
    {
        string root = CreateTempDirectory();
        try
        {
            string derivedRoot = Path.Combine(root, "derived");
            const string ReleaseId = "20260712000002-abcdef123456";
            var publisher = new ReleaseDerivedArtifactPublisher(derivedRoot, ReleaseId);
            var baseline = new Dictionary<string, ReadOnlyMemory<byte>>(StringComparer.Ordinal)
            {
                ["index.bin"] = Encoding.UTF8.GetBytes("baseline-index"),
                ["index.manifest.aeds"] = Encoding.UTF8.GetBytes("baseline-manifest")
            };
            await publisher.PublishGenerationAndProjectAsync(
                "search",
                "baseline",
                baseline,
                ["index.manifest.aeds"]);
            string searchRoot = publisher.GetKindRoot("search");
            byte[] baselineIndex = await File.ReadAllBytesAsync(Path.Combine(searchRoot, "index.bin"));
            byte[] baselineManifest = await File.ReadAllBytesAsync(Path.Combine(searchRoot, "index.manifest.aeds"));
            byte[] baselinePointer = await File.ReadAllBytesAsync(Path.Combine(searchRoot, "current.json"));
            string lockPath = publisher.GetKindPublicationLockPath("search");

            await using (var heldLock = new FileStream(
                             lockPath,
                             FileMode.OpenOrCreate,
                             FileAccess.ReadWrite,
                             FileShare.None))
            {
                var blockedPublisher = new ReleaseDerivedArtifactPublisher(
                    derivedRoot,
                    ReleaseId,
                    TimeSpan.FromMilliseconds(80),
                    TimeSpan.FromMilliseconds(10));
                await Assert.ThrowsAsync<TimeoutException>(() => blockedPublisher.PublishGenerationAndProjectAsync(
                    "search",
                    "blocked",
                    new Dictionary<string, ReadOnlyMemory<byte>>(StringComparer.Ordinal)
                    {
                        ["index.bin"] = Encoding.UTF8.GetBytes("blocked-index"),
                        ["index.manifest.aeds"] = Encoding.UTF8.GetBytes("blocked-manifest")
                    },
                    ["index.manifest.aeds"]));
            }

            Assert.Equal(baselineIndex, await File.ReadAllBytesAsync(Path.Combine(searchRoot, "index.bin")));
            Assert.Equal(baselineManifest, await File.ReadAllBytesAsync(Path.Combine(searchRoot, "index.manifest.aeds")));
            Assert.Equal(baselinePointer, await File.ReadAllBytesAsync(Path.Combine(searchRoot, "current.json")));
            Assert.False(Directory.Exists(Path.Combine(searchRoot, "generations", "blocked")));
            Assert.Empty(Directory.EnumerateDirectories(searchRoot, ".staging-*", SearchOption.TopDirectoryOnly));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task DerivedArtifacts_TamperedReleaseIdentityCannotReactivateOrChangeVisibleState()
    {
        string root = CreateTempDirectory();
        try
        {
            var publisher = new ReleaseDerivedArtifactPublisher(
                Path.Combine(root, "derived"),
                "20260712000003-abcdef123456");
            var first = new Dictionary<string, ReadOnlyMemory<byte>>(StringComparer.Ordinal)
            {
                ["index.bin"] = Encoding.UTF8.GetBytes("first-index"),
                ["index.manifest.aeds"] = Encoding.UTF8.GetBytes("first-manifest")
            };
            var second = new Dictionary<string, ReadOnlyMemory<byte>>(StringComparer.Ordinal)
            {
                ["index.bin"] = Encoding.UTF8.GetBytes("second-index"),
                ["index.manifest.aeds"] = Encoding.UTF8.GetBytes("second-manifest")
            };
            await publisher.PublishGenerationAndProjectAsync("search", "first", first, ["index.manifest.aeds"]);
            await publisher.PublishGenerationAndProjectAsync("search", "second", second, ["index.manifest.aeds"]);
            string searchRoot = publisher.GetKindRoot("search");
            byte[] visibleIndex = await File.ReadAllBytesAsync(Path.Combine(searchRoot, "index.bin"));
            byte[] visibleManifest = await File.ReadAllBytesAsync(Path.Combine(searchRoot, "index.manifest.aeds"));
            byte[] visiblePointer = await File.ReadAllBytesAsync(Path.Combine(searchRoot, "current.json"));
            string storedManifestPath = Path.Combine(searchRoot, "generations", "first", "generation-manifest.json");
            ReleaseDerivedArtifactGeneration stored = JsonSerializer.Deserialize<ReleaseDerivedArtifactGeneration>(
                await File.ReadAllBytesAsync(storedManifestPath))!;
            await File.WriteAllBytesAsync(
                storedManifestPath,
                JsonSerializer.SerializeToUtf8Bytes(stored with
                {
                    ReleaseId = "other-release"
                }));

            await Assert.ThrowsAsync<InvalidOperationException>(() => publisher.ReactivateGenerationAsync(
                "search",
                "first",
                ["index.manifest.aeds"]));

            Assert.Equal(visibleIndex, await File.ReadAllBytesAsync(Path.Combine(searchRoot, "index.bin")));
            Assert.Equal(visibleManifest, await File.ReadAllBytesAsync(Path.Combine(searchRoot, "index.manifest.aeds")));
            Assert.Equal(visiblePointer, await File.ReadAllBytesAsync(Path.Combine(searchRoot, "current.json")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SearchIndex_UsesReleaseScopedRootAndBrowserUrlWhenDerivedRootIsConfigured()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsusblog-derived-search");
        const string ReleaseId = "20260711000004-abcdef123456";

        string searchRoot = SearchIndexService.ResolveReleaseScopedSearchRoot(root, ReleaseId);
        string publicBase = SearchIndexService.ResolveReleaseScopedSearchPublicBase(ReleaseId);

        Assert.Equal(Path.Combine(Path.GetFullPath(root), ReleaseId, "search"), searchRoot);
        Assert.Equal($"/release-derived/{ReleaseId}/search", publicBase);
        Assert.Equal(
            ReleaseId,
            ReleaseDerivedStaticFileExtensions.ResolveReleaseId(
                new PathString($"/release-derived/{ReleaseId}/search/index.manifest.aeds")));
        Assert.Throws<InvalidOperationException>(() => SearchIndexService.ResolveReleaseScopedSearchRoot(root, "../active"));
    }

    [Fact]
    public void PublicAotCache_UsesOnlyItsImmutableReleaseDerivedScopeInProduction()
    {
        string root = CreateTempDirectory();
        try
        {
            const string ReleaseId = "20260711000005-abcdef123456";
            var environment = new TestWebHostEnvironment(root)
            {
                EnvironmentName = "Production"
            };

            string cacheRoot = PublicAotFileShellCache.ResolveCacheRootForTests(
                environment,
                Path.Combine(root, "derived"),
                ReleaseId);

            Assert.Equal(
                Path.Combine(root, "derived", ReleaseId, "public-aot"),
                cacheRoot);
            Assert.Throws<InvalidOperationException>(() => PublicAotFileShellCache.ResolveCacheRootForTests(
                environment,
                Path.Combine(root, "derived"),
                releaseId: null));
            Assert.Throws<InvalidOperationException>(() => PublicAotFileShellCache.ResolveCacheRootForTests(
                environment,
                releaseDerivedRoot: null,
                releaseId: null));
            Assert.Throws<ArgumentException>(() => ReleaseStorageLayout.BuildReleaseDerivedPath(
                Path.Combine(root, "derived"),
                "../active",
                "public-aot"));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void DataProtection_SharedRingSupportsBidirectionalOldAndNewPayloads()
    {
        string root = CreateTempDirectory();
        try
        {
            IDataProtectionProvider oldProvider = DataProtectionProvider.Create(
                new DirectoryInfo(root),
                builder => builder.SetApplicationName(ReleaseStorageLayout.RequiredDataProtectionApplicationName));
            IDataProtector oldProtector = oldProvider.CreateProtector("blue-green-session-v1");
            string oldPayload = oldProtector.Protect("blue-cookie");

            IDataProtectionProvider newProvider = DataProtectionProvider.Create(
                new DirectoryInfo(root),
                builder => builder.SetApplicationName(ReleaseStorageLayout.RequiredDataProtectionApplicationName));
            IDataProtector newProtector = newProvider.CreateProtector("blue-green-session-v1");
            string newPayload = newProtector.Protect("green-cookie");

            Assert.Equal("blue-cookie", newProtector.Unprotect(oldPayload));
            Assert.Equal("green-cookie", oldProtector.Unprotect(newPayload));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void DataProtectionProbe_RequiresSharedFsusBlogContractWithoutLeakingKeys()
    {
        string root = CreateTempDirectory();
        try
        {
            DataProtectionKeyRingProbeResult ready = DataProtectionKeyRingProbe.Inspect(root, "FsusBlog");
            DataProtectionKeyRingProbeResult wrongApplication = DataProtectionKeyRingProbe.Inspect(root, "FsusBlog.Candidate");

            Assert.True(ready.Ready);
            Assert.True(ready.CanRead);
            Assert.True(ready.CanWrite);
            Assert.Empty(Directory.EnumerateFiles(root, ".fsus-probe-*.tmp"));
            Assert.False(wrongApplication.Ready);
            Assert.Contains(wrongApplication.Errors, error => error.Contains("application name", StringComparison.OrdinalIgnoreCase));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task UploadCleanupLease_IsExclusiveAndUsesInstanceRetentionPlan()
    {
        string root = CreateTempDirectory();
        try
        {
            string current = "green-release-instance";
            string stale = "blue-old-instance";
            Directory.CreateDirectory(Path.Combine(root, current));
            Directory.CreateDirectory(Path.Combine(root, stale));
            string currentFile = Path.Combine(root, current, "current.tmp");
            string staleFile = Path.Combine(root, stale, "stale.tmp");
            await File.WriteAllTextAsync(currentFile, "current");
            await File.WriteAllTextAsync(staleFile, "stale");
            File.SetLastWriteTimeUtc(staleFile, DateTime.UtcNow.AddDays(-2));

            UploadCommitTempCleanupLease? first = await UploadCommitTempCleanupLease.TryAcquireAsync(
                root,
                current,
                TimeSpan.FromMinutes(5));
            UploadCommitTempCleanupLease? blocked = await UploadCommitTempCleanupLease.TryAcquireAsync(
                root,
                "other-instance",
                TimeSpan.FromMinutes(5));

            Assert.NotNull(first);
            Assert.Null(blocked);
            IReadOnlyList<UploadCommitTempCleanupCandidate> plan = UploadCommitTempCleanupLease.Plan(
                root,
                current,
                DateTimeOffset.UtcNow.AddHours(-1));
            Assert.Contains(plan, candidate => candidate.Path == currentFile && candidate.Protected && candidate.Reason == "current-instance");
            Assert.Contains(plan, candidate => candidate.Path == staleFile && !candidate.Protected && candidate.Reason == "expired-orphan");
            first!.Execute(current, DateTimeOffset.UtcNow.AddHours(-1), dryRun: false);
            Assert.True(File.Exists(currentFile));
            Assert.False(File.Exists(staleFile));

            await first.DisposeAsync();
            UploadCommitTempCleanupLease? next = await UploadCommitTempCleanupLease.TryAcquireAsync(
                root,
                "other-instance",
                TimeSpan.FromMinutes(5));
            Assert.NotNull(next);
            await next!.DisposeAsync();
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task UploadCleanupLease_AsyncExecutionChecksEveryIrreversibleDelete()
    {
        string root = CreateTempDirectory();
        try
        {
            const string Current = "green-release-instance";
            string staleDirectory = Path.Combine(root, "retired-release-instance");
            string freshDirectory = Path.Combine(root, "blue-live-instance");
            Directory.CreateDirectory(Path.Combine(root, Current));
            Directory.CreateDirectory(staleDirectory);
            Directory.CreateDirectory(freshDirectory);
            string staleFile = Path.Combine(staleDirectory, "stale.tmp");
            string freshFile = Path.Combine(freshDirectory, "fresh.tmp");
            await File.WriteAllTextAsync(staleFile, "stale");
            await File.WriteAllTextAsync(freshFile, "fresh");
            File.SetLastWriteTimeUtc(staleFile, DateTime.UtcNow.AddDays(-2));

            await using UploadCommitTempCleanupLease? lease = await UploadCommitTempCleanupLease.TryAcquireAsync(
                root,
                Current,
                TimeSpan.FromMinutes(5));
            Assert.NotNull(lease);
            var guarded = new List<string>();

            IReadOnlyList<UploadCommitTempCleanupCandidate> plan = await lease!.ExecuteAsync(
                Current,
                DateTimeOffset.UtcNow.AddHours(-1),
                dryRun: false,
                beforeDelete: (candidate, _) =>
                {
                    guarded.Add(candidate.Path);
                    return ValueTask.CompletedTask;
                });

            Assert.Contains(plan, candidate => candidate.Path == staleFile && !candidate.Protected);
            Assert.Contains(plan, candidate => candidate.Path == freshFile && candidate.Protected);
            Assert.Equal([staleFile], guarded);
            Assert.False(File.Exists(staleFile));
            Assert.True(File.Exists(freshFile));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ChunkCompletion_IsIdempotentAndNeverOverwritesDifferentContent()
    {
        string root = CreateTempDirectory();
        try
        {
            var service = CreateFileService(root);
            byte[] payload = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(payload));
            Result<UploadInitDto> init = await service.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "sample.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = payload.Length,
                ChunkSize = payload.Length,
                Sha256 = sha256
            });
            Assert.True(init.IsSuccess);
            Result<UploadPartAckDto> upload = await service.UploadPartAsync(
                init.Value!.UploadId,
                0,
                0,
                CreateFormFile(payload, "chunk"),
                sha256);
            Assert.True(upload.IsSuccess);

            Result<UploadCompleteDto> first = await service.CompleteUploadAsync(init.Value.UploadId, sha256);
            Result<UploadCompleteDto> retry = await CreateFileService(root).CompleteUploadAsync(init.Value.UploadId, sha256);

            Assert.True(first.IsSuccess);
            Assert.True(retry.IsSuccess);
            Assert.Equal(first.Value!.RelativeUrl, retry.Value!.RelativeUrl);
            Assert.Equal(
                payload,
                await File.ReadAllBytesAsync(
                    Path.Combine(
                        ReleaseStorageTestPaths.Create(root).PublicAssetRoot,
                        "illustration",
                        Path.GetFileName(first.Value.RelativeUrl))));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ChunkCompletion_DifferentExistingHashFailsClosedWithoutOverwrite()
    {
        string root = CreateTempDirectory();
        try
        {
            var service = CreateFileService(root);
            byte[] payload = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];
            byte[] existing = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 9, 9, 9, 9];
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(payload));
            Result<UploadInitDto> init = await service.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "sample.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = payload.Length,
                ChunkSize = payload.Length,
                Sha256 = sha256
            });
            Assert.True(init.IsSuccess);
            Result<UploadPartAckDto> upload = await service.UploadPartAsync(
                init.Value!.UploadId,
                0,
                0,
                CreateFormFile(payload, "chunk"),
                sha256);
            Assert.True(upload.IsSuccess);

            string finalPath = Path.Combine(
                ReleaseStorageTestPaths.Create(root).PublicAssetRoot,
                "illustration",
                init.Value.UploadId + ".png");
            Directory.CreateDirectory(Path.GetDirectoryName(finalPath)!);
            await File.WriteAllBytesAsync(finalPath, existing);
            Result<UploadCompleteDto> complete = await service.CompleteUploadAsync(init.Value.UploadId, sha256);

            Assert.False(complete.IsSuccess);
            Assert.Equal(ErrorCode.Conflict, complete.Error.Code);
            Assert.Equal(existing, await File.ReadAllBytesAsync(finalPath));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task SearchDerivedStaticFiles_ServeManifestAndAliasFromCurrentPointerWhenCompatibilityCopyLags()
    {
        string root = CreateTempDirectory();
        try
        {
            const string ReleaseId = "20260712000006-abcdef123456";
            var publisher = new ReleaseDerivedArtifactPublisher(
                Path.Combine(root, "derived"),
                ReleaseId);
            var first = new Dictionary<string, ReadOnlyMemory<byte>>(StringComparer.Ordinal)
            {
                ["index.bin"] = new byte[] { 1, 2, 3 },
                ["index.core.v1.bin"] = new byte[] { 4, 5, 6 },
                ["index.manifest.aeds"] = new byte[] { 7, 8, 9 }
            };
            var second = new Dictionary<string, ReadOnlyMemory<byte>>(StringComparer.Ordinal)
            {
                ["index.bin"] = new byte[] { 13, 14, 15 },
                ["index.core.v2.bin"] = new byte[] { 10, 11, 12 },
                ["index.manifest.aeds"] = new byte[] { 16, 17, 18 }
            };

            await SearchIndexService.PublishReleaseDerivedArtifactsAsync(publisher, first);
            ReleaseDerivedArtifactGeneration secondGeneration =
                await SearchIndexService.PublishReleaseDerivedArtifactsAsync(publisher, second);

            string derivedRoot = Path.GetFullPath(Path.Combine(root, "derived"));
            string searchRoot = publisher.GetKindRoot("search");
            await File.WriteAllBytesAsync(Path.Combine(searchRoot, "index.manifest.aeds"), first["index.manifest.aeds"].ToArray());
            await File.WriteAllBytesAsync(Path.Combine(searchRoot, "index.bin"), first["index.bin"].ToArray());

            using var provider = new ReleaseDerivedSearchPointerFileProvider(derivedRoot);
            string manifestSubpath = $"{ReleaseId}/search/index.manifest.aeds";
            string aliasSubpath = $"{ReleaseId}/search/index.bin";
            IFileInfo manifest = provider.GetFileInfo(manifestSubpath);
            IFileInfo alias = provider.GetFileInfo(aliasSubpath);
            IFileInfo shard = provider.GetFileInfo($"{ReleaseId}/search/index.core.v2.bin");

            Assert.True(manifest.Exists);
            Assert.Equal(second["index.manifest.aeds"].ToArray(), ReadFileInfo(manifest));
            Assert.Equal(second["index.bin"].ToArray(), ReadFileInfo(alias));
            Assert.Equal(second["index.core.v2.bin"].ToArray(), ReadFileInfo(shard));
            Assert.Contains(
                Path.Combine("generations", secondGeneration.Generation),
                manifest.PhysicalPath ?? string.Empty,
                StringComparison.Ordinal);
            Assert.DoesNotContain(
                Path.Combine("generations", secondGeneration.Generation),
                shard.PhysicalPath ?? string.Empty,
                StringComparison.Ordinal);
            Assert.Equal(
                first["index.manifest.aeds"].ToArray(),
                await File.ReadAllBytesAsync(Path.Combine(searchRoot, "index.manifest.aeds")));
            Assert.True(ReleaseDerivedSearchPointerFileProvider.TryParseSearchPointerFile(
                manifestSubpath,
                out string? parsedReleaseId,
                out string? parsedFileName));
            Assert.Equal(ReleaseId, parsedReleaseId);
            Assert.Equal("index.manifest.aeds", parsedFileName);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static byte[] ReadFileInfo(IFileInfo info)
    {
        using Stream stream = info.CreateReadStream();
        using var memory = new MemoryStream();
        stream.CopyTo(memory);
        return memory.ToArray();
    }

    private static FileService CreateFileService(string root)
        => new(ReleaseStorageTestPaths.Create(root), NullLogger<FileService>.Instance);

    private static FormFile CreateFormFile(byte[] bytes, string fileName)
        => new(new MemoryStream(bytes), 0, bytes.Length, "file", fileName);

    private static string CreateTempDirectory()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsusblog-release-storage-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private sealed class TestWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(ReleaseStorageLifecycleTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = "Development";
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
