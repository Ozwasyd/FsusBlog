namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    private delegate T ReadRecord<T>(ref Reader reader);

    private static byte[] EncodeFrame(FrameType type, Action<Writer> write)
    {
        var writer = new Writer();
        write(writer);
        return Aeds.Encode(type, writer.Written);
    }

    private static T DecodeFrame<T>(FrameType type, ReadOnlySpan<byte> frame, ReadRecord<T> read)
    {
        var reader = new Reader(Aeds.Decode(frame, type));
        var value = read(ref reader);
        reader.Finish();
        return value;
    }

    private static T DecodeFrame<T>(FrameType type, ReadOnlySpan<byte> frame, int maximumBytes,
        Func<ProtocolException> invalid, ReadRecord<T> read)
    {
        if (frame.Length > maximumBytes) throw invalid();
        return DecodeFrame(type, frame, read);
    }

    private static byte[] EncodeRecord<T>(FrameType type, T value, Action<T> validate, Action<Writer, T> write)
    {
        validate(value);
        return EncodeFrame(type, writer => write(writer, value));
    }

    private static T DecodeRecord<T>(FrameType type, ReadOnlySpan<byte> frame, ReadRecord<T> read, Action<T> validate)
    {
        var value = DecodeFrame(type, frame, read);
        validate(value);
        return value;
    }

    private static T DecodeRecord<T>(FrameType type, ReadOnlySpan<byte> frame, int maximumBytes,
        Func<ProtocolException> invalid, ReadRecord<T> read, Action<T> validate)
    {
        var value = DecodeFrame(type, frame, maximumBytes, invalid, read);
        validate(value);
        return value;
    }

    private static void Check([System.Diagnostics.CodeAnalysis.DoesNotReturnIf(false)] bool valid, string message) { if (!valid) throw new ProtocolException(message); }
    private static void Check([System.Diagnostics.CodeAnalysis.DoesNotReturnIf(false)] bool valid, Func<ProtocolException> invalid) { if (!valid) throw invalid(); }

    private static bool IsBase64Url(string value) =>
        value.All(static c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    private static bool IsLowerHex(string value, int length) =>
        value.Length == length && value.All(char.IsAsciiHexDigitLower);

    private static bool IsValidUnixMs(long value) => value is >= -62_135_596_800_000 and <= 253_402_300_799_999;

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

    internal static void Validate(SignIn value) => Check(value.Ticket.Length != 0, "Missing operator ticket");

    internal static void Validate(Session value) => Check(value.Name.Length != 0 && value.Generation > 0, "Invalid operator session");

    internal static void Validate(Draft value) => Check(value.Id > 0 && value.Revision > 0, "Invalid draft coordinates");

    internal static void Validate(ArticleCommand value) =>
        Check(value.Id >= 0 && value.ExpectedRevision >= 0 &&
            (value.Id == 0) == (value.ExpectedRevision == 0) && value.IdempotencyKey != Guid.Empty,
            "Invalid article command coordinates");

    internal static void Validate(DraftTaxonomy value) =>
        ValidateTaxonomy(value.Id, value.Revision, value.CategoryId, value.TagIds);

    internal static void Validate(TaxonomyAssignment value)
    {
        Check(value.IdempotencyKey != Guid.Empty, "Invalid taxonomy command key");
        ValidateTaxonomy(value.Id, value.ExpectedRevision, value.CategoryId, value.TagIds);
    }

    private static void ValidateTaxonomy(int article, long revision, int category, IReadOnlyList<int> tags) =>
        Check(article > 0 && revision > 0 && category >= 0 && tags.Count <= WireLimits.TaxonomyTagCount &&
            tags.All(tag => tag > 0) && tags.Distinct().Count() == tags.Count, "Invalid draft taxonomy coordinates");

    internal sealed class Writer : ScalarBufferWriter<Writer>
    {
        public Writer I32s(IReadOnlyList<int> values, int limit) =>
            List(values, limit, static (writer, value) => writer.I32(value));

        public Writer List<T>(IReadOnlyList<T> values, int limit, Action<Writer, T> writeItem)
        {
            if (values.Count > limit)
                throw new ProtocolException("AEDS collection exceeds its item limit");
            return Items(values, writeItem);
        }

        public Writer Items<T>(IReadOnlyList<T> values, Action<Writer, T> writeItem)
        {
            I32(values.Count);
            for (var index = 0; index < values.Count; index++)
                writeItem(this, values[index]);
            return this;
        }

        public Writer Optional<T>(T? value, Action<Writer, T> writeItem) where T : class
        {
            Bool(value is not null);
            if (value is not null) writeItem(this, value);
            return this;
        }

        public Writer Optional<T>(T? value, Action<Writer, T> writeItem) where T : struct
        {
            Bool(value.HasValue);
            if (value.HasValue) writeItem(this, value.Value);
            return this;
        }

        public Writer Uuid(Guid value)
        {
            value.TryWriteBytes(buffer.GetSpan(16), bigEndian: true, out _);
            buffer.Advance(16);
            return this;
        }

        public Writer Text(string value, int limit)
        {
            int length = Utf8.GetByteCount(value);
            if (length > limit)
                throw new ProtocolException("AEDS text exceeds its byte limit");
            I32(length);
            if (length != 0)
                buffer.Advance(Utf8.GetBytes(value, buffer.GetSpan(length)));
            return this;
        }

        public Writer FixedBytes(ReadOnlySpan<byte> value)
        {
            buffer.Write(value);
            return this;
        }

        public Writer Bytes(ReadOnlySpan<byte> value)
        {
            I32(value.Length);
            buffer.Write(value);
            return this;
        }
    }

    private ref struct Reader(ReadOnlySpan<byte> payload)
    {
        private ReadOnlySpan<byte> remaining = payload;

        public byte Byte() => Take(1)[0];
        public int I32() => BinaryPrimitives.ReadInt32LittleEndian(Take(4));
        public int[] I32s(int limit) => List(limit, 4, static (ref Reader reader) => reader.I32());
        public int Count(int minimum, int maximum, Func<ProtocolException> invalid)
        {
            var count = I32();
            if (count < minimum || count > maximum) throw invalid();
            return count;
        }

        public T[] Items<T>(int minimum, int maximum, Func<ProtocolException> invalid, ReadRecord<T> readItem)
        {
            var values = new T[Count(minimum, maximum, invalid)];
            for (var index = 0; index < values.Length; index++) values[index] = readItem(ref this);
            return values;
        }

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

        public T? Optional<T>(ReadRecord<T> read) where T : class => Bool() ? read(ref this) : null;
        public T? OptionalValue<T>(ReadRecord<T> read) where T : struct => Bool() ? read(ref this) : null;
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
