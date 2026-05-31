using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Tests;

public sealed class PublicSpaTemplateLocatorTests
{
    [Fact]
    public async Task Production_ReloadsTemplateAfterFileChanges()
    {
        string root = CreateTempDirectory();
        try
        {
            string indexPath = CreateIndex(root, "<html>v1</html>");
            var env = new TestWebHostEnvironment(root, Environments.Production);
            PublicSpaTemplateLocator.ResetCacheForTests();

            string first = await PublicSpaTemplateLocator.ReadIndexTemplateAsync(env, CancellationToken.None);
            await Task.Delay(1100);
            await File.WriteAllTextAsync(indexPath, "<html>v2</html>");
            File.SetLastWriteTimeUtc(indexPath, DateTime.UtcNow.AddSeconds(1));
            string second = await PublicSpaTemplateLocator.ReadIndexTemplateAsync(env, CancellationToken.None);

            Assert.Equal("<html>v1</html>", first);
            Assert.Equal("<html>v2</html>", second);
        }
        finally
        {
            PublicSpaTemplateLocator.ResetCacheForTests();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task Development_ReloadsTemplateAfterFileChanges()
    {
        string root = CreateTempDirectory();
        try
        {
            string indexPath = CreateIndex(root, "<html>v1</html>");
            var env = new TestWebHostEnvironment(root, Environments.Development);
            PublicSpaTemplateLocator.ResetCacheForTests();

            string first = await PublicSpaTemplateLocator.ReadIndexTemplateAsync(env, CancellationToken.None);
            await Task.Delay(1100);
            await File.WriteAllTextAsync(indexPath, "<html>v2</html>");
            File.SetLastWriteTimeUtc(indexPath, DateTime.UtcNow.AddSeconds(1));
            string second = await PublicSpaTemplateLocator.ReadIndexTemplateAsync(env, CancellationToken.None);

            Assert.Equal("<html>v1</html>", first);
            Assert.Equal("<html>v2</html>", second);
        }
        finally
        {
            PublicSpaTemplateLocator.ResetCacheForTests();
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ReadFrontendAssetVersionAsync_ChangesWhenTemplateChanges()
    {
        string root = CreateTempDirectory();
        try
        {
            string indexPath = CreateIndex(root, "<html><script type=\"module\" src=\"/assets/index-a.js\"></script></html>");
            var env = new TestWebHostEnvironment(root, Environments.Production);
            PublicSpaTemplateLocator.ResetCacheForTests();

            string first = await PublicSpaTemplateLocator.ReadFrontendAssetVersionAsync(env, CancellationToken.None);
            await Task.Delay(1100);
            await File.WriteAllTextAsync(indexPath, "<html><script type=\"module\" src=\"/assets/index-b.js\"></script></html>");
            File.SetLastWriteTimeUtc(indexPath, DateTime.UtcNow.AddSeconds(1));
            string second = await PublicSpaTemplateLocator.ReadFrontendAssetVersionAsync(env, CancellationToken.None);

            Assert.NotEqual(first, second);
        }
        finally
        {
            PublicSpaTemplateLocator.ResetCacheForTests();
            Directory.Delete(root, recursive: true);
        }
    }

    private static string CreateTempDirectory()
    {
        string path = Path.Combine(Path.GetTempPath(), "fsus-template-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        Directory.CreateDirectory(Path.Combine(path, "wwwroot"));
        return path;
    }

    private static string CreateIndex(string root, string html)
    {
        string indexPath = Path.Combine(root, "wwwroot", "index.html");
        File.WriteAllText(indexPath, html);
        return indexPath;
    }

    private sealed class TestWebHostEnvironment(string root, string environmentName) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(PublicSpaTemplateLocatorTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = environmentName;
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
