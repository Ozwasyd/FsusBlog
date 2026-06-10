using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinarySubscriptionEndpoints(IEndpointRouteBuilder group)
    {
        group.MapPost("/subscriptions", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            ISqlSugarClient db,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
            await HandleSiteSubscriptionAsync(httpContext, db, aeds, subscribe: true, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip");

        group.MapDelete("/subscriptions", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            ISqlSugarClient db,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
            await HandleSiteSubscriptionAsync(httpContext, db, aeds, subscribe: false, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip");
    }

    internal static async Task<BinaryFrameResult> HandleSiteSubscriptionAsync(
        HttpContext httpContext,
        ISqlSugarClient db,
        IAedsEncoder aeds,
        bool subscribe,
        CancellationToken cancellationToken)
    {
        var payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            AedsFrameType.SiteSubscriptionRequest,
            cancellationToken,
            maxFrameBytes: 1024);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }

        if (!PodBinaryCodec.TryDecodeSiteSubscriptionRequest(payload.Payload, out SiteSubscriptionBinaryRequest request))
        {
            return BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.Validation, "subscription_request_invalid"),
                aeds,
                StatusCodes.Status400BadRequest);
        }

        SiteSubscriptionBinaryResponse? response = subscribe
            ? await SubscriptionEndpoints.SubscribeAsync(request, db, cancellationToken)
            : await SubscriptionEndpoints.UnsubscribeAsync(request, db, cancellationToken);
        if (response is null)
        {
            return BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.Validation, "email_invalid"),
                aeds,
                StatusCodes.Status400BadRequest);
        }

        return BinaryResults.Frame(
            aeds,
            AedsFrameType.SiteSubscriptionResponse,
            writer => PodBinaryCodec.WriteSiteSubscriptionResponse(response, writer));
    }
}
