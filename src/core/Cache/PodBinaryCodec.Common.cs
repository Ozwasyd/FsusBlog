using System.Buffers;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.Models;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly JsonSerializerOptions AedsJsonPayloadOptions = new(JsonSerializerDefaults.Web);

    private static string? NullIfEmpty(string value) => value.Length == 0 ? null : value;

    public static void WriteJsonPayload<T>(T value, IBufferWriter<byte> target)
    {
        using var writer = new Utf8JsonWriter(target);
        JsonSerializer.Serialize(writer, value, AedsJsonPayloadOptions);
    }

    public static byte[] EncodeJsonPayload<T>(T value)
        => JsonSerializer.SerializeToUtf8Bytes(value, AedsJsonPayloadOptions);

    public static bool TryDecodeJsonPayload<T>(ReadOnlyMemory<byte> source, out T? value)
    {
        try
        {
            value = JsonSerializer.Deserialize<T>(source.Span, AedsJsonPayloadOptions);
            return true;
        }
        catch (JsonException)
        {
            value = default;
            return false;
        }
    }

    public static void WriteEmptySuccess(IBufferWriter<byte> target)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreateEmptySuccessPod());
    }

    public static byte[] EncodeEmptySuccess()
        => EncodeToArray(Marshal.SizeOf<EmptySuccessPod>(), WriteEmptySuccess);

    public static bool TryDecodeEmptySuccess(ReadOnlyMemory<byte> source, out EmptySuccessPod pod)
    {
        var reader = new BinaryPodReader(source.Span);
        return reader.TryReadPod(out pod) && reader.IsConsumed && pod.Ok == 1;
    }

    public static void WriteMutationId(long id, IBufferWriter<byte> target)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreateMutationIdPod(id));
    }

    public static byte[] EncodeMutationId(long id)
        => EncodeToArray(Marshal.SizeOf<MutationIdPod>(), writer => WriteMutationId(id, writer));

    public static bool TryDecodeMutationId(ReadOnlyMemory<byte> source, out MutationIdPod pod)
    {
        var reader = new BinaryPodReader(source.Span);
        return reader.TryReadPod(out pod) && reader.IsConsumed;
    }

    public static void WriteNameMutationRequest(string name, IBufferWriter<byte> target)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreateNameMutationRequestPod(name));
    }

    public static byte[] EncodeNameMutationRequest(string name)
        => EncodeToArray(Marshal.SizeOf<NameMutationRequestPod>(), writer => WriteNameMutationRequest(name, writer));

    public static bool TryDecodeNameMutationRequest(ReadOnlyMemory<byte> source, out string name)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out NameMutationRequestPod pod) || !reader.IsConsumed)
        {
            name = string.Empty;
            return false;
        }

        name = PodUtf8Codec.FromFixed128(pod.Name);
        return true;
    }

    public static void WriteStringMutationRequest(string value, IBufferWriter<byte> target)
    {
        var payload = new ArrayBufferWriter<byte>(Math.Max(128, value.Length));
        var mutable = new MutableStringMutationRequestPod
        {
            Value = PodUtf8Codec.AppendSlice(value, payload)
        };

        var writer = new BinaryPodWriter(target);
        Span<MutableStringMutationRequestPod> source = stackalloc MutableStringMutationRequestPod[1];
        source[0] = mutable;
        writer.WritePod(MemoryMarshal.Read<StringMutationRequestPod>(MemoryMarshal.AsBytes(source)));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeStringMutationRequest(string value)
        => EncodeToArray(128 + value.Length, writer => WriteStringMutationRequest(value, writer));

    public static bool TryDecodeStringMutationRequest(ReadOnlyMemory<byte> source, out string value)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out StringMutationRequestPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            value = string.Empty;
            return false;
        }

        value = PodUtf8Codec.ReadSlice(pod.Value, payload);
        return reader.IsConsumed;
    }

    public static void WritePasskeyCredentialFriendlyNameUpdateRequest(string friendlyName, IBufferWriter<byte> target)
    {
        var payload = new ArrayBufferWriter<byte>(Math.Max(128, friendlyName.Length));
        var mutable = new MutablePasskeyCredentialFriendlyNameUpdateRequestPod
        {
            FriendlyName = PodUtf8Codec.AppendSlice(friendlyName, payload)
        };

        var writer = new BinaryPodWriter(target);
        Span<MutablePasskeyCredentialFriendlyNameUpdateRequestPod> source = stackalloc MutablePasskeyCredentialFriendlyNameUpdateRequestPod[1];
        source[0] = mutable;
        writer.WritePod(MemoryMarshal.Read<PasskeyCredentialFriendlyNameUpdateRequestPod>(MemoryMarshal.AsBytes(source)));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodePasskeyCredentialFriendlyNameUpdateRequest(string friendlyName)
        => EncodeToArray(128 + friendlyName.Length, writer => WritePasskeyCredentialFriendlyNameUpdateRequest(friendlyName, writer));

    public static bool TryDecodePasskeyCredentialFriendlyNameUpdateRequest(ReadOnlyMemory<byte> source, out string friendlyName)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out PasskeyCredentialFriendlyNameUpdateRequestPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            friendlyName = string.Empty;
            return false;
        }

        friendlyName = PodUtf8Codec.ReadSlice(pod.FriendlyName, payload);
        return reader.IsConsumed;
    }

    public static void WriteApiError(in ErrorDetail error, IBufferWriter<byte> target, int httpStatus = 0)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreateApiErrorPod(error.Normalize(), httpStatus));
    }

    public static byte[] EncodeApiError(in ErrorDetail error, int httpStatus = 0)
    {
        ErrorDetail copy = error;
        return EncodeToArray(Marshal.SizeOf<ApiErrorPod>(), writer => WriteApiError(copy, writer, httpStatus));
    }

    public static bool TryDecodeApiError(ReadOnlyMemory<byte> source, out ApiErrorPod pod)
    {
        var reader = new BinaryPodReader(source.Span);
        return reader.TryReadPod(out pod) && reader.IsConsumed && pod.Code != (byte)ErrorCode.None;
    }

    public static ErrorDetail ToErrorDetail(in ApiErrorPod pod)
    {
        var code = Enum.IsDefined((ErrorCode)pod.Code) ? (ErrorCode)pod.Code : ErrorCode.Unknown;
        return ErrorDetail.Create(
            code,
            PodUtf8Codec.FromFixed256(pod.Message),
            EmptyToNull(PodUtf8Codec.FromFixed256(pod.Details)),
            EmptyToNull(PodUtf8Codec.FromFixed64(pod.TraceId)));
    }

    private static EmptySuccessPod CreateEmptySuccessPod()
    {
        Span<byte> bytes = stackalloc byte[Marshal.SizeOf<EmptySuccessPod>()];
        bytes.Clear();
        bytes[0] = 1;
        return MemoryMarshal.Read<EmptySuccessPod>(bytes);
    }

    private static MutationIdPod CreateMutationIdPod(long id)
    {
        Span<byte> bytes = stackalloc byte[Marshal.SizeOf<MutationIdPod>()];
        MemoryMarshal.Write(bytes, in id);
        return MemoryMarshal.Read<MutationIdPod>(bytes);
    }

    private static NameMutationRequestPod CreateNameMutationRequestPod(string name)
    {
        var mutable = new MutableNameMutationRequestPod
        {
            Name = EncodeFixedUtf8<FsusBlog.Shared.Contracts.Primitives.Utf8Fixed128>(name)
        };

        Span<MutableNameMutationRequestPod> source = stackalloc MutableNameMutationRequestPod[1];
        source[0] = mutable;
        return MemoryMarshal.Read<NameMutationRequestPod>(MemoryMarshal.AsBytes(source));
    }

    private static ApiErrorPod CreateApiErrorPod(in ErrorDetail error, int httpStatus)
    {
        var mutable = new MutableApiErrorPod
        {
            Code = (byte)error.Code,
            Category = (byte)error.Category,
            HttpStatus = httpStatus,
            Message = EncodeFixedUtf8<FsusBlog.Shared.Contracts.Primitives.Utf8Fixed256>(error.Message),
            Details = EncodeFixedUtf8<FsusBlog.Shared.Contracts.Primitives.Utf8Fixed256>(error.Details),
            TraceId = EncodeFixedUtf8<FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64>(error.TraceId)
        };

        Span<MutableApiErrorPod> source = stackalloc MutableApiErrorPod[1];
        source[0] = mutable;
        return MemoryMarshal.Read<ApiErrorPod>(MemoryMarshal.AsBytes(source));
    }

    private static string? EmptyToNull(string value)
        => string.IsNullOrEmpty(value) ? null : value;

    private static T EncodeFixedUtf8<T>(string? value)
        where T : unmanaged
    {
        Span<T> one = stackalloc T[1];
        one[0] = default;
        if (string.IsNullOrEmpty(value))
        {
            return one[0];
        }

        Span<byte> destination = MemoryMarshal.AsBytes(one);
        Encoder encoder = StrictUtf8.GetEncoder();
        encoder.Convert(value.AsSpan(), destination, flush: true, out _, out _, out _);
        return one[0];
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableApiErrorPod
    {
        public byte Code;
        public byte Category;
        public ushort Reserved0;
        public int HttpStatus;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed256 Message;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed256 Details;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 TraceId;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableNameMutationRequestPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed128 Name;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableStringMutationRequestPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Value;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutablePasskeyCredentialFriendlyNameUpdateRequestPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef FriendlyName;
    }
}
