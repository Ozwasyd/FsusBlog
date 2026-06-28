using FsusBlog.Server.Services;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

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

    private sealed class RecordingArticleViewFlushSink : IArticleViewFlushSink
    {
        public List<Dictionary<int, int>> Batches { get; } = [];

        public bool ThrowOnFlush { get; set; }

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
        public int FlushCount { get; private set; }

        public ValueTask EnqueueAsync(int articleId, int delta = 1, CancellationToken cancellationToken = default)
            => ValueTask.CompletedTask;

        public Task<ArticleViewFlushResult> FlushAsync(CancellationToken cancellationToken = default)
        {
            FlushCount += 1;
            return Task.FromResult(new ArticleViewFlushResult(0, new HashSet<int>()));
        }
    }
}
