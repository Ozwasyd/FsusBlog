using System.Text;
using FsusBlog.Core.Algorithms;
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

            byte[] rawBody = capture.ToArray();
            if (rawBody.Length == 0 && context.Response.StatusCode >= 400)
            {
                rawBody = BuildSyntheticErrorBody(context.Response.StatusCode);
                contentType = "application/json; charset=utf-8";
            }

            byte[] payload = ApiBinaryEnvelopeCodec.EncodeEnvelopePayload(context.Response.StatusCode, contentType, rawBody);
            AedsFrameType frameType = context.Response.StatusCode >= 400 ? AedsFrameType.ApiError : AedsFrameType.ApiEnvelope;
            byte[] frame = AedsBinaryWriter.WriteFrame(encoder, frameType, payload);

            context.Response.Body = originalBody;
            context.Response.ContentType = "application/octet-stream";
            context.Response.Headers.ContentLength = frame.Length;
            context.Response.Headers["X-Fsus-Frame-Version"] = "1";

            await context.Response.Body.WriteAsync(frame, context.RequestAborted);
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

    private static byte[] BuildSyntheticErrorBody(int statusCode)
    {
        string json = $"{{\"code\":{statusCode},\"message\":\"HTTP {statusCode}\"}}";
        return Encoding.UTF8.GetBytes(json);
    }
}
