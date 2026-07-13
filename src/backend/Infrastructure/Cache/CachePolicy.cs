namespace FsusBlog.Server.Infrastructure.Cache;

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
    bool RegisterKeysForPrefixInvalidation = true)
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
