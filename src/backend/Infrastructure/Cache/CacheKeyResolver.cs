namespace FsusBlog.Server.Infrastructure.Cache;

public sealed class CacheKeyResolver(
    ICachePolicyRegistry policyRegistry,
    IRuntimeKeyScope keyScope,
    ILogger<CacheKeyResolver> logger) : ICacheKeyResolver
{
    public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
        => keyScope.PrefixKey(ResolvePolicy(policyId).BuildKey(identity, version));

    public string BuildKey(CachePolicyId policyId, int identity, string? version = null)
        => keyScope.PrefixKey(ResolvePolicy(policyId).BuildKey(identity, version));

    private CachePolicy ResolvePolicy(CachePolicyId policyId)
    {
        if (policyRegistry.TryGet(policyId, out CachePolicy policy))
        {
            return policy;
        }

        logger.LogError("Cache policy missing while building key: {PolicyId}", policyId);
        throw new InvalidOperationException($"Cache policy is not registered: {policyId}.");
    }
}
