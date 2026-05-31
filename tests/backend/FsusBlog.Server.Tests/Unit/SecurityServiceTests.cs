using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Services.Security;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using System.Net;

namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// ModernAcAutomaton — core AC automaton tests
// ──────────────────────────────────────────────────────────────────────────────

public class ModernAcAutomatonTests
{
    [Fact]
    public void Build_EmptyKeywords_ContainsAnyReturnsFalse()
    {
        var ac = new ModernAcAutomaton();
        ac.Build([]);
        Assert.False(ac.ContainsAny("test text"));
    }

    [Fact]
    public void Build_NullKeywords_ContainsAnyReturnsFalse()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(null!);
        Assert.False(ac.ContainsAny("test"));
    }

    [Fact]
    public void ContainsAny_EmptyText_ReturnsFalse()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["hello"]);
        Assert.False(ac.ContainsAny(string.Empty));
    }

    [Fact]
    public void ContainsAny_ExactMatch_ReturnsTrue()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["forbidden"]);
        Assert.True(ac.ContainsAny("this text contains forbidden word"));
    }

    [Fact]
    public void ContainsAny_NotPresent_ReturnsFalse()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["forbidden"]);
        Assert.False(ac.ContainsAny("this text is clean"));
    }

    [Fact]
    public void ContainsAny_MultipleKeywords_MatchesAny()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["aaa", "bbb", "ccc"]);
        Assert.True(ac.ContainsAny("text with bbb inside"));
    }

    [Fact]
    public void ContainsAny_KeywordAtStart_ReturnsTrue()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["start"]);
        Assert.True(ac.ContainsAny("start of text"));
    }

    [Fact]
    public void ContainsAny_KeywordAtEnd_ReturnsTrue()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["end"]);
        Assert.True(ac.ContainsAny("text at end"));
    }

    [Fact]
    public void ContainsAny_AndRule_BothPresent_ReturnsTrue()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["alpha+beta"]);
        Assert.True(ac.ContainsAny("alpha and beta are both here"));
    }

    [Fact]
    public void ContainsAny_AndRule_OnlyOnePresent_ReturnsFalse()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["alpha+beta"]);
        Assert.False(ac.ContainsAny("only alpha here"));
    }

    [Fact]
    public void ContainsAny_DuplicateKeywords_DeduplicatesGracefully()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["dup", "dup", "dup"]);
        Assert.True(ac.ContainsAny("dup"));
    }

    [Fact]
    public void ContainsAny_WideNodeMatchesViaSortedChildBinarySearch()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["aa", "ab", "ac", "ad", "ae", "af", "ag"]);

        Assert.True(ac.ContainsAny("prefix ag suffix"));
        Assert.False(ac.ContainsAny("prefix az suffix"));
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// CrawlerDetectorService
// ──────────────────────────────────────────────────────────────────────────────

public class CrawlerDetectorServiceTests
{
    private static CrawlerDetectorService CreateService()
    {
        var cache = new MemoryCache(new MemoryCacheOptions());
        return new CrawlerDetectorService(NullLogger<CrawlerDetectorService>.Instance, cache);
    }

    [Fact]
    public async Task IsVerifiedCrawler_EmptyIp_ReturnsFalse()
    {
        var svc = CreateService();
        bool result = await svc.IsVerifiedCrawlerAsync("", "Googlebot/2.1");
        Assert.False(result);
    }

    [Fact]
    public async Task IsVerifiedCrawler_EmptyUserAgent_ReturnsFalse()
    {
        var svc = CreateService();
        bool result = await svc.IsVerifiedCrawlerAsync("66.249.64.1", "");
        Assert.False(result);
    }

    [Fact]
    public async Task IsVerifiedCrawler_TooLongIp_ReturnsFalse()
    {
        var svc = CreateService();
        string longIp = new('1', 65);
        bool result = await svc.IsVerifiedCrawlerAsync(longIp, "Googlebot/2.1");
        Assert.False(result);
    }

    [Fact]
    public async Task IsVerifiedCrawler_InvalidIp_ReturnsFalse()
    {
        var svc = CreateService();
        bool result = await svc.IsVerifiedCrawlerAsync("not.an.ip", "Googlebot/2.1");
        Assert.False(result);
    }

    [Fact]
    public async Task IsVerifiedCrawler_GooglebotWithoutCidr_ReturnsFalse()
    {
        var svc = CreateService();
        // No CIDR loaded, so even a Googlebot IP will fail the tree match
        bool result = await svc.IsVerifiedCrawlerAsync("66.249.64.1", "Mozilla/5.0 (compatible; Googlebot/2.1)");
        Assert.False(result);
    }

    [Fact]
    public async Task IsVerifiedCrawler_UnknownBot_ReturnsFalse()
    {
        var svc = CreateService();
        bool result = await svc.IsVerifiedCrawlerAsync("1.2.3.4", "SomeOtherBot/1.0");
        Assert.False(result);
    }

    [Fact]
    public void UpdateCidrLists_WithValidRanges_DoesNotThrow()
    {
        var svc = CreateService();
        // Should not throw even with lots of valid CIDR ranges
        svc.UpdateCidrLists(["66.249.64.0/19", "66.249.80.0/20"], ["40.77.0.0/17"]);
    }

    [Fact]
    public async Task IsVerifiedCrawler_GooglebotInRegisteredCidr_ReturnsTrue()
    {
        var svc = CreateService();
        svc.UpdateCidrLists(["66.249.64.0/19"], []);
        bool result = await svc.IsVerifiedCrawlerAsync("66.249.64.1", "Mozilla/5.0 (compatible; Googlebot/2.1)");
        Assert.True(result);
    }

    [Fact]
    public async Task IsVerifiedCrawler_BingbotInRegisteredCidr_ReturnsTrue()
    {
        var svc = CreateService();
        svc.UpdateCidrLists([], ["40.77.0.0/17"]);
        bool result = await svc.IsVerifiedCrawlerAsync("40.77.0.1", "Mozilla/5.0 (compatible; bingbot/2.0)");
        Assert.True(result);
    }

    [Fact]
    public async Task IsVerifiedCrawler_GooglebotOutsideCidr_ReturnsFalse()
    {
        var svc = CreateService();
        svc.UpdateCidrLists(["66.249.64.0/19"], []);
        bool result = await svc.IsVerifiedCrawlerAsync("1.2.3.4", "Mozilla/5.0 (compatible; Googlebot/2.1)");
        Assert.False(result);
    }

    [Fact]
    public void UpdateCidrLists_WithInvalidCidrEntries_SkipsInvalid()
    {
        var svc = CreateService();
        svc.UpdateCidrLists(["invalid", "", "66.249.64.0/19", "bad/bad"], []);
        // No exception expected; valid entries still loaded
    }
}
