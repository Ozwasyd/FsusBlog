using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotArtifactPipelineHotPathContractTests
{
    [Fact]
    public void PublicHotArtifactProjector_UsesDeltaRebuildAndBulkArticleReads()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactProjector.cs");
        string buildArticleFrames = ExtractMethodBlock(
            source,
            "private async Task<FrozenDictionary<int, PublicBinaryArtifact>> BuildArticleFramesAsync");

        Assert.DoesNotContain("=> BuildSnapshotAsync(current.HtmlArtifacts, ct);", source, StringComparison.Ordinal);
        Assert.Contains("BuildDeltaSnapshotCoreAsync", source, StringComparison.Ordinal);
        Assert.Contains("LoadArticleDetailsFromDbAsync", buildArticleFrames, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadArticleDetailFromDbAsync(articleId", buildArticleFrames, StringComparison.Ordinal);
        Assert.Contains("AddArticlePageFramesAsync", source, StringComparison.Ordinal);
        Assert.Contains("LoadArticlePageWindowFromDbAsync", source, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicHotArtifactProjector_ExposesArticleFrameLimitOverflowInsteadOfSilentTruncation()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactProjector.cs");
        string queryPublicIds = ExtractMethodBlock(source, "private async Task<PublicArticleFrameSelection> QueryPublicArticleIdsAsync");
        string buildSnapshot = ExtractMethodBlock(source, "private async Task<PublicHotReadSnapshot> BuildSnapshotCoreAsync");

        Assert.Contains("int publicArticleCount = await publicArticles.CountAsync", queryPublicIds, StringComparison.Ordinal);
        Assert.Contains(".Take(limit)", queryPublicIds, StringComparison.Ordinal);
        Assert.Contains("new PublicArticleFrameSelection(articleIds, publicArticleCount, limit)", queryPublicIds, StringComparison.Ordinal);
        Assert.Contains("selection.PublicArticleCount", buildSnapshot, StringComparison.Ordinal);
        Assert.Contains("selection.ArticleFrameLimit", buildSnapshot, StringComparison.Ordinal);
        Assert.Contains("ArticleFrameLimitExceeded", ReadRepoFile("src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs"), StringComparison.Ordinal);
    }

    [Fact]
    public void PublicHotArtifactProjector_DeltaRebuildsOnlyAffectedListScopes()
    {
        string projector = ReadRepoFile("src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactProjector.cs");
        string observability = ReadRepoFile("src/backend/Infrastructure/Observability/FsusObservability.cs");
        string delta = ExtractMethodBlock(projector, "private async Task<PublicHotReadSnapshot> BuildDeltaSnapshotCoreAsync");
        string scopedLists = ExtractMethodBlock(projector, "private async Task<int> AddAffectedListFramesAsync");

        Assert.DoesNotContain("BuildListFramesAsync", delta, StringComparison.Ordinal);
        Assert.DoesNotContain("BuildCategoryFrameAsync", delta, StringComparison.Ordinal);
        Assert.DoesNotContain("BuildTagFrameAsync", delta, StringComparison.Ordinal);
        Assert.DoesNotContain("QueryPublicCategoryIdsAsync", delta, StringComparison.Ordinal);
        Assert.DoesNotContain("QueryPublicTagIdsAsync", delta, StringComparison.Ordinal);

        Assert.Contains("PublicListKind.Home", scopedLists, StringComparison.Ordinal);
        Assert.Contains("PublicListKind.Archive", scopedLists, StringComparison.Ordinal);
        Assert.Contains("PublicListKind.Category", scopedLists, StringComparison.Ordinal);
        Assert.Contains("PublicListKind.Tag", scopedLists, StringComparison.Ordinal);
        Assert.Contains("RecordPublicHotDelta", projector, StringComparison.Ordinal);
        Assert.Contains("fsus.public_hot.delta.changed_articles", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.public_hot.delta.rebuilt_lists", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.public_hot.delta.rebuilt_taxonomy", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.public_hot.delta.elapsed_ms", observability, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicAotInvalidation_BatchesRouteRemovalsThroughCacheInterface()
    {
        string interfaceSource = ReadRepoFile("src/backend/Infrastructure/PublicAot/IPublicAotShellCache.cs");
        string serviceSource = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotInvalidationService.cs");

        Assert.Contains("RemoveManyAsync", interfaceSource, StringComparison.Ordinal);
        Assert.Contains("InvalidateRoutesAsync", serviceSource, StringComparison.Ordinal);
        Assert.Contains("cache.RemoveManyAsync", serviceSource, StringComparison.Ordinal);
        Assert.DoesNotContain("foreach (int articleId in normalizedArticleIds)\n        {\n            await InvalidateRouteAsync", serviceSource, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicAotFileShellCache_PrefixInvalidationDoesNotDecodeEveryDiskEntry()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotFileShellCache.cs");

        Assert.DoesNotContain("DeleteEntryFilesByPrefix", source, StringComparison.Ordinal);
        Assert.DoesNotContain("PublicAotCacheEntryBinaryCodec.Decode(File.ReadAllBytes", source, StringComparison.Ordinal);
        Assert.Contains("skipped disk scan", source, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicAotDocumentComposer_AvoidsRegexForLiteralHeadAndAttributeChecks()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs");
        string hasAttribute = ExtractMethodBlock(source, "private static bool HasAttribute");

        Assert.DoesNotContain("Regex.Replace(html, \"</head>\"", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Regex.IsMatch", hasAttribute, StringComparison.Ordinal);
        Assert.Contains("IndexOf(\"</head>\"", source, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicAotNodeSsrRenderer_BoundsWorkerOutputAndDocumentsSingleRequestGate()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotNodeSsrRenderer.cs");

        Assert.DoesNotContain("ReadToEndAsync", source, StringComparison.Ordinal);
        Assert.Contains("MaxSsrOutputBytes", source, StringComparison.Ordinal);
        Assert.Contains("WorkerProtocolSupportsMultiplexing = false", source, StringComparison.Ordinal);
        Assert.Contains("ResolveWorkerCount(configuration)", source, StringComparison.Ordinal);
        Assert.Contains("Environment.ProcessorCount", source, StringComparison.Ordinal);
        Assert.Contains("ReadProcessOutputBoundedAsync", source, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicSpaTemplateLocator_LazilyDecodesTextAndCachesResolvedAssets()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicSpaTemplateLocator.cs");

        Assert.DoesNotContain("Lock CacheGate", source, StringComparison.Ordinal);
        Assert.Contains("_templateCache", source, StringComparison.Ordinal);
        Assert.Contains("Path.GetFullPath(indexPath)", source, StringComparison.Ordinal);
        Assert.Contains("lastWriteTimeUtc.Ticks", source, StringComparison.Ordinal);
        Assert.Contains("_assetPathCache", source, StringComparison.Ordinal);
        Assert.Contains("LazyText", source, StringComparison.Ordinal);
        Assert.DoesNotContain("string Text, string AssetVersion", source, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleDetailAedsArtifactStore_MemoryHitAvoidsSynchronousFileChecks()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/PublicReadArtifacts/ArticleDetailAedsArtifactStore.cs");
        string tryReadMemory = ExtractMethodBlock(source, "private bool TryReadMemory");

        Assert.DoesNotContain("File.Exists", tryReadMemory, StringComparison.Ordinal);
        Assert.DoesNotContain("File.GetLastWriteTimeUtc", tryReadMemory, StringComparison.Ordinal);
        Assert.Contains("MemoryTtl", source, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ArticleDetailAedsArtifactStore_MemoryHitTrustsShortTtlWhenDiskFileIsMissing()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsus-aeds-artifact-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var env = new TestWebHostEnvironment(root);
            var store = new ArticleDetailAedsFileArtifactStore(
                env,
                NullLogger<ArticleDetailAedsFileArtifactStore>.Instance);
            byte[] frame = new AedsEncoder().Encode(AedsFrameType.ArticleDetail, [0x01, 0x02, 0x03]);
            await store.WriteAsync(42, frame);
            File.Delete(Path.Combine(root, "runtime-cache", "public", "articles", "42.aeds"));

            ArticleDetailAedsArtifact artifact = await store.TryReadAsync(42);

            Assert.True(artifact.Found);
            Assert.Equal(frame, artifact.Frame.ToArray());
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void PublicAotHtmlArtifact_UsesBufferWriterCompressionOutput()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotHtmlArtifact.cs");
        string tryCompress = ExtractMethodBlock(source, "private static byte[]? TryCompress");

        Assert.Contains("ArrayBufferWriter<byte>", source, StringComparison.Ordinal);
        Assert.DoesNotContain("new MemoryStream()", tryCompress, StringComparison.Ordinal);
        Assert.DoesNotContain("output.ToArray()", tryCompress, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicAotComposeNonTemplate_UsesSnapshotsAndMetricsForHotInputs()
    {
        string bootstrap = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotBootstrapProviders.cs");
        string renderer = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotNodeSsrRenderer.cs");
        string runtimeState = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotSsrRuntimeState.cs");
        string productionHealth = ReadRepoFile("src/backend/Infrastructure/Operations/ProductionHealth.cs");
        string registrations = ReadRepoFile("src/backend/Infrastructure/Bootstrap/RuntimePublicAotServiceCollectionExtensions.cs");
        string observability = ReadRepoFile("src/backend/Infrastructure/Observability/FsusObservability.cs");
        string loadSeoSnapshot = ExtractMethodBlock(bootstrap, "protected async Task<PublicAotSeoSnapshot> LoadSeoSnapshotAsync");

        Assert.Contains("IAotSeoConfigSnapshot", bootstrap, StringComparison.Ordinal);
        Assert.Contains("AotSeoConfigSnapshotTtl = TimeSpan.FromSeconds(30)", bootstrap, StringComparison.Ordinal);
        Assert.Contains("RecordPublicAotBootstrapSeoSnapshot", bootstrap, StringComparison.Ordinal);
        Assert.DoesNotContain("systemService.GetSeoConfigAsync()", loadSeoSnapshot, StringComparison.Ordinal);
        Assert.DoesNotContain("systemService.GetSiteComplianceConfigAsync()", loadSeoSnapshot, StringComparison.Ordinal);

        Assert.Contains("AddSingleton<IAotSeoConfigSnapshot, AotSeoConfigSnapshot>", registrations, StringComparison.Ordinal);
        Assert.Contains("RecordPublicAotCompose", renderer, StringComparison.Ordinal);
        Assert.Contains("GetOrCreateWorkerResourceSnapshot", runtimeState, StringComparison.Ordinal);
        Assert.Contains("RecordWorkerResourceSnapshot", runtimeState, StringComparison.Ordinal);
        Assert.Contains("runtimeState.GetOrCreateWorkerResourceSnapshot", renderer, StringComparison.Ordinal);
        Assert.Contains("publicAotSsrRuntime.GetOrCreateWorkerResourceSnapshot", productionHealth, StringComparison.Ordinal);

        Assert.Contains("fsus.aot.compose.elapsed", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.aot.bootstrap.seo_snapshot.hit_ratio", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.aot.cache.codec.hit_ratio", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.aot.shell_cache.file_hit_ratio", observability, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicAotComposeNonTemplate_AvoidsRepeatedCodecJsonLdAndFileIoWork()
    {
        string codec = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotCacheEntryBinaryCodec.cs");
        string documentComposer = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs");
        string fileCache = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotFileShellCache.cs");
        string buildJsonLd = ExtractMethodBlock(documentComposer, "private static string BuildJsonLd");

        Assert.Contains("DecodedCacheCapacity = 256", codec, StringComparison.Ordinal);
        Assert.Contains("TryGetDecodedCacheEntry", codec, StringComparison.Ordinal);
        Assert.Contains("RecordPublicAotCacheCodecAccess(cacheHit: true)", codec, StringComparison.Ordinal);
        Assert.Contains("RecordPublicAotCacheCodecAccess(cacheHit: false)", codec, StringComparison.Ordinal);

        Assert.Contains("Utf8JsonWriter", buildJsonLd, StringComparison.Ordinal);
        Assert.DoesNotContain("new List<Dictionary<string, object?>>", buildJsonLd, StringComparison.Ordinal);
        Assert.DoesNotContain("JsonSerializer.Serialize", buildJsonLd, StringComparison.Ordinal);

        Assert.Contains("_fileMetadataCache", fileCache, StringComparison.Ordinal);
        Assert.Contains("TryGetFileMetadataEntry", fileCache, StringComparison.Ordinal);
        Assert.Contains("File.GetLastWriteTimeUtc", fileCache, StringComparison.Ordinal);
        Assert.Contains("RecordPublicAotShellCacheFileAccess(cacheHit: true)", fileCache, StringComparison.Ordinal);
    }

    private static string ReadRepoFile(string relativePath, [CallerFilePath] string sourceFile = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string ExtractMethodBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing method signature: {signature}");

        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart >= 0, $"Missing method body: {signature}");

        int depth = 0;
        for (int i = braceStart; i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[start..(i + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Unable to extract method body: {signature}");
    }
    private sealed class TestWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(PublicAotArtifactPipelineHotPathContractTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = Environments.Production;
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
