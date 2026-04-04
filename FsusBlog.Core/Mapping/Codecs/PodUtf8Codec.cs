using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Core.Mapping.Codecs;

public static class PodUtf8Codec
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static Utf8Fixed64 ToFixed64(string? value) => EncodeFixed<Utf8Fixed64>(value);

    public static Utf8Fixed128 ToFixed128(string? value) => EncodeFixed<Utf8Fixed128>(value);

    public static Utf8Fixed256 ToFixed256(string? value) => EncodeFixed<Utf8Fixed256>(value);

    public static Utf8Fixed512 ToFixed512(string? value) => EncodeFixed<Utf8Fixed512>(value);

    public static string FromFixed64(in Utf8Fixed64 value) => DecodeFixed(value);

    public static string FromFixed128(in Utf8Fixed128 value) => DecodeFixed(value);

    public static string FromFixed256(in Utf8Fixed256 value) => DecodeFixed(value);

    public static Utf8SliceRef AppendSlice(string? value, List<byte> payload)
    {
        string text = value ?? string.Empty;
        int offset = payload.Count;
        int byteCount = Utf8.GetByteCount(text);
        if (byteCount > 0)
        {
            byte[] buffer = new byte[byteCount];
            _ = Utf8.GetBytes(text, buffer);
            payload.AddRange(buffer);
        }

        return CreateSlice(offset, byteCount);
    }

    public static string ReadSlice(in Utf8SliceRef slice, byte[] payload)
    {
        if (slice.Length <= 0 || payload.Length == 0)
        {
            return string.Empty;
        }

        if (slice.Offset < 0 || slice.Offset + slice.Length > payload.Length)
        {
            return string.Empty;
        }

        return Utf8.GetString(payload, slice.Offset, slice.Length);
    }

    private static T EncodeFixed<T>(string? value) where T : unmanaged
    {
        T pod = default;
        Span<T> one = stackalloc T[1];
        one[0] = pod;
        Span<byte> bytes = MemoryMarshal.AsBytes(one);
        bytes.Clear();

        if (!string.IsNullOrEmpty(value))
        {
            _ = Utf8.GetBytes(value.AsSpan(), bytes);
        }

        return one[0];
    }

    private static string DecodeFixed<T>(in T value) where T : unmanaged
    {
        ReadOnlySpan<T> one = MemoryMarshal.CreateReadOnlySpan(ref Unsafe.AsRef(in value), 1);
        ReadOnlySpan<byte> bytes = MemoryMarshal.AsBytes(one);
        int end = bytes.IndexOf((byte)0);
        int length = end >= 0 ? end : bytes.Length;
        return length == 0 ? string.Empty : Utf8.GetString(bytes[..length]);
    }

    private static Utf8SliceRef CreateSlice(int offset, int length)
    {
        MutableSlice temp = new() { Offset = offset, Length = length };
        Span<MutableSlice> source = stackalloc MutableSlice[1];
        source[0] = temp;
        ReadOnlySpan<byte> bytes = MemoryMarshal.AsBytes(source);
        return MemoryMarshal.Read<Utf8SliceRef>(bytes);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSlice
    {
        public int Offset;
        public int Length;
    }
}
