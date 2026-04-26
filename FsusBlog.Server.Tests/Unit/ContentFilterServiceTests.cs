using FsusBlog.Server.Services.Security;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests;

public sealed class ContentFilterServiceTests
{
    [Fact]
    public void ReloadKeywords_AfterDispose_IsNoOp()
    {
        string root = CreateTempDirectory();
        try
        {
            using var service = new ContentFilterService(new TestWebHostEnvironment(root), NullLogger<ContentFilterService>.Instance);
            service.Dispose();

            var exception = Record.Exception(() => service.ReloadKeywords());

            Assert.Null(exception);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static string CreateTempDirectory()
    {
        string path = Path.Combine(Path.GetTempPath(), "fsus-content-filter-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private sealed class TestWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(ContentFilterServiceTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = "Development";
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
