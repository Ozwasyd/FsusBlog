using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Results;

namespace FsusBlog.Server.Infrastructure.Binary;

internal interface IBinaryEnvelopePolicy
{
    bool AcceptsBinaryEnvelope(HttpRequest request);
    bool IsBinaryContentType(string contentType);
    bool IsBinaryRequestContentType(string contentType);
    bool IsStreamContentType(string contentType);
    ErrorCode MapErrorCode(int statusCode);
    void ApplyFrameResponse(HttpResponse response, int payloadLength, int? statusCode = null);
    Task WriteApiErrorAsync(HttpContext context, Stream responseBody, ErrorDetail error, int statusCode);
}

internal sealed class BinaryEnvelopePolicy : IBinaryEnvelopePolicy
{
    private const string BinaryContentType = "application/octet-stream";
    private const string BinaryFrameVersion = "2";

    public bool AcceptsBinaryEnvelope(HttpRequest request)
    {
        var acceptHeaders = request.Headers.Accept;
        for (int i = 0; i < acceptHeaders.Count; i++)
        {
            string? header = acceptHeaders[i];
            if (string.IsNullOrWhiteSpace(header))
            {
                continue;
            }

            ReadOnlySpan<char> remaining = header.AsSpan();
            while (!remaining.IsEmpty)
            {
                int comma = remaining.IndexOf(',');
                ReadOnlySpan<char> segment = comma >= 0 ? remaining[..comma] : remaining;
                int semicolon = segment.IndexOf(';');
                ReadOnlySpan<char> mediaType = (semicolon >= 0 ? segment[..semicolon] : segment).Trim();
                if (mediaType.Equals(BinaryContentType.AsSpan(), StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }

                if (comma < 0)
                {
                    break;
                }

                remaining = remaining[(comma + 1)..];
            }
        }

        return false;
    }

    public bool IsBinaryContentType(string contentType)
    {
        return IsBinaryRequestContentType(contentType)
            || contentType.StartsWith("application/wasm", StringComparison.OrdinalIgnoreCase);
    }

    public bool IsBinaryRequestContentType(string contentType)
    {
        return contentType.StartsWith(BinaryContentType, StringComparison.OrdinalIgnoreCase);
    }

    public bool IsStreamContentType(string contentType)
    {
        return contentType.StartsWith("application/grpc", StringComparison.OrdinalIgnoreCase);
    }

    public ErrorCode MapErrorCode(int statusCode)
        => ApiErrorSemanticMapper.MapErrorCode(statusCode);

    public void ApplyFrameResponse(HttpResponse response, int payloadLength, int? statusCode = null)
    {
        response.ContentType = BinaryContentType;
        if (statusCode.HasValue)
        {
            response.StatusCode = statusCode.Value;
        }

        response.Headers["X-Fsus-Frame-Version"] = BinaryFrameVersion;
        response.ContentLength = AedsFrameHeader.Size + payloadLength;
    }

    public async Task WriteApiErrorAsync(HttpContext context, Stream responseBody, ErrorDetail error, int statusCode)
    {
        var encoder = context.RequestServices?.GetService<IAedsEncoder>() ?? new AedsEncoder();
        using var payloadWriter = new PooledByteBufferWriter(256);
        PodBinaryCodec.WriteApiError(error, payloadWriter, statusCode);

        context.Response.Body = responseBody;
        ApplyFrameResponse(context.Response, payloadWriter.WrittenCount, statusCode);

        encoder.WriteHeader(AedsFrameType.ApiError, payloadWriter.WrittenSpan, context.Response.BodyWriter);
        Span<byte> payloadTarget = context.Response.BodyWriter.GetSpan(payloadWriter.WrittenCount);
        payloadWriter.WrittenSpan.CopyTo(payloadTarget);
        context.Response.BodyWriter.Advance(payloadWriter.WrittenCount);
        await context.Response.BodyWriter.FlushAsync(context.RequestAborted);
    }
}
