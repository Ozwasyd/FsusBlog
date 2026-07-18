using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityModerationHotPathContractTests
{
    [Fact]
    public async Task ModernAcAutomaton_ConcurrentScansKeepScratchStateIsolated()
    {
        var automaton = new ModernAcAutomaton();
        automaton.Build(["cache+postgresql", "notification", "crawler"]);
        const int ParticipantCount = 8;
        var allReady = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int readyCount = 0;

        Task<bool>[] workers = Enumerable.Range(0, ParticipantCount)
            .Select(index => Task.Run(async () =>
            {
                if (Interlocked.Increment(ref readyCount) == ParticipantCount)
                {
                    allReady.TrySetResult();
                }

                await start.Task;
                return index % 2 == 0
                    ? automaton.ContainsAny("postgresql cache hot path")
                    : !automaton.ContainsAny("ordinary article text");
            }))
            .ToArray();

        await allReady.Task;
        start.TrySetResult();
        bool[] results = await Task.WhenAll(workers);

        Assert.Equal(ParticipantCount, results.Length);
        Assert.All(results, Assert.True);
    }

    [Fact]
    public void TextAndCrawlerNormalization_PreserveExpectedRuntimeSemantics()
    {
        Assert.True(TextNormalizer.Initialize(NullLogger.Instance).IsSuccess);
        Assert.Equal("fsusblog", TextNormalizer.Normalize("FSUSｂLOG"));
        Assert.Equal("fsusblog", TextNormalizer.Normalize("ＦＳＵＳＢＬＯＧ"));
        string normalizedCrawler = CrawlerDetectorService.NormalizeCrawlerUserAgent(
            "Mozilla/5.0\u200B GOOGLEBOT/2.1");

        Assert.Equal("mozilla/5.0 googlebot/2.1", normalizedCrawler);
        Assert.DoesNotContain('\u200B', normalizedCrawler);
        Assert.Equal("äbot", CrawlerDetectorService.NormalizeCrawlerUserAgent("ÄBOT"));
        Assert.Same("mozilla/5.0 bot", CrawlerDetectorService.NormalizeCrawlerUserAgent("mozilla/5.0 bot"));
        Assert.Equal(new string('a', 512), CrawlerDetectorService.NormalizeCrawlerUserAgent(new string('A', 513)));
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
