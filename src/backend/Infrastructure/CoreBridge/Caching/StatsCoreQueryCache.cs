using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Caching;

public sealed class StatsCoreQueryCache(IUnifiedCache cache)
{
    public async Task<SiteStatsCoreModel> GetOrLoadAdminStatsAsync(Func<Task<SiteStatsCoreModel>> loader)
    {
        const string identity = "core:main";
        var hit = await cache.TryGetAsync(CachePolicyId.AdminStats, identity, DecodeSiteStats);
        if (hit.Hit && hit.Value is not null)
        {
            return hit.Value.GetValueOrDefault();
        }

        SiteStatsCoreModel loaded = await loader();
        await cache.SetRawAsync(CachePolicyId.AdminStats, identity, PodBinaryCodec.EncodeSiteStats(loaded), TimeSpan.FromMinutes(10));
        return loaded;
    }

    private static (bool Success, SiteStatsCoreModel? Value) DecodeSiteStats(ReadOnlyMemory<byte> bytes)
    {
        bool success = PodBinaryCodec.TryDecodeSiteStats(bytes, out SiteStatsCoreModel value);
        return (success, success ? value : default);
    }
}