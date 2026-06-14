using FsusBlog.Server.Infrastructure.Cache;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class HotStatsInvalidationCoalescerTests
{
    [Fact]
    public async Task FlushPendingAsync_CoalescesManyDirtyMarksIntoOneFlush()
    {
        var dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        var httpInvalidator = Substitute.For<IHttpCacheInvalidator>();
        await using ServiceProvider provider = new ServiceCollection()
            .AddSingleton(dispatcher)
            .AddSingleton(httpInvalidator)
            .AddSingleton(new CacheInvalidationRuntimeState())
            .BuildServiceProvider();
        var sut = new HotStatsInvalidationCoalescer(
            provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<HotStatsInvalidationCoalescer>.Instance);

        for (int i = 0; i < 10; i++)
        {
            sut.MarkStatsDirty("visit-log-flush");
            sut.MarkHotArticlesDirty("article-read-projection");
        }

        long beforeVersion = sut.CurrentHotArticlesVersion;
        await sut.FlushPendingAsync();

        await dispatcher.Received(1).InvalidateStatsAsync(Arg.Any<CancellationToken>());
        await httpInvalidator.Received(1).InvalidateAsync(CacheTag.HotArticles);
        HotStatsInvalidationSnapshot snapshot = sut.Snapshot();
        Assert.False(snapshot.StatsDirty);
        Assert.False(snapshot.HotArticlesDirty);
        Assert.Equal(10, snapshot.StatsDirtyCount);
        Assert.Equal(10, snapshot.HotArticlesDirtyCount);
        Assert.Equal(1, snapshot.StatsFlushCount);
        Assert.Equal(1, snapshot.HotArticlesFlushCount);
        Assert.Equal(10, snapshot.StatsCoalescedDirtyCount);
        Assert.Equal(10, snapshot.HotArticlesCoalescedDirtyCount);
        Assert.True(snapshot.HotArticlesVersion > beforeVersion);
    }

    [Fact]
    public async Task FlushPendingAsync_WhenHotArticlesInvalidationFails_DoesNotAdvanceVersion()
    {
        var dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        var httpInvalidator = Substitute.For<IHttpCacheInvalidator>();
        httpInvalidator
            .InvalidateAsync(CacheTag.HotArticles)
            .Returns(Task.FromException(new InvalidOperationException("hot articles cache unavailable")));
        await using ServiceProvider provider = new ServiceCollection()
            .AddSingleton(dispatcher)
            .AddSingleton(httpInvalidator)
            .AddSingleton(new CacheInvalidationRuntimeState())
            .BuildServiceProvider();
        var sut = new HotStatsInvalidationCoalescer(
            provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<HotStatsInvalidationCoalescer>.Instance);

        sut.MarkHotArticlesDirty("article-read-projection");
        long beforeVersion = sut.CurrentHotArticlesVersion;

        await sut.FlushPendingAsync();

        HotStatsInvalidationSnapshot snapshot = sut.Snapshot();
        Assert.Equal(beforeVersion, snapshot.HotArticlesVersion);
        Assert.True(snapshot.HotArticlesDirty);
        Assert.Equal(1, snapshot.HotArticlesDirtyCount);
        Assert.Equal(0, snapshot.HotArticlesFlushCount);
        Assert.Equal(0, snapshot.HotArticlesCoalescedDirtyCount);
        await httpInvalidator.Received(1).InvalidateAsync(CacheTag.HotArticles);
    }

    [Fact]
    public void Source_VisitLogMarksDirtyInsteadOfDirectBroadInvalidation()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src/backend/Services/VisitLog/VisitLogProcessorService.cs"));

        Assert.Contains("GetRequiredService<IHotStatsInvalidationCoalescer>()", source, StringComparison.Ordinal);
        Assert.Contains("MarkStatsDirty(\"visit-log-flush\")", source, StringComparison.Ordinal);
        Assert.Contains("MarkHotArticlesDirty(\"article-read-projection\")", source, StringComparison.Ordinal);
        Assert.DoesNotContain("InvalidateStatsAsync(token)", source, StringComparison.Ordinal);
        Assert.DoesNotContain("InvalidateHotArticlesAsync(token)", source, StringComparison.Ordinal);
    }

    private static string FindRepoRoot()
    {
        DirectoryInfo? current = new(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "FsusBlog.slnx")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException("repo root not found");
    }
}
