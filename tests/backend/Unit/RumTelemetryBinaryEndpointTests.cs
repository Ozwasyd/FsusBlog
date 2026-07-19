using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
namespace FsusBlog.Server.Tests.Unit;

public sealed class RumTelemetryBinaryEndpointTests
{
    [Fact]
    public async Task IngestAsync_ValidAedsBatch_ReturnsIngestResponseFrame()
    {
        var aeds = new AedsEncoder();
        var request = new RumMetricBatchRequest(
            "article",
            "article",
            "server-aot",
            [
                new RumMetricBatchItem(
                    "web_vital_lcp",
                    1234,
                    DateTime.UtcNow,
                    new Dictionary<string, double> { ["value"] = 1234 },
                    null)
            ]);
        var context = CreateContext(
            AedsFrameType.RumMetricBatchRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeRumMetricBatchRequest(request)));
        var service = new FakeRumTelemetryService
        {
            BatchResponse = new RumMetricIngestResponse(true, 1, 0)
        };

        BinaryFrameResult result = await BinaryEndpoints.HandleRumMetricBatchAsync(context, service, aeds, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.RumMetricIngestResponse, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeRumMetricIngestResponse(decoded.Payload, out RumMetricIngestResponse body));
        Assert.True(body.Accepted);
        Assert.Equal(1, body.AcceptedCount);
        Assert.Equal(request.PageType, service.BatchRequest!.PageType);
        Assert.Equal(RumTelemetryContractLimits.MaxFrameBytes, context.RequestServices.GetRequiredService<FakeBinaryEndpointRequestContext>().MaxFrameBytes);
    }

    [Fact]
    public async Task IngestAsync_MalformedPayload_ReturnsApiErrorFrame()
    {
        var aeds = new AedsEncoder();
        var context = CreateContext(
            AedsFrameType.RumMetricBatchRequest,
            BinaryRequestPayload.Success(new byte[] { 0x01, 0x02 }));
        var service = new FakeRumTelemetryService();

        BinaryFrameResult result = await BinaryEndpoints.HandleRumMetricBatchAsync(context, service, aeds, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        ErrorDetail error = PodBinaryCodec.ToErrorDetail(errorPod);
        Assert.Equal(ErrorCode.Validation, error.Code);
        Assert.Equal("rum_metric_batch_request_invalid", error.Message);
        Assert.Null(service.BatchRequest);
    }

    [Fact]
    public async Task IngestAsync_OversizedFrame_ReturnsPayloadTooLargeApiError()
    {
        var aeds = new AedsEncoder();
        var context = CreateContext(
            AedsFrameType.RumMetricBatchRequest,
            BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "请求帧超过 8192 bytes 上限")));
        var service = new FakeRumTelemetryService();

        BinaryFrameResult result = await BinaryEndpoints.HandleRumMetricBatchAsync(context, service, aeds, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status413PayloadTooLarge, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal(StatusCodes.Status413PayloadTooLarge, errorPod.HttpStatus);
        Assert.Null(service.BatchRequest);
    }

    private static DefaultHttpContext CreateContext(AedsFrameType expectedFrameType, BinaryRequestPayload payload)
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();

        var requestContext = new FakeBinaryEndpointRequestContext(expectedFrameType, payload);

        context.RequestServices = new ServiceCollection()
            .AddSingleton(requestContext)
            .AddSingleton<IBinaryEndpointRequestContext>(requestContext)
            .BuildServiceProvider();
        return context;
    }

    private static async Task<AedsDecodeResult> ExecuteAndDecodeAsync(BinaryFrameResult result, DefaultHttpContext context, AedsEncoder aeds)
    {
        await result.ExecuteAsync(context);
        var frame = ((MemoryStream)context.Response.Body).ToArray();
        Result<AedsDecodeResult> decoded = aeds.TryDecode(frame);

        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        return decoded.Value;
    }

    private sealed class FakeRumTelemetryService : IRumTelemetryService
    {
        public RumMetricBatchRequest? BatchRequest
        {
            get; private set;
        }
        public RumMetricIngestResponse BatchResponse { get; init; } = new(false, 0, 1);

        public Task<RumMetricIngestResponse> IngestAsync(RumMetricRequest request, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<RumMetricIngestResponse> IngestBatchAsync(RumMetricBatchRequest request, CancellationToken cancellationToken = default)
        {
            BatchRequest = request;
            return Task.FromResult(BatchResponse);
        }
    }

    private sealed class FakeBinaryEndpointRequestContext(
        AedsFrameType expectedFrameType,
        BinaryRequestPayload payload) : IBinaryEndpointRequestContext
    {
        public int? MaxFrameBytes
        {
            get; private set;
        }

        public Task<BinaryRequestPayload> ReadFrameAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            AedsFrameType expected,
            CancellationToken cancellationToken,
            int? maxFrameBytes = null)
        {
            Assert.Equal(expectedFrameType, expected);
            MaxFrameBytes = maxFrameBytes;
            return Task.FromResult(payload);
        }

        public Task<BinaryRequestPayload> ReadFrameAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            IReadOnlyCollection<AedsFrameType> expected,
            CancellationToken cancellationToken,
            int? maxFrameBytes = null)
        {
            Assert.Contains(expectedFrameType, expected);
            MaxFrameBytes = maxFrameBytes;
            return Task.FromResult(payload);
        }

        public Task<NameMutationPayload> ReadNameMutationAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            AedsFrameType expectedFrameType,
            CancellationToken cancellationToken)
            => throw new NotSupportedException();

        public string BuildArticleViewerIdentity(HttpContext context, int articleId)
            => throw new NotSupportedException();

        public ValueTask<long> GetArticleListCacheVersionAsync(ICacheStringReader cache)
            => throw new NotSupportedException();

        public string BuildArticleListCacheIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string keyword = "")
            => throw new NotSupportedException();

        public string BuildArticleHotCacheIdentity(int count)
            => throw new NotSupportedException();

        public string? GetDeviceFingerprint(HttpContext context)
            => null;

        public bool TryReadMfaProof(HttpContext context, out string proofToken)
        {
            proofToken = string.Empty;
            return false;
        }
    }
}
