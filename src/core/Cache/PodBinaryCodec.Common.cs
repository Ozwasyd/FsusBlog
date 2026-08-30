using System.Buffers;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Shared.Contracts.Models;

namespace FsusBlog.Core.Cache;

/// <summary>
/// Provides binary serialization and decoding operations for common contracts.
/// </summary>
public static partial class PodBinaryCodec
{
    private static readonly UTF8Encoding s_strictUtf8 = new(false, true);
    private static readonly JsonSerializerOptions s_aedsJsonPayloadOptions = new(JsonSerializerDefaults.Web);

    private static string? NullIfEmpty(string value) => value.Length == 0 ? null : value;

    /// <summary>
    /// Writes the <c>JsonPayload</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteJsonPayload<T>(T value, IBufferWriter<byte> target)
    {
        using var writer = new Utf8JsonWriter(target);
        JsonSerializer.Serialize(writer, value, s_aedsJsonPayloadOptions);
    }

    /// <summary>
    /// Encodes the <c>JsonPayload</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeJsonPayload<T>(T value)
        => JsonSerializer.SerializeToUtf8Bytes(value, s_aedsJsonPayloadOptions);

    /// <summary>
    /// Attempts to decode the <c>JsonPayload</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeJsonPayload<T>(ReadOnlyMemory<byte> source, out T? value)
    {
        try
        {
            value = JsonSerializer.Deserialize<T>(source.Span, s_aedsJsonPayloadOptions);
            return true;
        }
        catch (JsonException)
        {
            value = default;
            return false;
        }
    }

    /// <summary>
    /// Writes the <c>EmptySuccess</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteEmptySuccess(IBufferWriter<byte> target)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreateEmptySuccessPod());
    }

    /// <summary>
    /// Encodes the <c>EmptySuccess</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeEmptySuccess()
        => EncodeToArray(Marshal.SizeOf<EmptySuccessPod>(), WriteEmptySuccess);

    /// <summary>
    /// Attempts to decode the <c>EmptySuccess</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeEmptySuccess(ReadOnlyMemory<byte> source, out EmptySuccessPod pod)
    {
        var reader = new BinaryPodReader(source.Span);
        return reader.TryReadPod(out pod) && reader.IsConsumed && pod.Ok == 1;
    }

    /// <summary>
    /// Writes the <c>MutationId</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteMutationId(long id, IBufferWriter<byte> target)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreateMutationIdPod(id));
    }

    /// <summary>
    /// Encodes the <c>MutationId</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeMutationId(long id)
        => EncodeToArray(Marshal.SizeOf<MutationIdPod>(), writer => WriteMutationId(id, writer));

    /// <summary>
    /// Attempts to decode the <c>MutationId</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeMutationId(ReadOnlyMemory<byte> source, out MutationIdPod pod)
    {
        var reader = new BinaryPodReader(source.Span);
        return reader.TryReadPod(out pod) && reader.IsConsumed;
    }

    /// <summary>
    /// Writes the <c>NameMutationRequest</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteNameMutationRequest(string name, IBufferWriter<byte> target)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreateNameMutationRequestPod(name));
    }

    /// <summary>
    /// Encodes the <c>NameMutationRequest</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeNameMutationRequest(string name)
        => EncodeToArray(Marshal.SizeOf<NameMutationRequestPod>(), writer => WriteNameMutationRequest(name, writer));

    /// <summary>
    /// Attempts to decode the <c>NameMutationRequest</c> contract from a binary payload.
    /// </summary>
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

    /// <summary>
    /// Writes the <c>TaxonomyMetadataMutationRequest</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteTaxonomyMetadataMutationRequest(
        TaxonomyMetadataMutationRequestCoreModel request,
        IBufferWriter<byte> target)
    {
        var payload = new ArrayBufferWriter<byte>(Math.Max(128, request.Description?.Length ?? 0));
        var mutable = new MutableTaxonomyMetadataMutationRequestPod
        {
            Name = EncodeFixedUtf8<FsusBlog.Shared.Contracts.Primitives.Utf8Fixed128>(request.Name),
            Description = PodUtf8Codec.AppendSlice(request.Description, payload)
        };

        var writer = new BinaryPodWriter(target);
        Span<MutableTaxonomyMetadataMutationRequestPod> source = stackalloc MutableTaxonomyMetadataMutationRequestPod[1];
        source[0] = mutable;
        writer.WritePod(MemoryMarshal.Read<TaxonomyMetadataMutationRequestPod>(MemoryMarshal.AsBytes(source)));
        writer.WriteBytes(payload.WrittenSpan);
    }

    /// <summary>
    /// Encodes the <c>TaxonomyMetadataMutationRequest</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeTaxonomyMetadataMutationRequest(TaxonomyMetadataMutationRequestCoreModel request)
        => EncodeToArray(
            Marshal.SizeOf<TaxonomyMetadataMutationRequestPod>() + sizeof(int) + (request.Description?.Length ?? 0),
            writer => WriteTaxonomyMetadataMutationRequest(request, writer));

    /// <summary>
    /// Attempts to decode the current taxonomy metadata contract or its legacy 128-byte name-only form.
    /// </summary>
    public static bool TryDecodeTaxonomyMetadataMutationRequest(
        ReadOnlyMemory<byte> source,
        out TaxonomyMetadataMutationRequestCoreModel request,
        out bool isLegacy)
    {
        if (source.Length == Marshal.SizeOf<NameMutationRequestPod>())
        {
            isLegacy = true;
            if (TryDecodeNameMutationRequest(source, out string legacyName))
            {
                request = new TaxonomyMetadataMutationRequestCoreModel(legacyName, null);
                return true;
            }

            request = default;
            return false;
        }

        isLegacy = false;
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out TaxonomyMetadataMutationRequestPod pod)
            || !reader.TryReadBytes(out ReadOnlySpan<byte> payload)
            || !reader.IsConsumed
            || pod.Description.Offset != 0
            || pod.Description.Length != payload.Length)
        {
            request = default;
            return false;
        }

        try
        {
            request = new TaxonomyMetadataMutationRequestCoreModel(
                PodUtf8Codec.FromFixed128(pod.Name),
                NullIfEmpty(PodUtf8Codec.ReadSlice(pod.Description, payload)));
            return true;
        }
        catch (DecoderFallbackException)
        {
            request = default;
            return false;
        }
    }

    /// <summary>
    /// Writes the <c>StringMutationRequest</c> contract to the supplied binary destination.
    /// </summary>
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

    /// <summary>
    /// Encodes the <c>StringMutationRequest</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeStringMutationRequest(string value)
        => EncodeToArray(128 + value.Length, writer => WriteStringMutationRequest(value, writer));

    /// <summary>
    /// Attempts to decode the <c>StringMutationRequest</c> contract from a binary payload.
    /// </summary>
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

    /// <summary>
    /// Writes the <c>PasskeyCredentialFriendlyNameUpdateRequest</c> contract to the supplied binary destination.
    /// </summary>
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

    /// <summary>
    /// Encodes the <c>PasskeyCredentialFriendlyNameUpdateRequest</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodePasskeyCredentialFriendlyNameUpdateRequest(string friendlyName)
        => EncodeToArray(128 + friendlyName.Length, writer => WritePasskeyCredentialFriendlyNameUpdateRequest(friendlyName, writer));

    /// <summary>
    /// Attempts to decode the <c>PasskeyCredentialFriendlyNameUpdateRequest</c> contract from a binary payload.
    /// </summary>
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

    /// <summary>
    /// Writes the <c>ApiError</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteApiError(in ErrorDetail error, IBufferWriter<byte> target, int httpStatus = 0)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreateApiErrorPod(error.Normalize(), httpStatus));
    }

    /// <summary>
    /// Encodes the <c>ApiError</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeApiError(in ErrorDetail error, int httpStatus = 0)
    {
        ErrorDetail copy = error;
        return EncodeToArray(Marshal.SizeOf<ApiErrorPod>(), writer => WriteApiError(copy, writer, httpStatus));
    }

    /// <summary>
    /// Attempts to decode the <c>ApiError</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeApiError(ReadOnlyMemory<byte> source, out ApiErrorPod pod)
    {
        var reader = new BinaryPodReader(source.Span);
        return reader.TryReadPod(out pod) && reader.IsConsumed && pod.Code != (byte)ErrorCode.None;
    }

    /// <summary>
    /// Converts an API-error POD into a normalized core error detail.
    /// </summary>
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
        Encoder encoder = s_strictUtf8.GetEncoder();
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
    private struct MutableTaxonomyMetadataMutationRequestPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed128 Name;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Description;
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
