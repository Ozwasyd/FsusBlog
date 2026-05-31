using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotInvalidationTrackerTests
{
    [Fact]
    public void WasInvalidatedAfter_DetectsExactRouteInvalidation()
    {
        var tracker = new PublicAotInvalidationTracker();
        string cacheKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, "category:1");
        var request = new PublicAotBackfillRequest(
            PublicPageKind.Filter,
            "category:1",
            "/category/1",
            string.Empty,
            cacheKey)
        {
            ScheduledInvalidationVersion = tracker.GetCurrentVersion(PublicPageId.Filter, cacheKey)
        };

        tracker.MarkKey(cacheKey);

        Assert.True(tracker.WasInvalidatedAfter(request, PublicPageId.Filter));
    }

    [Fact]
    public void WasInvalidatedAfter_DetectsPagePrefixInvalidation()
    {
        var tracker = new PublicAotInvalidationTracker();
        string cacheKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, "tag:1");
        var request = new PublicAotBackfillRequest(
            PublicPageKind.Filter,
            "tag:1",
            "/tag/1",
            string.Empty,
            cacheKey)
        {
            ScheduledInvalidationVersion = tracker.GetCurrentVersion(PublicPageId.Filter, cacheKey)
        };

        tracker.MarkPrefix(CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, string.Empty));

        Assert.True(tracker.WasInvalidatedAfter(request, PublicPageId.Filter));
    }
}
