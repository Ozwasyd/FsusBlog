using FsusBlog.Server.Services.Background;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleBodyRepairQueueTests
{
    [Fact]
    public async Task TrySchedule_DeduplicatesPendingArticle()
    {
        var queue = new ArticleBodyRepairQueue();

        Assert.True(queue.TrySchedule(42, "article-detail-db"));
        Assert.True(queue.TrySchedule(42, "public-aot"));
        Assert.Equal(1, queue.PendingCount);

        await using IAsyncEnumerator<ArticleBodyRepairRequest> reader = queue.ReadAllAsync(CancellationToken.None)
            .GetAsyncEnumerator();
        Assert.True(await reader.MoveNextAsync());
        Assert.Equal(new ArticleBodyRepairRequest(42, "article-detail-db"), reader.Current);
    }

    [Fact]
    public void Complete_AllowsArticleToBeScheduledAgain()
    {
        var queue = new ArticleBodyRepairQueue();
        Assert.True(queue.TrySchedule(7, "search-index"));

        queue.Complete(7);

        Assert.True(queue.TrySchedule(7, "public-hot-read"));
        Assert.Equal(1, queue.PendingCount);
    }

    [Fact]
    public void TrySchedule_RejectsInvalidArticleId()
    {
        var queue = new ArticleBodyRepairQueue();

        Assert.False(queue.TrySchedule(0, "article-detail-db"));
        Assert.Equal(0, queue.PendingCount);
    }

    [Fact]
    public void TrySchedule_StoppedReaderRejects257thArticleAndReleasesPendingAdmission()
    {
        var queue = new ArticleBodyRepairQueue();
        for (int articleId = 1; articleId <= 256; articleId++)
        {
            Assert.True(queue.TrySchedule(articleId, "article-detail-db"));
        }

        Assert.False(queue.TrySchedule(257, "article-detail-db"));
        Assert.Equal(256, queue.PendingCount);
        Assert.False(queue.TrySchedule(257, "public-aot"));
        Assert.Equal(256, queue.PendingCount);
        Assert.True(queue.TrySchedule(1, "public-aot"));
        Assert.Equal(256, queue.PendingCount);
    }

    [Fact]
    public void TrySchedule_ConcurrentRejectedDuplicatesAreNotReportedAsAdmitted()
    {
        var queue = new ArticleBodyRepairQueue();
        for (int articleId = 1; articleId <= 256; articleId++)
        {
            Assert.True(queue.TrySchedule(articleId, "article-detail-db"));
        }

        int accepted = 0;
        Parallel.For(0, 10_000, _ =>
        {
            if (queue.TrySchedule(257, "public-aot"))
            {
                Interlocked.Increment(ref accepted);
            }
        });

        Assert.Equal(0, accepted);
        Assert.Equal(256, queue.PendingCount);
    }

    [Fact]
    public void TrySchedule_100000UniqueArticlesWithStoppedReaderRemainBounded()
    {
        var queue = new ArticleBodyRepairQueue();
        int accepted = 0;
        int maximumPending = 0;
        for (int articleId = 1; articleId <= 100_000; articleId++)
        {
            if (queue.TrySchedule(articleId, "article-detail-db"))
            {
                accepted++;
            }

            maximumPending = Math.Max(maximumPending, queue.PendingCount);
        }

        Assert.Equal(256, accepted);
        Assert.Equal(256, maximumPending);
        Assert.Equal(256, queue.PendingCount);
        Assert.False(queue.TrySchedule(100_000, "public-aot"));
        Assert.Equal(256, queue.PendingCount);
    }

    [Fact]
    public async Task TrySchedule_RejectedArticleCanBeScheduledAfterDrain()
    {
        var queue = new ArticleBodyRepairQueue();
        for (int articleId = 1; articleId <= 256; articleId++)
        {
            Assert.True(queue.TrySchedule(articleId, "article-detail-db"));
        }

        Assert.False(queue.TrySchedule(257, "article-detail-db"));
        Assert.False(queue.TrySchedule(257, "public-aot"));

        await using IAsyncEnumerator<ArticleBodyRepairRequest> reader = queue.ReadAllAsync(CancellationToken.None)
            .GetAsyncEnumerator();
        for (int articleId = 1; articleId <= 256; articleId++)
        {
            Assert.True(await reader.MoveNextAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal(new ArticleBodyRepairRequest(articleId, "article-detail-db"), reader.Current);
            queue.Complete(reader.Current.ArticleId);
        }

        Assert.Equal(0, queue.PendingCount);
        Assert.True(queue.TrySchedule(257, "public-aot"));
        Assert.True(await reader.MoveNextAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(new ArticleBodyRepairRequest(257, "public-aot"), reader.Current);
        queue.Complete(reader.Current.ArticleId);
        Assert.Equal(0, queue.PendingCount);

        Assert.True(queue.TrySchedule(1, "public-hot-read"));
        Assert.True(await reader.MoveNextAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(new ArticleBodyRepairRequest(1, "public-hot-read"), reader.Current);
        queue.Complete(reader.Current.ArticleId);
        Assert.Equal(0, queue.PendingCount);
    }

    [Fact]
    public async Task TryRetry_FullQueueRejectsRetryAndAllowsRetryAfterDrain()
    {
        var queue = new ArticleBodyRepairQueue();
        Assert.True(queue.TrySchedule(1, "article-detail-db"));
        await using IAsyncEnumerator<ArticleBodyRepairRequest> reader = queue.ReadAllAsync(CancellationToken.None)
            .GetAsyncEnumerator();
        Assert.True(await reader.MoveNextAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5)));
        ArticleBodyRepairRequest failedRequest = reader.Current;

        for (int articleId = 2; articleId <= 257; articleId++)
        {
            Assert.True(queue.TrySchedule(articleId, "public-aot"));
        }

        Assert.Equal(257, queue.PendingCount); // 256 queued plus the worker's in-flight request.
        queue.Complete(failedRequest.ArticleId); // The worker completes before retry admission.
        Assert.False(queue.TryRetry(failedRequest));
        Assert.Equal(256, queue.PendingCount);
        Assert.False(queue.TrySchedule(failedRequest.ArticleId, "public-hot-read"));
        Assert.Equal(256, queue.PendingCount);

        for (int articleId = 2; articleId <= 257; articleId++)
        {
            Assert.True(await reader.MoveNextAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal(new ArticleBodyRepairRequest(articleId, "public-aot"), reader.Current);
            queue.Complete(reader.Current.ArticleId);
        }

        Assert.Equal(0, queue.PendingCount);
        Assert.True(queue.TryRetry(failedRequest));
        Assert.True(await reader.MoveNextAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(failedRequest with
        {
            Attempt = 1
        }, reader.Current);
        queue.Complete(reader.Current.ArticleId);
        Assert.Equal(0, queue.PendingCount);
    }

    [Fact]
    public async Task ReadAllAsync_CancelWaitingReaderDoesNotCloseQueue()
    {
        var queue = new ArticleBodyRepairQueue();
        using var cancellation = new CancellationTokenSource();
        await using (IAsyncEnumerator<ArticleBodyRepairRequest> reader = queue.ReadAllAsync(cancellation.Token)
            .GetAsyncEnumerator())
        {
            Task<bool> waiting = reader.MoveNextAsync().AsTask();
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(
                () => waiting.WaitAsync(TimeSpan.FromSeconds(5)));
        }

        Assert.Equal(0, queue.PendingCount);
        Assert.True(queue.TrySchedule(42, "public-aot"));
        await using IAsyncEnumerator<ArticleBodyRepairRequest> replacementReader = queue.ReadAllAsync(CancellationToken.None)
            .GetAsyncEnumerator();
        Assert.True(await replacementReader.MoveNextAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(new ArticleBodyRepairRequest(42, "public-aot"), replacementReader.Current);
        queue.Complete(replacementReader.Current.ArticleId);
        Assert.Equal(0, queue.PendingCount);
    }
}
