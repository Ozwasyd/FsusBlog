using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Services.Subscriptions;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Configuration;

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
            IConfiguration configuration,
            CancellationToken cancellationToken) =>
            await HandleSiteSubscriptionAsync(httpContext, db, aeds, configuration, subscribe: true, cancellationToken))
        .AllowAnonymous()
        .WithMetadata(new BinaryCredentialPolicyMetadata(BinaryCredentialPolicy.Omit))
        .RequireRateLimiting("fixed_ip");

        group.MapDelete("/subscriptions", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            ISqlSugarClient db,
            IAedsEncoder aeds,
            IConfiguration configuration,
            ISiteSubscriptionProofService proofService,
            CancellationToken cancellationToken) =>
            await HandleSiteSubscriptionAsync(httpContext, db, aeds, configuration, subscribe: false, cancellationToken, proofService))
        .AllowAnonymous()
        .WithMetadata(new BinaryCredentialPolicyMetadata(BinaryCredentialPolicy.Omit))
        .RequireRateLimiting("fixed_ip");
    }

    internal static async Task<BinaryFrameResult> HandleSiteSubscriptionAsync(
        HttpContext httpContext,
        ISqlSugarClient db,
        IAedsEncoder aeds,
        IConfiguration configuration,
        bool subscribe,
        CancellationToken cancellationToken,
        ISiteSubscriptionProofService? proofService = null)
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
                aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status400BadRequest, ErrorCode.Validation));
        }

        SiteSubscriptionBinaryResponse? response;
        if (subscribe)
        {
            response = await SubscriptionEndpoints.SubscribeAsync(request, db, configuration, cancellationToken);
        }
        else
        {
            if (proofService is null)
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Forbidden, "subscription_unsubscribe_proof_required"),
                    aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status428PreconditionRequired, ErrorCode.Forbidden));
            }

            var proofRequest = new SiteSubscriptionUnsubscribeProofConsumeRequest(
                ReadSiteSubscriptionProofToken(httpContext),
                request.Email,
                request.Channel);
            SiteSubscriptionUnsubscribeProofConsumeResult proof = await proofService.ValidateUnsubscribeProofAsync(
                proofRequest,
                cancellationToken);
            if (!proof.Accepted || proof.Claims is null)
            {
                int statusCode = string.Equals(proof.Reason, "email_invalid", StringComparison.Ordinal)
                    ? StatusCodes.Status400BadRequest
                    : StatusCodes.Status428PreconditionRequired;
                ErrorCode code = statusCode == StatusCodes.Status400BadRequest
                    ? ErrorCode.Validation
                    : ErrorCode.Forbidden;
                return BinaryResults.FromError(
                    ErrorDetail.Create(code, proof.Reason),
                    aeds, ApiErrorSemanticMapper.RequireTransportMappingId(statusCode, code));
            }

            response = await SubscriptionEndpoints.UnsubscribeAsync(request, db, proof.Claims, configuration, cancellationToken);
            if (response is not null)
            {
                _ = await proofService.CommitUnsubscribeProofAsync(proofRequest, cancellationToken);
            }
        }

        if (response is null)
        {
            return BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.Validation, "email_invalid"),
                aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status400BadRequest, ErrorCode.Validation));
        }

        return BinaryResults.Frame(
            aeds,
            AedsFrameType.SiteSubscriptionResponse,
            writer => PodBinaryCodec.WriteSiteSubscriptionResponse(response, writer));
    }

    private static string ReadSiteSubscriptionProofToken(HttpContext httpContext)
    {
        if (!httpContext.Request.Headers.TryGetValue(SiteSubscriptionProofService.HeaderName, out var values) || values.Count != 1)
        {
            return string.Empty;
        }

        return values[0]?.Trim() ?? string.Empty;
    }
}
