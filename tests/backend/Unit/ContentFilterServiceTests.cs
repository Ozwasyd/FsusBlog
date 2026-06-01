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
    public void ValidateContent_WithTopRedLineTerm_IsBlocked()
    {
        string root = CreateTempDirectory();
        try
        {
            using var service = new ContentFilterService(new TestWebHostEnvironment(root), NullLogger<ContentFilterService>.Instance);
            var result = service.ValidateContent("这条评论提到习近平相关内容");
            Assert.False(result.IsValid);
            Assert.Equal("political_redline_detected", result.ReasonCode);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData("广告关键词 加v", "广告关键词", "", "contact_lead_detected")]
    [InlineData("广告关键词 习近平", "广告关键词", "", "malicious_ad_detected")]
    [InlineData("违禁词汇 毛泽东", "", "违禁词汇", "political_redline_detected")]
    [InlineData("共享关键词", "共享关键词", "共享关键词", "malicious_ad_detected")]
    public void ValidateContent_WhenMultipleRuleKindsMatch_PreservesPriorityOrder(
        string text,
        string adWord,
        string sensitiveWord,
        string expectedReasonCode)
    {
        string root = CreateTempDirectory();
        try
        {
            string dictDir = Path.Combine(root, "Dictionaries");
            Directory.CreateDirectory(dictDir);
            File.WriteAllLines(Path.Combine(dictDir, "SensitiveWords.txt"), string.IsNullOrEmpty(sensitiveWord) ? [] : [sensitiveWord]);
            File.WriteAllLines(Path.Combine(dictDir, "AdWords.txt"), string.IsNullOrEmpty(adWord) ? [] : [adWord]);

            using var service = new ContentFilterService(new TestWebHostEnvironment(root), NullLogger<ContentFilterService>.Instance);
            var result = service.ValidateContent(text);

            Assert.False(result.IsValid);
            Assert.Equal(expectedReasonCode, result.ReasonCode);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ReloadKeywords_UpdatesUnifiedRuleSearch()
    {
        string root = CreateTempDirectory();
        try
        {
            string dictDir = Path.Combine(root, "Dictionaries");
            Directory.CreateDirectory(dictDir);
            string sensitivePath = Path.Combine(dictDir, "SensitiveWords.txt");
            string adPath = Path.Combine(dictDir, "AdWords.txt");
            File.WriteAllLines(sensitivePath, []);
            File.WriteAllLines(adPath, []);

            using var service = new ContentFilterService(new TestWebHostEnvironment(root), NullLogger<ContentFilterService>.Instance);
            Assert.True(service.ValidateContent("这里有新广告词").IsValid);

            File.WriteAllLines(adPath, ["新广告词"]);
            service.ReloadKeywords();
            var result = service.ValidateContent("这里有新广告词");

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

    [Fact]
    public void ContentFilterService_DictionaryRetryDoesNotUseThreadSleep()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src", "backend", "Services", "Security", "ContentFilterService.cs"));

        Assert.DoesNotContain("Thread.Sleep", source, StringComparison.Ordinal);
        Assert.DoesNotContain(".GetAwaiter().GetResult()", source, StringComparison.Ordinal);
        Assert.Contains("WaitForReloadRetryAsync", source, StringComparison.Ordinal);
        Assert.Contains("WaitForStartupReloadRetry", source, StringComparison.Ordinal);
    }

    [Fact]
    public void ContentFilterService_UsesUnifiedTaggedAutomaton()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src", "backend", "Services", "Security", "ContentFilterService.cs"));

        Assert.DoesNotContain("_sensitiveSearch", source, StringComparison.Ordinal);
        Assert.DoesNotContain("_adSearch", source, StringComparison.Ordinal);
        Assert.DoesNotContain("_contactSearch", source, StringComparison.Ordinal);
        Assert.DoesNotContain("TopRedLineRegex", source, StringComparison.Ordinal);
        Assert.DoesNotContain(".ContainsAny(bufferSpan)", source, StringComparison.Ordinal);
        Assert.Contains("TryFindBest(bufferSpan", source, StringComparison.Ordinal);
    }

    private static string CreateTempDirectory()
    {
        string path = Path.Combine(Path.GetTempPath(), "fsus-content-filter-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")) ||
                File.Exists(Path.Combine(current, "src", "backend", "Services", "Security", "ContentFilterService.cs")))
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
        public string ApplicationName { get; set; } = nameof(ContentFilterServiceTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = "Development";
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
