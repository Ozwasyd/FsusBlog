using System.Buffers;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Binary;

using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.Results;

public sealed class BinaryFrameResult(
    AedsFrameType frameType,
    Action<IBufferWriter<byte>> writePayload,
    int? statusCode = null) : IResult
{
    private static readonly byte[] s_emptySuccessPayload = PodBinaryCodec.EncodeEmptySuccess();
    private static readonly ReadOnlyMemory<byte> s_emptySuccessFrame =
        new AedsEncoder().Encode(AedsFrameType.EmptySuccess, s_emptySuccessPayload);
    private readonly AedsFrameType _frameType = frameType;
    private readonly Action<IBufferWriter<byte>> _writePayload = writePayload;
    private readonly int? _statusCode = statusCode;

    public async Task ExecuteAsync(HttpContext httpContext)
    {
        IBinaryEnvelopePolicy envelopePolicy = ResolveEnvelopePolicy(httpContext);
        if (!_statusCode.HasValue && _frameType == AedsFrameType.EmptySuccess)
        {
            envelopePolicy.ApplyFrameResponse(httpContext.Response, s_emptySuccessPayload.Length);
            await httpContext.Response.BodyWriter.WriteAsync(s_emptySuccessFrame, httpContext.RequestAborted);
            return;
        }

        using var frameWriter = new AedsFrameBufferWriter(1024);
        _writePayload(frameWriter.PayloadWriter);
        frameWriter.Seal(_frameType);

        envelopePolicy.ApplyFrameResponse(httpContext.Response, frameWriter.PayloadLength, _statusCode);
        await httpContext.Response.BodyWriter.WriteAsync(frameWriter.WrittenFrame, httpContext.RequestAborted);
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

public sealed record BinaryFrameResponseMetadata(
    string? ETag = null,
    string? CacheControl = null,
    string? ContentEncoding = null,
    bool AcceptRangesNone = true,
    bool VaryAcceptEncoding = false);

public sealed class BinaryPreencodedFrameResult : IResult
{
    private readonly ReadOnlyMemory<byte> _frame;
    private OwnedAedsFrameReadLease? _ownedLease;
    private readonly bool _ownsLease;
    private int _ownedExecutionStarted;
    private readonly int? _statusCode;
    private readonly BinaryFrameResponseMetadata? _metadata;

    public BinaryPreencodedFrameResult(
        ReadOnlyMemory<byte> frame,
        int? statusCode = null,
        BinaryFrameResponseMetadata? metadata = null)
    {
        _frame = frame;
        _statusCode = statusCode;
        _metadata = metadata;
    }

    public BinaryPreencodedFrameResult(
        OwnedAedsFrameReadLease ownedLease,
        int? statusCode = null,
        BinaryFrameResponseMetadata? metadata = null)
    {
        _ownedLease = ownedLease ?? throw new ArgumentNullException(nameof(ownedLease));
        _ownsLease = true;
        _statusCode = statusCode;
        _metadata = metadata;
    }

    public async Task ExecuteAsync(HttpContext httpContext)
    {
        if (_ownsLease && Interlocked.Exchange(ref _ownedExecutionStarted, 1) != 0)
        {
            throw new InvalidOperationException("An owned pre-encoded frame result can only be executed once.");
        }

        OwnedAedsFrameReadLease? lease = Interlocked.Exchange(ref _ownedLease, null);
        try
        {
            ReadOnlyMemory<byte> frame = lease?.Memory ?? _frame;
            httpContext.Response.ContentType = "application/octet-stream";
            if (_statusCode.HasValue)
            {
                httpContext.Response.StatusCode = _statusCode.Value;
            }

            httpContext.Response.Headers["X-Fsus-Frame-Version"] = AedsFrameHeader.CurrentVersion.ToString();
            ApplyMetadata(httpContext.Response, _metadata);
            if (MatchesIfNoneMatch(httpContext.Request.Headers.IfNoneMatch, _metadata?.ETag))
            {
                httpContext.Response.StatusCode = StatusCodes.Status304NotModified;
                httpContext.Response.ContentLength = 0;
                return;
            }

            httpContext.Response.ContentLength = frame.Length;
            if (HttpMethods.IsHead(httpContext.Request.Method))
            {
                return;
            }

            await httpContext.Response.BodyWriter.WriteAsync(frame, httpContext.RequestAborted);
        }
        finally
        {
            lease?.Dispose();
        }
    }

    private static void ApplyMetadata(HttpResponse response, BinaryFrameResponseMetadata? metadata)
    {
        if (metadata is null)
        {
            return;
        }

        if (!string.IsNullOrWhiteSpace(metadata.ETag))
        {
            response.Headers.ETag = metadata.ETag;
        }

        if (!string.IsNullOrWhiteSpace(metadata.CacheControl))
        {
            response.Headers.CacheControl = metadata.CacheControl;
        }

        if (!string.IsNullOrWhiteSpace(metadata.ContentEncoding))
        {
            response.Headers.ContentEncoding = metadata.ContentEncoding;
        }

        if (metadata.AcceptRangesNone)
        {
            response.Headers.AcceptRanges = "none";
        }

        if (metadata.VaryAcceptEncoding)
        {
            response.Headers.Vary = "Accept-Encoding";
        }
    }

    private static bool MatchesIfNoneMatch(StringValues values, string? etag)
    {
        if (string.IsNullOrWhiteSpace(etag) || values.Count == 0)
        {
            return false;
        }

        for (int i = 0; i < values.Count; i++)
        {
            ReadOnlySpan<char> header = (values[i] ?? string.Empty).AsSpan();
            while (true)
            {
                int comma = header.IndexOf(',');
                ReadOnlySpan<char> candidate = (comma >= 0 ? header[..comma] : header).Trim();
                if (candidate.Equals("*", StringComparison.Ordinal)
                    || candidate.Equals(etag.AsSpan(), StringComparison.Ordinal))
                {
                    return true;
                }

                if (comma < 0)
                {
                    break;
                }

                header = header[(comma + 1)..];
            }
        }

        return false;
    }
}
