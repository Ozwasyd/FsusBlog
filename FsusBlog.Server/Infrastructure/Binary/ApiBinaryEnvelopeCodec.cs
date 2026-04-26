using System.Buffers;
using System.Buffers.Binary;
using FsusBlog.Core.Common;
using System.Text;

namespace FsusBlog.Server.Infrastructure.Binary;

public static class ApiBinaryEnvelopeCodec
{
    public static byte[] EncodeEnvelopePayload(int statusCode, string? contentType, ReadOnlySpan<byte> body)
    {
        using var writer = new PooledByteBufferWriter(GetInitialCapacity(contentType, body.Length));
        WriteEnvelopePayload(statusCode, contentType, body, writer);
        return writer.ToArray();
    }

    public static void WriteEnvelopePayload(int statusCode, string? contentType, ReadOnlySpan<byte> body, IBufferWriter<byte> destination)
    {
        Result result = TryWriteEnvelopePayload(statusCode, contentType, body, destination);
        if (!result.IsSuccess)
        {
            throw new ArgumentOutOfRangeException(nameof(contentType), result.Error.Message);
        }
    }

    public static Result TryWriteEnvelopePayload(int statusCode, string? contentType, ReadOnlySpan<byte> body, IBufferWriter<byte> destination)
    {
        string safeContentType = contentType ?? string.Empty;
        int contentTypeByteCount = Encoding.UTF8.GetByteCount(safeContentType);
        if (contentTypeByteCount > ushort.MaxValue)
        {
            return Result.Failure(ErrorCode.Validation, "binary_envelope_content_type_too_large");
        }

        WriteInt32(destination, statusCode);
        WriteUInt16(destination, checked((ushort)contentTypeByteCount));

        if (contentTypeByteCount > 0)
        {
            Span<byte> contentTypeSpan = destination.GetSpan(contentTypeByteCount);
            int written = Encoding.UTF8.GetBytes(safeContentType.AsSpan(), contentTypeSpan);
            destination.Advance(written);
        }

        WriteInt32(destination, body.Length);
        if (!body.IsEmpty)
        {
            destination.Write(body);
        }

        return Result.Success();
    }

    private static int GetInitialCapacity(string? contentType, int bodyLength)
    {
        int contentTypeByteCount = Encoding.UTF8.GetByteCount(contentType ?? string.Empty);
        return sizeof(int)
            + sizeof(ushort)
            + contentTypeByteCount
            + sizeof(int)
            + bodyLength;
    }

    private static void WriteInt32(IBufferWriter<byte> destination, int value)
    {
        Span<byte> span = destination.GetSpan(sizeof(int));
        BinaryPrimitives.WriteInt32LittleEndian(span, value);
        destination.Advance(sizeof(int));
    }

    private static void WriteUInt16(IBufferWriter<byte> destination, ushort value)
    {
        Span<byte> span = destination.GetSpan(sizeof(ushort));
        BinaryPrimitives.WriteUInt16LittleEndian(span, value);
        destination.Advance(sizeof(ushort));
    }
}
