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
        CancellationToken cancellationToken,
        int? maxFrameBytes = null);

    Task<BinaryRequestPayload> ReadFrameAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IReadOnlyCollection<AedsFrameType> expectedFrameTypes,
        CancellationToken cancellationToken,
        int? maxFrameBytes = null);

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

    public Task<BinaryRequestPayload> ReadFrameAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken,
        int? maxFrameBytes = null)
        => ReadFrameAsync(httpContext, aeds, [expectedFrameType], cancellationToken, maxFrameBytes);

    public async Task<BinaryRequestPayload> ReadFrameAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IReadOnlyCollection<AedsFrameType> expectedFrameTypes,
        CancellationToken cancellationToken,
        int? maxFrameBytes = null)
    {
        int frameLimit = NormalizeFrameLimit(maxFrameBytes);
        if (!IsBinaryContentType(httpContext.Request.ContentType))
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "请求体必须使用 application/octet-stream"));
        }

        if (httpContext.Request.ContentLength.HasValue && httpContext.Request.ContentLength.Value > frameLimit)
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, $"请求帧超过 {FormatBytes(frameLimit)} 上限"));
        }

        ReadResult headerResult = await httpContext.Request.BodyReader.ReadAtLeastAsync(AedsFrameHeader.Size, cancellationToken);
        ReadOnlySequence<byte> headerBuffer = headerResult.Buffer;
        if (headerBuffer.Length < AedsFrameHeader.Size)
        {
            httpContext.Request.BodyReader.AdvanceTo(headerBuffer.End);
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS frame too short"));
        }

        var headerReader = new SequenceReader<byte>(headerBuffer.Slice(0, AedsFrameHeader.Size));
        if (!TryReadHeader(
                ref headerReader,
                out uint magic,
                out byte version,
                out byte headerLength,
                out ushort flags,
                out ushort frameTypeRaw,
                out uint payloadLength,
                out ushort expectedPayloadCrc))
        {
            httpContext.Request.BodyReader.AdvanceTo(headerBuffer.End);
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS header length mismatch"));
        }

        SequencePosition headerConsumed = headerBuffer.GetPosition(AedsFrameHeader.Size);
        httpContext.Request.BodyReader.AdvanceTo(headerConsumed, headerConsumed);

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

        if (flags != 0)
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS request flags unsupported"));
        }

        AedsFrameType actualFrameType = (AedsFrameType)frameTypeRaw;
        if (!IsExpectedFrameType(actualFrameType, expectedFrameTypes))
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "请求帧类型不匹配"));
        }

        if (payloadLength > frameLimit - AedsFrameHeader.Size)
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, $"请求帧超过 {FormatBytes(frameLimit)} 上限"));
        }

        long expectedFrameLength = AedsFrameHeader.Size + (long)payloadLength;
        if (httpContext.Request.ContentLength.HasValue && httpContext.Request.ContentLength.Value != expectedFrameLength)
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS payload length mismatch"));
        }

        if (payloadLength == 0)
        {
            return expectedPayloadCrc == AedsCrc16.Compute(ReadOnlySpan<byte>.Empty)
                ? BinaryRequestPayload.Success(ReadOnlyMemory<byte>.Empty, actualFrameType)
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

        return BinaryRequestPayload.Success(new ReadOnlyMemory<byte>(payloadBuffer, 0, (int)payloadLength), actualFrameType);
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

    private static bool TryReadHeader(
        ref SequenceReader<byte> reader,
        out uint magic,
        out byte version,
        out byte headerLength,
        out ushort flags,
        out ushort frameTypeRaw,
        out uint payloadLength,
        out ushort expectedPayloadCrc)
    {
        magic = 0;
        version = 0;
        headerLength = 0;
        flags = 0;
        frameTypeRaw = 0;
        payloadLength = 0;
        expectedPayloadCrc = 0;

        if (!reader.TryReadLittleEndian(out int magicRaw)
            || !reader.TryRead(out version)
            || !reader.TryRead(out headerLength)
            || !reader.TryReadLittleEndian(out short flagsRaw)
            || !reader.TryReadLittleEndian(out short frameTypeRawSigned)
            || !reader.TryReadLittleEndian(out int payloadLengthRaw)
            || !reader.TryReadLittleEndian(out short payloadCrcRaw))
        {
            return false;
        }

        magic = unchecked((uint)magicRaw);
        flags = unchecked((ushort)flagsRaw);
        frameTypeRaw = unchecked((ushort)frameTypeRawSigned);
        payloadLength = unchecked((uint)payloadLengthRaw);
        expectedPayloadCrc = unchecked((ushort)payloadCrcRaw);
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

    private static bool IsExpectedFrameType(AedsFrameType actualFrameType, IReadOnlyCollection<AedsFrameType> expectedFrameTypes)
    {
        foreach (AedsFrameType expectedFrameType in expectedFrameTypes)
        {
            if (actualFrameType == expectedFrameType)
            {
                return true;
            }
        }

        return false;
    }

    private static int NormalizeFrameLimit(int? maxFrameBytes)
    {
        if (maxFrameBytes is null or <= 0)
        {
            return MaxBinaryRequestFrameBytes;
        }

        return Math.Min(Math.Max(maxFrameBytes.Value, AedsFrameHeader.Size), MaxBinaryRequestFrameBytes);
    }

    private static string FormatBytes(int bytes)
        => bytes == MaxBinaryRequestFrameBytes
            ? "8 MiB"
            : $"{bytes} bytes";
}

internal readonly record struct BinaryRequestPayload(bool IsSuccess, ReadOnlyMemory<byte> Payload, ErrorDetail Error, AedsFrameType FrameType = AedsFrameType.Unknown)
{
    public static BinaryRequestPayload Success(ReadOnlyMemory<byte> payload, AedsFrameType frameType = AedsFrameType.Unknown)
        => new(true, payload, ErrorDetail.None, frameType);

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
