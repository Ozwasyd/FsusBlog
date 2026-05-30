using System.Buffers;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.Binary;

internal interface IBinaryRequestBinder
{
    Task<BinaryRequestPayload> ReadFrameAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken);

    Task<NameMutationPayload> ReadNameMutationAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken);
}

internal sealed class BinaryRequestBinder : IBinaryRequestBinder
{
    private const string BinaryContentType = "application/octet-stream";
    private const int MaxBinaryRequestFrameBytes = 8 * 1024 * 1024;

    public async Task<BinaryRequestPayload> ReadFrameAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken)
    {
        if (!IsBinaryContentType(httpContext.Request.ContentType))
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "请求体必须使用 application/octet-stream"));
        }

        if (httpContext.Request.ContentLength is > MaxBinaryRequestFrameBytes)
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "请求帧超过 8 MiB 上限"));
        }

        using var frameWriter = new PooledByteBufferWriter(
            (int)Math.Min(httpContext.Request.ContentLength ?? 1024, MaxBinaryRequestFrameBytes),
            clearOnReturn: true);
        byte[] rented = ArrayPool<byte>.Shared.Rent(81920);
        try
        {
            while (true)
            {
                int read = await httpContext.Request.Body.ReadAsync(rented.AsMemory(0, rented.Length), cancellationToken);
                if (read == 0)
                {
                    break;
                }

                if (frameWriter.WrittenCount + read > MaxBinaryRequestFrameBytes)
                {
                    return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "请求帧超过 8 MiB 上限"));
                }

                frameWriter.Write(rented.AsSpan(0, read));
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(rented, clearArray: true);
        }

        var decoded = aeds.TryDecode(frameWriter.WrittenMemory);
        if (!decoded.IsSuccess)
        {
            return BinaryRequestPayload.Failure(decoded.Error);
        }

        if (decoded.Value.FrameType != expectedFrameType)
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "请求帧类型不匹配"));
        }

        int payloadLength = decoded.Value.Payload.Length;
        byte[] frameBuffer = frameWriter.DetachBuffer(out _);
        httpContext.Response.OnCompleted(static state =>
        {
            ArrayPool<byte>.Shared.Return((byte[])state, clearArray: true);
            return Task.CompletedTask;
        }, frameBuffer);

        return BinaryRequestPayload.Success(new ReadOnlyMemory<byte>(frameBuffer, AedsFrameHeader.Size, payloadLength));
    }

    public async Task<NameMutationPayload> ReadNameMutationAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken)
    {
        var payload = await ReadFrameAsync(httpContext, aeds, expectedFrameType, cancellationToken);
        if (!payload.IsSuccess)
        {
            return NameMutationPayload.Failure(payload.Error);
        }

        if (!PodBinaryCodec.TryDecodeNameMutationRequest(payload.Payload, out string name))
        {
            return NameMutationPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "名称请求体非法"));
        }

        return NameMutationPayload.Success(name);
    }

    private static bool IsBinaryContentType(string? contentType)
        => contentType?.StartsWith(BinaryContentType, StringComparison.OrdinalIgnoreCase) == true;
}

internal readonly record struct BinaryRequestPayload(bool IsSuccess, ReadOnlyMemory<byte> Payload, ErrorDetail Error)
{
    public static BinaryRequestPayload Success(ReadOnlyMemory<byte> payload)
        => new(true, payload, ErrorDetail.None);

    public static BinaryRequestPayload Failure(ErrorDetail error)
        => new(false, ReadOnlyMemory<byte>.Empty, error);
}

internal readonly record struct NameMutationPayload(bool IsSuccess, string Name, ErrorDetail Error)
{
    public static NameMutationPayload Success(string name)
        => new(true, name, ErrorDetail.None);

    public static NameMutationPayload Failure(ErrorDetail error)
        => new(false, string.Empty, error);
}
