using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DistributedInvalidationTargetResolverTests
{
    [Fact]
    public void ArticleMutation_OwnsExactArticleListHotAndStatsTargets()
    {
        DistributedInvalidationTargetPlan plan = Resolve(
            DistributedInvalidationEventKinds.ArticleMutation,
            ["article-list", "hot-articles", "stats"],
            ["article:42"],
            ["article-detail:42", "public-aot", "public-hot-read"]);

        Assert.True(plan.IsExact);
        Assert.Contains(plan.CacheKeys, key => key.PolicyId == CachePolicyId.ArticleDetail && key.Identity == "42");
        Assert.Contains(plan.CacheKeys, key => key.PolicyId == CachePolicyId.ArticleListVersion);
        Assert.Contains(plan.CacheKeys, key => key.PolicyId == CachePolicyId.ArticleHot);
        Assert.Contains(plan.CacheKeys, key => key.PolicyId == CachePolicyId.AdminStats);
        Assert.Contains(plan.AotTargets, target => target.PageId == PublicPageId.ArticleDetail && target.RouteKey == "article:42");
        Assert.Contains(plan.HotReadFragments, static fragment => fragment == "article:42");
        Assert.Contains(plan.HotReadFragments, static fragment => fragment == "html:article:42");
        Assert.Contains(plan.HotReadFragments, static fragment => fragment == "list:home");
        Assert.DoesNotContain(plan.HotReadFragments, static fragment => fragment.Contains("comments", StringComparison.Ordinal));
        Assert.DoesNotContain(plan.CacheKeys, key => key.PolicyId == CachePolicyId.SystemSeo);
    }

    [Fact]
    public void CommentMutation_DoesNotOwnArticleDetailOrTaxonomy()
    {
        DistributedInvalidationTargetPlan plan = Resolve(
            DistributedInvalidationEventKinds.CommentMutation,
            ["comments", "stats"],
            ["article:42:comments"],
            ["public-hot-read"]);

        Assert.True(plan.IsExact);
        Assert.Contains(plan.CacheKeys, key => key.PolicyId == CachePolicyId.CommentCursorVersion && key.Identity == "article:42");
        Assert.Contains(plan.CacheKeys, key => key.PolicyId == CachePolicyId.AdminStats);
        Assert.Empty(plan.AotTargets);
        Assert.Equal(["article:42:comments"], plan.HotReadFragments);
        Assert.DoesNotContain(plan.CacheKeys, key => key.PolicyId == CachePolicyId.ArticleDetail);
        Assert.DoesNotContain(plan.CacheKeys, key => key.PolicyId == CachePolicyId.CategoryFrame);
        Assert.DoesNotContain(plan.CacheKeys, key => key.PolicyId == CachePolicyId.SystemSeo);
    }

    [Fact]
    public void TaxonomyMutation_OwnsCategoryTagAndListFragmentsOnly()
    {
        DistributedInvalidationTargetPlan plan = Resolve(
            DistributedInvalidationEventKinds.TaxonomyMutation,
            ["article-list", "category", "tag"],
            ["taxonomy:*"],
            ["public-aot", "public-hot-read"]);

        Assert.True(plan.IsExact);
        Assert.Contains(plan.CacheKeys, key => key.PolicyId == CachePolicyId.CategoryFrame);
        Assert.Contains(plan.CacheKeys, key => key.PolicyId == CachePolicyId.TagFrame);
        Assert.Contains(plan.HotReadFragments, static fragment => fragment == "taxonomy:category");
        Assert.Contains(plan.HotReadFragments, static fragment => fragment == "taxonomy:tag");
        Assert.Contains(plan.AotTargets, static target => target.IsPrefix && target.RouteKey == "category:*");
        Assert.Contains(plan.AotTargets, static target => target.IsPrefix && target.RouteKey == "tag:*");
        Assert.Contains(plan.AotTargets, static target => target.IsPrefix && target.RouteKey == "tag-name:*");
        Assert.DoesNotContain(plan.CacheKeys, key => key.PolicyId == CachePolicyId.ArticleDetail);
        Assert.DoesNotContain(plan.AotTargets, target => target.PageId == PublicPageId.ArticleDetail);
    }

    [Fact]
    public void SeoMutation_OwnsPublicShellNotArticleFrames()
    {
        DistributedInvalidationTargetPlan plan = Resolve(
            DistributedInvalidationEventKinds.SeoMutation,
            ["seo"],
            ["system:seo"],
            ["public-aot"]);

        Assert.True(plan.IsExact);
        Assert.Contains(plan.CacheKeys, key => key.PolicyId == CachePolicyId.SystemSeo);
        Assert.DoesNotContain(plan.CacheKeys, key => key.PolicyId == CachePolicyId.ArticleDetail);
        Assert.DoesNotContain(plan.AotTargets, target => target.PageId == PublicPageId.ArticleDetail);
        Assert.Contains(plan.HotReadFragments, static fragment => fragment.StartsWith("html:", StringComparison.Ordinal));
    }

    [Fact]
    public void SystemPageMutation_OwnsExactSlug()
    {
        DistributedInvalidationTargetPlan plan = Resolve(
            DistributedInvalidationEventKinds.SystemPageMutation,
            ["system-page"],
            ["system-page:about"],
            ["public-aot"]);

        Assert.True(plan.IsExact);
        Assert.Equal(["html:about"], plan.HotReadFragments);
        Assert.All(plan.AotTargets, target => Assert.Equal("about", target.RouteKey));
        Assert.DoesNotContain(plan.CacheKeys, key => key.PolicyId == CachePolicyId.ArticleDetail);
    }

    [Fact]
    public void UnknownCacheTarget_RequiresFullReconcileWithoutPartialPlan()
    {
        DistributedInvalidationTargetPlan plan = Resolve(
            DistributedInvalidationEventKinds.ArticleMutation,
            ["not-a-cache-target"],
            ["article:42"],
            ["public-aot"]);

        Assert.False(plan.IsExact);
        Assert.Equal("cache-target:not-a-cache-target", plan.FullReconcileReason);
    }

    [Theory]
    [InlineData(DistributedInvalidationEventKinds.ArticleMutation)]
    [InlineData(DistributedInvalidationEventKinds.CommentMutation)]
    [InlineData(DistributedInvalidationEventKinds.TaxonomyMutation)]
    [InlineData(DistributedInvalidationEventKinds.SystemPageMutation)]
    [InlineData(DistributedInvalidationEventKinds.SeoMutation)]
    [InlineData(DistributedInvalidationEventKinds.ComplianceMutation)]
    [InlineData(DistributedInvalidationEventKinds.PublicAotArtifactUpdated)]
    [InlineData(DistributedInvalidationEventKinds.PublicHotReadVersionPublished)]
    public void EveryKnownKind_HasAResolverOwner(string kind)
    {
        DistributedInvalidationEvent invalidation = kind switch
        {
            DistributedInvalidationEventKinds.ArticleMutation => Event(kind, ["article-list"], ["article:7"], ["public-aot", "public-hot-read"]),
            DistributedInvalidationEventKinds.CommentMutation => Event(kind, ["comments"], ["article:7:comments"], ["public-hot-read"]),
            DistributedInvalidationEventKinds.TaxonomyMutation => Event(kind, ["category", "tag"], ["taxonomy:*"], ["public-hot-read"]),
            DistributedInvalidationEventKinds.SystemPageMutation => Event(kind, ["system-page"], ["system-page:privacy"], ["public-aot"]),
            DistributedInvalidationEventKinds.SeoMutation => Event(kind, ["seo"], ["system:seo"], ["public-aot"]),
            DistributedInvalidationEventKinds.ComplianceMutation => Event(kind, ["seo"], ["system:compliance"], ["public-aot"]),
            DistributedInvalidationEventKinds.PublicAotArtifactUpdated => Event(kind, ["article"], ["article:7"], ["aot:public:aot:v2:doc:2:article:7"]),
            DistributedInvalidationEventKinds.PublicHotReadVersionPublished => Event(kind, ["hot-articles"], ["article:hot"], ["public-hot-read:v3"]),
            _ => throw new InvalidOperationException(kind)
        };

        DistributedInvalidationTargetPlan plan = DistributedInvalidationTargetResolver.Resolve(invalidation);
        Assert.True(plan.IsExact, plan.FullReconcileReason);
        Assert.True(plan.ParsedTargetCount > 0);
    }

    private static DistributedInvalidationTargetPlan Resolve(
        string kind,
        IReadOnlyList<string> cacheTags,
        IReadOnlyList<string> routeKeys,
        IReadOnlyList<string> artifactKeys)
        => DistributedInvalidationTargetResolver.Resolve(Event(kind, cacheTags, routeKeys, artifactKeys));

    private static DistributedInvalidationEvent Event(
        string kind,
        IReadOnlyList<string> cacheTags,
        IReadOnlyList<string> routeKeys,
        IReadOnlyList<string> artifactKeys)
        => DistributedInvalidationEvent.Create(
            $"event-{kind}",
            kind,
            "node-a",
            "test",
            cacheTags,
            routeKeys,
            artifactKeys,
            $"trace-{kind}",
            TimeProvider.System);
}
