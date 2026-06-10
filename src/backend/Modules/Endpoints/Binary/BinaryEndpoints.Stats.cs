using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;
using System.Buffers;
using System.Data.Common;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinaryStatsEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/stats", static async Task<IResult> (
            IStatsCoreService core,
            IUnifiedCache cache,
            IAedsEncoder aeds) =>
        {
            const string identity = "core:main";
            CacheReadResult<ReadOnlyMemory<byte>> frame = await cache.TryGetRawReadonlyAsync(CachePolicyId.AdminStatsFrame, identity);
            if (frame.Hit && frame.Value.Length > 0)
            {
                return BinaryResults.PreencodedFrame(frame.Value);
            }

            var result = await core.GetAdminStatsAsync();
            if (!result.IsSuccess)
            {
                return BinaryResults.FromError(result.Error, aeds);
            }

            byte[] payload = PodBinaryCodec.EncodeSiteStats(result.Value);
            byte[] encodedFrame = aeds.Encode(AedsFrameType.AdminStats, payload);
            await cache.SetRawAsync(CachePolicyId.AdminStatsFrame, identity, encodedFrame, TimeSpan.FromMinutes(10));
            return BinaryResults.PreencodedFrame(encodedFrame);
        }).RequireAuthorization(policy => policy.RequireRole("admin"));

        group.MapGet("/stats/recent-comments", static async Task<BinaryFrameResult> (
            IStatsCoreService core,
            IAedsEncoder aeds) =>
        {
            var result = await core.GetAdminStatsAsync();
            if (!result.IsSuccess)
            {
                return BinaryResults.FromError(result.Error, aeds);
            }

            return BinaryResults.Frame(aeds, AedsFrameType.RecentCommentStats, writer => PodBinaryCodec.WriteRecentCommentStats(result.Value.RecentComments, writer));
        }).RequireAuthorization(policy => policy.RequireRole("admin"));

        group.MapGet("/stats/regions", static async Task<BinaryFrameResult> (
            IStatsCoreService core,
            IAedsEncoder aeds) =>
        {
            var result = await core.GetAdminStatsAsync();
            if (!result.IsSuccess)
            {
                return BinaryResults.FromError(result.Error, aeds);
            }

            return BinaryResults.Frame(aeds, AedsFrameType.RegionStats, writer => PodBinaryCodec.WriteRegionStats(result.Value.RegionDistributions, writer));
        }).RequireAuthorization(policy => policy.RequireRole("admin"));
    }
}
