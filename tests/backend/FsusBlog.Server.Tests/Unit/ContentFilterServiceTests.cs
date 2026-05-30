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

    [Fact]
    public void ValidateContent_EmptyString_IsValid()
    {
        string root = CreateTempDirectory();
        try
        {
            using var service = new ContentFilterService(new TestWebHostEnvironment(root), NullLogger<ContentFilterService>.Instance);
            var result = service.ValidateContent(string.Empty);
            Assert.True(result.IsValid);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ValidateContent_WhitespaceOnly_IsValid()
    {
        string root = CreateTempDirectory();
        try
        {
            using var service = new ContentFilterService(new TestWebHostEnvironment(root), NullLogger<ContentFilterService>.Instance);
            var result = service.ValidateContent("   \t\n  ");
            Assert.True(result.IsValid);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ValidateContent_NormalText_IsValid()
    {
        string root = CreateTempDirectory();
        try
        {
            using var service = new ContentFilterService(new TestWebHostEnvironment(root), NullLogger<ContentFilterService>.Instance);
            var result = service.ValidateContent("这是一段普通的评论内容。");
            Assert.True(result.IsValid);
            Assert.Equal("ok", result.ReasonCode);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData("加v信")]
    [InlineData("vx联系")]
    [InlineData("qq群加入")]
    public void ValidateContent_ContactPattern_IsBlocked(string text)
    {
        string root = CreateTempDirectory();
        try
        {
            using var service = new ContentFilterService(new TestWebHostEnvironment(root), NullLogger<ContentFilterService>.Instance);
            var result = service.ValidateContent(text);
            Assert.False(result.IsValid);
            Assert.Equal("contact_lead_detected", result.ReasonCode);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ValidateContent_WithSensitiveWord_IsBlocked()
    {
        string root = CreateTempDirectory();
        try
        {
            string dictDir = Path.Combine(root, "Dictionaries");
            Directory.CreateDirectory(dictDir);
            File.WriteAllLines(Path.Combine(dictDir, "SensitiveWords.txt"), ["违禁词汇"]);
            File.WriteAllLines(Path.Combine(dictDir, "AdWords.txt"), []);

            using var service = new ContentFilterService(new TestWebHostEnvironment(root), NullLogger<ContentFilterService>.Instance);
            var result = service.ValidateContent("这条评论包含违禁词汇内容");
            Assert.False(result.IsValid);
            Assert.Equal("sensitive_term_detected", result.ReasonCode);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ValidateContent_WithAdWord_IsBlocked()
    {
        string root = CreateTempDirectory();
        try
        {
            string dictDir = Path.Combine(root, "Dictionaries");
            Directory.CreateDirectory(dictDir);
            File.WriteAllLines(Path.Combine(dictDir, "SensitiveWords.txt"), []);
            File.WriteAllLines(Path.Combine(dictDir, "AdWords.txt"), ["广告关键词"]);

            using var service = new ContentFilterService(new TestWebHostEnvironment(root), NullLogger<ContentFilterService>.Instance);
            var result = service.ValidateContent("这里有广告关键词推广");
            Assert.False(result.IsValid);
            Assert.Equal("malicious_ad_detected", result.ReasonCode);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ValidateContent_NormalTextAfterReload_IsValid()
    {
        string root = CreateTempDirectory();
        try
        {
            using var service = new ContentFilterService(new TestWebHostEnvironment(root), NullLogger<ContentFilterService>.Instance);
            service.ReloadKeywords();
            var result = service.ValidateContent("普通内容");
            Assert.True(result.IsValid);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ValidateContent_LongNormalText_IsValid()
    {
        string root = CreateTempDirectory();
        try
        {
            using var service = new ContentFilterService(new TestWebHostEnvironment(root), NullLogger<ContentFilterService>.Instance);
            var longText = string.Join(" ", Enumerable.Repeat("普通内容很好", 100));
            var result = service.ValidateContent(longText);
            Assert.True(result.IsValid);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ReloadKeywords_WithPopulatedFiles_DoesNotThrow()
    {
        string root = CreateTempDirectory();
        try
        {
            string dictDir = Path.Combine(root, "Dictionaries");
            Directory.CreateDirectory(dictDir);
            File.WriteAllLines(Path.Combine(dictDir, "SensitiveWords.txt"), ["word1", "word2", "word3"]);
            File.WriteAllLines(Path.Combine(dictDir, "AdWords.txt"), ["ad1", "ad2"]);

            using var service = new ContentFilterService(new TestWebHostEnvironment(root), NullLogger<ContentFilterService>.Instance);
            var ex = Record.Exception(() => service.ReloadKeywords());
            Assert.Null(ex);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ContentFilterService_DisposeIsIdempotent()
    {
        string root = CreateTempDirectory();
        try
        {
            var service = new ContentFilterService(new TestWebHostEnvironment(root), NullLogger<ContentFilterService>.Instance);
            service.Dispose();
            service.Dispose(); // second dispose should not throw
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
