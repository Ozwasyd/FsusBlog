using System.Collections.Concurrent;
using System.Reflection;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.VisitLog;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using FsusBlog.Server.Tests.TestInfrastructure;

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
            await sut.MarkStatsDirtyAsync("visit-log-flush");
            await sut.MarkHotArticlesDirtyAsync("article-read-projection");
        }

        long beforeVersion = sut.CurrentHotArticlesVersion;
        await sut.FlushPendingAsync();

        await dispatcher.Received(1).InvalidateStatsAsync(Arg.Any<CancellationToken>());
        await httpInvalidator.Received(1).InvalidateAsync(CacheTag.HotArticles);
        HotStatsInvalidationSnapshot snapshot = await sut.SnapshotAsync();
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

        await sut.MarkHotArticlesDirtyAsync("article-read-projection");
        long beforeVersion = sut.CurrentHotArticlesVersion;

        await sut.FlushPendingAsync();

        HotStatsInvalidationSnapshot snapshot = await sut.SnapshotAsync();
        Assert.Equal(beforeVersion, snapshot.HotArticlesVersion);
        Assert.True(snapshot.HotArticlesDirty);
        Assert.Equal(1, snapshot.HotArticlesDirtyCount);
        Assert.Equal(0, snapshot.HotArticlesFlushCount);
        Assert.Equal(0, snapshot.HotArticlesCoalescedDirtyCount);
        await httpInvalidator.Received(1).InvalidateAsync(CacheTag.HotArticles);
    }

    [Fact]
    public void Runtime_VisitLogMarksDirtyInsteadOfDirectBroadInvalidation()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(VisitLogProcessorService));

        Assert.Contains("GetRequiredService", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("IHotStatsInvalidationCoalescer", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("MarkStatsDirtyAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("visit-log-flush", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("MarkHotArticlesDirtyAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("article-read-projection", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("ICacheInvalidationDispatcher.InvalidateStatsAsync", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("ICacheInvalidationDispatcher.InvalidateHotArticlesAsync", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void VisitLogProcessor_RuntimeUsesAsyncDirtyContract()
    {
        MethodInfo stats = typeof(IHotStatsInvalidationCoalescer).GetMethod(
            nameof(IHotStatsInvalidationCoalescer.MarkStatsDirtyAsync))!;
        MethodInfo hotArticles = typeof(IHotStatsInvalidationCoalescer).GetMethod(
            nameof(IHotStatsInvalidationCoalescer.MarkHotArticlesDirtyAsync))!;
        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(VisitLogProcessorService));

        Assert.Equal(typeof(Task), stats.ReturnType);
        Assert.Equal(typeof(Task), hotArticles.ReturnType);
        Assert.Contains("MarkStatsDirtyAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("visit-log-flush", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("MarkHotArticlesDirtyAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("article-read-projection", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("IHotStatsInvalidationCoalescer.MarkStatsDirty(", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("IHotStatsInvalidationCoalescer.MarkHotArticlesDirty(", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public async Task MarkDirtyAsync_AggregatesDirtyCountsAcrossInstances()
    {
        var cache = CreateSharedCounterCache();
        var dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        var httpInvalidator = Substitute.For<IHttpCacheInvalidator>();
        await using ServiceProvider provider = new ServiceCollection()
            .AddSingleton(dispatcher)
            .AddSingleton(httpInvalidator)
            .AddSingleton(new CacheInvalidationRuntimeState(cache))
            .BuildServiceProvider();
        var first = new HotStatsInvalidationCoalescer(
            provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<HotStatsInvalidationCoalescer>.Instance,
            cache);
        var second = new HotStatsInvalidationCoalescer(
            provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<HotStatsInvalidationCoalescer>.Instance,
            cache);

        await first.MarkStatsDirtyAsync("visit-log-flush");
        await second.MarkStatsDirtyAsync("visit-log-flush");
        await first.MarkHotArticlesDirtyAsync("article-read-projection");
        await second.MarkHotArticlesDirtyAsync("article-read-projection");

        HotStatsInvalidationSnapshot snapshot = await first.SnapshotAsync();

        Assert.Equal(2, snapshot.StatsDirtyCount);
        Assert.Equal(2, snapshot.HotArticlesDirtyCount);
        await cache.Received().IncrementAsync(CachePolicyId.AdminStats, "hot-stats:stats:dirty", 1, Arg.Any<CancellationToken>());
        await cache.Received().IncrementAsync(CachePolicyId.AdminStats, "hot-stats:hot-articles:dirty", 1, Arg.Any<CancellationToken>());
    }

    private static IUnifiedCache CreateSharedCounterCache()
    {
        var values = new ConcurrentDictionary<string, long>(StringComparer.Ordinal);
        var cache = Substitute.For<IUnifiedCache>();
        cache.IncrementAsync(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<long>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                string identity = call.ArgAt<string>(1);
                long value = call.ArgAt<long>(2);
                return values.AddOrUpdate(identity, value, (_, current) => current + value);
            });
        cache.GetStringAsync(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                string identity = call.ArgAt<string>(1);
                return values.TryGetValue(identity, out long value)
                    ? value.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    : null;
            });
        return cache;
    }
}
