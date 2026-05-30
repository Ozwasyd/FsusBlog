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
    double L2JitterRatio = 0d)
{
    public string BuildKey(string identity, string? version = null)
    {
        string normalizedIdentity = string.IsNullOrWhiteSpace(identity) ? "default" : identity.Trim();
        return string.IsNullOrWhiteSpace(version)
            ? $"fsus:{Domain}:{Resource}:{normalizedIdentity}"
            : $"fsus:{Domain}:{Resource}:{normalizedIdentity}:{version}";
    }
}
