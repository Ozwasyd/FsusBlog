using System.Buffers.Binary;
using System.Text;
using System.Buffers;
using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.Binary;

public static class ApiBinaryEnvelopeCodec
{
    public static byte[] EncodeEnvelopePayload(int statusCode, string? contentType, ReadOnlySpan<byte> body)
    {
        string safeContentType = contentType ?? string.Empty;
        int contentTypeByteCount = Encoding.UTF8.GetByteCount(safeContentType);
        int payloadLength = sizeof(int)
            + sizeof(ushort)
            + contentTypeByteCount
            + sizeof(int)
            + body.Length;

        byte[] payload = new byte[payloadLength];
        var span = payload.AsSpan();
        int offset = 0;

        BinaryPrimitives.WriteInt32LittleEndian(span.Slice(offset, sizeof(int)), statusCode);
        offset += sizeof(int);

        BinaryPrimitives.WriteUInt16LittleEndian(span.Slice(offset, sizeof(ushort)), checked((ushort)contentTypeByteCount));
        offset += sizeof(ushort);

        if (contentTypeByteCount > 0)
        {
            offset += Encoding.UTF8.GetBytes(safeContentType.AsSpan(), span.Slice(offset, contentTypeByteCount));
        }

        BinaryPrimitives.WriteInt32LittleEndian(span.Slice(offset, sizeof(int)), body.Length);
        offset += sizeof(int);

        body.CopyTo(span.Slice(offset, body.Length));
        return payload;
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
