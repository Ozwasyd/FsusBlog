using System.Buffers;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.Results;

public sealed class BinaryFrameResult(
    IAedsEncoder encoder,
    AedsFrameType frameType,
    Action<IBufferWriter<byte>> writePayload) : IResult
{
    private const string BinaryContentType = "application/octet-stream";

    private readonly IAedsEncoder _encoder = encoder;
    private readonly AedsFrameType _frameType = frameType;
    private readonly Action<IBufferWriter<byte>> _writePayload = writePayload;

    public async Task ExecuteAsync(HttpContext httpContext)
    {
        using var payloadWriter = new PooledByteBufferWriter(1024);
        _writePayload(payloadWriter);

        httpContext.Response.ContentType = BinaryContentType;
        httpContext.Response.Headers["X-Fsus-Frame-Version"] = "1";
        httpContext.Response.ContentLength = AedsFrameHeader.Size + payloadWriter.WrittenCount;

        _encoder.WriteFrame(_frameType, payloadWriter.WrittenSpan, httpContext.Response.BodyWriter);
        await httpContext.Response.BodyWriter.FlushAsync(httpContext.RequestAborted);
    }
}
