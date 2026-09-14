namespace FsusBlog.Server.Infrastructure.Cache;

public enum CacheL1EvictionPolicy : byte
{
    LeastRecentlyUsed = 0
}

public sealed record CachePolicy(
    CachePolicyId Id,
    string Domain,
    string Resource,
    TimeSpan L1Ttl,
    TimeSpan L2Ttl,
    TimeSpan? NegativeTtl = null,
    CacheTag[]? InvalidationTags = null,
    bool SecurityCritical = false,
    double L2JitterRatio = 0d,
    bool RegisterKeysForPrefixInvalidation = true,
    int L1MaxEntries = 1024,
    long L1MaxLogicalBytes = 8 * 1024 * 1024,
    long L1MaxCapacityBytes = 8 * 1024 * 1024,
    CacheL1EvictionPolicy L1EvictionPolicy = CacheL1EvictionPolicy.LeastRecentlyUsed)
{
    public string BuildKey(string identity, string? version = null)
    {
        string normalizedIdentity = CacheIdentity.Normalize(identity);
        string? normalizedVersion = CacheIdentity.NormalizeVersion(version);
        return normalizedVersion is null
            ? $"fsus:{Domain}:{Resource}:{normalizedIdentity}"
            : $"fsus:{Domain}:{Resource}:{normalizedIdentity}:{normalizedVersion}";
    }

    public string BuildKey(int identity, string? version = null)
    {
        string? normalizedVersion = CacheIdentity.NormalizeVersion(version);
        return normalizedVersion is null
            ? string.Create(System.Globalization.CultureInfo.InvariantCulture, $"fsus:{Domain}:{Resource}:{identity}")
            : string.Create(System.Globalization.CultureInfo.InvariantCulture, $"fsus:{Domain}:{Resource}:{identity}:{normalizedVersion}");
    }
}
