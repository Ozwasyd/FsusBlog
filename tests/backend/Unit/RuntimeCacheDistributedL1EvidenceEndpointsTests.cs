using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Modules.Endpoints;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RuntimeCacheDistributedL1EvidenceEndpointsTests
{
    [Fact]
    public void L1EvidenceIdentitiesAreUniqueAcrossRequiredCardinality()
    {
        string[] identities = Enumerable.Range(1, 100_000)
            .Select(ordinal => RuntimeCacheDistributedL1EvidenceEndpoints.BuildL1Identity("required-cardinality", ordinal))
            .ToArray();

        Assert.Equal(100_000, identities.Distinct(StringComparer.Ordinal).Count());
        Assert.Equal("runtime-cache-evidence:required-cardinality:l1:000001", identities[0]);
        Assert.Equal("runtime-cache-evidence:required-cardinality:l1:100000", identities[^1]);
    }

    [Fact]
    public void L1EvidenceAlternatesIndependentBoundedPolicies()
    {
        Assert.Equal(CachePolicyId.SystemPage, RuntimeCacheDistributedL1EvidenceEndpoints.PolicyForOrdinal(1));
        Assert.Equal(CachePolicyId.SystemCompliance, RuntimeCacheDistributedL1EvidenceEndpoints.PolicyForOrdinal(2));
        Assert.Equal(CachePolicyId.SystemPage, RuntimeCacheDistributedL1EvidenceEndpoints.PolicyForOrdinal(99_999));
        Assert.Equal(CachePolicyId.SystemCompliance, RuntimeCacheDistributedL1EvidenceEndpoints.PolicyForOrdinal(100_000));
    }

    [Theory]
    [InlineData("run-1", true)]
    [InlineData("run.with.dots", true)]
    [InlineData("", false)]
    [InlineData("run_with_underscore", false)]
    [InlineData("run/with/slash", false)]
    public void RunIdentityUsesClosedAlphabet(string runId, bool expected)
    {
        Assert.Equal(expected, RuntimeCacheDistributedL1EvidenceEndpoints.ValidRunId(runId));
    }
}
