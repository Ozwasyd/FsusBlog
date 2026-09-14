using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Services;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleViewWriteBufferTests
{
    [Fact]
    public async Task FlushAsync_CoalescesSameArticleAndFlushesMultipleArticles()
    {
        var sink = new RecordingArticleViewFlushSink();
        ServiceProvider services = new ServiceCollection()
            .AddScoped<IArticleViewFlushSink>(_ => sink)
            .BuildServiceProvider();
        var buffer = new ArticleViewWriteBuffer(
            services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<ArticleViewWriteBuffer>.Instance);

        await buffer.EnqueueAsync(42);
        await buffer.EnqueueAsync(42, 3);
        await buffer.EnqueueAsync(7, 2);

        ArticleViewFlushResult result = await buffer.FlushAsync();

        Assert.Equal(6, result.AcceptedDelta);
        Assert.Equal(new HashSet<int> { 42, 7 }, result.UpdatedArticleIds);
        Assert.Single(sink.Batches);
        Assert.Equal(4, sink.Batches[0][42]);
        Assert.Equal(2, sink.Batches[0][7]);
    }

    [Fact]
    public async Task FlushAsync_RequeuesSnapshotWhenSinkFails()
    {
        var sink = new RecordingArticleViewFlushSink { ThrowOnFlush = true };
        ServiceProvider services = new ServiceCollection()
            .AddScoped<IArticleViewFlushSink>(_ => sink)
            .BuildServiceProvider();
        var buffer = new ArticleViewWriteBuffer(
            services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<ArticleViewWriteBuffer>.Instance);

        await buffer.EnqueueAsync(42, 5);
        await Assert.ThrowsAsync<InvalidOperationException>(() => buffer.FlushAsync());

        sink.ThrowOnFlush = false;
        ArticleViewFlushResult result = await buffer.FlushAsync();

        Assert.Equal(5, result.AcceptedDelta);
        Assert.Equal(new HashSet<int> { 42 }, result.UpdatedArticleIds);
        Assert.Equal(2, sink.Batches.Count);
    }

    [Fact]
    public async Task StopAsync_FlushesPendingViewsBeforeShutdownCompletes()
    {
        var buffer = new RecordingArticleViewWriteBuffer();
        var worker = new ArticleViewFlushWorker(buffer, NullLogger<ArticleViewFlushWorker>.Instance);

        await worker.StopAsync(CancellationToken.None);

        Assert.Equal(1, buffer.FlushCount);
    }

    [Fact]
    public async Task FlushSink_AfterPersistenceFailureInDerivedDelivery_DoesNotRejectCommittedDelta()
    {
        var articleService = Substitute.For<IArticleCoreService>();
        articleService
            .IncreaseViewCountsAsync(Arg.Any<ArticleViewCountBatchCommand>(), Arg.Any<CancellationToken>())
            .Returns(Result<IReadOnlySet<int>>.Success(new HashSet<int> { 42 }));
        var hotStats = Substitute.For<IHotStatsInvalidationCoalescer>();
        var failedDelivery = Substitute.For<IPublicHotArtifactDeliveryStateStore>();
        failedDelivery
            .MarkDirtyAsync(Arg.Any<PublicHotArtifactDeliveryClass>(), Arg.Any<CancellationToken>())
            .Returns<Task<long>>(_ => throw new InvalidOperationException("redis-offline"));
        var queue = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 8 }),
            failedDelivery);
        var runtime = new CacheInvalidationRuntimeState();
        var sink = new ArticleServiceViewFlushSink(
            articleService,
            hotStats,
            queue,
            NullLogger<ArticleServiceViewFlushSink>.Instance,
            runtime);

        IReadOnlySet<int> updated = await sink.FlushArticleViewsAsync(new Dictionary<int, int> { [42] = 3 });

        Assert.Equal(new HashSet<int> { 42 }, updated);
        Assert.Equal("distributed_degraded", runtime.Snapshot().LastKind);
        await articleService.Received(1).IncreaseViewCountsAsync(
            Arg.Is<ArticleViewCountBatchCommand>(command => command.ArticleCounts[42] == 3),
            Arg.Any<CancellationToken>());
    }

    private sealed class RecordingArticleViewFlushSink : IArticleViewFlushSink
    {
        public List<Dictionary<int, int>> Batches { get; } = [];

        public bool ThrowOnFlush
        {
            get; set;
        }

        public ValueTask<IReadOnlySet<int>> FlushArticleViewsAsync(
            IReadOnlyDictionary<int, int> articleCounts,
            CancellationToken cancellationToken = default)
        {
            Batches.Add(articleCounts.ToDictionary());
            if (ThrowOnFlush)
            {
                throw new InvalidOperationException("flush failed");
            }

            return ValueTask.FromResult<IReadOnlySet<int>>(articleCounts.Keys.ToHashSet());
        }
    }

    private sealed class RecordingArticleViewWriteBuffer : IArticleViewWriteBuffer
    {
        public int FlushCount
        {
            get; private set;
        }

        public ValueTask EnqueueAsync(int articleId, int delta = 1, CancellationToken cancellationToken = default)
            => ValueTask.CompletedTask;

        public Task<ArticleViewFlushResult> FlushAsync(CancellationToken cancellationToken = default)
        {
            FlushCount += 1;
            return Task.FromResult(new ArticleViewFlushResult(0, new HashSet<int>()));
        }
    }
}
