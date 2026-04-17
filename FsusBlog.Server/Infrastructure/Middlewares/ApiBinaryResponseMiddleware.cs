using System.Buffers;
using System.Text.Json;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Binary;

namespace FsusBlog.Server.Infrastructure.Middlewares;

public sealed class ApiBinaryResponseMiddleware
{
    private readonly RequestDelegate _next;

    public ApiBinaryResponseMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context, IAedsEncoder encoder)
    {
        if (!ShouldWrap(context.Request.Path))
        {
            await _next(context);
            return;
        }

        Stream originalBody = context.Response.Body;
        await using var capture = new MemoryStream();
        context.Response.Body = capture;

        try
        {
            await _next(context);

            if (context.Response.HasStarted)
            {
                capture.Position = 0;
                await capture.CopyToAsync(originalBody, context.RequestAborted);
                return;
            }

            string contentType = context.Response.ContentType ?? string.Empty;
            if (IsBinaryContentType(contentType) || IsStreamContentType(contentType))
            {
                capture.Position = 0;
                await capture.CopyToAsync(originalBody, context.RequestAborted);
                return;
            }

            ReadOnlySpan<byte> rawBody = default;
            byte[]? ownedBody = null;
            if (capture.Length > 0)
            {
                if (capture.TryGetBuffer(out ArraySegment<byte> buffer))
                {
                    rawBody = buffer.AsSpan(0, checked((int)capture.Length));
                }
                else
                {
                    ownedBody = capture.ToArray();
                    rawBody = ownedBody;
                }
            }

            if (rawBody.Length == 0 && context.Response.StatusCode >= 400)
            {
                ownedBody = BuildSyntheticErrorBody(context.Response.StatusCode);
                rawBody = ownedBody;
                contentType = "application/json; charset=utf-8";
            }

            int envelopeStatusCode = context.Response.StatusCode;
            var payloadWriter = new ArrayBufferWriter<byte>(Math.Max(rawBody.Length + 64, 256));
            Result envelopeResult = ApiBinaryEnvelopeCodec.TryWriteEnvelopePayload(envelopeStatusCode, contentType, rawBody, payloadWriter);
            AedsFrameType frameType = envelopeStatusCode >= 400 ? AedsFrameType.ApiError : AedsFrameType.ApiEnvelope;

            if (!envelopeResult.IsSuccess)
            {
                payloadWriter = new ArrayBufferWriter<byte>(256);
                envelopeStatusCode = StatusCodes.Status500InternalServerError;
                byte[] errorBody = BuildSyntheticErrorBody(envelopeStatusCode, envelopeResult.Error.Message);
                Result fallbackResult = ApiBinaryEnvelopeCodec.TryWriteEnvelopePayload(
                    envelopeStatusCode,
                    "application/json; charset=utf-8",
                    errorBody,
                    payloadWriter);
                if (!fallbackResult.IsSuccess)
                {
                    throw new InvalidOperationException("binary_envelope_fallback_failed");
                }

                frameType = AedsFrameType.ApiError;
            }

            context.Response.Body = originalBody;
            context.Response.StatusCode = envelopeStatusCode;
            context.Response.ContentType = "application/octet-stream";
            context.Response.ContentLength = AedsFrameHeader.Size + payloadWriter.WrittenCount;
            context.Response.Headers["X-Fsus-Frame-Version"] = "1";

            encoder.WriteFrame(frameType, payloadWriter.WrittenSpan, context.Response.BodyWriter);
            await context.Response.BodyWriter.FlushAsync(context.RequestAborted);
        }
        finally
        {
            context.Response.Body = originalBody;
        }
    }

    private static bool ShouldWrap(PathString path)
    {
        if (!path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (path.StartsWithSegments("/api/notifications/stream", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return true;
    }

    private static bool IsBinaryContentType(string contentType)
    {
        return contentType.StartsWith("application/octet-stream", StringComparison.OrdinalIgnoreCase)
            || contentType.StartsWith("application/wasm", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsStreamContentType(string contentType)
    {
        return contentType.StartsWith("text/event-stream", StringComparison.OrdinalIgnoreCase)
            || contentType.StartsWith("application/grpc", StringComparison.OrdinalIgnoreCase);
    }

    private static byte[] BuildSyntheticErrorBody(int statusCode, string? message = null)
    {
        string safeMessage = string.IsNullOrWhiteSpace(message) ? $"HTTP {statusCode}" : message;
        return JsonSerializer.SerializeToUtf8Bytes(new { code = statusCode, message = safeMessage });
    }
}
