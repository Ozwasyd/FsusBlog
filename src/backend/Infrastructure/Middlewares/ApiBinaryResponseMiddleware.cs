using System.Buffers;
using System.IO;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
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
        IBinaryEnvelopePolicy envelopePolicy = context.RequestServices.GetRequiredService<IBinaryEnvelopePolicy>();
        if (!ShouldInspect(context.Request.Path))
        {
            await _next(context);
            return;
        }

        if (IsCorsPreflight(context.Request))
        {
            await _next(context);
            return;
        }

        bool isBinaryEndpoint = context.Request.Path.StartsWithSegments("/api/binary", StringComparison.OrdinalIgnoreCase);
        if (isBinaryEndpoint)
        {
            if (HasExplicitIncompatibleAccept(context.Request, envelopePolicy))
            {
                await envelopePolicy.WriteApiErrorAsync(
                    context,
                    context.Response.Body,
                    ErrorDetail.Create(envelopePolicy.MapErrorCode(StatusCodes.Status406NotAcceptable), "binary_accept_required", traceId: context.TraceIdentifier),
                    StatusCodes.Status406NotAcceptable);
                return;
            }

            if (HasIncompatibleBinaryRequestBody(context.Request, envelopePolicy))
            {
                await envelopePolicy.WriteApiErrorAsync(
                    context,
                    context.Response.Body,
                    ErrorDetail.Create(envelopePolicy.MapErrorCode(StatusCodes.Status415UnsupportedMediaType), "binary_content_type_required", traceId: context.TraceIdentifier),
                    StatusCodes.Status415UnsupportedMediaType);
                return;
            }

            await InvokeBinaryEndpointDirectAsync(context, envelopePolicy);
            return;
        }
        else if (!envelopePolicy.AcceptsBinaryEnvelope(context.Request))
        {
            await _next(context);
            return;
        }

        Stream originalBody = context.Response.Body;
        await using var capture = new PooledCaptureStream();
        context.Response.Body = capture;

        try
        {
            await _next(context);

            if (context.Response.HasStarted)
            {
                if (capture.Length > 0)
                {
                    await originalBody.WriteAsync(capture.WrittenMemory, context.RequestAborted);
                }

                return;
            }

            bool acceptsBinaryEnvelope = envelopePolicy.AcceptsBinaryEnvelope(context.Request);
            string contentType = context.Response.ContentType ?? string.Empty;
            if (envelopePolicy.IsBinaryContentType(contentType) || envelopePolicy.IsStreamContentType(contentType))
            {
                if (capture.Length > 0)
                {
                    await originalBody.WriteAsync(capture.WrittenMemory, context.RequestAborted);
                }

                return;
            }

            ReadOnlyMemory<byte> rawBody = capture.WrittenMemory;

            if (!acceptsBinaryEnvelope)
            {
                context.Response.Body = originalBody;
                if (rawBody.Length == 0 && context.Response.StatusCode >= 400)
                {
                    await envelopePolicy.WriteApiErrorAsync(
                        context,
                        originalBody,
                        ErrorDetail.Create(envelopePolicy.MapErrorCode(context.Response.StatusCode), $"HTTP {context.Response.StatusCode}", traceId: context.TraceIdentifier),
                        context.Response.StatusCode);
                    return;
                }

                if (rawBody.Length > 0)
                {
                    await originalBody.WriteAsync(rawBody, context.RequestAborted);
                }

                return;
            }

            if (rawBody.Length == 0 && context.Response.StatusCode >= 400)
            {
                await envelopePolicy.WriteApiErrorAsync(
                    context,
                    originalBody,
                    ErrorDetail.Create(envelopePolicy.MapErrorCode(context.Response.StatusCode), $"HTTP {context.Response.StatusCode}", traceId: context.TraceIdentifier),
                    context.Response.StatusCode);
                return;
            }

            int statusCode = context.Response.StatusCode >= 400
                ? context.Response.StatusCode
                : StatusCodes.Status406NotAcceptable;
            string message = context.Response.StatusCode >= 400
                ? $"HTTP {context.Response.StatusCode}"
                : "binary_response_required";
            await envelopePolicy.WriteApiErrorAsync(
                context,
                originalBody,
                ErrorDetail.Create(envelopePolicy.MapErrorCode(statusCode), message, traceId: context.TraceIdentifier),
                statusCode);
        }
        finally
        {
            context.Response.Body = originalBody;
        }
    }

    private static bool ShouldInspect(PathString path)
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

    private static bool HasExplicitIncompatibleAccept(HttpRequest request, IBinaryEnvelopePolicy envelopePolicy)
    {
        return request.Headers.Accept.Count > 0 && !envelopePolicy.AcceptsBinaryEnvelope(request);
    }

    private static bool IsCorsPreflight(HttpRequest request)
    {
        return HttpMethods.IsOptions(request.Method)
            && request.Headers.ContainsKey("Origin")
            && request.Headers.ContainsKey("Access-Control-Request-Method");
    }

    private static bool HasIncompatibleBinaryRequestBody(HttpRequest request, IBinaryEnvelopePolicy envelopePolicy)
    {
        if (HttpMethods.IsGet(request.Method) || HttpMethods.IsHead(request.Method))
        {
            return false;
        }

        if (!request.ContentLength.HasValue || request.ContentLength.Value == 0)
        {
            return false;
        }

        string contentType = request.ContentType ?? string.Empty;
        return !envelopePolicy.IsBinaryRequestContentType(contentType);
    }

    private sealed class PooledCaptureStream : Stream
    {
        private readonly PooledByteBufferWriter _writer = new(1024);

        public ReadOnlyMemory<byte> WrittenMemory => _writer.WrittenMemory;

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => _writer.WrittenCount;

        public override long Position
        {
            get => _writer.WrittenCount;
            set => throw new NotSupportedException();
        }

        public override void Flush()
        {
        }

        public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count)
        {
            _writer.Write(buffer.AsSpan(offset, count));
        }

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            _writer.Write(buffer);
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                return Task.FromCanceled(cancellationToken);
            }

            _writer.Write(buffer.AsSpan(offset, count));
            return Task.CompletedTask;
        }

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                return ValueTask.FromCanceled(cancellationToken);
            }

            _writer.Write(buffer.Span);
            return ValueTask.CompletedTask;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _writer.Dispose();
            }

            base.Dispose(disposing);
        }

        public override ValueTask DisposeAsync()
        {
            _writer.Dispose();
            return base.DisposeAsync();
        }
    }

    private async Task InvokeBinaryEndpointDirectAsync(HttpContext context, IBinaryEnvelopePolicy envelopePolicy)
    {
        await _next(context);

        if (context.Response.HasStarted || context.Response.StatusCode < 400 || !IsResponseBodyEmpty(context.Response.Body))
        {
            return;
        }

        await envelopePolicy.WriteApiErrorAsync(
            context,
            context.Response.Body,
            ErrorDetail.Create(envelopePolicy.MapErrorCode(context.Response.StatusCode), $"HTTP {context.Response.StatusCode}", traceId: context.TraceIdentifier),
            context.Response.StatusCode);
    }

    private static bool IsResponseBodyEmpty(Stream body)
        => !body.CanSeek || body.Length == 0;
}
