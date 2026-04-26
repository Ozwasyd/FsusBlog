using FsusBlog.Server.Infrastructure.PublicAot;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotBackfillSchedulerTests
{
    [Fact]
    public void TrySchedule_WhenQueueIsFull_ReturnsFalse_AndDoesNotLeakInFlight()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["PublicAot:BackfillQueueCapacity"] = "32"
            })
            .Build();
        var scheduler = new PublicAotBackfillScheduler(configuration);
        for (int i = 0; i < scheduler.QueueCapacity; i++)
        {
            bool queued = scheduler.TrySchedule(new PublicAotBackfillRequest(
                PublicPageKind.Home,
                $"home:{i}",
                "/",
                string.Empty,
                $"cache:{i}"));
            Assert.True(queued);
        }

        bool overflowQueued = scheduler.TrySchedule(new PublicAotBackfillRequest(
            PublicPageKind.ArticleDetail,
            "article:99",
            "/article/99",
            string.Empty,
            "cache:overflow"));

        Assert.False(overflowQueued);
        Assert.Equal(scheduler.QueueCapacity, scheduler.InFlightCount);
        Assert.Equal(32, scheduler.QueueCapacity);
    }

    [Fact]
    public void TrySchedule_DuplicateCacheKey_IsDeduplicated()
    {
        IConfiguration configuration = new ConfigurationBuilder().Build();
        var scheduler = new PublicAotBackfillScheduler(configuration);
        var first = new PublicAotBackfillRequest(PublicPageKind.Home, "home", "/", string.Empty, "cache:dup");
        var second = new PublicAotBackfillRequest(PublicPageKind.Home, "home", "/", string.Empty, "cache:dup");

        bool firstQueued = scheduler.TrySchedule(first);
        bool secondQueued = scheduler.TrySchedule(second);

        Assert.True(firstQueued);
        Assert.False(secondQueued);
        Assert.Equal(1, scheduler.InFlightCount);
    }
}
