using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Taxonomy;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DataScaleTaxonomyProjectionTests
{
    private static readonly DateTime s_businessNow = new(2026, 9, 14, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void CanonicalVisibility_ExcludesScheduledArchivedAndDeletedArticles()
    {
        // 1. Published article with past publish time => true
        var published = new Article
        {
            Id = 1,
            Title = "data-scale:article:1",
            Status = ArticleStatus.Published,
            IsDeleted = false,
            PublishedAt = s_businessNow.AddMinutes(-5),
            ScheduledPublishAt = null
        };
        Assert.True(ArticlePublication.IsPubliclyVisible(published, s_businessNow));

        // 2. Scheduled article (status = 1) with future scheduled time => false
        var scheduled = new Article
        {
            Id = 7,
            Title = "data-scale:article:7",
            Status = ArticleStatus.Draft, // Status 1
            IsDeleted = false,
            PublishedAt = null,
            ScheduledPublishAt = s_businessNow.AddDays(7)
        };
        Assert.False(ArticlePublication.IsPubliclyVisible(scheduled, s_businessNow));

        // 3. Archived article (status = 3) => false
        var archived = new Article
        {
            Id = 10,
            Title = "data-scale:article:10",
            Status = ArticleStatus.Archived, // Status 3
            IsDeleted = false,
            PublishedAt = s_businessNow.AddHours(-1),
            ScheduledPublishAt = null
        };
        Assert.False(ArticlePublication.IsPubliclyVisible(archived, s_businessNow));

        // 4. Deleted article (status = 4) => false
        var deleted = new Article
        {
            Id = 20,
            Title = "data-scale:article:20",
            Status = ArticleStatus.Deleted, // Status 4
            IsDeleted = true,
            PublishedAt = s_businessNow.AddMinutes(-1),
            ScheduledPublishAt = null
        };
        Assert.False(ArticlePublication.IsPubliclyVisible(deleted, s_businessNow));
    }

    [Fact]
    public void ExpectedTaxonomyModel_CountsOnlyPubliclyVisibleArticles()
    {
        // Simulate data-scale scale-xs (10 articles)
        int articleCount = 10;
        int publicArticles = 0;
        var categoryCounts = new Dictionary<int, int> { [1] = 0, [2] = 0, [3] = 0, [4] = 0 };
        var tagCounts = new Dictionary<int, int>();
        for (int i = 1; i <= 8; i++)
        {
            tagCounts[i] = 0;
        }

        for (int seed = 1; seed <= articleCount; seed++)
        {
            ArticleStatus status = seed % 20 == 0 ? ArticleStatus.Deleted
                : seed % 10 == 0 ? ArticleStatus.Archived
                : seed % 7 == 0 ? ArticleStatus.Draft
                : ArticleStatus.Published;

            bool isDeleted = status == ArticleStatus.Deleted;
            DateTime? publishedAt = status == ArticleStatus.Archived ? s_businessNow.AddHours(-1) : null;
            DateTime? scheduledPublishAt = status == ArticleStatus.Draft ? s_businessNow.AddDays(7) : null;

            bool isPublic = ArticlePublication.IsPubliclyVisible(
                status,
                isDeleted,
                publishedAt,
                scheduledPublishAt,
                s_businessNow);

            if (isPublic)
            {
                publicArticles++;
                int categoryRn = ((seed - 1) % 4) + 1;
                categoryCounts[categoryRn]++;

                int primaryTag = ((seed - 1) % 8) + 1;
                var tags = new HashSet<int> { primaryTag };
                if (seed % 3 == 0)
                {
                    tags.Add((seed % 8) + 1);
                }

                foreach (int tag in tags)
                {
                    tagCounts[tag]++;
                }
            }
        }

        // Seeds 7 (scheduled) and 10 (archived) must NOT be counted
        Assert.Equal(8, publicArticles);
        Assert.Equal(8, categoryCounts.Values.Sum());
        // Tag distinct counts: duplicate relations per article do not inflate tag counts
        Assert.All(tagCounts.Values, count => Assert.True(count is >= 1 and <= 2));
    }

    [Fact]
    public async Task FrameVersion_MonotonicallyAdvancesAndEvictsLegacyKeys()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.TaxonomyFrameVersion, "main", Arg.Any<CancellationToken>())
            .Returns("1");
        cache.IncrementAsync(CachePolicyId.TaxonomyFrameVersion, "main", 1, Arg.Any<CancellationToken>())
            .Returns(2);

        var service = new TaxonomyCountProjectionService(
            Substitute.For<ISqlSugarClient>(),
            cache,
            cache,
            cache,
            Substitute.For<IHttpCacheInvalidator>());

        long newVersion = await service.BumpFrameVersionAsync("data-scale-taxonomy-projection");

        Assert.Equal(2, newVersion);
        await cache.Received(1).RemoveManyAsync(
            Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
                keys.Any(k => k.PolicyId == CachePolicyId.CategoryFrame && k.Identity == "all")
                && keys.Any(k => k.PolicyId == CachePolicyId.TagFrame && k.Identity == "all")
                && keys.Any(k => k.PolicyId == CachePolicyId.CategoryFrame && k.Identity == "v:1:all")
                && keys.Any(k => k.PolicyId == CachePolicyId.TagFrame && k.Identity == "v:1:all")
                && keys.Any(k => k.PolicyId == CachePolicyId.CategoryFrame && k.Identity == "v:2:all")
                && keys.Any(k => k.PolicyId == CachePolicyId.TagFrame && k.Identity == "v:2:all")),
            Arg.Any<CancellationToken>());
    }
}
