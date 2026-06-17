using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests;

public sealed class SpaAssetManifestServiceTests
{
    [Fact]
    public void GetPublicAssetSet_DevelopmentViteHost_UsesSourceAssets()
    {
        string root = CreateTempDirectory();
        try
        {
            var env = new TestWebHostEnvironment(root, Environments.Development);
            var service = new SpaAssetManifestService(env, NullLogger<SpaAssetManifestService>.Instance);
            var context = new DefaultHttpContext();
            context.Request.Host = new HostString("localhost:3000");

            SpaAssetSet assets = service.GetPublicAssetSet(context, PublicPageId.Home);

            Assert.True(assets.UsesSourceAssets);
            Assert.Equal("/src/bootstrap/entry.ts", assets.EntryScript);
            Assert.Contains("/src/assets/public-shell-critical.css", assets.Stylesheets);
            Assert.Contains("/src/assets/tailwind.css", assets.Stylesheets);
            Assert.Contains("/src/assets/public-page.css?direct", assets.Stylesheets);
            Assert.DoesNotContain("/src/assets/markdown.css", assets.Stylesheets);
            Assert.Equal("dev-source-assets", assets.FrontendAssetVersion);
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
            WriteManifest(root, "public-page-a.css");
            var env = new TestWebHostEnvironment(root, Environments.Development);
            var service = new SpaAssetManifestService(env, NullLogger<SpaAssetManifestService>.Instance);
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
            WriteManifest(root, "public-page-a.css");
            var env = new TestWebHostEnvironment(root, Environments.Production);
            var service = new SpaAssetManifestService(env, NullLogger<SpaAssetManifestService>.Instance);

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
            WriteManifest(root, "public-page-a.css");
            var env = new TestWebHostEnvironment(root, Environments.Production);
            var service = new SpaAssetManifestService(env, NullLogger<SpaAssetManifestService>.Instance);

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
            WriteManifest(root, "public-page-a.css");
            var env = new TestWebHostEnvironment(root, Environments.Production);
            var service = new SpaAssetManifestService(env, NullLogger<SpaAssetManifestService>.Instance);
            string first = service.GetFrontendAssetVersion();

            Thread.Sleep(1100);
            WriteManifest(root, "public-page-b.css");
            string second = service.GetFrontendAssetVersion();

            Assert.Equal(first, second);
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
            WriteManifest(root, "public-page-a.css");
            var env = new TestWebHostEnvironment(root, Environments.Development);
            var service = new SpaAssetManifestService(env, NullLogger<SpaAssetManifestService>.Instance);
            string first = service.GetFrontendAssetVersion();

            Thread.Sleep(1100);
            WriteManifest(root, "public-page-b.css");
            string second = service.GetFrontendAssetVersion();

            Assert.NotEqual(first, second);
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

    private static void WriteManifest(string root, string publicCss)
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
    "name": "full-app-core"
  },
  "_vendor-element-plus-a.js": {
    "file": "assets/vendor-element-plus-a.js",
    "name": "vendor-element-plus"
  },
  "_full-app-core-a.css": {
    "file": "assets/full-app-core-a.css"
  },
  "src/views/admin/Dashboard.vue": {
    "file": "assets/admin-a.js",
    "name": "route-admin",
    "css": ["assets/admin-a.css"]
  }
}
""");
        File.SetLastWriteTimeUtc(manifestPath, DateTime.UtcNow.AddSeconds(1));
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
