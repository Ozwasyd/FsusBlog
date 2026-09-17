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
}
