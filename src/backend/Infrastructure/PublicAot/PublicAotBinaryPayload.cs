using System.Buffers;
using System.Buffers.Binary;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicAotBinaryPayload
{
    private const byte NullKind = 0;
    private const byte StringKind = 1;
    private const byte Int32Kind = 2;
    private const byte Int64Kind = 3;
    private const byte DoubleKind = 4;
    private const byte BoolKind = 5;
    private const byte ObjectKind = 6;
    private const byte ArrayKind = 7;
    private const byte DecimalKind = 8;
    private const int MaxStringBytes = 2 * 1024 * 1024;
    private const int MaxCollectionCount = 100_000;

    internal static string EncodeObject(object? value)
        => Base64UrlEncode(EncodeObjectFrame(value));

    internal static byte[] EncodeObjectFrame(object? value)
    {
        var payload = new ArrayBufferWriter<byte>();
        var writer = new Writer(payload);
        writer.WriteValue(value);
        return new AedsEncoder().Encode(AedsFrameType.PublicAotBootstrap, payload.WrittenSpan);
    }

    internal static bool TryDecodeObject(string? payload, out Dictionary<string, object?> value)
    {
        value = new Dictionary<string, object?>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(payload))
        {
            return false;
        }

        try
        {
            byte[] frame = Base64UrlDecode(payload.Trim());
            Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(frame);
            if (decoded.IsFailure ||
                decoded.Value.FrameType != AedsFrameType.PublicAotBootstrap)
            {
                return false;
            }

            var reader = new Reader(decoded.Value.Payload.Span);
            if (!reader.TryReadValue(out object? root) || reader.Remaining != 0 || root is not Dictionary<string, object?> rootObject)
            {
                return false;
            }

            value = rootObject;
            return true;
        }
        catch
        {
            return false;
        }
    }

    internal static bool TryDecodeObject(ReadOnlyMemory<byte> frame, out Dictionary<string, object?> value)
    {
        value = new Dictionary<string, object?>(StringComparer.Ordinal);
        try
        {
            Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(frame);
            if (decoded.IsFailure ||
                decoded.Value.FrameType != AedsFrameType.PublicAotBootstrap)
            {
                return false;
            }

            var reader = new Reader(decoded.Value.Payload.Span);
            if (!reader.TryReadValue(out object? root) || reader.Remaining != 0 || root is not Dictionary<string, object?> rootObject)
            {
                return false;
            }

            value = rootObject;
            return true;
        }
        catch
        {
            return false;
        }
    }

    internal static string TryGetString(IReadOnlyDictionary<string, object?> payload, string propertyName)
    {
        if (!payload.TryGetValue(propertyName, out object? value) || value is null)
        {
            return string.Empty;
        }

        return value switch
        {
            string text => text,
            int number => number.ToString(System.Globalization.CultureInfo.InvariantCulture),
            long number => number.ToString(System.Globalization.CultureInfo.InvariantCulture),
            double number => number.ToString(System.Globalization.CultureInfo.InvariantCulture),
            bool boolean => boolean ? "true" : "false",
            _ => string.Empty
        };
    }

    internal static IReadOnlyDictionary<string, object?>? TryGetObject(IReadOnlyDictionary<string, object?> payload, string propertyName)
        => payload.TryGetValue(propertyName, out object? value) && value is IReadOnlyDictionary<string, object?> nested
            ? nested
            : null;

    private static byte[] Base64UrlDecode(string value)
    {
        string normalized = value.Replace('-', '+').Replace('_', '/');
        normalized = normalized.PadRight((normalized.Length + 3) / 4 * 4, '=');
        return Convert.FromBase64String(normalized);
    }

    private static string Base64UrlEncode(ReadOnlySpan<byte> value)
        => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private ref struct Writer
    {
        private readonly IBufferWriter<byte> _target;

        internal Writer(IBufferWriter<byte> target)
        {
            _target = target;
        }

        internal void WriteValue(object? value)
        {
            switch (value)
            {
                case null:
                    WriteByte(NullKind);
                    return;
                case string text:
                    WriteByte(StringKind);
                    WriteStringPayload(text);
                    return;
                case bool boolean:
                    WriteByte(BoolKind);
                    WriteByte(boolean ? (byte)1 : (byte)0);
                    return;
                case Enum enumValue:
                    WriteByte(StringKind);
                    WriteStringPayload(enumValue.ToString());
                    return;
                case byte or sbyte or short or ushort or int:
                    WriteByte(Int32Kind);
                    WriteInt32(Convert.ToInt32(value, System.Globalization.CultureInfo.InvariantCulture));
                    return;
                case uint or long or ulong:
                    WriteInteger(Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture));
                    return;
                case float or double:
                    WriteByte(DoubleKind);
                    WriteDouble(Convert.ToDouble(value, System.Globalization.CultureInfo.InvariantCulture));
                    return;
                case decimal decimalValue:
                    WriteByte(DecimalKind);
                    WriteDecimal(decimalValue);
                    return;
                case DateTime dateTime:
                    WriteByte(StringKind);
                    WriteStringPayload(PublicAotUtcTime.Format(dateTime));
                    return;
                case DateTimeOffset dateTimeOffset:
                    WriteByte(StringKind);
                    WriteStringPayload(PublicAotUtcTime.Format(dateTimeOffset));
                    return;
                case IReadOnlyDictionary<string, object?> dictionary:
                    WriteObject(dictionary);
                    return;
                case System.Collections.IDictionary dictionary:
                    WriteObject(ToDictionary(dictionary));
                    return;
                case System.Collections.IEnumerable enumerable:
                    WriteArray(enumerable);
                    return;
                default:
                    throw new InvalidOperationException($"public_aot_payload_unsupported_type:{value.GetType().FullName}");
            }
        }

        private void WriteInteger(long value)
        {
            if (value >= int.MinValue && value <= int.MaxValue)
            {
                WriteByte(Int32Kind);
                WriteInt32((int)value);
                return;
            }

            WriteByte(Int64Kind);
            WriteInt64(value);
        }

        private void WriteObject(IReadOnlyDictionary<string, object?> value)
        {
            WriteByte(ObjectKind);
            WriteInt32(value.Count);
            foreach ((string key, object? item) in value)
            {
                WriteStringPayload(key);
                WriteValue(item);
            }
        }

        private void WriteArray(System.Collections.IEnumerable value)
        {
            var items = new List<object?>();
            foreach (object? item in value)
            {
                items.Add(item);
            }

            WriteByte(ArrayKind);
            WriteInt32(items.Count);
            foreach (object? item in items)
            {
                WriteValue(item);
            }
        }

        private static Dictionary<string, object?> ToDictionary(System.Collections.IDictionary dictionary)
        {
            var result = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (System.Collections.DictionaryEntry entry in dictionary)
            {
                if (entry.Key is null)
                {
                    continue;
                }

                result[Convert.ToString(entry.Key, System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty] = entry.Value;
            }

            return result;
        }

        private void WriteStringPayload(string value)
        {
            int byteCount = Encoding.UTF8.GetByteCount(value);
            WriteInt32(byteCount);
            if (byteCount == 0)
            {
                return;
            }

            Span<byte> span = _target.GetSpan(byteCount);
            int written = Encoding.UTF8.GetBytes(value.AsSpan(), span);
            _target.Advance(written);
        }

        private void WriteByte(byte value)
        {
            Span<byte> span = _target.GetSpan(1);
            span[0] = value;
            _target.Advance(1);
        }

        private void WriteInt32(int value)
        {
            Span<byte> span = _target.GetSpan(sizeof(int));
            BinaryPrimitives.WriteInt32LittleEndian(span, value);
            _target.Advance(sizeof(int));
        }

        private void WriteInt64(long value)
        {
            Span<byte> span = _target.GetSpan(sizeof(long));
            BinaryPrimitives.WriteInt64LittleEndian(span, value);
            _target.Advance(sizeof(long));
        }

        private void WriteDouble(double value)
        {
            Span<byte> span = _target.GetSpan(sizeof(double));
            BinaryPrimitives.WriteDoubleLittleEndian(span, value);
            _target.Advance(sizeof(double));
        }

        private void WriteDecimal(decimal value)
        {
            int[] bits = decimal.GetBits(value);
            WriteInt32(bits[0]);
            WriteInt32(bits[1]);
            WriteInt32(bits[2]);
            WriteInt32(bits[3]);
        }

        private void WriteBytes(ReadOnlySpan<byte> bytes)
        {
            Span<byte> span = _target.GetSpan(bytes.Length);
            bytes.CopyTo(span);
            _target.Advance(bytes.Length);
        }
    }

    private ref struct Reader
    {
        private readonly ReadOnlySpan<byte> _source;
        private int _offset;

        internal Reader(ReadOnlySpan<byte> source)
        {
            _source = source;
            _offset = 0;
        }

        internal int Remaining => _source.Length - _offset;

        internal bool TryReadValue(out object? value)
        {
            value = null;
            if (!TryReadByte(out byte kind))
            {
                return false;
            }

            switch (kind)
            {
                case NullKind:
                    return true;
                case StringKind:
                    return TryReadString(out value);
                case Int32Kind:
                    if (!TryReadInt32(out int int32Value))
                    {
                        return false;
                    }

                    value = int32Value;
                    return true;
                case Int64Kind:
                    if (!TryReadInt64(out long int64Value))
                    {
                        return false;
                    }

                    value = int64Value;
                    return true;
                case DoubleKind:
                    if (!TryReadDouble(out double doubleValue))
                    {
                        return false;
                    }

                    value = doubleValue;
                    return true;
                case BoolKind:
                    if (!TryReadByte(out byte boolValue))
                    {
                        return false;
                    }

                    value = boolValue == 1;
                    return true;
                case ObjectKind:
                    return TryReadObject(out value);
                case ArrayKind:
                    return TryReadArray(out value);
                case DecimalKind:
                    if (!TryReadDecimal(out decimal decimalValue))
                    {
                        return false;
                    }

                    value = decimalValue;
                    return true;
                default:
                    return false;
            }
        }

        private bool TryReadObject(out object? value)
        {
            value = null;
            if (!TryReadCount(out int count))
            {
                return false;
            }

            var result = new Dictionary<string, object?>(count, StringComparer.Ordinal);
            for (int i = 0; i < count; i++)
            {
                if (!TryReadString(out object? keyValue) || keyValue is not string key || !TryReadValue(out object? item))
                {
                    return false;
                }

                result[key] = item;
            }

            value = result;
            return true;
        }

        private bool TryReadArray(out object? value)
        {
            value = null;
            if (!TryReadCount(out int count))
            {
                return false;
            }

            var result = new object?[count];
            for (int i = 0; i < count; i++)
            {
                if (!TryReadValue(out result[i]))
                {
                    return false;
                }
            }

            value = result;
            return true;
        }

        private bool TryReadString(out object? value)
        {
            value = null;
            if (!TryReadInt32(out int length) || length < 0 || length > MaxStringBytes || Remaining < length)
            {
                return false;
            }

            value = Encoding.UTF8.GetString(_source.Slice(_offset, length));
            _offset += length;
            return true;
        }

        private bool TryReadCount(out int count)
        {
            if (!TryReadInt32(out count) || count < 0 || count > MaxCollectionCount)
            {
                count = 0;
                return false;
            }

            return true;
        }

        private bool TryReadByte(out byte value)
        {
            value = 0;
            if (Remaining < 1)
            {
                return false;
            }

            value = _source[_offset++];
            return true;
        }

        private bool TryReadInt32(out int value)
        {
            value = 0;
            if (Remaining < sizeof(int))
            {
                return false;
            }

            value = BinaryPrimitives.ReadInt32LittleEndian(_source.Slice(_offset, sizeof(int)));
            _offset += sizeof(int);
            return true;
        }

        private bool TryReadInt64(out long value)
        {
            value = 0;
            if (Remaining < sizeof(long))
            {
                return false;
            }

            value = BinaryPrimitives.ReadInt64LittleEndian(_source.Slice(_offset, sizeof(long)));
            _offset += sizeof(long);
            return true;
        }

        private bool TryReadDouble(out double value)
        {
            value = 0;
            if (Remaining < sizeof(double))
            {
                return false;
            }

            value = BinaryPrimitives.ReadDoubleLittleEndian(_source.Slice(_offset, sizeof(double)));
            _offset += sizeof(double);
            return true;
        }

        private bool TryReadDecimal(out decimal value)
        {
            value = 0m;
            if (!TryReadInt32(out int lo) ||
                !TryReadInt32(out int mid) ||
                !TryReadInt32(out int hi) ||
                !TryReadInt32(out int flags))
            {
                return false;
            }

            const int SignMask = unchecked((int)0x80000000);
            const int ScaleMask = 0x00FF0000;
            int reservedBits = flags & ~(SignMask | ScaleMask);
            byte scale = (byte)((flags >> 16) & 0xFF);
            if (reservedBits != 0 || scale > 28)
            {
                return false;
            }

            bool isNegative = (flags & SignMask) != 0;
            value = new decimal(lo, mid, hi, isNegative, scale);
            return true;
        }
    }
}
