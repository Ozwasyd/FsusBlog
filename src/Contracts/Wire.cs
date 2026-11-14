using System.Buffers;
using System.Buffers.Binary;
using System.Text;

namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static byte[] EncodeEmptySuccess() => Aeds.Encode(FrameType.EmptySuccess, [1, 0, 0, 0]);

    public static byte[] EncodeError(int status, string message, string? details = null, string? traceId = null)
    {
        if (status is < 400 or > 599)
            throw new ArgumentOutOfRangeException(nameof(status));

        Span<byte> payload = stackalloc byte[WireLayouts.ErrorBytes];
        payload.Clear();
        (payload[0], payload[1]) = status switch
        {
            400 => ((byte)1, (byte)1),
            401 => ((byte)4, (byte)2),
            403 or 423 => ((byte)5, (byte)3),
            404 => ((byte)2, (byte)4),
            409 => ((byte)3, (byte)5),
            _ => ((byte)6, (byte)13)
        };
        BinaryPrimitives.WriteInt32LittleEndian(payload[WireLayouts.ErrorStatusOffset..], status);
        WriteFixedText(message, payload[WireLayouts.ErrorMessageOffset..WireLayouts.ErrorDetailsOffset]);
        WriteFixedText(details, payload[WireLayouts.ErrorDetailsOffset..WireLayouts.ErrorTraceIdOffset]);
        WriteFixedText(traceId, payload[WireLayouts.ErrorTraceIdOffset..]);
        return Aeds.Encode(FrameType.ApiError, payload);
    }

    private static void WriteFixedText(string? value, Span<byte> destination)
    {
        if (string.IsNullOrEmpty(value))
            return;

        var terminator = value.IndexOf('\0');
        var text = terminator < 0 ? value.AsSpan() : value.AsSpan(0, terminator);
        Encoding.UTF8.GetEncoder().Convert(text, destination, true, out _, out _, out _);
    }

    internal static void Validate(SignIn value)
    {
        if (value.Ticket.Length == 0)
            throw new ProtocolException("Missing operator ticket");
    }

    internal static void Validate(Session value)
    {
        if (value.Name.Length == 0 || value.Generation <= 0)
            throw new ProtocolException("Invalid operator session");
    }

    internal static void Validate(Draft value)
    {
        if (value.Id <= 0 || value.Revision <= 0)
            throw new ProtocolException("Invalid draft coordinates");
    }

    internal static void Validate(ArticleCommand value)
    {
        if (value.Id < 0 || value.ExpectedRevision < 0 ||
            (value.Id == 0) != (value.ExpectedRevision == 0) || value.IdempotencyKey == Guid.Empty)
            throw new ProtocolException("Invalid article command coordinates");
    }

    private sealed class Writer
    {
        private readonly ArrayBufferWriter<byte> buffer = new();
        public ReadOnlySpan<byte> Written => buffer.WrittenSpan;

        public void I32(int value)
        {
            BinaryPrimitives.WriteInt32LittleEndian(buffer.GetSpan(4), value);
            buffer.Advance(4);
        }

        public void I64(long value)
        {
            BinaryPrimitives.WriteInt64LittleEndian(buffer.GetSpan(8), value);
            buffer.Advance(8);
        }

        public void Bool(bool value)
        {
            buffer.GetSpan(1)[0] = value ? (byte)1 : (byte)0;
            buffer.Advance(1);
        }

        public void Uuid(Guid value)
        {
            value.TryWriteBytes(buffer.GetSpan(16), bigEndian: true, out _);
            buffer.Advance(16);
        }

        public void Text(string value, int limit)
        {
            int length = Utf8.GetByteCount(value);
            if (length > limit)
                throw new ProtocolException("AEDS text exceeds its byte limit");
            I32(length);
            if (length != 0)
                buffer.Advance(Utf8.GetBytes(value, buffer.GetSpan(length)));
        }
    }

    private ref struct Reader(ReadOnlySpan<byte> payload)
    {
        private ReadOnlySpan<byte> remaining = payload;

        public int I32() => BinaryPrimitives.ReadInt32LittleEndian(Take(4));
        public long I64() => BinaryPrimitives.ReadInt64LittleEndian(Take(8));
        public Guid Uuid() => new(Take(16), bigEndian: true);

        public bool Bool() => Take(1)[0] switch
        {
            0 => false,
            1 => true,
            _ => throw new ProtocolException("Invalid AEDS boolean")
        };

        public string Text(int limit)
        {
            int length = I32();
            if (length < 0 || length > limit)
                throw new ProtocolException("Invalid AEDS text length");
            try
            {
                return Utf8.GetString(Take(length));
            }
            catch (DecoderFallbackException)
            {
                throw new ProtocolException("Invalid AEDS UTF-8");
            }
        }

        public void Finish()
        {
            if (!remaining.IsEmpty)
                throw new ProtocolException("Trailing AEDS payload data");
        }

        private ReadOnlySpan<byte> Take(int length)
        {
            if (length > remaining.Length)
                throw new ProtocolException("Truncated AEDS payload");
            var result = remaining[..length];
            remaining = remaining[length..];
            return result;
        }
    }
}
