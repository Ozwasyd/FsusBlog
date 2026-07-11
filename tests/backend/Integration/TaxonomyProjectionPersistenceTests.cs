using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Taxonomy;
using FsusBlog.Server.Tests.TestInfrastructure;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class TaxonomyProjectionPersistenceTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task ReconcileArticleAsync_PersistsCategoryTagCountsProjectionAndBumpsFrameVersion()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleTag),
            typeof(CategoryPublicArticleCount),
            typeof(TagPublicArticleCount),
            typeof(ArticlePublicTaxonomyProjection));

        int articleId = db.Insertable(new Article
        {
            Title = "taxonomy projection",
            Summary = "published",
            CategoryId = 7,
            Status = ArticleStatus.Published,
            PublishedAt = DateTime.UtcNow.AddMinutes(-5),
            CreateTime = DateTime.UtcNow.AddMinutes(-10),
            IsDeleted = false
        }).ExecuteReturnIdentity();
        db.Insertable(new[]
        {
            new ArticleTag { ArticleId = articleId, TagId = 11 },
            new ArticleTag { ArticleId = articleId, TagId = 12 }
        }).ExecuteCommand();

        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.TaxonomyFrameVersion, "main", Arg.Any<CancellationToken>())
            .Returns("0");
        cache.IncrementAsync(CachePolicyId.TaxonomyFrameVersion, "main", 1, Arg.Any<CancellationToken>())
            .Returns(1);
        IHttpCacheInvalidator invalidator = Substitute.For<IHttpCacheInvalidator>();
        var service = new TaxonomyCountProjectionService(db, cache, invalidator);

        await service.ReconcileArticleAsync(articleId);

        CategoryPublicArticleCount? category = await db.Queryable<CategoryPublicArticleCount>().InSingleAsync(7);
        List<TagPublicArticleCount> tags = await db.Queryable<TagPublicArticleCount>()
            .OrderBy(item => item.TagId)
            .ToListAsync();
        ArticlePublicTaxonomyProjection? projection =
            await db.Queryable<ArticlePublicTaxonomyProjection>().InSingleAsync(articleId);

        Assert.NotNull(category);
        Assert.Equal(1, category.ArticleCount);
        Assert.Equal([11, 12], tags.Select(static item => item.TagId));
        Assert.All(tags, static item => Assert.Equal(1, item.ArticleCount));
        Assert.NotNull(projection);
        Assert.Equal(7, projection.CategoryId);
        Assert.Equal("11,12", projection.TagIds);
        await cache.Received(1).IncrementAsync(
            CachePolicyId.TaxonomyFrameVersion,
            "main",
            1,
            Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveManyAsync(
            Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
                HasKey(keys, CachePolicyId.CategoryFrame, "all")
                && HasKey(keys, CachePolicyId.TagFrame, "all")
                && HasKey(keys, CachePolicyId.CategoryFrame, "v:0:all")
                && HasKey(keys, CachePolicyId.TagFrame, "v:0:all")
                && HasKey(keys, CachePolicyId.CategoryFrame, "v:1:all")
                && HasKey(keys, CachePolicyId.TagFrame, "v:1:all")),
            Arg.Any<CancellationToken>());
        await invalidator.Received(1).InvalidateAsync(
            Arg.Is<CacheTag[]>(values => values.SequenceEqual([CacheTag.Category, CacheTag.Tag])));
    }

    private static bool HasKey(
        IReadOnlyList<CacheKeyIdentity> keys,
        CachePolicyId policyId,
        string identity)
        => keys.Any(key => key.PolicyId == policyId
            && string.Equals(key.Identity, identity, StringComparison.Ordinal));
}
