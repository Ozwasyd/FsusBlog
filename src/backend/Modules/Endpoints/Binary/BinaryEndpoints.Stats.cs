using System.Buffers;
using System.Data.Common;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinaryStatsEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/stats", static Task<IResult> (
            IStatsCoreService core,
            IUnifiedCache cache,
            IOwnedFrameCache ownedFrameCache,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) => HandleAdminStatsFrameAsync(
                core,
                cache,
                ownedFrameCache,
                aeds,
                cancellationToken))
            .RequireAdminPermission(AdminPermissions.AuditRead);

        group.MapGet("/stats/recent-comments", static async Task<BinaryFrameResult> (
            IStatsCoreService core,
            IAedsEncoder aeds) =>
        {
            var result = await core.GetAdminRecentCommentsAsync();
            if (!result.IsSuccess)
            {
                return BinaryResults.FromError(result.Error, aeds);
            }

            return BinaryResults.Frame(aeds, AedsFrameType.RecentCommentStats, writer => PodBinaryCodec.WriteRecentCommentStats(result.Value ?? [], writer));
        }).RequireAdminPermission(AdminPermissions.AuditRead);

        group.MapGet("/stats/regions", static async Task<BinaryFrameResult> (
            IStatsCoreService core,
            IAedsEncoder aeds) =>
        {
            var result = await core.GetAdminRegionStatsAsync();
            if (!result.IsSuccess)
            {
                return BinaryResults.FromError(result.Error, aeds);
            }

            return BinaryResults.Frame(aeds, AedsFrameType.RegionStats, writer => PodBinaryCodec.WriteRegionStats(result.Value ?? [], writer));
        }).RequireAdminPermission(AdminPermissions.AuditRead);
    }

    internal static async Task<IResult> HandleAdminStatsFrameAsync(
        IStatsCoreService core,
        IUnifiedCache cache,
        IOwnedFrameCache ownedFrameCache,
        IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        const int maxVersionRetries = 2;
        for (int attempt = 0; attempt <= maxVersionRetries; attempt++)
        {
            long version = await AdminStatsFrameVersioning.ResolveAsync(cache, cancellationToken);
            string identity = AdminStatsFrameVersioning.BuildIdentity(version);
            OwnedFrameCacheReadResult frame = await ownedFrameCache.TryGetOwnedFrameAsync(
                CachePolicyId.AdminStatsFrame,
                identity,
                AedsFrameType.AdminStats,
                cancellationToken);
            if (frame.Hit && frame.Lease is not null)
            {
                return BinaryResults.PreencodedFrame(frame.Lease);
            }

            var result = await core.GetAdminStatsAsync(version);
            if (!result.IsSuccess)
            {
                return BinaryResults.FromError(result.Error, aeds);
            }

            long confirmedVersion = await AdminStatsFrameVersioning.ResolveAsync(cache, cancellationToken);
            if (confirmedVersion != version)
            {
                if (attempt < maxVersionRetries)
                {
                    continue;
                }

                // Sustained mutation churn: serve the just-read result without installing it
                // under a generation that it did not observe.
                return BinaryResults.Frame(
                    aeds,
                    AedsFrameType.AdminStats,
                    writer => PodBinaryCodec.WriteSiteStats(result.Value, writer));
            }

            OwnedAedsFrame ownedFrame = BuildCachedFrame(
                AedsFrameType.AdminStats,
                writer => PodBinaryCodec.WriteSiteStats(result.Value, writer));
            return await StoreAndReturnOwnedFrameAsync(
                ownedFrameCache,
                CachePolicyId.AdminStatsFrame,
                identity,
                ownedFrame,
                TimeSpan.FromMinutes(10),
                cancellationToken);
        }

        throw new InvalidOperationException("Admin stats frame version retry loop exited unexpectedly.");
    }
}
