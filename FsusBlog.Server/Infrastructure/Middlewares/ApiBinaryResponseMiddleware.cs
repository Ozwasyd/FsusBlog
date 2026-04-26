using System.Buffers;
using System.IO;
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

            string contentType = context.Response.ContentType ?? string.Empty;
            if (IsBinaryContentType(contentType) || IsStreamContentType(contentType))
            {
                if (capture.Length > 0)
                {
                    await originalBody.WriteAsync(capture.WrittenMemory, context.RequestAborted);
                }

                return;
            }

            byte[]? ownedBody = null;
            ReadOnlyMemory<byte> rawBody = capture.WrittenMemory;

            if (rawBody.Length == 0 && context.Response.StatusCode >= 400)
            {
                ownedBody = BuildSyntheticErrorBody(context.Response.StatusCode);
                rawBody = ownedBody;
                contentType = "application/json; charset=utf-8";
            }

            int envelopeStatusCode = context.Response.StatusCode;
            var payloadWriter = new ArrayBufferWriter<byte>(Math.Max(rawBody.Length + 64, 256));
            Result envelopeResult = ApiBinaryEnvelopeCodec.TryWriteEnvelopePayload(envelopeStatusCode, contentType, rawBody.Span, payloadWriter);
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
                    payloadWriter = new ArrayBufferWriter<byte>(256);
                    payloadWriter.Write(ApiBinaryEnvelopeCodec.EncodeEnvelopePayload(
                        envelopeStatusCode,
                        "application/json; charset=utf-8",
                        errorBody));
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
}
