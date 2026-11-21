using System.Buffers;
using System.Buffers.Binary;
using System.Text;

namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    private delegate T ReadRecord<T>(ref Reader reader);

    private static byte[] EncodeRecord<T>(FrameType type, T value, Action<T> validate, Action<Writer, T> write)
    {
        validate(value);
        var writer = new Writer();
        write(writer, value);
        return Aeds.Encode(type, writer.Written);
    }

    private static T DecodeRecord<T>(FrameType type, ReadOnlySpan<byte> frame, ReadRecord<T> read, Action<T> validate)
    {
        var reader = new Reader(Aeds.Decode(frame, type));
        var value = read(ref reader);
        reader.Finish();
        validate(value);
        return value;
    }

    public static byte[] EncodeEmptySuccess() => Aeds.Encode(FrameType.EmptySuccess, [1, 0, 0, 0]);

    public static byte[] EncodeError(int status, string message, string? details = null, string? traceId = null)
    {
        if (status is < 400 or > 599)
            throw new ArgumentOutOfRangeException(nameof(status));

        Span<byte> payload = stackalloc byte[WireLayouts.ErrorBytes];
        payload.Clear();
        (payload[0], payload[1]) = status switch
        {
            400 or 422 => ((byte)1, (byte)1),
            401 => ((byte)4, (byte)2),
            403 or 423 or 428 => ((byte)5, (byte)3),
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

    internal static void Validate(DraftTaxonomy value) =>
        ValidateTaxonomy(value.Id, value.Revision, value.CategoryId, value.TagIds);

    internal static void Validate(TaxonomyAssignment value)
    {
        if (value.IdempotencyKey == Guid.Empty)
            throw new ProtocolException("Invalid taxonomy command key");
        ValidateTaxonomy(value.Id, value.ExpectedRevision, value.CategoryId, value.TagIds);
    }

    private static void ValidateTaxonomy(int article, long revision, int category, IReadOnlyList<int> tags)
    {
        if (article <= 0 || revision <= 0 || category < 0 || tags.Count > WireLimits.TaxonomyTagCount ||
            tags.Any(tag => tag <= 0) || tags.Distinct().Count() != tags.Count)
            throw new ProtocolException("Invalid draft taxonomy coordinates");
    }

    internal sealed class Writer : ScalarBufferWriter
    {

        public void I32s(IReadOnlyList<int> values, int limit) =>
            List(values, limit, static (writer, value) => writer.I32(value));

        public void List<T>(IReadOnlyList<T> values, int limit, Action<Writer, T> writeItem)
        {
            if (values.Count > limit)
                throw new ProtocolException("AEDS collection exceeds its item limit");
            I32(values.Count);
            for (var index = 0; index < values.Count; index++)
                writeItem(this, values[index]);
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

        public void FixedBytes(ReadOnlySpan<byte> value) => buffer.Write(value);

        public void Bytes(ReadOnlySpan<byte> value)
        {
            I32(value.Length);
            buffer.Write(value);
        }
    }

    private ref struct Reader(ReadOnlySpan<byte> payload)
    {
        private ReadOnlySpan<byte> remaining = payload;

        public byte Byte() => Take(1)[0];
        public int I32() => BinaryPrimitives.ReadInt32LittleEndian(Take(4));
        public int[] I32s(int limit) => List(limit, 4, static (ref Reader reader) => reader.I32());
        public T[] List<T>(int limit, int minItemBytes, ReadRecord<T> readItem)
        {
            var count = I32();
            if (count < 0 || count > limit || count > remaining.Length / minItemBytes)
                throw new ProtocolException("Invalid AEDS collection length");
            if (count == 0) return [];
            var values = new T[count];
            for (var index = 0; index < count; index++) values[index] = readItem(ref this);
            return values;
        }
        public long I64() => BinaryPrimitives.ReadInt64LittleEndian(Take(8));
        public Guid Uuid() => new(Take(16), bigEndian: true);

        public ReadOnlySpan<byte> FixedBytes(int length) => Take(length);

        public ReadOnlySpan<byte> Bytes(int limit)
        {
            var length = I32();
            if (length < 0 || length > limit) throw new ProtocolException("Invalid AEDS byte collection length");
            return Take(length);
        }

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
