using System.Buffers.Binary;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Codecs;
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

    public static IEnumerable<object[]> MalformedAedsFrames()
    {
        var encoder = new AedsEncoder();
        byte[] valid = encoder.Encode(AedsFrameType.RumMetricBatchRequest, [0x01, 0x02]);

        yield return ["short", new byte[] { 0x01, 0x02 }, "AEDS frame too short"];
        yield return ["magic", Mutate(valid, static frame => frame[0] ^= 0xff), "AEDS magic mismatch"];
        yield return ["version", Mutate(valid, static frame => frame[4]++), "AEDS version unsupported"];
        yield return ["flags", Mutate(valid, static frame => BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(6, 2), 1)), "AEDS request flags unsupported"];
        yield return ["type", Mutate(valid, static frame => BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(8, 2), (ushort)AedsFrameType.ArticleList)), "请求帧类型不匹配"];
        yield return ["crc", Mutate(valid, static frame => frame[^1] ^= 0xff), "AEDS payload crc mismatch"];
    }

    [Theory]
    [MemberData(nameof(MalformedAedsFrames))]
    public async Task IngestAsync_MalformedAedsFrame_ReturnsExact400Validation(
        string caseName,
        byte[] frame,
        string expectedMessage)
    {
        _ = caseName;
        var aeds = new AedsEncoder();
        var context = CreateRealBinderContext(frame);
        var service = new FakeRumTelemetryService();

        BinaryFrameResult result = await BinaryEndpoints.HandleRumMetricBatchAsync(
            context,
            service,
            aeds,
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal(StatusCodes.Status400BadRequest, errorPod.HttpStatus);
        Assert.Equal((byte)ErrorCode.Validation, errorPod.Code);
        Assert.Equal(expectedMessage, PodUtf8Codec.FromFixed256(errorPod.Message));
        Assert.Null(service.BatchRequest);
    }

    private static byte[] Mutate(byte[] source, Action<byte[]> mutation)
    {
        byte[] copy = [.. source];
        mutation(copy);
        return copy;
    }

    private static DefaultHttpContext CreateRealBinderContext(byte[] frame)
    {
        var context = new DefaultHttpContext();
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = frame.Length;
        context.Request.Body = new MemoryStream(frame);
        context.Response.Body = new MemoryStream();
        context.RequestServices = new ServiceCollection()
            .AddSingleton<IBinaryEndpointRequestContext>(new BinderBackedBinaryEndpointRequestContext())
            .BuildServiceProvider();
        return context;
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

    private sealed class BinderBackedBinaryEndpointRequestContext : IBinaryEndpointRequestContext
    {
        private readonly BinaryRequestBinder _binder = new();

        public Task<BinaryRequestPayload> ReadFrameAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            AedsFrameType expectedFrameType,
            CancellationToken cancellationToken,
            int? maxFrameBytes = null)
            => _binder.ReadFrameAsync(httpContext, aeds, expectedFrameType, cancellationToken, maxFrameBytes);

        public Task<BinaryRequestPayload> ReadFrameAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            IReadOnlyCollection<AedsFrameType> expectedFrameTypes,
            CancellationToken cancellationToken,
            int? maxFrameBytes = null)
            => _binder.ReadFrameAsync(httpContext, aeds, expectedFrameTypes, cancellationToken, maxFrameBytes);

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

        public string BuildArticleHotCacheIdentity(int count)
            => throw new NotSupportedException();

        public string? GetDeviceFingerprint(HttpContext context)
            => throw new NotSupportedException();

        public bool TryReadMfaProof(HttpContext context, out string proofToken)
            => throw new NotSupportedException();
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
