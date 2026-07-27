using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests;

public sealed class SpaAssetManifestServiceTests
{
    private static readonly DateTime s_initialManifestVersionUtc = new(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    private static readonly DateTime s_updatedManifestVersionUtc = new(2024, 1, 2, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void GetPublicAssetSet_DevelopmentViteHost_UsesSourceAssets()
    {
        string root = CreateTempDirectory();
        try
        {
            var env = new TestWebHostEnvironment(root, Environments.Development);
            var service = CreateService(root, env);
            var context = new DefaultHttpContext();
            context.Request.Host = new HostString("localhost:3000");

            SpaAssetSet assets = service.GetPublicAssetSet(context, PublicPageId.Home);

            Assert.True(assets.UsesSourceAssets);
            Assert.Equal("/src/bootstrap/entry.ts", assets.EntryScript);
            Assert.Collection(
                assets.Stylesheets,
                href => Assert.Equal("/src/assets/public-shell-critical.css?direct", href),
                href => Assert.Equal("/src/assets/tailwind.css?direct", href),
                href => Assert.Equal("/src/assets/public-page.css?direct", href));
            Assert.Equal("dev-source-assets", assets.FrontendAssetVersion);
            Assert.Empty(assets.AssetSetDigest);
            Assert.Equal(ReleaseIdContract.LocalSentinel, assets.FrontendBuildIdentity);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void GetPublicAssetSet_DevelopmentArticle_UsesDirectMarkdownCss()
    {
        string root = CreateTempDirectory();
        try
        {
            var env = new TestWebHostEnvironment(root, Environments.Development);
            var service = CreateService(root, env);
            var context = new DefaultHttpContext();
            context.Request.Host = new HostString("localhost:3000");

            SpaAssetSet assets = service.GetPublicAssetSet(context, PublicPageId.ArticleDetail);

            Assert.Collection(
                assets.Stylesheets,
                href => Assert.Equal("/src/assets/public-shell-critical.css?direct", href),
                href => Assert.Equal("/src/assets/tailwind.css?direct", href),
                href => Assert.Equal("/src/assets/public-page.css?direct", href),
                href => Assert.Equal("/src/assets/markdown.css?direct", href));
            Assert.DoesNotContain("/src/assets/markdown.css", assets.Stylesheets);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void GetFrontendAssetVersion_DevelopmentForwardedViteHost_UsesSourceAssetNamespace()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            var env = new TestWebHostEnvironment(root, Environments.Development);
            var service = CreateService(root, env);
            var context = new DefaultHttpContext();
            context.Request.Host = new HostString("127.0.0.1:7568");
            context.Request.Headers["X-Forwarded-Host"] = "127.0.0.1:3000";

            string version = service.GetFrontendAssetVersion(context);

            Assert.Equal("dev-source-assets", version);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void GetPublicAssetSet_ProductionManifest_ReturnsStableEntryAndManifestCss()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            var env = new TestWebHostEnvironment(root, Environments.Production);
            var service = CreateService(root, env);

            SpaAssetSet assets = service.GetPublicAssetSet(pageId: PublicPageId.Home);

            Assert.False(assets.UsesSourceAssets);
            Assert.Equal("/assets/fsus-spa-entry.js", assets.EntryScript);
            Assert.Collection(
                assets.Stylesheets,
                href => Assert.Equal("/assets/public-shell-critical-a.css", href),
                href => Assert.Equal("/assets/tailwind-a.css", href),
                href => Assert.Equal("/assets/public-page-a.css", href));
            Assert.Contains("/assets/public-page-a.css", assets.Stylesheets);
            Assert.DoesNotContain(assets.Stylesheets, static href => href.Contains("vendor-element-plus", StringComparison.OrdinalIgnoreCase));
            Assert.DoesNotContain(assets.Stylesheets, static href => href.Contains("full-app-core", StringComparison.OrdinalIgnoreCase));
            Assert.DoesNotContain(assets.Stylesheets, static href => href.Contains("markdown", StringComparison.OrdinalIgnoreCase));
            Assert.Empty(assets.ModulePreloads);
            Assert.DoesNotContain(assets.ModulePreloads, static href => href.EndsWith(".css", StringComparison.OrdinalIgnoreCase));
            Assert.Contains("/assets/entry-runtime-a.js", assets.FullAppTakeover.ModulePreloads);
            Assert.Contains("/assets/full-app-core-a.js", assets.FullAppTakeover.ModulePreloads);
            Assert.Contains("/assets/vendor-element-plus-a.js", assets.FullAppTakeover.ModulePreloads);
            Assert.Contains("/assets/vendor-element-plus-a.css", assets.FullAppTakeover.Stylesheets);
            Assert.Contains("/assets/full-app-core-a.css", assets.FullAppTakeover.Stylesheets);
            Assert.NotEqual("missing-manifest", assets.FrontendAssetVersion);
            Assert.Equal("local-unversioned", assets.FrontendBuildIdentity);
            Assert.DoesNotContain(
                assets.FullAppTakeover.Stylesheets,
                static href => href.Contains("route-", StringComparison.OrdinalIgnoreCase));
            Assert.Equal(Path.Combine(root, "local-unversioned", "index.html"), service.GetIndexTemplatePath());
            SpaAssetManifestReadiness readiness = service.GetReadiness();
            Assert.Equal("ok", readiness.Status);
            Assert.Equal("local-unversioned", readiness.ReleaseId);
            Assert.Equal(GetDescriptorPath(root), readiness.DescriptorPath);
            Assert.Equal(
                JsonNode.Parse(File.ReadAllText(readiness.DescriptorPath!))!["contentDigest"]!.GetValue<string>(),
                readiness.DescriptorContentDigest);
            Assert.Equal(GetReceiptPath(root), readiness.BuildReceiptPath);
            Assert.Equal(
                JsonNode.Parse(File.ReadAllText(readiness.BuildReceiptPath!))!["contentDigest"]!.GetValue<string>(),
                readiness.BuildReceiptDigest);
            Assert.Equal(new string('0', 40), readiness.SourceCommit);
            Assert.Equal("sha256:" + new string('a', 64), readiness.WorktreeFingerprint);
            Assert.Equal(Path.Combine(root, "local-unversioned"), readiness.AssetRoot);
            Assert.Equal(Path.Combine(root, "local-unversioned", "index.html"), readiness.IndexPath);
            Assert.Equal(
                Path.Combine(root, "local-unversioned", ".vite", "manifest.json"),
                readiness.ManifestPath);
            Assert.Equal(Digest(Assert.IsType<string>(readiness.ManifestPath)), readiness.ManifestDigest);
            Assert.Equal(
                Path.Combine(root, "local-unversioned", "asset-manifest.json"),
                readiness.AssetInventoryPath);
            Assert.Equal(
                Digest(Assert.IsType<string>(readiness.AssetInventoryPath)),
                readiness.AssetInventoryDigest);
            Assert.Null(readiness.Error);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void GetPublicAssetSet_ArticleManifest_IncludesMarkdownCssWithoutFullAppAssets()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            var env = new TestWebHostEnvironment(root, Environments.Production);
            var service = CreateService(root, env);

            SpaAssetSet assets = service.GetPublicAssetSet(pageId: PublicPageId.ArticleDetail);

            Assert.Contains("/assets/markdown-a.css", assets.Stylesheets);
            Assert.DoesNotContain(assets.Stylesheets, static href => href.Contains("vendor-element-plus", StringComparison.OrdinalIgnoreCase));
            Assert.DoesNotContain(assets.Stylesheets, static href => href.Contains("full-app-core", StringComparison.OrdinalIgnoreCase));
            Assert.Empty(assets.ModulePreloads);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void GetFrontendAssetVersion_ProductionKeepsStartupManifestSnapshot()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            var env = new TestWebHostEnvironment(root, Environments.Production);
            var service = CreateService(root, env);
            string first = service.GetFrontendAssetVersion();

            WriteManifest(root, "public-page-b.css", s_updatedManifestVersionUtc);
            string second = service.GetFrontendAssetVersion();

            Assert.Equal(first, second);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_MissingManifestRecoversAfterBoundedRetryWithoutPublishingFallbackAssets()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            File.Delete(Path.Combine(GetReleaseAssetRoot(root), ".vite", "manifest.json"));
            var service = CreateService(root, new TestWebHostEnvironment(root, Environments.Production), retryIntervalMilliseconds: 50);

            Assert.Equal("failed", service.GetReadiness().Status);
            Assert.Equal("retryable-failed", service.GetReadiness().State);
            SpaAssetSet nonreadyAssets = service.GetPublicAssetSet(pageId: PublicPageId.Home);
            Assert.Empty(nonreadyAssets.EntryScript);
            Assert.Empty(nonreadyAssets.Stylesheets);
            Assert.Empty(nonreadyAssets.ModulePreloads);
            Assert.Equal(FullAppTakeoverAssetSet.Empty, nonreadyAssets.FullAppTakeover);

            WriteManifest(root, "public-page-b.css", s_updatedManifestVersionUtc);
            Assert.True(SpinWait.SpinUntil(
                () => service.GetReadiness().State == "ready",
                TimeSpan.FromSeconds(1)));
            Assert.Contains("/assets/public-page-b.css", service.GetPublicAssetSet(pageId: PublicPageId.Home).Stylesheets);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_CompleteAssetsWithoutManifestRemainNotReadyAndDoNotSelectCssByPrefix()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string assetsRoot = Path.Combine(GetReleaseAssetRoot(root), "assets");
            File.WriteAllText(Path.Combine(assetsRoot, "public-page-z.css"), "other generation");
            File.Delete(Path.Combine(GetReleaseAssetRoot(root), ".vite", "manifest.json"));
            var service = CreateService(root, new TestWebHostEnvironment(root, Environments.Production));

            SpaAssetSet assets = service.GetPublicAssetSet(pageId: PublicPageId.Home);

            Assert.Equal("failed", service.GetReadiness().Status);
            Assert.Empty(assets.EntryScript);
            Assert.Empty(assets.Stylesheets);
            Assert.DoesNotContain("/assets/public-page-z.css", assets.Stylesheets);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_ExactManifestOwnerSelectionIgnoresNewerSamePrefixFile()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string unlisted = Path.Combine(GetReleaseAssetRoot(root), "assets", "public-page-z.css");
            File.WriteAllText(unlisted, "unlisted newer generation");
            File.SetLastWriteTimeUtc(unlisted, s_updatedManifestVersionUtc);

            SpaAssetManifestService service = CreateService(root, new TestWebHostEnvironment(root, Environments.Production));
            SpaAssetSet assets = service.GetPublicAssetSet(pageId: PublicPageId.Home);

            Assert.Equal("failed", service.GetReadiness().Status);
            Assert.DoesNotContain("/assets/public-page-z.css", assets.Stylesheets);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_FrontendAssetVersionChangesWhenAnySealedInventoryFileChanges()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            var environment = new TestWebHostEnvironment(root, Environments.Production);
            string first = CreateService(root, environment).GetFrontendAssetVersion();

            ReplaceInventoryFileAndReseal(root, "assets/fsus-spa-entry.js", "stable entry generation two");
            SpaAssetManifestService reloaded = CreateService(root, environment);

            SpaAssetSet assets = reloaded.GetPublicAssetSet(pageId: PublicPageId.Home);
            Assert.NotEqual(first, assets.FrontendAssetVersion);
            Assert.Equal(assets.FrontendAssetVersion, assets.AssetSetDigest);
            Assert.Equal(assets.AssetSetDigest, reloaded.GetReadiness().AssetSetDigest);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_ExplicitPointerCanActivateRetainedCompleteGeneration()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            const string RetainedReleaseId = "retained-old-generation";
            string retainedRoot = CreateRetainedGeneration(root, RetainedReleaseId);

            SpaAssetManifestReadiness readiness = CreateService(
                root,
                new TestWebHostEnvironment(root, Environments.Production),
                descriptorPath: Path.Combine(retainedRoot, "spa-manifest-descriptor.json"),
                receiptPath: Path.Combine(retainedRoot, "production-build-receipt.json"),
                releaseId: RetainedReleaseId).GetReadiness();

            Assert.Equal("ok", readiness.Status);
            Assert.Equal(RetainedReleaseId, readiness.ReleaseId);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsRetainedDescriptorPointerWithoutMatchingReleaseIdentity()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string retainedRoot = CreateRetainedGeneration(root, "retained-old-generation");

            SpaAssetManifestReadiness readiness = CreateService(
                root,
                new TestWebHostEnvironment(root, Environments.Production),
                descriptorPath: Path.Combine(retainedRoot, "spa-manifest-descriptor.json"),
                receiptPath: Path.Combine(retainedRoot, "production-build-receipt.json")).GetReadiness();

            Assert.Equal("failed", readiness.Status);
            Assert.Equal("spa_manifest_descriptor_authority_mismatch", readiness.Error);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RealAssetGenerationChangeMakesOldPublicAotDocumentNotRenderable()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            var environment = new TestWebHostEnvironment(root, Environments.Production);
            string oldVersion = CreateService(root, environment).GetFrontendAssetVersion();
            var staleDocument = new PublicAotCacheEntry
            {
                CacheKey = "public:aot:v2:doc:1:home",
                RouteKey = "home",
                RendererVersion = PublicAotConstants.RendererVersion,
                FrontendAssetVersion = oldVersion,
                ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(5),
                Value = "<html>old asset generation</html>"
            };

            ReplaceInventoryFileAndReseal(root, "assets/fsus-spa-entry.js", "stable entry generation two");
            string currentVersion = CreateService(root, environment).GetFrontendAssetVersion();

            Assert.NotEqual(oldVersion, currentVersion);
            Assert.False(PublicAotArtifactStore.IsRenderableCacheEntry(staleDocument, currentVersion));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_TerminalDigestFailureWaitsForNewDescriptorGeneration()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            File.AppendAllText(Path.Combine(GetReleaseAssetRoot(root), ".vite", "manifest.json"), "\n");
            var service = CreateService(root, new TestWebHostEnvironment(root, Environments.Production), retryIntervalMilliseconds: 50);
            SpaAssetManifestReadiness failed = service.GetReadiness();

            Assert.Equal("terminal-failed", failed.State);
            Assert.Equal("spa_manifest_digest_mismatch", failed.Error);
            Assert.False(SpinWait.SpinUntil(
                () => service.GetReadiness().Attempts != failed.Attempts,
                TimeSpan.FromMilliseconds(120)));
            Assert.Equal(failed.Attempts, service.GetReadiness().Attempts);

            WriteManifest(root, "public-page-b.css", s_updatedManifestVersionUtc);
            Assert.True(SpinWait.SpinUntil(
                () => service.GetReadiness().State == "ready",
                TimeSpan.FromSeconds(1)));
            SpaAssetManifestReadiness ready = service.GetReadiness();
            Assert.Equal("ready", ready.State);
            Assert.NotEqual(failed.DescriptorGeneration, ready.DescriptorGeneration);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_ParseFailureRecoversAfterDescriptorIsAtomicallyReplaced()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string manifestPath = Path.Combine(GetReleaseAssetRoot(root), ".vite", "manifest.json");
            File.WriteAllText(manifestPath, "{");
            ResealManifestMutation(root);
            var service = CreateService(
                root,
                new TestWebHostEnvironment(root, Environments.Production),
                retryIntervalMilliseconds: 50);

            Assert.Equal("retryable-failed", service.GetReadiness().State);

            WriteManifest(root, "public-page-b.css", s_updatedManifestVersionUtc);

            Assert.True(SpinWait.SpinUntil(
                () => service.GetReadiness().State == "ready",
                TimeSpan.FromSeconds(1)));
            Assert.Contains(
                "/assets/public-page-b.css",
                service.GetPublicAssetSet(pageId: PublicPageId.Home).Stylesheets);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_SameGenerationReloadFailureKeepsCompleteReadySnapshot()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            var service = CreateService(
                root,
                new TestWebHostEnvironment(root, Environments.Production),
                retryIntervalMilliseconds: 50);
            SpaAssetSet readyAssets = service.GetPublicAssetSet(pageId: PublicPageId.Home);
            string readyVersion = readyAssets.FrontendAssetVersion;
            string? readyDigest = service.GetReadiness().LoadedDigest;
            File.Delete(Path.Combine(GetReleaseAssetRoot(root), ".vite", "manifest.json"));

            Assert.True(SpinWait.SpinUntil(
                () => service.GetReadiness().State == "retryable-failed",
                TimeSpan.FromSeconds(1)));

            SpaAssetManifestReadiness failed = service.GetReadiness();
            SpaAssetSet retained = service.GetPublicAssetSet(pageId: PublicPageId.Home);
            Assert.Equal(readyVersion, retained.FrontendAssetVersion);
            Assert.Equal(readyAssets.Stylesheets, retained.Stylesheets);
            Assert.Equal(
                readyAssets.FullAppTakeover.ModulePreloads,
                retained.FullAppTakeover.ModulePreloads);
            Assert.Equal(
                readyAssets.FullAppTakeover.Stylesheets,
                retained.FullAppTakeover.Stylesheets);
            Assert.Equal(readyDigest, failed.LoadedDigest);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_CrossReleaseMissingManifestDropsOldReadySnapshot()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            var service = CreateService(
                root,
                new TestWebHostEnvironment(root, Environments.Production),
                retryIntervalMilliseconds: 50);
            string oldVersion = service.GetFrontendAssetVersion();

            string descriptorPath = GetDescriptorPath(root);
            JsonNode descriptor = JsonNode.Parse(File.ReadAllText(descriptorPath))!;
            descriptor["releaseId"] = "next-release";
            File.WriteAllText(descriptorPath, descriptor.ToJsonString());
            ResealDescriptorDigest(root);
            File.Delete(Path.Combine(GetReleaseAssetRoot(root), ".vite", "manifest.json"));

            Assert.True(SpinWait.SpinUntil(
                () => service.GetReadiness().State == "terminal-failed",
                TimeSpan.FromSeconds(1)));
            Assert.Equal(
                "spa_manifest_release_identity_mismatch",
                service.GetReadiness().Error);
            SpaAssetSet assets = service.GetPublicAssetSet(pageId: PublicPageId.Home);
            Assert.Equal("missing-manifest", assets.FrontendAssetVersion);
            Assert.NotEqual(oldVersion, assets.FrontendAssetVersion);
            Assert.Empty(assets.EntryScript);
            Assert.Empty(assets.Stylesheets);
            Assert.Empty(assets.ModulePreloads);
            Assert.Null(service.GetReadiness().LoadedDigest);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_SameGenerationLoadingServesOldSnapshotWithoutBlockingReaders()
    {
        string root = CreateTempDirectory();
        using var loading = new ManualResetEventSlim();
        using var releaseLoad = new ManualResetEventSlim();
        int loadCount = 0;
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            var service = CreateService(
                root,
                new TestWebHostEnvironment(root, Environments.Production),
                retryIntervalMilliseconds: 50,
                onLoadStartedForTests: () =>
                {
                    if (Interlocked.Increment(ref loadCount) == 2)
                    {
                        loading.Set();
                        releaseLoad.Wait(TimeSpan.FromSeconds(2));
                    }
                });
            string readyVersion = service.GetFrontendAssetVersion();

            Thread.Sleep(60);
            Task<SpaAssetManifestReadiness> reload = Task.Run(service.GetReadiness);
            Assert.True(loading.Wait(TimeSpan.FromSeconds(1)));

            var stopwatch = System.Diagnostics.Stopwatch.StartNew();
            SpaAssetSet duringLoad = service.GetPublicAssetSet(pageId: PublicPageId.Home);
            SpaAssetManifestReadiness loadingReadiness = service.GetReadiness();
            stopwatch.Stop();

            Assert.Equal("loading", loadingReadiness.State);
            Assert.Equal(readyVersion, duringLoad.FrontendAssetVersion);
            Assert.True(stopwatch.Elapsed < TimeSpan.FromMilliseconds(200));
            Assert.False(reload.IsCompleted);

            releaseLoad.Set();
            Assert.Equal("ready", reload.GetAwaiter().GetResult().State);
        }
        finally
        {
            releaseLoad.Set();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RetryPolicyBoundsPollingAndAdmission()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            File.Delete(Path.Combine(GetReleaseAssetRoot(root), ".vite", "manifest.json"));
            var service = CreateService(
                root,
                new TestWebHostEnvironment(root, Environments.Production),
                retryIntervalMilliseconds: 50,
                admissionDeadlineMilliseconds: 100);
            int firstAttempts = service.GetReadiness().Attempts;

            for (int index = 0; index < 20; index++)
            {
                _ = service.GetReadiness();
            }
            Assert.Equal(firstAttempts, service.GetReadiness().Attempts);

            Thread.Sleep(60);
            int admittedAttempts = service.GetReadiness().Attempts;
            Assert.True(admittedAttempts > firstAttempts);

            Thread.Sleep(60);
            for (int index = 0; index < 20; index++)
            {
                _ = service.GetReadiness();
            }
            Assert.Equal(admittedAttempts, service.GetReadiness().Attempts);

            WriteManifest(root, "public-page-b.css", s_updatedManifestVersionUtc);
            Assert.True(SpinWait.SpinUntil(
                () => service.GetReadiness().State == "ready",
                TimeSpan.FromSeconds(1)));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_MissingDescriptorManifestDoesNotFallBackToOldDist()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            File.Delete(Path.Combine(root, "local-unversioned", ".vite", "manifest.json"));
            File.Delete(Path.Combine(root, "wwwroot", ".vite", "manifest.json"));
            string oldManifest = Path.Combine(root, "frontend", "dist", ".vite");
            Directory.CreateDirectory(oldManifest);
            File.WriteAllText(Path.Combine(oldManifest, "manifest.json"), "{}");
            string contentRoot = Path.Combine(root, "backend");
            Directory.CreateDirectory(contentRoot);
            var environment = new TestWebHostEnvironment(root, Environments.Production)
            {
                ContentRootPath = contentRoot
            };
            var service = CreateService(root, environment);
            Assert.Equal("spa_manifest_missing", service.GetReadiness().Error);
            Assert.Equal("missing-manifest", service.GetFrontendAssetVersion());
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_MultipleCandidateManifestsStillReadsOnlyDescriptorPath()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string oldCandidate = Path.Combine(root, "wwwroot", ".vite", "manifest.json");
            File.WriteAllText(
                oldCandidate,
                File.ReadAllText(oldCandidate).Replace(
                    "public-page-a.css",
                    "public-page-stale.css",
                    StringComparison.Ordinal));
            File.WriteAllText(
                Path.Combine(root, "wwwroot", "assets", "public-page-stale.css"),
                "stale");

            SpaAssetSet assets = CreateService(
                root,
                new TestWebHostEnvironment(root, Environments.Production))
                .GetPublicAssetSet(pageId: PublicPageId.Home);

            Assert.Contains("/assets/public-page-a.css", assets.Stylesheets);
            Assert.DoesNotContain("/assets/public-page-stale.css", assets.Stylesheets);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsDescriptorForAnotherRelease()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string descriptor = GetDescriptorPath(root);
            File.WriteAllText(descriptor, File.ReadAllText(descriptor).Replace("local-unversioned", "other-release", StringComparison.Ordinal));
            ResealDescriptorDigest(root);
            AssertReadinessFailure(root, "spa_manifest_release_identity_mismatch");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsSameReleaseIdFromAnotherConfiguredAssetRoot()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string descriptorPath = GetDescriptorPath(root);
            string expectedRoot = Path.Combine(root, "local-unversioned");
            string shadowRoot = Path.Combine(root, "shadow-store", "local-unversioned");
            Directory.CreateDirectory(shadowRoot);
            File.WriteAllText(descriptorPath, File.ReadAllText(descriptorPath).Replace(expectedRoot, shadowRoot, StringComparison.Ordinal));
            ResealDescriptorDigest(root);

            AssertReadinessFailure(root, "spa_manifest_asset_root_authority_mismatch");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsUnsafeReleaseIdentityBeforeReadingDescriptor()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);

            SpaAssetManifestReadiness readiness = CreateService(
                root,
                new TestWebHostEnvironment(root, Environments.Production),
                releaseId: "../escaped-release").GetReadiness();

            Assert.Equal("failed", readiness.Status);
            Assert.Equal("spa_manifest_asset_root_authority_mismatch", readiness.Error);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsDescriptorAndReceiptOutsideCurrentReleaseAuthority()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string outsideDescriptor = Path.Combine(root, "outside-descriptor.json");
            File.Copy(GetDescriptorPath(root), outsideDescriptor);
            SpaAssetManifestReadiness descriptorReadiness = CreateService(
                root,
                new TestWebHostEnvironment(root, Environments.Production),
                descriptorPath: outsideDescriptor).GetReadiness();
            Assert.Equal(
                "spa_manifest_descriptor_authority_mismatch",
                descriptorReadiness.Error);

            string outsideReceipt = Path.Combine(root, "outside-receipt.json");
            File.Copy(GetReceiptPath(root), outsideReceipt);
            SpaAssetManifestReadiness receiptReadiness = CreateService(
                root,
                new TestWebHostEnvironment(root, Environments.Production),
                receiptPath: outsideReceipt).GetReadiness();
            Assert.Equal(
                "spa_build_receipt_authority_mismatch",
                receiptReadiness.Error);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_DescriptorDigestIsOrderIndependentButRejectsTamperAndExtraFields()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string descriptorPath = GetDescriptorPath(root);
            JsonObject descriptor = JsonNode.Parse(File.ReadAllText(descriptorPath))!.AsObject();
            var reversed = new JsonObject();
            foreach ((string key, JsonNode? value) in descriptor.Reverse())
            {
                reversed[key] = value?.DeepClone();
            }
            File.WriteAllText(descriptorPath, reversed.ToJsonString());
            Assert.Equal("ok", CreateService(root, new TestWebHostEnvironment(root, Environments.Production)).GetReadiness().Status);

            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            File.WriteAllText(descriptorPath, File.ReadAllText(descriptorPath).Replace("local-unversioned", "tampered-release", StringComparison.Ordinal));
            AssertReadinessFailure(root, "spa_manifest_descriptor_content_digest_mismatch");

            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            descriptor = JsonNode.Parse(File.ReadAllText(descriptorPath))!.AsObject();
            descriptor["unexpected"] = "rejected";
            File.WriteAllText(descriptorPath, descriptor.ToJsonString());
            AssertReadinessFailure(root, "spa_manifest_descriptor_schema_invalid");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_InvalidDescriptorJsonUsesStableReadinessReason()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            File.WriteAllText(GetDescriptorPath(root), "{");

            SpaAssetManifestReadiness readiness = CreateService(
                root,
                new TestWebHostEnvironment(root, Environments.Production)).GetReadiness();

            Assert.Equal("failed", readiness.Status);
            Assert.Equal("spa_manifest_descriptor_invalid_json", readiness.Error);
            Assert.DoesNotContain(root, Assert.IsType<string>(readiness.Error), StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsManifestAndInventoryDigestMismatch()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            File.AppendAllText(Path.Combine(root, "local-unversioned", ".vite", "manifest.json"), "\n");
            AssertReadinessFailure(root, "spa_manifest_digest_mismatch");
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            File.AppendAllText(Path.Combine(root, "local-unversioned", "asset-manifest.json"), "\n");
            AssertReadinessFailure(root, "spa_asset_inventory_digest_mismatch");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsReceiptSourceContractAndExactArtifactPathMismatch()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string receipt = GetReceiptPath(root);
            File.WriteAllText(receipt, File.ReadAllText(receipt).Replace(new string('0', 40), new string('c', 40), StringComparison.Ordinal));
            ResealReceiptDigest(root, updateDescriptor: true);
            AssertReadinessFailure(root, "spa_build_receipt_source_invalid");

            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            File.WriteAllText(receipt, File.ReadAllText(receipt).Replace("\"artifacts\"", "\"artifactz\"", StringComparison.Ordinal));
            ResealReceiptDigest(root, updateDescriptor: true);
            AssertReadinessFailure(root, "spa_build_receipt_contract_invalid");

            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            JsonNode receiptNode = JsonNode.Parse(File.ReadAllText(receipt))!;
            JsonArray receiptArtifacts = receiptNode["artifacts"]!.AsArray();
            string originalPath = receiptArtifacts[0]!["path"]!.GetValue<string>();
            receiptArtifacts[0]!["path"] = "frontend-dist/rebound-" + Path.GetFileName(originalPath);
            File.WriteAllText(receipt, receiptNode.ToJsonString());
            ResealReceiptDigest(root, updateDescriptor: true);
            AssertReadinessFailure(root, "spa_build_receipt_artifact_mismatch");

            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            File.WriteAllText(receipt, $$"""
            {
              "sourceState": {
                "commit": "{{new string('0', 40)}}",
                "worktreeFingerprint": "sha256:{{new string('a', 64)}}"
              },
              "artifacts": [],
              "contentDigest": null
            }
            """);
            ResealReceiptDigest(root, updateDescriptor: true);
            AssertReadinessFailure(root, "spa_build_receipt_contract_invalid");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsEscapedAndSymlinkManifestPaths()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string descriptorPath = GetDescriptorPath(root);
            File.WriteAllText(descriptorPath, File.ReadAllText(descriptorPath).Replace(
                Path.Combine(root, "local-unversioned", ".vite", "manifest.json"),
                Path.Combine(root, "outside-manifest.json"), StringComparison.Ordinal));
            ResealDescriptorDigest(root);
            AssertReadinessFailure(root, "spa_manifest_path_escaped_asset_root");

            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string rootManifest = Path.Combine(root, "local-unversioned", ".vite", "manifest.json");
            string symlinkManifest = Path.Combine(root, "local-unversioned", ".vite", "linked-manifest.json");
            File.CreateSymbolicLink(symlinkManifest, rootManifest);
            File.WriteAllText(descriptorPath, File.ReadAllText(descriptorPath).Replace(rootManifest, symlinkManifest, StringComparison.Ordinal));
            ResealDescriptorDigest(root);
            AssertReadinessFailure(root, "spa_manifest_symlink_escaped_asset_root");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsInventoryThatDoesNotBindIndexAndManifestAssets()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string inventoryPath = Path.Combine(root, "local-unversioned", "asset-manifest.json");
            File.WriteAllText(inventoryPath, "{ \"schema\": \"fsusblog.release-assets.v1\", \"releaseId\": \"local-unversioned\", \"frontendBuildId\": \"local-unversioned\", \"files\": [] }");
            ResealDescriptor(root);
            AssertReadinessFailure(root, "spa_asset_inventory_missing_index_or_manifest");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsExtraInventoryEntryAndSymlinkedAssetDirectory()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string inventoryPath = Path.Combine(root, "local-unversioned", "asset-manifest.json");
            JsonObject inventory = JsonNode.Parse(File.ReadAllText(inventoryPath))!.AsObject();
            inventory["files"]!.AsArray().Add(new JsonObject
            {
                ["path"] = "assets/phantom.css",
                ["sha256"] = "sha256:" + new string('f', 64),
                ["bytes"] = 1
            });
            File.WriteAllText(inventoryPath, inventory.ToJsonString());
            ResealDescriptor(root);
            AssertReadinessFailure(root, "spa_asset_inventory_file_missing");

            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string assetDirectory = Path.Combine(root, "local-unversioned", "assets");
            string externalDirectory = Path.Combine(root, "external-assets");
            Directory.Move(assetDirectory, externalDirectory);
            Directory.CreateSymbolicLink(assetDirectory, externalDirectory);
            AssertReadinessFailure(root, "spa_manifest_symlink_escaped_asset_root");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsMaterializedFileMissingFromInventory()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            File.WriteAllText(
                Path.Combine(root, "local-unversioned", "materialization-extra.txt"),
                "extra");

            AssertReadinessFailure(root, "spa_asset_inventory_materialization_mismatch");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsSymlinkedReleaseDirectory()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string releaseDirectory = Path.Combine(root, "local-unversioned");
            string externalRelease = Path.Combine(root, "external-release");
            Directory.Move(releaseDirectory, externalRelease);
            Directory.CreateSymbolicLink(releaseDirectory, externalRelease);

            AssertReadinessFailure(root, "spa_manifest_symlink_escaped_asset_root");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_DoesNotScanWebRootCssWhenDescriptorManifestHasNoPublicCss()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string manifestPath = Path.Combine(root, "wwwroot", ".vite", "manifest.json");
            File.WriteAllText(manifestPath, "{ \"src/bootstrap/entry.ts\": { \"file\": \"assets/index-abc.js\", \"name\": \"route-public\" } }");
            File.WriteAllText(Path.Combine(root, "wwwroot", "assets", "public-page-stale.css"), "stale");
            WriteDescriptor(root);

            SpaAssetSet assets = CreateService(root, new TestWebHostEnvironment(root, Environments.Production))
                .GetPublicAssetSet(pageId: PublicPageId.Home);

            Assert.Empty(assets.Stylesheets);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_ForwardedViteHostCannotEnableSourceAssets()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            var service = CreateService(root, new TestWebHostEnvironment(root, Environments.Production));
            var context = new DefaultHttpContext();
            context.Request.Headers["X-Forwarded-Host"] = "localhost:3000";
            Assert.False(service.GetPublicAssetSet(context, PublicPageId.Home).UsesSourceAssets);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void GetFrontendAssetVersion_DevelopmentChangesWhenManifestChanges()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            var env = new TestWebHostEnvironment(root, Environments.Development);
            var service = CreateService(root, env);
            string first = service.GetFrontendAssetVersion();

            string unchanged = service.GetFrontendAssetVersion();
            WriteManifest(root, "public-page-b.css", s_initialManifestVersionUtc);
            string sameVersion = service.GetFrontendAssetVersion();
            WriteManifest(root, "public-page-b.css", s_updatedManifestVersionUtc);
            string updatedVersion = service.GetFrontendAssetVersion();

            Assert.Equal(first, unchanged);
            Assert.Equal(first, sameVersion);
            Assert.NotEqual(first, updatedVersion);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsMissingRequiredManifestOwner()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string manifest = Path.Combine(root, "wwwroot", ".vite", "manifest.json");
            File.WriteAllText(manifest, File.ReadAllText(manifest).Replace(
                "\"name\": \"route-auth\"", "\"name\": \"removed-owner\"", StringComparison.Ordinal));
            WriteDescriptor(root);
            AssertReadinessFailure(root, "spa_manifest_required_entry_invalid");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsAmbiguousRequiredManifestOwner()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string manifest = Path.Combine(root, "wwwroot", ".vite", "manifest.json");
            File.WriteAllText(manifest, File.ReadAllText(manifest).Replace(
                "\"name\": \"route-auth\"", "\"name\": \"route-admin\"", StringComparison.Ordinal));
            WriteDescriptor(root);
            AssertReadinessFailure(root, "spa_manifest_required_entry_invalid");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsMissingManifestImportTarget()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string manifest = Path.Combine(root, "wwwroot", ".vite", "manifest.json");
            File.WriteAllText(manifest, File.ReadAllText(manifest).Replace(
                "\"name\": \"route-error\"", "\"name\": \"route-error\", \"imports\": [\"missing\"]", StringComparison.Ordinal));
            WriteDescriptor(root);
            AssertReadinessFailure(root, "spa_manifest_import_missing");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsManifestImportCycle()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string manifest = Path.Combine(root, "wwwroot", ".vite", "manifest.json");
            File.WriteAllText(manifest, File.ReadAllText(manifest).Replace(
                "\"name\": \"route-error\"", "\"name\": \"route-error\", \"imports\": [\"error\"]", StringComparison.Ordinal));
            WriteDescriptor(root);
            AssertReadinessFailure(root, "spa_manifest_import_cycle");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsTruncatedInvalidEscapeAndDuplicateManifestEntriesWithoutPartialResult()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string manifestPath = Path.Combine(root, "wwwroot", ".vite", "manifest.json");
            string completeFirstEntry = File.ReadAllText(manifestPath);
            int secondEntry = completeFirstEntry.IndexOf("  \"_entry-runtime-a.js\":", StringComparison.Ordinal);
            Assert.True(secondEntry > 0);
            File.WriteAllText(manifestPath, completeFirstEntry[..(secondEntry + 20)]);
            Assert.Equal(
                "spa_manifest_parse_failed",
                CreateService(root, new TestWebHostEnvironment(root, Environments.Development)).GetReadiness().Error);

            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            manifestPath = Path.Combine(root, "wwwroot", ".vite", "manifest.json");
            File.WriteAllText(manifestPath, "{ \"entry\": \"\\q\" }");
            Assert.Equal(
                "spa_manifest_parse_failed",
                CreateService(root, new TestWebHostEnvironment(root, Environments.Development)).GetReadiness().Error);

            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            manifestPath = Path.Combine(root, "wwwroot", ".vite", "manifest.json");
            string original = File.ReadAllText(manifestPath);
            File.WriteAllText(
                manifestPath,
                original.Insert(
                    original.IndexOf('\n') + 1,
                    "  \"src/bootstrap/entry.ts\": { \"file\": \"assets/index-abc.js\", \"name\": \"route-public\" },\n"));
            Assert.Equal(
                "spa_manifest_schema_invalid",
                CreateService(root, new TestWebHostEnvironment(root, Environments.Development)).GetReadiness().Error);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsManifestEntryFieldTypeMismatch()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string manifestPath = Path.Combine(root, "wwwroot", ".vite", "manifest.json");
            JsonObject manifest = JsonNode.Parse(File.ReadAllText(manifestPath))!.AsObject();
            manifest["src/bootstrap/entry.ts"]!["css"] = "assets/public-page-a.css";
            File.WriteAllText(manifestPath, manifest.ToJsonString());
            Assert.Equal(
                "spa_manifest_schema_invalid",
                CreateService(root, new TestWebHostEnvironment(root, Environments.Development)).GetReadiness().Error);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsUnknownManifestFieldAndBooleanTypeMismatch()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string manifestPath = Path.Combine(root, "wwwroot", ".vite", "manifest.json");
            JsonObject manifest = JsonNode.Parse(File.ReadAllText(manifestPath))!.AsObject();
            manifest["src/bootstrap/entry.ts"]!["unrecognized"] = "ignored-before";
            File.WriteAllText(manifestPath, manifest.ToJsonString());
            Assert.Equal(
                "spa_manifest_schema_invalid",
                CreateService(root, new TestWebHostEnvironment(root, Environments.Development)).GetReadiness().Error);

            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            manifest = JsonNode.Parse(File.ReadAllText(manifestPath))!.AsObject();
            manifest["src/bootstrap/entry.ts"]!["isEntry"] = "true";
            File.WriteAllText(manifestPath, manifest.ToJsonString());
            Assert.Equal(
                "spa_manifest_schema_invalid",
                CreateService(root, new TestWebHostEnvironment(root, Environments.Development)).GetReadiness().Error);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsManifestFileAndCssOutsideAssetRoot()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string manifestPath = Path.Combine(root, "local-unversioned", ".vite", "manifest.json");
            JsonObject manifest = JsonNode.Parse(File.ReadAllText(manifestPath))!.AsObject();
            manifest["src/bootstrap/entry.ts"]!["file"] = "../escaped.js";
            File.WriteAllText(manifestPath, manifest.ToJsonString());
            ResealManifestMutation(root);
            AssertReadinessFailure(root, "spa_manifest_asset_path_invalid");

            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            manifestPath = Path.Combine(root, "local-unversioned", ".vite", "manifest.json");
            manifest = JsonNode.Parse(File.ReadAllText(manifestPath))!.AsObject();
            manifest["src/bootstrap/entry.ts"]!["css"] = new JsonArray("/assets/absolute.css");
            File.WriteAllText(manifestPath, manifest.ToJsonString());
            ResealManifestMutation(root);
            AssertReadinessFailure(root, "spa_manifest_asset_path_invalid");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_RejectsManifestReferenceMissingFromInventoryOrWithTamperedDigest()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string manifestPath = Path.Combine(root, "local-unversioned", ".vite", "manifest.json");
            JsonObject manifest = JsonNode.Parse(File.ReadAllText(manifestPath))!.AsObject();
            manifest["src/bootstrap/entry.ts"]!["file"] = "assets/not-in-inventory.js";
            File.WriteAllText(manifestPath, manifest.ToJsonString());
            File.WriteAllText(Path.Combine(GetReleaseAssetRoot(root), "assets", "not-in-inventory.js"), "not-in-inventory");
            ResealManifestMutation(root);
            AssertReadinessFailure(root, "spa_asset_inventory_materialization_mismatch");

            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            string inventoryPath = Path.Combine(root, "local-unversioned", "asset-manifest.json");
            JsonObject inventory = JsonNode.Parse(File.ReadAllText(inventoryPath))!.AsObject();
            JsonObject entry = inventory["files"]!.AsArray()
                .Select(static item => item!.AsObject())
                .Single(static item => item["path"]!.GetValue<string>() == "assets/index-abc.js");
            entry["sha256"] = "sha256:" + new string('f', 64);
            File.WriteAllText(inventoryPath, inventory.ToJsonString());
            ResealDescriptor(root);
            AssertReadinessFailure(root, "spa_asset_inventory_file_digest_mismatch");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Production_SemanticDigestIsIndependentOfManifestEntryOrder()
    {
        string root = CreateTempDirectory();
        try
        {
            WriteManifest(root, "public-page-a.css", s_initialManifestVersionUtc);
            var env = new TestWebHostEnvironment(root, Environments.Production);
            string first = CreateService(root, env).GetFrontendAssetVersion();
            string manifest = Path.Combine(root, "wwwroot", ".vite", "manifest.json");
            JsonObject source = JsonNode.Parse(File.ReadAllText(manifest))!.AsObject();
            var reversed = new JsonObject();
            foreach ((string key, JsonNode? value) in source.Reverse())
            {
                reversed[key] = value?.DeepClone();
            }
            File.WriteAllText(manifest, reversed.ToJsonString());
            WriteDescriptor(root);
            Assert.Equal(first, CreateService(root, new TestWebHostEnvironment(root, Environments.Production)).GetFrontendAssetVersion());
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static string CreateTempDirectory()
    {
        string path = Path.Combine(Path.GetTempPath(), "fsus-manifest-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(path, "wwwroot", ".vite"));
        Directory.CreateDirectory(Path.Combine(path, "wwwroot", "assets"));
        File.WriteAllText(Path.Combine(path, "wwwroot", "index.html"), "<html><head></head><body><div id=\"app\"></div></body></html>");
        return path;
    }

    private static string GetReleaseAssetRoot(string root)
        => Path.Combine(root, "local-unversioned");

    private static string GetDescriptorPath(string root)
        => Path.Combine(GetReleaseAssetRoot(root), "spa-manifest-descriptor.json");

    private static string GetReceiptPath(string root)
        => Path.Combine(GetReleaseAssetRoot(root), "production-build-receipt.json");

    private static void WriteManifest(string root, string publicCss, DateTime versionUtc)
    {
        string manifestPath = Path.Combine(root, "wwwroot", ".vite", "manifest.json");
        File.WriteAllText(manifestPath, $$"""
{
  "src/bootstrap/entry.ts": {
    "file": "assets/index-abc.js",
    "name": "route-public",
    "css": [
      "assets/full-app-core-a.css",
      "assets/public-shell-critical-a.css",
      "assets/tailwind-a.css",
      "assets/vendor-element-plus-a.css",
      "assets/markdown-a.css",
      "assets/{{publicCss}}"
    ]
  },
  "_entry-runtime-a.js": {
    "file": "assets/entry-runtime-a.js",
    "name": "entry-runtime"
  },
  "_full-app-core-a.js": {
    "file": "assets/full-app-core-a.js",
    "name": "full-app-core",
    "imports": ["_full-app-core-a.css"]
  },
  "_vendor-element-plus-a.js": {
    "file": "assets/vendor-element-plus-a.js",
    "name": "vendor-element-plus",
    "imports": ["_vendor-element-plus-a.css"]
  },
  "_full-app-core-a.css": {
    "file": "assets/full-app-core-a.css"
  },
  "_vendor-element-plus-a.css": {
    "file": "assets/vendor-element-plus-a.css"
  },
  "src/views/admin/Dashboard.vue": {
    "file": "assets/admin-a.js",
    "name": "route-admin",
    "css": ["assets/admin-a.css"]
  },
  "public-runtime": { "file": "assets/public-runtime.js", "name": "public-page-runtime" },
  "public-critical": { "file": "assets/public-shell-critical-a.css", "name": "public-shell-critical" },
  "tailwind": { "file": "assets/tailwind-a.css", "name": "tailwind" },
  "public-page": { "file": "assets/{{publicCss}}", "name": "public-page" },
  "markdown": { "file": "assets/markdown-a.css", "name": "markdown" },
  "user": { "file": "assets/user.js", "name": "route-user" },
  "auth": { "file": "assets/auth.js", "name": "route-auth" },
  "error": { "file": "assets/error.js", "name": "route-error" }
}
""");
        File.SetLastWriteTimeUtc(manifestPath, versionUtc);
        Assert.Equal(versionUtc, File.GetLastWriteTimeUtc(manifestPath));
        WriteDescriptor(root);
    }

    private static SpaAssetManifestService CreateService(
        string root,
        TestWebHostEnvironment env,
        string? descriptorPath = null,
        string? receiptPath = null,
        string? releaseId = null,
        int? retryIntervalMilliseconds = null,
        int? admissionDeadlineMilliseconds = null,
        Action? onLoadStartedForTests = null)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["FSUSBLOG_SPA_MANIFEST_DESCRIPTOR"] = descriptorPath ?? GetDescriptorPath(root),
                ["FSUSBLOG_PRODUCTION_BUILD_RECEIPT"] = receiptPath ?? GetReceiptPath(root),
                ["FSUSBLOG_RELEASE_ASSET_ROOT"] = root,
                ["FSUSBLOG_RELEASE_ID"] = releaseId,
                ["FSUSBLOG_SPA_MANIFEST_RETRY_INTERVAL_MS"] = retryIntervalMilliseconds?.ToString(),
                ["FSUSBLOG_SPA_MANIFEST_RETRY_ADMISSION_DEADLINE_MS"] = admissionDeadlineMilliseconds?.ToString()
            })
            .Build();
        var releaseIdentity = new ReleaseIdentityProvider(configuration);
        return onLoadStartedForTests is null
            ? new SpaAssetManifestService(
                env,
                configuration,
                releaseIdentity,
                NullLogger<SpaAssetManifestService>.Instance)
            : new SpaAssetManifestService(
                env,
                configuration,
                releaseIdentity,
                NullLogger<SpaAssetManifestService>.Instance,
                onLoadStartedForTests);
    }

    private static void AssertReadinessFailure(string root, string expectedError)
    {
        SpaAssetManifestReadiness readiness = CreateService(root, new TestWebHostEnvironment(root, Environments.Production)).GetReadiness();
        Assert.Equal("failed", readiness.Status);
        Assert.Equal(expectedError, readiness.Error);
    }

    private static void WriteDescriptor(string root)
    {
        const string ReleaseId = "local-unversioned";
        string assetRoot = GetReleaseAssetRoot(root);
        if (Directory.Exists(assetRoot))
        {
            Directory.Delete(assetRoot, recursive: true);
        }
        Directory.CreateDirectory(Path.Combine(assetRoot, ".vite"));
        Directory.CreateDirectory(Path.Combine(assetRoot, "assets"));
        File.Copy(Path.Combine(root, "wwwroot", "index.html"), Path.Combine(assetRoot, "index.html"), overwrite: true);
        File.Copy(Path.Combine(root, "wwwroot", ".vite", "manifest.json"), Path.Combine(assetRoot, ".vite", "manifest.json"), overwrite: true);
        using JsonDocument manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(assetRoot, ".vite", "manifest.json")));
        HashSet<string> assets = ["index.html", ".vite/manifest.json", "assets/fsus-spa-entry.js"];
        foreach (JsonProperty entry in manifest.RootElement.EnumerateObject())
        {
            foreach (string property in new[] { "file", "css" })
            {
                if (!entry.Value.TryGetProperty(property, out JsonElement value))
                    continue;
                if (value.ValueKind == JsonValueKind.String)
                    assets.Add(value.GetString()!);
                if (value.ValueKind == JsonValueKind.Array)
                {
                    foreach (JsonElement item in value.EnumerateArray())
                        assets.Add(item.GetString()!);
                }
            }
        }
        foreach (string asset in assets.Where(static asset => asset.StartsWith("assets/", StringComparison.Ordinal)))
        {
            string path = Path.Combine(assetRoot, asset.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, asset);
        }
        string inventoryPath = Path.Combine(assetRoot, "asset-manifest.json");
        File.WriteAllText(inventoryPath, $$"""
        { "schema": "fsusblog.release-assets.v1", "releaseId": "{{ReleaseId}}", "frontendBuildId": "{{ReleaseId}}", "files": [{{string.Join(',', assets.OrderBy(static asset => asset, StringComparer.Ordinal).Select(asset => $"{{\"path\":\"{asset}\",\"sha256\":\"{Digest(Path.Combine(assetRoot, asset.Replace('/', Path.DirectorySeparatorChar)))}\",\"bytes\":{new FileInfo(Path.Combine(assetRoot, asset.Replace('/', Path.DirectorySeparatorChar))).Length}}}"))}}] }
        """);
        string manifestPath = Path.Combine(assetRoot, ".vite", "manifest.json");
        string receiptPath = GetReceiptPath(root);
        JsonNode[] artifactNodes = assets
            .OrderBy(static asset => asset, StringComparer.Ordinal)
            .Select(asset =>
            {
                string file = Path.Combine(assetRoot, asset.Replace('/', Path.DirectorySeparatorChar));
                return (JsonNode)new JsonObject
                {
                    ["path"] = "frontend-dist/" + asset,
                    ["size"] = new FileInfo(file).Length,
                    ["sha256"] = Digest(file)
                };
            })
            .ToArray();
        var receipt = new JsonObject
        {
            ["schema"] = "fsusblog.ci-production-build-receipt.v1",
            ["status"] = "complete",
            ["sourceState"] = new JsonObject
            {
                ["commit"] = new string('0', 40),
                ["worktreeFingerprint"] = "sha256:" + new string('a', 64)
            },
            ["producer"] = new JsonObject
            {
                ["workflow"] = "Quality Gate",
                ["runId"] = "1665",
                ["runAttempt"] = 1,
                ["job"] = "production-build-artifacts"
            },
            ["toolchain"] = new JsonObject
            {
                ["node"] = "v24.1.0",
                ["npm"] = "11.0.0",
                ["dotnet"] = "10.0.1",
                ["vite"] = "7.0.0",
                ["vitest"] = "4.0.0",
                ["playwright"] = "1.58.0",
                ["emsdk"] = "4.0.0"
            },
            ["inputDigests"] = new JsonArray
            {
                new JsonObject
                {
                    ["path"] = "global.json",
                    ["fileCount"] = 1,
                    ["size"] = 1,
                    ["sha256"] = "sha256:" + new string('b', 64)
                }
            },
            ["build"] = new JsonObject
            {
                ["profile"] = "production-release-fresh",
                ["command"] = "./tools/test.sh ci-tier production-build-artifacts"
            },
            ["domains"] = new JsonArray
            {
                new JsonObject
                {
                    ["name"] = "frontend-dist",
                    ["path"] = "frontend-dist",
                    ["consumerMode"] = "read-only",
                    ["fileCount"] = artifactNodes.Length
                }
            },
            ["artifacts"] = new JsonArray(artifactNodes),
            ["metrics"] = new JsonObject
            {
                ["artifactCount"] = artifactNodes.Length,
                ["artifactBytes"] = assets.Sum(asset => new FileInfo(Path.Combine(
                    assetRoot,
                    asset.Replace('/', Path.DirectorySeparatorChar))).Length)
            },
            ["digestTable"] = new JsonObject
            {
                ["authority"] = "receipt.artifacts",
                ["traversalCount"] = 1,
                ["entryCount"] = artifactNodes.Length
            },
            ["seal"] = new JsonObject
            {
                ["mode"] = "read-only-files",
                ["atomicReceipt"] = true,
                ["sealedAt"] = "2026-07-26T01:00:00Z"
            },
            ["createdAt"] = "2026-07-26T01:00:00Z",
            ["contentDigest"] = null
        };
        using (JsonDocument receiptDocument = JsonDocument.Parse(receipt.ToJsonString()))
        {
            receipt["contentDigest"] = DigestCanonicalReceipt(receiptDocument.RootElement);
        }
        string receiptDigest = receipt["contentDigest"]!.GetValue<string>();
        File.WriteAllText(receiptPath, receipt.ToJsonString());
        string descriptorPath = GetDescriptorPath(root);
        File.WriteAllText(descriptorPath, $$"""
        {
          "schema": "fsusblog.spa-manifest-descriptor.v1",
          "releaseId": "{{ReleaseId}}",
          "sourceCommit": "{{new string('0', 40)}}",
          "worktreeFingerprint": "sha256:{{new string('a', 64)}}",
          "buildReceiptDigest": "{{receiptDigest}}",
          "assetRoot": "{{assetRoot.Replace("\\", "\\\\")}}",
          "manifestPath": "{{manifestPath.Replace("\\", "\\\\")}}",
          "manifestDigest": "{{Digest(manifestPath)}}",
          "assetInventoryDigest": "{{Digest(inventoryPath)}}",
          "contentDigest": ""
        }
        """);
        ResealDescriptorDigest(root);
    }

    private static string CreateRetainedGeneration(string root, string releaseId)
    {
        string source = GetReleaseAssetRoot(root);
        string retainedRoot = Path.Combine(root, releaseId);
        CopyDirectory(source, retainedRoot);

        string inventoryPath = Path.Combine(retainedRoot, "asset-manifest.json");
        JsonObject inventory = JsonNode.Parse(File.ReadAllText(inventoryPath))!.AsObject();
        inventory["releaseId"] = releaseId;
        inventory["frontendBuildId"] = releaseId;
        File.WriteAllText(inventoryPath, inventory.ToJsonString());

        string descriptorPath = Path.Combine(retainedRoot, "spa-manifest-descriptor.json");
        JsonObject descriptor = JsonNode.Parse(File.ReadAllText(descriptorPath))!.AsObject();
        descriptor["releaseId"] = releaseId;
        descriptor["assetRoot"] = retainedRoot;
        descriptor["manifestPath"] = Path.Combine(retainedRoot, ".vite", "manifest.json");
        descriptor["assetInventoryDigest"] = Digest(inventoryPath);
        File.WriteAllText(descriptorPath, descriptor.ToJsonString());
        ResealDescriptorDigestAt(descriptorPath);
        return retainedRoot;
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (string file in Directory.GetFiles(source))
        {
            File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
        }
        foreach (string directory in Directory.GetDirectories(source))
        {
            CopyDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)));
        }
    }

    private static void ResealDescriptor(string root)
    {
        string assetRoot = Path.Combine(root, "local-unversioned");
        string manifestPath = Path.Combine(assetRoot, ".vite", "manifest.json");
        string inventoryPath = Path.Combine(assetRoot, "asset-manifest.json");
        string descriptorPath = GetDescriptorPath(root);
        JsonNode descriptor = JsonNode.Parse(File.ReadAllText(descriptorPath))!;
        descriptor["manifestDigest"] = Digest(manifestPath);
        descriptor["assetInventoryDigest"] = Digest(inventoryPath);
        File.WriteAllText(descriptorPath, descriptor.ToJsonString());
        ResealDescriptorDigest(root);
    }

    private static void ReplaceInventoryFileAndReseal(string root, string relativePath, string contents)
    {
        string assetRoot = GetReleaseAssetRoot(root);
        string path = Path.Combine(assetRoot, relativePath.Replace('/', Path.DirectorySeparatorChar));
        File.WriteAllText(path, contents);

        string inventoryPath = Path.Combine(assetRoot, "asset-manifest.json");
        JsonObject inventory = JsonNode.Parse(File.ReadAllText(inventoryPath))!.AsObject();
        JsonObject inventoryEntry = inventory["files"]!.AsArray()
            .Select(static item => item!.AsObject())
            .Single(item => item["path"]!.GetValue<string>() == relativePath);
        inventoryEntry["sha256"] = Digest(path);
        inventoryEntry["bytes"] = new FileInfo(path).Length;
        File.WriteAllText(inventoryPath, inventory.ToJsonString());

        string receiptPath = GetReceiptPath(root);
        JsonObject receipt = JsonNode.Parse(File.ReadAllText(receiptPath))!.AsObject();
        JsonObject receiptEntry = receipt["artifacts"]!.AsArray()
            .Select(static item => item!.AsObject())
            .Single(item => item["path"]!.GetValue<string>() == "frontend-dist/" + relativePath);
        receiptEntry["sha256"] = Digest(path);
        receiptEntry["size"] = new FileInfo(path).Length;
        receipt["metrics"]!["artifactBytes"] = receipt["artifacts"]!.AsArray()
            .Select(static item => item!.AsObject()["size"]!.GetValue<long>())
            .Sum();
        File.WriteAllText(receiptPath, receipt.ToJsonString());
        ResealReceiptDigest(root, updateDescriptor: true);
        ResealDescriptor(root);
    }

    private static void ResealManifestMutation(string root)
    {
        string assetRoot = GetReleaseAssetRoot(root);
        string manifestPath = Path.Combine(assetRoot, ".vite", "manifest.json");
        string inventoryPath = Path.Combine(assetRoot, "asset-manifest.json");
        JsonObject inventory = JsonNode.Parse(File.ReadAllText(inventoryPath))!.AsObject();
        JsonObject inventoryManifest = inventory["files"]!.AsArray()
            .Select(static item => item!.AsObject())
            .Single(static item => item["path"]!.GetValue<string>() == ".vite/manifest.json");
        inventoryManifest["sha256"] = Digest(manifestPath);
        inventoryManifest["bytes"] = new FileInfo(manifestPath).Length;
        File.WriteAllText(inventoryPath, inventory.ToJsonString());

        string receiptPath = GetReceiptPath(root);
        JsonObject receipt = JsonNode.Parse(File.ReadAllText(receiptPath))!.AsObject();
        JsonObject receiptManifest = receipt["artifacts"]!.AsArray()
            .Select(static item => item!.AsObject())
            .Single(static item => item["path"]!.GetValue<string>() == "frontend-dist/.vite/manifest.json");
        receiptManifest["sha256"] = Digest(manifestPath);
        receiptManifest["size"] = new FileInfo(manifestPath).Length;
        receipt["metrics"]!["artifactBytes"] = receipt["artifacts"]!.AsArray()
            .Select(static item => item!.AsObject()["size"]!.GetValue<long>())
            .Sum();
        File.WriteAllText(receiptPath, receipt.ToJsonString());
        ResealReceiptDigest(root, updateDescriptor: true);
        ResealDescriptor(root);
    }

    private static void ResealReceiptDigest(string root, bool updateDescriptor)
    {
        string receiptPath = GetReceiptPath(root);
        JsonNode receipt = JsonNode.Parse(File.ReadAllText(receiptPath))!;
        receipt["contentDigest"] = null;
        using (JsonDocument receiptDocument = JsonDocument.Parse(receipt.ToJsonString()))
        {
            receipt["contentDigest"] = DigestCanonicalReceipt(receiptDocument.RootElement);
        }
        File.WriteAllText(receiptPath, receipt.ToJsonString());
        if (!updateDescriptor)
        {
            return;
        }

        string descriptorPath = GetDescriptorPath(root);
        JsonNode descriptor = JsonNode.Parse(File.ReadAllText(descriptorPath))!;
        descriptor["buildReceiptDigest"] = receipt["contentDigest"]!.GetValue<string>();
        File.WriteAllText(descriptorPath, descriptor.ToJsonString());
        ResealDescriptorDigest(root);
    }

    private static void ResealDescriptorDigest(string root)
    {
        ResealDescriptorDigestAt(GetDescriptorPath(root));
    }

    private static void ResealDescriptorDigestAt(string descriptorPath)
    {
        JsonNode descriptor = JsonNode.Parse(File.ReadAllText(descriptorPath))!;
        descriptor["contentDigest"] = null;
        using (JsonDocument descriptorDocument = JsonDocument.Parse(descriptor.ToJsonString()))
        {
            descriptor["contentDigest"] = DigestCanonicalReceipt(descriptorDocument.RootElement);
        }
        File.WriteAllText(descriptorPath, descriptor.ToJsonString());
    }

    private static string Digest(string path) => "sha256:" + Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path)));

    private static string DigestCanonicalReceipt(JsonElement receipt)
    {
        using var bytes = new MemoryStream();
        using (var writer = new Utf8JsonWriter(bytes, new JsonWriterOptions
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
        }))
        {
            WriteCanonicalReceipt(writer, receipt, omitContentDigest: true);
        }
        return "sha256:" + Convert.ToHexStringLower(SHA256.HashData(bytes.ToArray()));
    }

    private static void WriteCanonicalReceipt(Utf8JsonWriter writer, JsonElement value, bool omitContentDigest)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            writer.WriteStartObject();
            foreach (JsonProperty property in value.EnumerateObject()
                .Where(property => !omitContentDigest || property.Name != "contentDigest")
                .OrderBy(static property => property.Name, StringComparer.Ordinal))
            {
                writer.WritePropertyName(property.Name);
                WriteCanonicalReceipt(writer, property.Value, omitContentDigest: false);
            }
            writer.WriteEndObject();
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            writer.WriteStartArray();
            foreach (JsonElement item in value.EnumerateArray())
            {
                WriteCanonicalReceipt(writer, item, omitContentDigest: false);
            }
            writer.WriteEndArray();
        }
        else
        {
            value.WriteTo(writer);
        }
    }

    private sealed class TestWebHostEnvironment(string root, string environmentName) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(SpaAssetManifestServiceTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = environmentName;
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
