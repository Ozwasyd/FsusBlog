using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Results;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// CacheTagExtensions
// ──────────────────────────────────────────────────────────────────────────────

public class CacheTagExtensionsTests
{
    [Theory]
    [InlineData(CacheTag.ArticleList, "ArticleList")]
    [InlineData(CacheTag.HotArticles, "HotArticles")]
    [InlineData(CacheTag.Category, "Category")]
    [InlineData(CacheTag.Tag, "Tag")]
    [InlineData(CacheTag.SystemPage, "SystemPage")]
    [InlineData(CacheTag.Seo, "Seo")]
    [InlineData(CacheTag.Stats, "Stats")]
    [InlineData(CacheTag.Aot, "Aot")]
    [InlineData(CacheTag.Comment, "Comment")]
    [InlineData(CacheTag.None, "None")]
    public void ToOutputCacheTag_ReturnsExpected(CacheTag tag, string expected)
    {
        Assert.Equal(expected, tag.ToOutputCacheTag());
    }

    [Fact]
    public void ToOutputCacheTag_UnknownValue_ReturnsNone()
    {
        var unknown = (CacheTag)999;
        Assert.Equal("None", unknown.ToOutputCacheTag());
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// AedsBinaryWriter
// ──────────────────────────────────────────────────────────────────────────────

public class AedsBinaryWriterTests
{
    [Fact]
    public void WriteFrame_ToBufferWriter_ProducesValidAedsFrame()
    {
        var encoder = Substitute.For<IAedsEncoder>();
        // Use real encoder for actual output
        var realEncoder = new AedsEncoder();
        byte[] payload = new byte[] { 0x01, 0x02 };
        using var writer = new PooledByteBufferWriter(AedsFrameHeader.Size + payload.Length);
        AedsBinaryWriter.WriteFrame(realEncoder, AedsFrameType.ArticleList, payload, writer);

        Assert.True(writer.WrittenCount >= AedsFrameHeader.Size + payload.Length);
    }

    [Fact]
    public void WriteFrame_EmptyPayload_StillWritesHeader()
    {
        var encoder = new AedsEncoder();
        using var writer = new PooledByteBufferWriter(AedsFrameHeader.Size);
        AedsBinaryWriter.WriteFrame(encoder, AedsFrameType.ArticleDetail, [], writer);
        Assert.True(writer.WrittenCount >= AedsFrameHeader.Size);
    }

    [Fact]
    public void WriteFrame_ToBufferWriter_WritesBytes()
    {
        // Use real encoder (not mock) since span can't be used with NSubstitute
        var encoder = new AedsEncoder();
        var writer = new PooledByteBufferWriter(128);
        AedsBinaryWriter.WriteFrame(encoder, AedsFrameType.ArticleList, new byte[] { 1, 2 }, writer);
        Assert.True(writer.WrittenCount >= AedsFrameHeader.Size);
    }
}

public class BinaryResultsTests
{
    [Fact]
    public async Task FromError_WritesBinaryFrameAndMappedStatusCode()
    {
        var context = new DefaultHttpContext();
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var result = BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden, "权限不足"), new AedsEncoder());
        await result.ExecuteAsync(context);

        Assert.Equal(StatusCodes.Status403Forbidden, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);
        Assert.True(body.Length > AedsFrameHeader.Size);
    }
}

public class BinaryRequestBinderTests
{
    [Fact]
    public async Task ReadFrameAsync_ValidFrame_ReturnsPayloadSlice()
    {
        var encoder = new AedsEncoder();
        byte[] payload = [0x10, 0x20, 0x30, 0x40];
        using var writer = new PooledByteBufferWriter(AedsFrameHeader.Size + payload.Length);
        encoder.WriteFrame(AedsFrameType.AuthLoginRequest, payload, writer);

        var context = new DefaultHttpContext();
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = writer.WrittenCount;
        context.Request.Body = new MemoryStream(writer.WrittenMemory.ToArray());
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var binder = new BinaryRequestBinder();
        BinaryRequestPayload result = await binder.ReadFrameAsync(
            context,
            encoder,
            AedsFrameType.AuthLoginRequest,
            CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.Equal(payload, result.Payload.ToArray());
    }

    [Fact]
    public async Task ReadFrameAsync_DeclaredOversizedPayloadRejectsBeforePayloadRead()
    {
        byte[] frameHeader = new byte[AedsFrameHeader.Size];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(frameHeader.AsSpan(0, 4), AedsEncoder.Magic);
        frameHeader[4] = AedsFrameHeader.CurrentVersion;
        frameHeader[5] = AedsFrameHeader.Size;
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(frameHeader.AsSpan(8, 2), (ushort)AedsFrameType.AuthLoginRequest);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(frameHeader.AsSpan(10, 4), 8 * 1024 * 1024);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(frameHeader.AsSpan(14, 2), AedsCrc16.Compute(ReadOnlySpan<byte>.Empty));

        var context = new DefaultHttpContext();
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = frameHeader.Length;
        context.Request.Body = new MemoryStream(frameHeader);
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var binder = new BinaryRequestBinder();
        BinaryRequestPayload result = await binder.ReadFrameAsync(
            context,
            new AedsEncoder(),
            AedsFrameType.AuthLoginRequest,
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Contains("8 MiB", result.Error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadFrameAsync_NonZeroRequestFlagsAreRejected()
    {
        byte[] frame = new AedsEncoder().Encode(AedsFrameType.AuthLoginRequest, [0x01, 0x02]);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(6, 2), 1);

        var context = new DefaultHttpContext();
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = frame.Length;
        context.Request.Body = new MemoryStream(frame);
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var binder = new BinaryRequestBinder();
        BinaryRequestPayload result = await binder.ReadFrameAsync(
            context,
            new AedsEncoder(),
            AedsFrameType.AuthLoginRequest,
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Contains("flags", result.Error.Message, StringComparison.OrdinalIgnoreCase);
    }
}

public class BackgroundWorkflowSourceTests
{
    [Fact]
    public void ContentFilterReload_SourceUsesSerializedQueueInsteadOfWatcherTaskRun()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/Security/ContentFilterService.cs"));

        Assert.Contains("Channel.CreateBounded<string>", source, StringComparison.Ordinal);
        Assert.Contains("ProcessReloadQueueAsync", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.Run(async () => await ReloadFromWatcherAsync", source, StringComparison.Ordinal);
        Assert.Contains("ReadAllLinesCoreAsync", source, StringComparison.Ordinal);
    }

    [Fact]
    public void NotificationStreamPublish_SourceQueuesLocalFanoutAndBatchesMultiRouteBacklog()
    {
        string publisher = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/NotificationStream/RedisNotificationStreamPublisher.cs"));
        string backlog = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/NotificationStream/NotificationStreamBacklogStore.cs"));

        Assert.Contains("NotificationStreamLocalFanoutQueue", publisher, StringComparison.Ordinal);
        Assert.Contains("TryEnqueue(frame, target)", publisher, StringComparison.Ordinal);
        Assert.Contains("IBatch batch = _database.CreateBatch()", backlog, StringComparison.Ordinal);
        Assert.Contains("Task.WhenAll(writes)", backlog, StringComparison.Ordinal);
    }

    [Fact]
    public void UploadSessionCleanup_SourceRunsInBackgroundWorker()
    {
        string fileService = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/FileService.cs"));
        string worker = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/Background/UploadSessionCleanupWorker.cs"));

        Assert.DoesNotContain("await CleanupExpiredSessionsAsync(cancellationToken);", fileService, StringComparison.Ordinal);
        Assert.Contains("RequestUploadSessionCleanup()", fileService, StringComparison.Ordinal);
        Assert.Contains("UploadSessionCleanupWorker", worker, StringComparison.Ordinal);
        Assert.Contains("RunCleanupOnceAsync", worker, StringComparison.Ordinal);
    }

    [Fact]
    public void VisitProjectionAndPublicHot_SourceCoalesceBackgroundWork()
    {
        string projection = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/VisitLog/ArticleViewProjectionService.cs"));
        string repair = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/VisitLog/ArticleViewProjectionRepairWorker.cs"));
        string publicHotQueue = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactUpdateQueue.cs"));

        Assert.Contains("IncreaseViewCountsAsync", projection, StringComparison.Ordinal);
        Assert.Contains("MaxPerBatchViewInvalidations", projection, StringComparison.Ordinal);
        Assert.Contains("article-view-projection-batch", projection, StringComparison.Ordinal);
        Assert.Contains("ArticleViewProjectionRepairWorker", repair, StringComparison.Ordinal);
        Assert.Contains("ViewProjectionRefreshInterval", publicHotQueue, StringComparison.Ordinal);
    }
}

public class MiddlewareResultsTests
{
    [Fact]
    public async Task WriteErrorAsync_WithAedsEncoder_WritesApiErrorFrame()
    {
        var services = new ServiceCollection()
            .AddSingleton<IAedsEncoder, AedsEncoder>()
            .BuildServiceProvider();

        var context = new DefaultHttpContext
        {
            RequestServices = services
        };
        await using var body = new MemoryStream();
        context.Response.Body = body;

        await MiddlewareResults.WriteErrorAsync(
            context,
            "account is restricted and cannot perform this write action",
            423,
            "trace-1",
            "ACCOUNT_BANNED_WRITE_LOCKED");

        Assert.Equal(423, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);

        var encoder = services.GetRequiredService<IAedsEncoder>();
        var decoded = encoder.TryDecode(body.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var errorPod));
        Assert.Equal(423, errorPod.HttpStatus);
        Assert.Equal("account is restricted and cannot perform this write action", PodUtf8Codec.FromFixed256(errorPod.Message));
        Assert.Equal("ACCOUNT_BANNED_WRITE_LOCKED", PodUtf8Codec.FromFixed256(errorPod.Details));
        Assert.Equal("trace-1", PodUtf8Codec.FromFixed64(errorPod.TraceId));
    }
}

public class ApiBinaryResponseMiddlewareTests
{
    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.RequestServices = new ServiceCollection()
            .AddSingleton<IBinaryEnvelopePolicy, BinaryEnvelopePolicy>()
            .AddSingleton<IAedsEncoder, AedsEncoder>()
            .BuildServiceProvider();
        return context;
    }

    [Fact]
    public async Task InvokeAsync_BinaryEndpointWithTextAccept_ReturnsApiErrorFrameBeforeEndpoint()
    {
        static Task Next(HttpContext context)
        {
            throw new InvalidOperationException("binary endpoint should not execute");
        }

        var context = CreateContext();
        context.Request.Path = "/api/binary/article/list/home/1/10.aeds";
        context.Request.Headers.Accept = "application/" + "json";
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var encoder = new AedsEncoder();
        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, encoder);

        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);

        var decoded = encoder.TryDecode(body.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var errorPod));
        Assert.Equal(StatusCodes.Status406NotAcceptable, errorPod.HttpStatus);
        Assert.Equal("binary_accept_required", PodUtf8Codec.FromFixed256(errorPod.Message));
    }

    [Fact]
    public async Task InvokeAsync_BinaryEndpointWithTextBody_ReturnsApiErrorFrameBeforeEndpoint()
    {
        static Task Next(HttpContext context)
        {
            throw new InvalidOperationException("binary endpoint should not execute");
        }

        var context = CreateContext();
        context.Request.Path = "/api/binary/admin/article";
        context.Request.Method = "POST";
        context.Request.Headers.Accept = "application/octet-stream";
        context.Request.ContentType = "application/" + "json";
        context.Request.ContentLength = 2;
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var encoder = new AedsEncoder();
        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, encoder);

        Assert.Equal(StatusCodes.Status415UnsupportedMediaType, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);

        var decoded = encoder.TryDecode(body.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var errorPod));
        Assert.Equal(StatusCodes.Status415UnsupportedMediaType, errorPod.HttpStatus);
        Assert.Equal("binary_content_type_required", PodUtf8Codec.FromFixed256(errorPod.Message));
    }

    [Fact]
    public async Task InvokeAsync_BinaryEndpointCorsPreflight_SkipsBinaryEnvelopeChecks()
    {
        static Task Next(HttpContext context)
        {
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return Task.CompletedTask;
        }

        var context = CreateContext();
        context.Request.Path = "/api/binary/system/seo";
        context.Request.Method = HttpMethods.Options;
        context.Request.Headers.Origin = "http://127.0.0.1:3000";
        context.Request.Headers.AccessControlRequestMethod = "GET";
        context.Request.Headers.Accept = "application/" + "json";
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var encoder = new AedsEncoder();
        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, encoder);

        Assert.Equal(StatusCodes.Status204NoContent, context.Response.StatusCode);
        Assert.Equal(0, body.Length);
    }

    [Theory]
    [InlineData("")]
    [InlineData("*/*")]
    [InlineData("application/octet-stream")]
    [InlineData("application/octet-stream; charset=binary")]
    [InlineData("application/json;q=1, application/octet-stream;q=0.5")]
    public async Task InvokeAsync_BinaryEndpointCompatibleAcceptVariants_RunEndpoint(string accept)
    {
        static async Task Next(HttpContext context)
        {
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "application/octet-stream";
            await context.Response.Body.WriteAsync(new byte[] { 0x42 });
        }

        var context = CreateContext();
        context.Request.Path = "/api/binary/system/seo";
        context.Request.Headers.Accept = accept;
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, new AedsEncoder());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(new byte[] { 0x42 }, body.ToArray());
    }

    [Theory]
    [InlineData("application/octet-stream;q=0")]
    [InlineData("application/json, application/octet-stream;q=0")]
    public async Task InvokeAsync_BinaryEndpointQZeroRejectsBinaryAccept(string accept)
    {
        static Task Next(HttpContext context)
        {
            throw new InvalidOperationException("binary endpoint should not execute");
        }

        var context = CreateContext();
        context.Request.Path = "/api/binary/system/seo";
        context.Request.Headers.Accept = accept;
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var encoder = new AedsEncoder();
        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, encoder);

        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        var decoded = encoder.TryDecode(body.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
    }

    [Fact]
    public async Task InvokeAsync_BinaryEndpointWithCompatibleAccept_DoesNotWrapEndpointResponse()
    {
        Stream? endpointBody = null;
        async Task Next(HttpContext context)
        {
            endpointBody = context.Response.Body;
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "application/octet-stream";
            await context.Response.Body.WriteAsync(new byte[] { 0x01, 0x02, 0x03 });
        }

        var context = CreateContext();
        context.Request.Path = "/api/binary/system/seo";
        context.Request.Headers.Accept = "application/octet-stream";
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, new AedsEncoder());

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);
        Assert.Equal(new byte[] { 0x01, 0x02, 0x03 }, body.ToArray());
        Assert.Same(body, endpointBody);
    }

    [Fact]
    public async Task InvokeAsync_BinaryEndpointWithEmptyAuthorizationFailure_ReturnsApiErrorFrame()
    {
        static Task Next(HttpContext context)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        }

        var context = CreateContext();
        context.Request.Path = "/api/binary/comment/me";
        context.Request.Headers.Accept = "application/octet-stream";
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var encoder = new AedsEncoder();
        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, encoder);

        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);

        var decoded = encoder.TryDecode(body.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var errorPod));
        Assert.Equal(StatusCodes.Status401Unauthorized, errorPod.HttpStatus);
        Assert.Equal("HTTP 401", PodUtf8Codec.FromFixed256(errorPod.Message));
    }

    [Fact]
    public async Task InvokeAsync_BinaryAcceptWithTextSuccess_ReturnsApiErrorFrame()
    {
        static async Task Next(HttpContext context)
        {
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "text/plain; charset=utf-8";
            await context.Response.WriteAsync("ok");
        }

        var context = CreateContext();
        context.Request.Path = "/api/test";
        context.Request.Headers.Accept = "application/octet-stream";
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var encoder = new AedsEncoder();
        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, encoder);

        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);

        byte[] frameBytes = body.ToArray();
        var decoded = encoder.TryDecode(frameBytes);
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var errorPod));
        Assert.Equal(StatusCodes.Status406NotAcceptable, errorPod.HttpStatus);
        Assert.Equal("binary_response_required", PodUtf8Codec.FromFixed256(errorPod.Message));
    }

    [Fact]
    public async Task InvokeAsync_BinaryAcceptWithLargeTextResponse_ReturnsCaptureLimitApiError()
    {
        static async Task Next(HttpContext context)
        {
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "text/plain; charset=utf-8";
            byte[] payload = new byte[ApiBinaryResponseMiddleware.MaxCapturedResponseBytes + 1];
            await context.Response.Body.WriteAsync(payload);
        }

        var context = CreateContext();
        context.Request.Path = "/api/test";
        context.Request.Headers.Accept = "application/octet-stream";
        await using var body = new MemoryStream();
        context.Response.Body = body;

        var encoder = new AedsEncoder();
        var middleware = new ApiBinaryResponseMiddleware(Next);
        await middleware.InvokeAsync(context, encoder);

        Assert.Equal(StatusCodes.Status413PayloadTooLarge, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);

        var decoded = encoder.TryDecode(body.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var errorPod));
        Assert.Equal(StatusCodes.Status413PayloadTooLarge, errorPod.HttpStatus);
        Assert.Equal("binary_response_capture_limit_exceeded", PodUtf8Codec.FromFixed256(errorPod.Message));
    }
}
