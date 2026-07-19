using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Caching;

public sealed class StatsCoreQueryCache(
    ICacheTypedReader cacheReader,
    ICacheRawWriter cacheWriter,
    ICacheSingleFlightCoordinator coordinator)
{
    public async Task<SiteStatsCoreModel> GetOrLoadAdminStatsAsync(Func<Task<SiteStatsCoreModel>> loader)
        => await GetOrLoadAdminStatsAsync("core:main", loader);

    public async Task<SiteStatsCoreModel> GetOrLoadAdminStatsAsync(
        long sourceGeneration,
        Func<Task<SiteStatsCoreModel>> loader)
        => await GetOrLoadAdminStatsAsync(
            AdminStatsFrameVersioning.BuildCoreSourceIdentity(sourceGeneration),
            loader);

    private async Task<SiteStatsCoreModel> GetOrLoadAdminStatsAsync(
        string identity,
        Func<Task<SiteStatsCoreModel>> loader)
    {
        var hit = await cacheReader.TryGetAsync(CachePolicyId.AdminStats, identity, DecodeSiteStats);
        if (hit.Hit)
        {
            return hit.Value.GetValueOrDefault();
        }

        await using IAsyncDisposable lease = await coordinator.AcquireAsync(CachePolicyId.AdminStats, identity);
        hit = await cacheReader.TryGetAsync(CachePolicyId.AdminStats, identity, DecodeSiteStats);
        if (hit.Hit)
        {
            return hit.Value.GetValueOrDefault();
        }

        SiteStatsCoreModel loaded = await loader();
        await cacheWriter.SetRawAsync(CachePolicyId.AdminStats, identity, PodBinaryCodec.EncodeSiteStats(loaded), TimeSpan.FromMinutes(10));
        return loaded;
    }

    public async Task<IReadOnlyList<RecentCommentCoreModel>> GetOrLoadAdminRecentCommentsAsync(Func<Task<IReadOnlyList<RecentCommentCoreModel>>> loader)
        => await GetOrLoadAsync(
            CachePolicyId.AdminStatsRecentComments,
            "core:main",
            DecodeRecentComments,
            PodBinaryCodec.EncodeRecentCommentStats,
            loader);

    public async Task<IReadOnlyList<RegionDistributionCoreModel>> GetOrLoadAdminRegionStatsAsync(Func<Task<IReadOnlyList<RegionDistributionCoreModel>>> loader)
        => await GetOrLoadAsync(
            CachePolicyId.AdminStatsRegions,
            "core:main",
            DecodeRegions,
            PodBinaryCodec.EncodeRegionStats,
            loader);

    private async Task<T> GetOrLoadAsync<T>(
        CachePolicyId policyId,
        string identity,
        Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
        Func<T, byte[]> encoder,
        Func<Task<T>> loader)
    {
        var hit = await cacheReader.TryGetAsync(policyId, identity, decoder);
        if (hit.Hit && hit.Value is not null)
        {
            return hit.Value;
        }

        await using IAsyncDisposable lease = await coordinator.AcquireAsync(policyId, identity);
        hit = await cacheReader.TryGetAsync(policyId, identity, decoder);
        if (hit.Hit && hit.Value is not null)
        {
            return hit.Value;
        }

        T loaded = await loader();
        await cacheWriter.SetRawAsync(policyId, identity, encoder(loaded), TimeSpan.FromMinutes(10));
        return loaded;
    }

    private static (bool Success, SiteStatsCoreModel? Value) DecodeSiteStats(ReadOnlyMemory<byte> bytes)
    {
        bool success = PodBinaryCodec.TryDecodeSiteStats(bytes, out SiteStatsCoreModel value);
        return (success, success ? value : default);
    }

    private static (bool Success, IReadOnlyList<RecentCommentCoreModel>? Value) DecodeRecentComments(ReadOnlyMemory<byte> bytes)
    {
        bool success = PodBinaryCodec.TryDecodeRecentCommentStats(bytes, out List<RecentCommentCoreModel> value);
        return (success, success ? value : default);
    }

    private static (bool Success, IReadOnlyList<RegionDistributionCoreModel>? Value) DecodeRegions(ReadOnlyMemory<byte> bytes)
    {
        bool success = PodBinaryCodec.TryDecodeRegionStats(bytes, out List<RegionDistributionCoreModel> value);
        return (success, success ? value : default);
    }
}
