using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// CachePolicy
// ──────────────────────────────────────────────────────────────────────────────

public class CachePolicyTests
{
    private static CachePolicy MakePolicy(string domain = "blog", string resource = "article") =>
        new(CachePolicyId.ArticleList, domain, resource, TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(10));

    [Fact]
    public void BuildKey_DefaultIdentity_IncludesDefaultWord()
    {
        var policy = MakePolicy();
        string key = policy.BuildKey("  ");
        Assert.Contains("default", key);
    }

    [Fact]
    public void BuildKey_NormalIdentity_IncludesIdentity()
    {
        var policy = MakePolicy("blog", "article-detail");
        string key = policy.BuildKey("42");
        Assert.Equal("fsus:blog:article-detail:42", key);
    }

    [Fact]
    public void BuildKey_WithVersion_AppendsSuffix()
    {
        var policy = MakePolicy();
        string key = policy.BuildKey("1", "v5");
        Assert.EndsWith(":v5", key);
    }

    [Fact]
    public void BuildKey_EmptyIdentity_UsesDefault()
    {
        var policy = MakePolicy();
        string key = policy.BuildKey(string.Empty);
        Assert.Contains(":default", key);
    }

    [Fact]
    public void BuildKey_NullVersion_NoVersionSuffix()
    {
        var policy = MakePolicy("sys", "seo");
        string key = policy.BuildKey("admin");
        Assert.Equal("fsus:sys:seo:admin", key);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// CachePolicyRegistry
// ──────────────────────────────────────────────────────────────────────────────

public class CachePolicyRegistryTests
{
    private readonly CachePolicyRegistry _registry = new();

    [Theory]
    [InlineData(CachePolicyId.ArticleList)]
    [InlineData(CachePolicyId.ArticleDetail)]
    [InlineData(CachePolicyId.ArticleHot)]
    [InlineData(CachePolicyId.ArticleSearch)]
    [InlineData(CachePolicyId.SystemSeo)]
    [InlineData(CachePolicyId.AdminStats)]
    [InlineData(CachePolicyId.SecurityBlockedUser)]
    public void TryGet_KnownPolicyId_ReturnsTrue(CachePolicyId id)
    {
        bool found = _registry.TryGet(id, out var policy);
        Assert.True(found);
        Assert.Equal(id, policy.Id);
    }

    [Fact]
    public void TryGet_UnknownPolicyId_ReturnsFalse()
    {
        bool found = _registry.TryGet((CachePolicyId)9999, out _);
        Assert.False(found);
    }

    [Fact]
    public void AllPolicies_HaveNonEmptyDomainAndResource()
    {
        foreach (CachePolicyId id in Enum.GetValues<CachePolicyId>())
        {
            if (_registry.TryGet(id, out var policy))
            {
                Assert.False(string.IsNullOrWhiteSpace(policy.Domain), $"Policy {id} has empty Domain");
                Assert.False(string.IsNullOrWhiteSpace(policy.Resource), $"Policy {id} has empty Resource");
            }
        }
    }

    [Fact]
    public void SecurityCriticalPolicies_HaveSecurityDomain()
    {
        foreach (CachePolicyId id in Enum.GetValues<CachePolicyId>())
        {
            if (_registry.TryGet(id, out var policy) && policy.SecurityCritical)
            {
                Assert.Equal("sec", policy.Domain);
            }
        }
    }

    [Fact]
    public void SecurityBlacklistUser_UsesNonExpiringL2Cache()
    {
        Assert.True(_registry.TryGet(CachePolicyId.SecurityBlacklistUser, out var policy));

        Assert.Equal(Timeout.InfiniteTimeSpan, policy.L2Ttl);
    }
}
