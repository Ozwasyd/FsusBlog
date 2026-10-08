#nullable enable
using System.Buffers;
using System.Buffers.Binary;
using System.Text;

using FsusBlog.Shared.Contracts.AuthoringPreferences;

namespace FsusBlog.Core.Cache;

/// <summary>Typed writing aid receipt payloads; authentication and persistence remain with Server.</summary>
public static partial class PodBinaryCodec
{
    private const int WritingAidReceiptMaximumPayloadBytes = 1434;
    private static readonly UTF8Encoding s_writingAidReceiptUtf8 = new(false, true);

    /// <summary>Writes only a receipt accepted by the existing domain validator, atomically to its destination.</summary>
    public static void WriteWritingAidPreferenceReceipt(
        WritingAidPreferenceReceipt receipt,
        IBufferWriter<byte> destination)
    {
        ArgumentNullException.ThrowIfNull(destination);
        if (receipt?.Previous is null
            || !WritingAidPreferenceReceiptValidator.Validate(receipt, receipt.Previous.Owner))
        {
            throw new ArgumentException("Invalid writing aid preference receipt.", nameof(receipt));
        }

        var previous = new ArrayBufferWriter<byte>();
        var committed = new ArrayBufferWriter<byte>();
        WriteWritingAidPreferenceSnapshot(receipt.Previous, previous);
        WriteWritingAidPreferenceSnapshot(receipt.Committed, committed);
        var payload = new ArrayBufferWriter<byte>();
        WriteWritingAidReceiptByte(payload, 1);
        WriteWritingAidReceiptFixed(payload, receipt.OperationId.ToString("D"), 64);
        WriteWritingAidReceiptFixed(payload, receipt.DeviceScope, 71);
        WriteWritingAidReceiptByte(payload, receipt.Action == "update" ? (byte)0 : (byte)1);
        WriteWritingAidReceiptByte(payload, 0);
        WriteWritingAidReceiptSnapshot(payload, previous.WrittenSpan);
        WriteWritingAidReceiptSnapshot(payload, committed.WrittenSpan);
        WriteWritingAidReceiptFixed(payload, receipt.ContentDigest, 64);
        if (payload.WrittenCount > WritingAidReceiptMaximumPayloadBytes)
        {
            throw new ArgumentException("Writing aid preference receipt exceeds its bound.", nameof(receipt));
        }

        Span<byte> output = destination.GetSpan(payload.WrittenCount);
        payload.WrittenSpan.CopyTo(output);
        destination.Advance(payload.WrittenCount);
    }

    /// <summary>Admits exact, bounded payloads with real domain digest, owner and transition verification.</summary>
    public static bool TryDecodeWritingAidPreferenceReceipt(
        ReadOnlyMemory<byte> source,
        WritingAidPreferenceOwner expectedOwner,
        out WritingAidPreferenceReceipt? receipt)
    {
        receipt = null;
        if (!WritingAidPreferenceValidator.IsValidOwner(expectedOwner)
            || source.Length is < 412 or > WritingAidReceiptMaximumPayloadBytes)
        {
            return false;
        }

        ReadOnlySpan<byte> bytes = source.Span;
        int offset = 0;
        if (bytes[offset++] != 1
            || !ReadWritingAidReceiptFixed(bytes, ref offset, 64, 36, out string operation)
            || !Guid.TryParseExact(operation, "D", out Guid operationId)
            || operationId == Guid.Empty || operationId.ToString("D") != operation
            || !ReadWritingAidReceiptFixed(bytes, ref offset, 71, 71, out string deviceScope))
        {
            return false;
        }

        byte action = bytes[offset++];
        byte status = bytes[offset++];
        if (action > 1 || status != 0
            || !ReadWritingAidReceiptSnapshot(source, ref offset, expectedOwner, out var previous)
            || !ReadWritingAidReceiptSnapshot(source, ref offset, expectedOwner, out var committed)
            || !ReadWritingAidReceiptFixed(bytes, ref offset, 64, 64, out string digest)
            || offset != bytes.Length)
        {
            return false;
        }

        var candidate = new WritingAidPreferenceReceipt(
            operationId, deviceScope, previous!, committed!, action == 0 ? "update" : "initialize", "committed", digest);
        if (!WritingAidPreferenceReceiptValidator.Validate(candidate, expectedOwner))
        {
            return false;
        }

        receipt = candidate;
        return true;
    }

    private static void WriteWritingAidReceiptByte(IBufferWriter<byte> destination, byte value)
    {
        destination.GetSpan(1)[0] = value;
        destination.Advance(1);
    }

    private static void WriteWritingAidReceiptFixed(IBufferWriter<byte> destination, string value, int length)
    {
        Span<byte> output = destination.GetSpan(length)[..length];
        output.Clear();
        s_writingAidReceiptUtf8.GetBytes(value, output);
        destination.Advance(length);
    }

    private static void WriteWritingAidReceiptSnapshot(IBufferWriter<byte> destination, ReadOnlySpan<byte> bytes)
    {
        BinaryPrimitives.WriteInt32LittleEndian(destination.GetSpan(4), bytes.Length);
        destination.Advance(4);
        bytes.CopyTo(destination.GetSpan(bytes.Length));
        destination.Advance(bytes.Length);
    }

    private static bool ReadWritingAidReceiptFixed(
        ReadOnlySpan<byte> source,
        ref int offset,
        int width,
        int used,
        out string value)
    {
        value = string.Empty;
        if (source.Length - offset < width)
        {
            return false;
        }

        ReadOnlySpan<byte> bytes = source.Slice(offset, width);
        if (bytes[used..].IndexOfAnyExcept((byte)0) >= 0)
        {
            return false;
        }

        try
        {
            value = s_writingAidReceiptUtf8.GetString(bytes[..used]);
        }
        catch (DecoderFallbackException)
        {
            return false;
        }

        offset += width;
        return true;
    }

    private static bool ReadWritingAidReceiptSnapshot(
        ReadOnlyMemory<byte> source,
        ref int offset,
        WritingAidPreferenceOwner expectedOwner,
        out WritingAidPreferenceSnapshot? snapshot)
    {
        snapshot = null;
        if (source.Length - offset < 4)
        {
            return false;
        }

        int length = BinaryPrimitives.ReadInt32LittleEndian(source.Span.Slice(offset, 4));
        offset += 4;
        if (length is < 101 or > 612 || length > source.Length - offset
            || !TryDecodeWritingAidPreferenceSnapshot(source.Slice(offset, length), expectedOwner, out snapshot))
        {
            return false;
        }

        offset += length;
        return true;
    }
}
