using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

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
        Assert.Contains("Volatile.Read(ref _cachedTemplate)", source, StringComparison.Ordinal);
        Assert.Contains("Interlocked.Exchange(ref _cachedTemplate", source, StringComparison.Ordinal);
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

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(FindRepoRoot(), relativePath));

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

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
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
