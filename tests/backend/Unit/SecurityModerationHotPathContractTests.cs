using System.Collections.Concurrent;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityModerationHotPathContractTests
{
    [Fact]
    public void ModernAcAutomaton_ConcurrentScansKeepScratchStateIsolated()
    {
        var automaton = new ModernAcAutomaton();
        automaton.Build(["cache+postgresql", "notification", "crawler"]);
        using var barrier = new Barrier(8);
        var results = new ConcurrentBag<bool>();

        Parallel.For(0, 8, index =>
        {
            barrier.SignalAndWait();
            results.Add(index % 2 == 0
                ? automaton.ContainsAny("postgresql cache hot path")
                : !automaton.ContainsAny("ordinary article text"));
        });

        Assert.Equal(8, results.Count);
        Assert.All(results, Assert.True);
    }

    [Fact]
    public void TextAndCrawlerNormalization_PreserveExpectedRuntimeSemantics()
    {
        Assert.Equal("fsusblog", TextNormalizer.Normalize("FSUSｂLOG"));
        string normalizedCrawler = CrawlerDetectorService.NormalizeCrawlerUserAgent(
            "Mozilla/5.0\u200B GOOGLEBOT/2.1");

        Assert.Equal("mozilla/5.0 googlebot/2.1", normalizedCrawler);
        Assert.DoesNotContain('\u200B', normalizedCrawler);
    }

    [Fact]
    public async Task CrawlerCidrLookup_RecognizesConfiguredProviderWithoutDnsFallback()
    {
        var service = new CrawlerDetectorService(
            Microsoft.Extensions.Logging.Abstractions.NullLogger<CrawlerDetectorService>.Instance,
            new Microsoft.Extensions.Caching.Memory.MemoryCache(
                new Microsoft.Extensions.Caching.Memory.MemoryCacheOptions()));
        service.UpdateCidrLists(["66.249.64.0/19"], []);

        Assert.True(await service.IsVerifiedCrawlerAsync("66.249.66.1", "GoogleBot/2.1"));
        Assert.False(await service.IsVerifiedCrawlerAsync("203.0.113.1", "GoogleBot/2.1"));
    }
}
