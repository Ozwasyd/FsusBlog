using System.Buffers.Binary;
using System.Text;

namespace FsusBlog.Shared.Contracts.Outputs;

internal sealed class PublicAotEntryPayloadView
{
    private const uint AedsMagic = 0x53444541;
    private const byte AedsVersion = 2;
    private const ushort PublicAotBootstrapFrame = 71;
    private const int AedsHeaderLength = 16;
    private const byte NullKind = 0;
    private const byte StringKind = 1;
    private const byte Int32Kind = 2;
    private const byte Int64Kind = 3;
    private const byte DoubleKind = 4;
    private const byte BoolKind = 5;
    private const byte ObjectKind = 6;
    private const byte ArrayKind = 7;
    private const byte DecimalKind = 8;

    private PublicAotEntryPayloadView(
        IReadOnlyDictionary<string, object?> bootstrap,
        IReadOnlyDictionary<string, object?> hydration,
        IReadOnlyDictionary<string, object?>? islands)
    {
        Bootstrap = bootstrap;
        Hydration = hydration;
        Islands = islands;
    }

    public IReadOnlyDictionary<string, object?> Bootstrap
    {
        get;
    }

    public IReadOnlyDictionary<string, object?> Hydration
    {
        get;
    }

    public bool HasIslands => Islands is not null;

    public IReadOnlyDictionary<string, object?>? Islands
    {
        get;
    }

    public static bool TryCreate(PublicAotShellEntryContract entry, out PublicAotEntryPayloadView? view, out string error)
    {
        view = null;

        if (!TryDecode(entry.BootstrapPayload!, out IReadOnlyDictionary<string, object?> bootstrap))
        {
            error = "AOT bootstrap 不是合法 AEDS payload";
            return false;
        }

        if (!TryDecode(entry.HydrationPropsPayload!, out IReadOnlyDictionary<string, object?> hydration))
        {
            error = "AOT hydration props 不是合法 AEDS payload";
            return false;
        }

        IReadOnlyDictionary<string, object?>? islands = null;
        if (!string.IsNullOrWhiteSpace(entry.IslandsPayload) &&
            !TryDecode(entry.IslandsPayload!, out islands))
        {
            error = "AOT islands 不是合法 AEDS payload";
            return false;
        }

        view = new PublicAotEntryPayloadView(bootstrap, hydration, islands);
        error = string.Empty;
        return true;
    }

    private static bool TryDecode(string payload, out IReadOnlyDictionary<string, object?> value)
    {
        value = new Dictionary<string, object?>(StringComparer.Ordinal);
        try
        {
            byte[] frame = Base64UrlDecode(payload.Trim());
            if (frame.Length < AedsHeaderLength ||
                BinaryPrimitives.ReadUInt32LittleEndian(frame.AsSpan(0, 4)) != AedsMagic ||
                frame[4] != AedsVersion ||
                frame[5] != AedsHeaderLength ||
                BinaryPrimitives.ReadUInt16LittleEndian(frame.AsSpan(8, 2)) != PublicAotBootstrapFrame)
            {
                return false;
            }

            uint payloadLength = BinaryPrimitives.ReadUInt32LittleEndian(frame.AsSpan(10, 4));
            if (payloadLength != frame.Length - AedsHeaderLength)
            {
                return false;
            }

            ReadOnlySpan<byte> payloadSpan = frame.AsSpan(AedsHeaderLength);
            ushort payloadCrc16 = BinaryPrimitives.ReadUInt16LittleEndian(frame.AsSpan(14, 2));
            if (payloadCrc16 != Crc16(payloadSpan))
            {
                return false;
            }

            var reader = new Reader(payloadSpan);
            if (!reader.TryReadValue(out object? root) || reader.Remaining != 0 || root is not IReadOnlyDictionary<string, object?> rootObject)
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

    private static byte[] Base64UrlDecode(string value)
    {
        string normalized = value.Replace('-', '+').Replace('_', '/');
        normalized = normalized.PadRight((normalized.Length + 3) / 4 * 4, '=');
        return Convert.FromBase64String(normalized);
    }

    private static ushort Crc16(ReadOnlySpan<byte> data)
    {
        const ushort polynomial = 0xA001;
        ushort crc = 0xFFFF;
        for (int i = 0; i < data.Length; i++)
        {
            crc ^= data[i];
            for (int bit = 0; bit < 8; bit++)
            {
                crc = (ushort)(((crc & 1) != 0) ? ((crc >> 1) ^ polynomial) : (crc >> 1));
            }
        }

        return crc;
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
            if (!TryReadInt32(out int length) || length < 0 || Remaining < length)
            {
                return false;
            }

            value = Encoding.UTF8.GetString(_source.Slice(_offset, length));
            _offset += length;
            return true;
        }

        private bool TryReadCount(out int count)
        {
            if (!TryReadInt32(out count) || count < 0)
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

            const int signMask = unchecked((int)0x80000000);
            const int scaleMask = 0x00FF0000;
            int reservedBits = flags & ~(signMask | scaleMask);
            byte scale = (byte)((flags >> 16) & 0xFF);
            if (reservedBits != 0 || scale > 28)
            {
                return false;
            }

            bool isNegative = (flags & signMask) != 0;
            value = new decimal(lo, mid, hi, isNegative, scale);
            return true;
        }
    }
}
