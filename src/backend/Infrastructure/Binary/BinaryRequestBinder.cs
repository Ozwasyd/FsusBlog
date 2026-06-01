using System.Buffers;
using System.Buffers.Binary;
using System.IO.Pipelines;
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

        byte[] headerBuffer = ArrayPool<byte>.Shared.Rent(AedsFrameHeader.Size);
        try
        {
            if (!await ReadExactAsync(httpContext.Request.BodyReader, headerBuffer.AsMemory(0, AedsFrameHeader.Size), cancellationToken))
            {
                return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS frame too short"));
            }

            ReadOnlySpan<byte> header = headerBuffer.AsSpan(0, AedsFrameHeader.Size);
            uint magic = BinaryPrimitives.ReadUInt32LittleEndian(header[0..4]);
            byte version = header[4];
            byte headerLength = header[5];
            ushort frameTypeRaw = BinaryPrimitives.ReadUInt16LittleEndian(header[8..10]);
            uint payloadLength = BinaryPrimitives.ReadUInt32LittleEndian(header[10..14]);
            ushort expectedPayloadCrc = BinaryPrimitives.ReadUInt16LittleEndian(header[14..16]);

            if (magic != AedsEncoder.Magic)
            {
                return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS magic mismatch"));
            }

            if (version != AedsFrameHeader.CurrentVersion)
            {
                return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS version unsupported"));
            }

            if (headerLength != AedsFrameHeader.Size)
            {
                return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS header length mismatch"));
            }

            if (frameTypeRaw != (ushort)expectedFrameType)
            {
                return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "请求帧类型不匹配"));
            }

            if (payloadLength > MaxBinaryRequestFrameBytes - AedsFrameHeader.Size)
            {
                return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "请求帧超过 8 MiB 上限"));
            }

            long expectedFrameLength = AedsFrameHeader.Size + (long)payloadLength;
            if (httpContext.Request.ContentLength.HasValue && httpContext.Request.ContentLength.Value != expectedFrameLength)
            {
                return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS payload length mismatch"));
            }

            if (payloadLength == 0)
            {
                return expectedPayloadCrc == AedsCrc16.Compute(ReadOnlySpan<byte>.Empty)
                    ? BinaryRequestPayload.Success(ReadOnlyMemory<byte>.Empty)
                    : BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS payload crc mismatch"));
            }

            byte[] payloadBuffer = ArrayPool<byte>.Shared.Rent((int)payloadLength);
            ErrorDetail payloadError = await ReadPayloadAndValidateAsync(
                    httpContext,
                    payloadBuffer,
                    (int)payloadLength,
                    expectedPayloadCrc,
                    cancellationToken);
            if (payloadError.Code != ErrorCode.None)
            {
                return BinaryRequestPayload.Failure(payloadError);
            }

            httpContext.Response.OnCompleted(static state =>
            {
                ArrayPool<byte>.Shared.Return((byte[])state, clearArray: true);
                return Task.CompletedTask;
            }, payloadBuffer);

            return BinaryRequestPayload.Success(new ReadOnlyMemory<byte>(payloadBuffer, 0, (int)payloadLength));
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(headerBuffer, clearArray: true);
        }
    }

    private static async Task<ErrorDetail> ReadPayloadAndValidateAsync(
        HttpContext httpContext,
        byte[] payloadBuffer,
        int payloadLength,
        ushort expectedPayloadCrc,
        CancellationToken cancellationToken)
    {
        bool read = await ReadExactAsync(httpContext.Request.BodyReader, payloadBuffer.AsMemory(0, payloadLength), cancellationToken);
        if (!read)
        {
            ArrayPool<byte>.Shared.Return(payloadBuffer, clearArray: true);
            return ErrorDetail.Create(ErrorCode.Validation, "AEDS payload length mismatch");
        }

        ushort actualCrc = AedsCrc16.Compute(payloadBuffer.AsSpan(0, payloadLength));
        if (actualCrc == expectedPayloadCrc)
        {
            return ErrorDetail.None;
        }

        ArrayPool<byte>.Shared.Return(payloadBuffer, clearArray: true);
        return ErrorDetail.Create(ErrorCode.Validation, "AEDS payload crc mismatch");
    }

    private static async Task<bool> ReadExactAsync(
        PipeReader reader,
        Memory<byte> destination,
        CancellationToken cancellationToken)
    {
        int copied = 0;
        while (copied < destination.Length)
        {
            ReadResult result = await reader.ReadAsync(cancellationToken);
            ReadOnlySequence<byte> buffer = result.Buffer;
            long remaining = destination.Length - copied;
            long copyLength = Math.Min(buffer.Length, remaining);
            if (copyLength > 0)
            {
                buffer.Slice(0, copyLength).CopyTo(destination.Span[copied..]);
                copied += (int)copyLength;
                SequencePosition consumed = buffer.GetPosition(copyLength);
                reader.AdvanceTo(consumed, consumed);
            }
            else
            {
                reader.AdvanceTo(buffer.Start, buffer.End);
            }

            if (result.IsCompleted && copied < destination.Length)
            {
                return false;
            }
        }

        return true;
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
