using System.Buffers;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Binary;

namespace FsusBlog.Server.Infrastructure.Results;

public sealed class BinaryFrameResult(
    IAedsEncoder encoder,
    AedsFrameType frameType,
    Action<IBufferWriter<byte>> writePayload,
    int? statusCode = null) : IResult
{
    private static readonly byte[] EmptySuccessPayload = PodBinaryCodec.EncodeEmptySuccess();
    private static readonly ReadOnlyMemory<byte> EmptySuccessFrame =
        new AedsEncoder().Encode(AedsFrameType.EmptySuccess, EmptySuccessPayload);
    private readonly IAedsEncoder _encoder = encoder;
    private readonly AedsFrameType _frameType = frameType;
    private readonly Action<IBufferWriter<byte>> _writePayload = writePayload;
    private readonly int? _statusCode = statusCode;

    public async Task ExecuteAsync(HttpContext httpContext)
    {
        IBinaryEnvelopePolicy envelopePolicy = ResolveEnvelopePolicy(httpContext);
        if (!_statusCode.HasValue && _frameType == AedsFrameType.EmptySuccess)
        {
            envelopePolicy.ApplyFrameResponse(httpContext.Response, EmptySuccessPayload.Length);
            await httpContext.Response.BodyWriter.WriteAsync(EmptySuccessFrame, httpContext.RequestAborted);
            return;
        }

        using var payloadWriter = new PooledByteBufferWriter(1024);
        _writePayload(payloadWriter);

        envelopePolicy.ApplyFrameResponse(httpContext.Response, payloadWriter.WrittenCount, _statusCode);
        _encoder.WriteFrame(_frameType, payloadWriter.WrittenSpan, httpContext.Response.BodyWriter);
        await httpContext.Response.BodyWriter.FlushAsync(httpContext.RequestAborted);
    }

    private static IBinaryEnvelopePolicy ResolveEnvelopePolicy(HttpContext httpContext)
        => httpContext.RequestServices?.GetService<IBinaryEnvelopePolicy>() ?? new BinaryEnvelopePolicy();
}

public sealed class BinaryFramePayloadResult(
    IAedsEncoder encoder,
    AedsFrameType frameType,
    ReadOnlyMemory<byte> payload,
    int? statusCode = null) : IResult
{
    private readonly IAedsEncoder _encoder = encoder;
    private readonly AedsFrameType _frameType = frameType;
    private readonly ReadOnlyMemory<byte> _payload = payload;
    private readonly int? _statusCode = statusCode;

    public async Task ExecuteAsync(HttpContext httpContext)
    {
        IBinaryEnvelopePolicy envelopePolicy = ResolveEnvelopePolicy(httpContext);
        envelopePolicy.ApplyFrameResponse(httpContext.Response, _payload.Length, _statusCode);
        _encoder.WriteFrame(_frameType, _payload.Span, httpContext.Response.BodyWriter);
        await httpContext.Response.BodyWriter.FlushAsync(httpContext.RequestAborted);
    }

    private static IBinaryEnvelopePolicy ResolveEnvelopePolicy(HttpContext httpContext)
        => httpContext.RequestServices?.GetService<IBinaryEnvelopePolicy>() ?? new BinaryEnvelopePolicy();
}

public sealed class BinaryPreencodedFrameResult(ReadOnlyMemory<byte> frame, int? statusCode = null) : IResult
{
    private readonly ReadOnlyMemory<byte> _frame = frame;
    private readonly int? _statusCode = statusCode;

    public async Task ExecuteAsync(HttpContext httpContext)
    {
        httpContext.Response.ContentType = "application/octet-stream";
        if (_statusCode.HasValue)
        {
            httpContext.Response.StatusCode = _statusCode.Value;
        }

        httpContext.Response.Headers["X-Fsus-Frame-Version"] = AedsFrameHeader.CurrentVersion.ToString();
        httpContext.Response.ContentLength = _frame.Length;
        await httpContext.Response.BodyWriter.WriteAsync(_frame, httpContext.RequestAborted);
    }
}
