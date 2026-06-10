using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinaryTelemetryEndpoints(IEndpointRouteBuilder group)
    {
        group.MapPost("/telemetry/rum", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IRumTelemetryService service,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
            await HandleRumMetricBatchAsync(httpContext, service, aeds, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip");
    }

    internal static async Task<BinaryFrameResult> HandleRumMetricBatchAsync(
        HttpContext httpContext,
        IRumTelemetryService service,
        IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        var payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            AedsFrameType.RumMetricBatchRequest,
            cancellationToken,
            RumTelemetryService.MaxFrameBytes);
        if (!payload.IsSuccess)
        {
            int status = payload.Error.Message.Contains("上限", StringComparison.Ordinal)
                ? StatusCodes.Status413PayloadTooLarge
                : 0;
            return BinaryResults.FromError(payload.Error, aeds, status);
        }

        if (!PodBinaryCodec.TryDecodeRumMetricBatchRequest(payload.Payload, out RumMetricBatchRequest request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "rum_metric_batch_request_invalid"), aeds);
        }

        RumMetricIngestResponse response = await service.IngestBatchAsync(request, cancellationToken);
        return BinaryResults.Frame(aeds, AedsFrameType.RumMetricIngestResponse, writer => PodBinaryCodec.WriteRumMetricIngestResponse(response, writer));
    }
}
