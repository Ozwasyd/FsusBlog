namespace FsusBlog.Server.Infrastructure.Cache;

public interface ICachePolicyRegistry
{
    bool TryGet(CachePolicyId id, out CachePolicy policy);
}
