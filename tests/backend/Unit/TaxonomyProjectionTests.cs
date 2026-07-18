using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Taxonomy;
using NSubstitute;
using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

public sealed class TaxonomyProjectionTests
{
    [Fact]
    public async Task BumpFrameVersionAsync_EvictsLegacyPreviousAndCurrentFrameIdentities()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.TaxonomyFrameVersion, "main", Arg.Any<CancellationToken>())
            .Returns("4");
        cache.IncrementAsync(CachePolicyId.TaxonomyFrameVersion, "main", 1, Arg.Any<CancellationToken>())
            .Returns(5);
        var service = new TaxonomyCountProjectionService(
            Substitute.For<ISqlSugarClient>(),
            cache,
            Substitute.For<IHttpCacheInvalidator>());

        long version = await service.BumpFrameVersionAsync("test");

        Assert.Equal(5, version);
        await cache.Received(1).RemoveManyAsync(
            Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
                keys.Count == 6
                && HasKey(keys, CachePolicyId.CategoryFrame, "all")
                && HasKey(keys, CachePolicyId.TagFrame, "all")
                && HasKey(keys, CachePolicyId.CategoryFrame, "v:4:all")
                && HasKey(keys, CachePolicyId.TagFrame, "v:4:all")
                && HasKey(keys, CachePolicyId.CategoryFrame, "v:5:all")
                && HasKey(keys, CachePolicyId.TagFrame, "v:5:all")),
            Arg.Any<CancellationToken>());
    }

    private static bool HasKey(
        IReadOnlyList<CacheKeyIdentity> keys,
        CachePolicyId policyId,
        string identity)
        => keys.Any(key => key.PolicyId == policyId
            && string.Equals(key.Identity, identity, StringComparison.Ordinal));
}
