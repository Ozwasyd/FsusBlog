using System.Buffers;
using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Core.Cache;

/// <summary>
/// Provides the closed POD codecs for the Font and Theme administration read surfaces.
/// </summary>
public static partial class PodBinaryCodec
{
    private const int FontThemePayloadVersion = 1;

    /// <summary>
    /// Writes the bounded FontRegistryList POD payload to the caller-owned writer; invalid records throw.
    /// </summary>
    public static void WriteFontRegistryList(FontRegistryListResponse response, IBufferWriter<byte> destination)
    {
        IReadOnlyList<FontRegistryItemResponse> items = response.Items ?? throw new ArgumentException("Required Items are missing.", nameof(response));
        ValidateFontThemeCount(items.Count, FontThemeAdminContractLimits.MaxRegistryItems, nameof(response));
        var blob = new ArrayBufferWriter<byte>(Math.Max(128, items.Count * 128));
        var pods = new FontRegistryItemPod[items.Count];
        for (int i = 0; i < items.Count; i++)
        {
            pods[i] = CreateFontRegistryItemPod(items[i], blob);
        }

        WriteFontThemePayload(destination, items.Count, pods, blob);
    }

    /// <summary>
    /// Encodes a bounded FontRegistryList POD payload without an AEDS frame header.
    /// </summary>
    public static byte[] EncodeFontRegistryList(FontRegistryListResponse response)
        => EncodeToArray(256, writer => WriteFontRegistryList(response, writer));

    /// <summary>
    /// Validates and decodes the complete FontRegistryList POD payload; malformed wire data returns false.
    /// </summary>
    public static bool TryDecodeFontRegistryList(ReadOnlyMemory<byte> source, out FontRegistryListResponse response)
    {
        response = new FontRegistryListResponse([]);
        var reader = new BinaryPodReader(source.Span);
        if (!TryReadFontThemeHeader(ref reader, FontThemeAdminContractLimits.MaxRegistryItems, out int count))
        {
            return false;
        }

        var pods = new FontRegistryItemPod[count];
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out pods[i]))
            {
                return false;
            }
        }

        if (!TryReadFontThemeBlob(ref reader, out ReadOnlySpan<byte> blob))
        {
            return false;
        }

        try
        {
            var items = new List<FontRegistryItemResponse>(count);
            int cursor = 0;
            foreach (FontRegistryItemPod pod in pods)
            {
                if (!TryDecodeFontRegistryItem(pod, blob, ref cursor, out FontRegistryItemResponse item))
                {
                    return false;
                }

                items.Add(item);
            }

            if (cursor != blob.Length)
            {
                return false;
            }

            response = new FontRegistryListResponse(items);
            return true;
        }
        catch (Exception exception) when (IsFontThemeDecodeException(exception))
        {
            return false;
        }
    }

    /// <summary>
    /// Writes the bounded FontRegistryDetail POD payload to the caller-owned writer; invalid records throw.
    /// </summary>
    public static void WriteFontRegistryDetail(FontRegistryDetailResponse response, IBufferWriter<byte> destination)
    {
        IReadOnlyList<FontFaceResponse> faces = response.Faces ?? throw new ArgumentException("Required Faces are missing.", nameof(response));
        ValidateFontThemeCount(faces.Count, FontThemeAdminContractLimits.MaxFontFaces, nameof(response));
        if (response.Font.FaceCount != faces.Count || response.Font.CriticalFaceCount != faces.Count(static face => face.Critical))
        {
            throw new ArgumentException("Font face summary does not match the detail records.", nameof(response));
        }

        var blob = new ArrayBufferWriter<byte>(512);
        FontRegistryDetailPod detail = CreateFontRegistryDetailPod(response, blob);
        var facePods = new FontFacePod[faces.Count];
        for (int i = 0; i < faces.Count; i++)
        {
            facePods[i] = CreateFontFacePod(faces[i], blob);
        }

        var writer = new BinaryPodWriter(destination);
        WriteFontThemeHeader(ref writer, faces.Count, checked(Marshal.SizeOf<FontRegistryDetailPod>() + (faces.Count * Marshal.SizeOf<FontFacePod>()) + sizeof(int) + blob.WrittenCount));
        writer.WritePod(detail);
        foreach (FontFacePod pod in facePods)
        {
            writer.WritePod(pod);
        }
        writer.WriteBytes(blob.WrittenSpan);
    }

    /// <summary>
    /// Encodes a bounded FontRegistryDetail POD payload without an AEDS frame header.
    /// </summary>
    public static byte[] EncodeFontRegistryDetail(FontRegistryDetailResponse response)
        => EncodeToArray(1_024, writer => WriteFontRegistryDetail(response, writer));

    /// <summary>
    /// Validates and decodes the complete FontRegistryDetail POD payload; malformed wire data returns false.
    /// </summary>
    public static bool TryDecodeFontRegistryDetail(ReadOnlyMemory<byte> source, out FontRegistryDetailResponse? response)
    {
        response = null;
        var reader = new BinaryPodReader(source.Span);
        if (!TryReadFontThemeHeader(ref reader, FontThemeAdminContractLimits.MaxFontFaces, out int faceCount) ||
            !reader.TryReadPod(out FontRegistryDetailPod detail))
        {
            return false;
        }

        var faces = new FontFacePod[faceCount];
        for (int i = 0; i < faceCount; i++)
        {
            if (!reader.TryReadPod(out faces[i]))
            {
                return false;
            }
        }

        if (!TryReadFontThemeBlob(ref reader, out ReadOnlySpan<byte> blob))
        {
            return false;
        }

        try
        {
            int cursor = 0;
            if (!TryDecodeFontRegistryDetail(detail, blob, ref cursor, out FontRegistryItemResponse font, out string licenseText, out string licenseSourceJson, out string manifestJson) ||
                font.FaceCount != faceCount)
            {
                return false;
            }

            var decodedFaces = new List<FontFaceResponse>(faceCount);
            foreach (FontFacePod face in faces)
            {
                if (!TryDecodeFontFace(face, blob, ref cursor, out FontFaceResponse decoded))
                {
                    return false;
                }
                decodedFaces.Add(decoded);
            }

            if (cursor != blob.Length || font.CriticalFaceCount != decodedFaces.Count(static face => face.Critical))
            {
                return false;
            }

            response = new FontRegistryDetailResponse(font, licenseText, licenseSourceJson, manifestJson, decodedFaces);
            return true;
        }
        catch (Exception exception) when (IsFontThemeDecodeException(exception))
        {
            return false;
        }
    }

    /// <summary>
    /// Writes the bounded FontActivationList POD payload to the caller-owned writer; invalid records throw.
    /// </summary>
    public static void WriteFontActivationList(FontActivationListResponse response, IBufferWriter<byte> destination)
    {
        IReadOnlyList<FontActivationResponse> items = response.Items ?? throw new ArgumentException("Required Items are missing.", nameof(response));
        ValidateFontThemeCount(items.Count, FontThemeAdminContractLimits.MaxFontActivations, nameof(response));
        var blob = new ArrayBufferWriter<byte>(Math.Max(128, items.Count * 128));
        var pods = new FontActivationPod[items.Count];
        for (int i = 0; i < items.Count; i++)
        {
            pods[i] = CreateFontActivationPod(items[i], blob);
        }
        WriteFontThemePayload(destination, items.Count, pods, blob);
    }

    /// <summary>
    /// Encodes a bounded FontActivationList POD payload without an AEDS frame header.
    /// </summary>
    public static byte[] EncodeFontActivationList(FontActivationListResponse response)
        => EncodeToArray(256, writer => WriteFontActivationList(response, writer));

    /// <summary>
    /// Validates and decodes the complete FontActivationList POD payload; malformed wire data returns false.
    /// </summary>
    public static bool TryDecodeFontActivationList(ReadOnlyMemory<byte> source, out FontActivationListResponse response)
    {
        response = new FontActivationListResponse([]);
        var reader = new BinaryPodReader(source.Span);
        if (!TryReadFontThemeHeader(ref reader, FontThemeAdminContractLimits.MaxFontActivations, out int count))
        {
            return false;
        }

        var pods = new FontActivationPod[count];
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out pods[i]))
            {
                return false;
            }
        }
        if (!TryReadFontThemeBlob(ref reader, out ReadOnlySpan<byte> blob))
        {
            return false;
        }

        try
        {
            var items = new List<FontActivationResponse>(count);
            int cursor = 0;
            foreach (FontActivationPod pod in pods)
            {
                if (!TryDecodeFontActivation(pod, blob, ref cursor, out FontActivationResponse item))
                {
                    return false;
                }
                items.Add(item);
            }
            if (cursor != blob.Length)
            {
                return false;
            }
            response = new FontActivationListResponse(items);
            return true;
        }
        catch (Exception exception) when (IsFontThemeDecodeException(exception))
        {
            return false;
        }
    }

    /// <summary>
    /// Writes the bounded ThemeRegistryList POD payload to the caller-owned writer; invalid records throw.
    /// </summary>
    public static void WriteThemeRegistryList(ThemeRegistryListResponse response, IBufferWriter<byte> destination)
    {
        IReadOnlyList<ThemeRegistryItemResponse> items = response.Items ?? throw new ArgumentException("Required Items are missing.", nameof(response));
        ValidateFontThemeCount(items.Count, FontThemeAdminContractLimits.MaxRegistryItems, nameof(response));
        var blob = new ArrayBufferWriter<byte>(Math.Max(128, items.Count * 128));
        var pods = new ThemeRegistryItemPod[items.Count];
        for (int i = 0; i < items.Count; i++)
        {
            pods[i] = CreateThemeRegistryItemPod(items[i], blob);
        }
        WriteFontThemePayload(destination, items.Count, pods, blob);
    }

    /// <summary>
    /// Encodes a bounded ThemeRegistryList POD payload without an AEDS frame header.
    /// </summary>
    public static byte[] EncodeThemeRegistryList(ThemeRegistryListResponse response)
        => EncodeToArray(256, writer => WriteThemeRegistryList(response, writer));

    /// <summary>
    /// Validates and decodes the complete ThemeRegistryList POD payload; malformed wire data returns false.
    /// </summary>
    public static bool TryDecodeThemeRegistryList(ReadOnlyMemory<byte> source, out ThemeRegistryListResponse response)
    {
        response = new ThemeRegistryListResponse([]);
        var reader = new BinaryPodReader(source.Span);
        if (!TryReadFontThemeHeader(ref reader, FontThemeAdminContractLimits.MaxRegistryItems, out int count))
        {
            return false;
        }
        var pods = new ThemeRegistryItemPod[count];
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out pods[i]))
            {
                return false;
            }
        }
        if (!TryReadFontThemeBlob(ref reader, out ReadOnlySpan<byte> blob))
        {
            return false;
        }

        try
        {
            var items = new List<ThemeRegistryItemResponse>(count);
            int cursor = 0;
            foreach (ThemeRegistryItemPod pod in pods)
            {
                if (!TryDecodeThemeRegistryItem(pod, blob, ref cursor, out ThemeRegistryItemResponse item))
                {
                    return false;
                }
                items.Add(item);
            }
            if (cursor != blob.Length)
            {
                return false;
            }
            response = new ThemeRegistryListResponse(items);
            return true;
        }
        catch (Exception exception) when (IsFontThemeDecodeException(exception))
        {
            return false;
        }
    }

    /// <summary>
    /// Writes the bounded ThemeRegistryDetail POD payload to the caller-owned writer; invalid records throw.
    /// </summary>
    public static void WriteThemeRegistryDetail(ThemeRegistryDetailResponse response, IBufferWriter<byte> destination)
    {
        IReadOnlyList<string> modes = response.Modes ?? throw new ArgumentException("Required Modes are missing.", nameof(response));
        ValidateFontThemeCount(modes.Count, FontThemeAdminContractLimits.MaxThemeModes, nameof(response));
        if (modes.Distinct(StringComparer.Ordinal).Count() != modes.Count || modes.Any(static mode => mode is not ("light" or "dark")))
        {
            throw new ArgumentException("Theme modes must be a unique light/dark subset.", nameof(response));
        }

        var blob = new ArrayBufferWriter<byte>(1_024);
        ThemeRegistryDetailPod detail = CreateThemeRegistryDetailPod(response, blob);
        var modeRefs = new Utf8SliceRef[modes.Count];
        for (int i = 0; i < modes.Count; i++)
        {
            modeRefs[i] = AppendFontThemeText(modes[i], blob, FontThemeAdminContractLimits.MaxIdentifierBytes, allowEmpty: false, nameof(response.Modes));
        }

        var writer = new BinaryPodWriter(destination);
        WriteFontThemeHeader(ref writer, modes.Count, checked(Marshal.SizeOf<ThemeRegistryDetailPod>() + (modes.Count * Marshal.SizeOf<Utf8SliceRef>()) + sizeof(int) + blob.WrittenCount));
        writer.WritePod(detail);
        foreach (Utf8SliceRef mode in modeRefs)
        {
            writer.WriteSliceRef(mode);
        }
        writer.WriteBytes(blob.WrittenSpan);
    }

    /// <summary>
    /// Encodes a bounded ThemeRegistryDetail POD payload without an AEDS frame header.
    /// </summary>
    public static byte[] EncodeThemeRegistryDetail(ThemeRegistryDetailResponse response)
        => EncodeToArray(2_048, writer => WriteThemeRegistryDetail(response, writer));

    /// <summary>
    /// Validates and decodes the complete ThemeRegistryDetail POD payload; malformed wire data returns false.
    /// </summary>
    public static bool TryDecodeThemeRegistryDetail(ReadOnlyMemory<byte> source, out ThemeRegistryDetailResponse? response)
    {
        response = null;
        var reader = new BinaryPodReader(source.Span);
        if (!TryReadFontThemeHeader(ref reader, FontThemeAdminContractLimits.MaxThemeModes, out int modeCount) ||
            !reader.TryReadPod(out ThemeRegistryDetailPod detail))
        {
            return false;
        }
        var modes = new Utf8SliceRef[modeCount];
        for (int i = 0; i < modeCount; i++)
        {
            if (!reader.TryReadSliceRef(out modes[i]))
            {
                return false;
            }
        }
        if (!TryReadFontThemeBlob(ref reader, out ReadOnlySpan<byte> blob))
        {
            return false;
        }

        try
        {
            int cursor = 0;
            if (!TryDecodeThemeRegistryDetail(detail, blob, ref cursor, out ThemeRegistryItemResponse theme, out string manifestJson, out string configSchemaJson, out ThemeSupportResponse supports, out ThemeBudgetResponse budgets, out ThemePermissionResponse permissions))
            {
                return false;
            }
            var decodedModes = new List<string>(modeCount);
            foreach (Utf8SliceRef mode in modes)
            {
                if (!TryReadFontThemeText(mode, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, allowEmpty: false, out string text) ||
                    text is not ("light" or "dark") || decodedModes.Contains(text, StringComparer.Ordinal))
                {
                    return false;
                }
                decodedModes.Add(text);
            }
            if (cursor != blob.Length)
            {
                return false;
            }
            response = new ThemeRegistryDetailResponse(theme, manifestJson, configSchemaJson, decodedModes, supports, budgets, permissions);
            return true;
        }
        catch (Exception exception) when (IsFontThemeDecodeException(exception))
        {
            return false;
        }
    }

    /// <summary>
    /// Writes the bounded ThemeActivationList POD payload to the caller-owned writer; invalid records throw.
    /// </summary>
    public static void WriteThemeActivationList(ThemeActivationListResponse response, IBufferWriter<byte> destination)
    {
        IReadOnlyList<ThemeActivationResponse> items = response.Items ?? throw new ArgumentException("Required Items are missing.", nameof(response));
        ValidateFontThemeCount(items.Count, FontThemeAdminContractLimits.MaxThemeActivations, nameof(response));
        var blob = new ArrayBufferWriter<byte>(Math.Max(128, items.Count * 96));
        var pods = new ThemeActivationPod[items.Count];
        for (int i = 0; i < items.Count; i++)
        {
            pods[i] = CreateThemeActivationPod(items[i], blob);
        }
        WriteFontThemePayload(destination, items.Count, pods, blob);
    }

    /// <summary>
    /// Encodes a bounded ThemeActivationList POD payload without an AEDS frame header.
    /// </summary>
    public static byte[] EncodeThemeActivationList(ThemeActivationListResponse response)
        => EncodeToArray(256, writer => WriteThemeActivationList(response, writer));

    /// <summary>
    /// Validates and decodes the complete ThemeActivationList POD payload; malformed wire data returns false.
    /// </summary>
    public static bool TryDecodeThemeActivationList(ReadOnlyMemory<byte> source, out ThemeActivationListResponse response)
    {
        response = new ThemeActivationListResponse([]);
        var reader = new BinaryPodReader(source.Span);
        if (!TryReadFontThemeHeader(ref reader, FontThemeAdminContractLimits.MaxThemeActivations, out int count))
        {
            return false;
        }
        var pods = new ThemeActivationPod[count];
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out pods[i]))
            {
                return false;
            }
        }
        if (!TryReadFontThemeBlob(ref reader, out ReadOnlySpan<byte> blob))
        {
            return false;
        }
        try
        {
            var items = new List<ThemeActivationResponse>(count);
            int cursor = 0;
            foreach (ThemeActivationPod pod in pods)
            {
                if (!TryDecodeThemeActivation(pod, blob, ref cursor, out ThemeActivationResponse item))
                {
                    return false;
                }
                items.Add(item);
            }
            if (cursor != blob.Length)
            {
                return false;
            }
            response = new ThemeActivationListResponse(items);
            return true;
        }
        catch (Exception exception) when (IsFontThemeDecodeException(exception))
        {
            return false;
        }
    }

    /// <summary>
    /// Writes the bounded ThemeActivation POD payload to the caller-owned writer; invalid records throw.
    /// </summary>
    public static void WriteThemeActivation(ThemeActivationResponse response, IBufferWriter<byte> destination)
    {
        var blob = new ArrayBufferWriter<byte>(128);
        ThemeActivationPod pod = CreateThemeActivationPod(response, blob);
        var writer = new BinaryPodWriter(destination);
        WriteFontThemeHeader(ref writer, 1, checked(Marshal.SizeOf<ThemeActivationPod>() + sizeof(int) + blob.WrittenCount));
        writer.WritePod(pod);
        writer.WriteBytes(blob.WrittenSpan);
    }

    /// <summary>
    /// Encodes a bounded ThemeActivation POD payload without an AEDS frame header.
    /// </summary>
    public static byte[] EncodeThemeActivation(ThemeActivationResponse response)
        => EncodeToArray(256, writer => WriteThemeActivation(response, writer));

    /// <summary>
    /// Validates and decodes the complete ThemeActivation POD payload; malformed wire data returns false.
    /// </summary>
    public static bool TryDecodeThemeActivation(ReadOnlyMemory<byte> source, out ThemeActivationResponse? response)
    {
        response = null;
        var reader = new BinaryPodReader(source.Span);
        if (!TryReadFontThemeHeader(ref reader, 1, out int count) || count != 1 ||
            !reader.TryReadPod(out ThemeActivationPod pod) ||
            !TryReadFontThemeBlob(ref reader, out ReadOnlySpan<byte> blob))
        {
            return false;
        }
        try
        {
            int cursor = 0;
            return TryDecodeThemeActivation(pod, blob, ref cursor, out response) && cursor == blob.Length;
        }
        catch (Exception exception) when (IsFontThemeDecodeException(exception))
        {
            return false;
        }
    }

    /// <summary>
    /// Writes the bounded ThemeActivationHistory POD payload to the caller-owned writer; invalid records throw.
    /// </summary>
    public static void WriteThemeActivationHistory(ThemeActivationHistoryResponse response, IBufferWriter<byte> destination)
    {
        IReadOnlyList<ThemeActivationHistoryItemResponse> items = response.Items ?? throw new ArgumentException("Required Items are missing.", nameof(response));
        ValidateFontThemeCount(items.Count, FontThemeAdminContractLimits.MaxThemeActivationHistory, nameof(response));
        var blob = new ArrayBufferWriter<byte>(Math.Max(128, items.Count * 192));
        var pods = new ThemeActivationHistoryPod[items.Count];
        for (int i = 0; i < items.Count; i++)
        {
            pods[i] = CreateThemeActivationHistoryPod(items[i], blob);
        }
        WriteFontThemePayload(destination, items.Count, pods, blob);
    }

    /// <summary>
    /// Encodes a bounded ThemeActivationHistory POD payload without an AEDS frame header.
    /// </summary>
    public static byte[] EncodeThemeActivationHistory(ThemeActivationHistoryResponse response)
        => EncodeToArray(512, writer => WriteThemeActivationHistory(response, writer));

    /// <summary>
    /// Validates and decodes the complete ThemeActivationHistory POD payload; malformed wire data returns false.
    /// </summary>
    public static bool TryDecodeThemeActivationHistory(ReadOnlyMemory<byte> source, out ThemeActivationHistoryResponse response)
    {
        response = new ThemeActivationHistoryResponse([]);
        var reader = new BinaryPodReader(source.Span);
        if (!TryReadFontThemeHeader(ref reader, FontThemeAdminContractLimits.MaxThemeActivationHistory, out int count))
        {
            return false;
        }
        var pods = new ThemeActivationHistoryPod[count];
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out pods[i]))
            {
                return false;
            }
        }
        if (!TryReadFontThemeBlob(ref reader, out ReadOnlySpan<byte> blob))
        {
            return false;
        }
        try
        {
            var items = new List<ThemeActivationHistoryItemResponse>(count);
            int cursor = 0;
            foreach (ThemeActivationHistoryPod pod in pods)
            {
                if (!TryDecodeThemeActivationHistory(pod, blob, ref cursor, out ThemeActivationHistoryItemResponse item))
                {
                    return false;
                }
                items.Add(item);
            }
            if (cursor != blob.Length)
            {
                return false;
            }
            response = new ThemeActivationHistoryResponse(items);
            return true;
        }
        catch (Exception exception) when (IsFontThemeDecodeException(exception))
        {
            return false;
        }
    }

    private static void WriteFontThemePayload<T>(IBufferWriter<byte> destination, int count, IReadOnlyList<T> pods, ArrayBufferWriter<byte> blob)
        where T : unmanaged
    {
        ValidateFontThemeBlob(blob);
        int payloadLength = checked((count * Marshal.SizeOf<T>()) + sizeof(int) + blob.WrittenCount);
        var writer = new BinaryPodWriter(destination);
        WriteFontThemeHeader(ref writer, count, payloadLength);
        foreach (T pod in pods)
        {
            writer.WritePod(pod);
        }
        writer.WriteBytes(blob.WrittenSpan);
    }

    private static void WriteFontThemeHeader(ref BinaryPodWriter writer, int recordCount, int payloadLength)
    {
        writer.WritePod(CastFontThemePod<MutableFontThemePayloadHeaderPod, FontThemePayloadHeaderPod>(new MutableFontThemePayloadHeaderPod
        {
            Version = FontThemePayloadVersion,
            RecordCount = recordCount,
            PayloadLength = payloadLength
        }));
    }

    private static bool TryReadFontThemeHeader(ref BinaryPodReader reader, int maxCount, out int count)
    {
        count = 0;
        if (!reader.TryReadPod(out FontThemePayloadHeaderPod header) ||
            header.Version != FontThemePayloadVersion ||
            header.RecordCount < 0 || header.RecordCount > maxCount ||
            header.PayloadLength < sizeof(int) || header.PayloadLength != reader.Remaining ||
            header.Reserved0 != 0)
        {
            return false;
        }
        count = header.RecordCount;
        return true;
    }

    private static bool TryReadFontThemeBlob(ref BinaryPodReader reader, out ReadOnlySpan<byte> blob)
    {
        if (!reader.TryReadBytes(out blob) || blob.Length > FontThemeAdminContractLimits.MaxBlobBytes || !reader.IsConsumed)
        {
            blob = default;
            return false;
        }
        return true;
    }

    private static void ValidateFontThemeBlob(ArrayBufferWriter<byte> blob)
    {
        if (blob.WrittenCount > FontThemeAdminContractLimits.MaxBlobBytes)
        {
            throw new ArgumentOutOfRangeException(nameof(blob), "Font/Theme payload blob exceeds the wire limit.");
        }
    }

    private static void ValidateFontThemeCount(int count, int maximum, string parameterName)
    {
        if (count < 0 || count > maximum)
        {
            throw new ArgumentOutOfRangeException(parameterName, $"Record count must be between 0 and {maximum}.");
        }
    }

    private static Utf8SliceRef AppendFontThemeText(string? value, ArrayBufferWriter<byte> blob, int maxBytes, bool allowEmpty, string parameterName)
    {
        if (value is null || (!allowEmpty && value.Length == 0))
        {
            throw new ArgumentException("Required Font/Theme text is missing.", parameterName);
        }
        int byteCount = PodUtf8Codec.GetSliceByteCount(value);
        if (byteCount > maxBytes || checked(blob.WrittenCount + byteCount) > FontThemeAdminContractLimits.MaxBlobBytes)
        {
            throw new ArgumentOutOfRangeException(parameterName, $"Font/Theme text exceeds its {maxBytes}-byte wire limit.");
        }
        return PodUtf8Codec.AppendSlice(value, blob);
    }

    private static Utf8SliceRef AppendOptionalFontThemeText(string? value, ArrayBufferWriter<byte> blob, int maxBytes, string parameterName)
        => value is null ? default : AppendFontThemeText(value, blob, maxBytes, allowEmpty: true, parameterName);

    private static bool TryReadFontThemeText(Utf8SliceRef slice, ReadOnlySpan<byte> blob, ref int cursor, int maxBytes, bool allowEmpty, out string value)
    {
        value = string.Empty;
        if (slice.Offset != cursor || slice.Length < 0 || slice.Length > maxBytes || slice.Length > blob.Length - cursor)
        {
            return false;
        }
        value = PodUtf8Codec.ReadSlice(slice, blob);
        cursor += slice.Length;
        return allowEmpty || value.Length > 0;
    }

    private static bool TryReadOptionalFontThemeText(byte present, Utf8SliceRef slice, ReadOnlySpan<byte> blob, ref int cursor, int maxBytes, out string? value)
    {
        value = null;
        if (present > 1)
        {
            return false;
        }
        if (present == 0)
        {
            return slice.Offset == 0 && slice.Length == 0;
        }
        if (!TryReadFontThemeText(slice, blob, ref cursor, maxBytes, allowEmpty: true, out string decoded))
        {
            return false;
        }
        value = decoded;
        return true;
    }

    private static bool IsFontThemeDecodeException(Exception exception)
        => exception is DecoderFallbackException or ArgumentOutOfRangeException or FormatException or OverflowException;

    private static long FontThemeUnixMs(DateTimeOffset value) => value.ToUnixTimeMilliseconds();

    private static DateTimeOffset FontThemeDateTime(long value) => DateTimeOffset.FromUnixTimeMilliseconds(value);

    private static byte FontInstallStateCode(string value) => value switch
    {
        "installed" => FontThemeAdminContractLimits.FontInstallStateInstalled,
        _ => throw new ArgumentException("Unknown font install state.", nameof(value))
    };

    private static string FontInstallStateName(byte value) => value switch
    {
        FontThemeAdminContractLimits.FontInstallStateInstalled => "installed",
        _ => throw new FormatException("Unknown font install state code.")
    };

    private static byte ThemeInstallStateCode(string value) => value switch
    {
        "Discovered" => FontThemeAdminContractLimits.ThemeInstallStateDiscovered,
        "Validated" => FontThemeAdminContractLimits.ThemeInstallStateValidated,
        "Installed" => FontThemeAdminContractLimits.ThemeInstallStateInstalled,
        "Enabled" => FontThemeAdminContractLimits.ThemeInstallStateEnabled,
        "Disabled" => FontThemeAdminContractLimits.ThemeInstallStateDisabled,
        "Failed" => FontThemeAdminContractLimits.ThemeInstallStateFailed,
        "RolledBack" => FontThemeAdminContractLimits.ThemeInstallStateRolledBack,
        "Uninstalled" => FontThemeAdminContractLimits.ThemeInstallStateUninstalled,
        _ => throw new ArgumentException("Unknown theme install state.", nameof(value))
    };

    private static string ThemeInstallStateName(byte value) => value switch
    {
        FontThemeAdminContractLimits.ThemeInstallStateDiscovered => "Discovered",
        FontThemeAdminContractLimits.ThemeInstallStateValidated => "Validated",
        FontThemeAdminContractLimits.ThemeInstallStateInstalled => "Installed",
        FontThemeAdminContractLimits.ThemeInstallStateEnabled => "Enabled",
        FontThemeAdminContractLimits.ThemeInstallStateDisabled => "Disabled",
        FontThemeAdminContractLimits.ThemeInstallStateFailed => "Failed",
        FontThemeAdminContractLimits.ThemeInstallStateRolledBack => "RolledBack",
        FontThemeAdminContractLimits.ThemeInstallStateUninstalled => "Uninstalled",
        _ => throw new FormatException("Unknown theme install state code.")
    };

    private static byte ThemeActivationStatusCode(string value) => value switch
    {
        "Applied" => FontThemeAdminContractLimits.ThemeActivationStatusApplied,
        "Rejected" => FontThemeAdminContractLimits.ThemeActivationStatusRejected,
        "RolledBack" => FontThemeAdminContractLimits.ThemeActivationStatusRolledBack,
        "ResetToDefault" => FontThemeAdminContractLimits.ThemeActivationStatusResetToDefault,
        _ => throw new ArgumentException("Unknown theme activation status.", nameof(value))
    };

    private static string ThemeActivationStatusName(byte value) => value switch
    {
        FontThemeAdminContractLimits.ThemeActivationStatusApplied => "Applied",
        FontThemeAdminContractLimits.ThemeActivationStatusRejected => "Rejected",
        FontThemeAdminContractLimits.ThemeActivationStatusRolledBack => "RolledBack",
        FontThemeAdminContractLimits.ThemeActivationStatusResetToDefault => "ResetToDefault",
        _ => throw new FormatException("Unknown theme activation status code.")
    };

    private static FontRegistryItemPod CreateFontRegistryItemPod(FontRegistryItemResponse item, ArrayBufferWriter<byte> blob)
    {
        ValidateFontSummary(item);
        return CastFontThemePod<MutableFontRegistryItemPod, FontRegistryItemPod>(new MutableFontRegistryItemPod
        {
            InstalledAtUnixMs = FontThemeUnixMs(item.InstalledAt),
            UpdatedAtUnixMs = FontThemeUnixMs(item.UpdatedAt),
            TotalSizeBytes = item.TotalSizeBytes,
            FaceCount = item.FaceCount,
            CriticalFaceCount = item.CriticalFaceCount,
            Enabled = item.Enabled ? (byte)1 : (byte)0,
            BuiltIn = item.BuiltIn ? (byte)1 : (byte)0,
            InstallState = FontInstallStateCode(item.InstallState),
            FontId = AppendFontThemeText(item.FontId, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.FontId)),
            Name = AppendFontThemeText(item.Name, blob, FontThemeAdminContractLimits.MaxLabelBytes, false, nameof(item.Name)),
            Family = AppendFontThemeText(item.Family, blob, FontThemeAdminContractLimits.MaxFamilyBytes, false, nameof(item.Family)),
            Category = AppendFontThemeText(item.Category, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.Category)),
            Version = AppendFontThemeText(item.Version, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.Version))
        });
    }

    private static FontRegistryDetailPod CreateFontRegistryDetailPod(FontRegistryDetailResponse response, ArrayBufferWriter<byte> blob)
    {
        FontRegistryItemResponse item = response.Font;
        ValidateFontSummary(item);
        return CastFontThemePod<MutableFontRegistryDetailPod, FontRegistryDetailPod>(new MutableFontRegistryDetailPod
        {
            InstalledAtUnixMs = FontThemeUnixMs(item.InstalledAt),
            UpdatedAtUnixMs = FontThemeUnixMs(item.UpdatedAt),
            TotalSizeBytes = item.TotalSizeBytes,
            FaceCount = item.FaceCount,
            CriticalFaceCount = item.CriticalFaceCount,
            Enabled = item.Enabled ? (byte)1 : (byte)0,
            BuiltIn = item.BuiltIn ? (byte)1 : (byte)0,
            InstallState = FontInstallStateCode(item.InstallState),
            FontId = AppendFontThemeText(item.FontId, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.FontId)),
            Name = AppendFontThemeText(item.Name, blob, FontThemeAdminContractLimits.MaxLabelBytes, false, nameof(item.Name)),
            Family = AppendFontThemeText(item.Family, blob, FontThemeAdminContractLimits.MaxFamilyBytes, false, nameof(item.Family)),
            Category = AppendFontThemeText(item.Category, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.Category)),
            Version = AppendFontThemeText(item.Version, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.Version)),
            LicenseText = AppendFontThemeText(response.LicenseText, blob, FontThemeAdminContractLimits.MaxLicenseBytes, true, nameof(response.LicenseText)),
            LicenseSourceJson = AppendFontThemeText(response.LicenseSourceJson, blob, FontThemeAdminContractLimits.MaxJsonBytes, true, nameof(response.LicenseSourceJson)),
            ManifestJson = AppendFontThemeText(response.ManifestJson, blob, FontThemeAdminContractLimits.MaxJsonBytes, true, nameof(response.ManifestJson))
        });
    }

    private static FontFacePod CreateFontFacePod(FontFaceResponse face, ArrayBufferWriter<byte> blob)
    {
        if (face.Weight <= 0 || face.SizeBytes < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(face));
        }
        return CastFontThemePod<MutableFontFacePod, FontFacePod>(new MutableFontFacePod
        {
            SizeBytes = face.SizeBytes,
            Weight = face.Weight,
            Critical = face.Critical ? (byte)1 : (byte)0,
            HasUnicodeRange = face.UnicodeRange is null ? (byte)0 : (byte)1,
            Style = AppendFontThemeText(face.Style, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(face.Style)),
            FilePath = AppendFontThemeText(face.FilePath, blob, FontThemeAdminContractLimits.MaxPathBytes, false, nameof(face.FilePath)),
            ContentHash = AppendFontThemeText(face.ContentHash, blob, FontThemeAdminContractLimits.MaxHashBytes, false, nameof(face.ContentHash)),
            UnicodeRange = AppendOptionalFontThemeText(face.UnicodeRange, blob, FontThemeAdminContractLimits.MaxUnicodeRangeBytes, nameof(face.UnicodeRange)),
            FontDisplay = AppendFontThemeText(face.FontDisplay, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(face.FontDisplay))
        });
    }

    private static FontActivationPod CreateFontActivationPod(FontActivationResponse item, ArrayBufferWriter<byte> blob)
    {
        if (item.ConfigVersion < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(item.ConfigVersion));
        }
        return CastFontThemePod<MutableFontActivationPod, FontActivationPod>(new MutableFontActivationPod
        {
            ConfigVersion = item.ConfigVersion,
            UpdatedAtUnixMs = FontThemeUnixMs(item.UpdatedAt),
            Scope = AppendFontThemeText(item.Scope, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.Scope)),
            UiFontId = AppendFontThemeText(item.UiFontId, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.UiFontId)),
            ProseFontId = AppendFontThemeText(item.ProseFontId, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.ProseFontId)),
            CodeFontId = AppendFontThemeText(item.CodeFontId, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.CodeFontId)),
            CjkFontId = AppendFontThemeText(item.CjkFontId, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.CjkFontId)),
            EmojiFontId = AppendFontThemeText(item.EmojiFontId, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.EmojiFontId))
        });
    }

    private static ThemeRegistryItemPod CreateThemeRegistryItemPod(ThemeRegistryItemResponse item, ArrayBufferWriter<byte> blob)
    {
        return CastFontThemePod<MutableThemeRegistryItemPod, ThemeRegistryItemPod>(new MutableThemeRegistryItemPod
        {
            InstalledAtUnixMs = FontThemeUnixMs(item.InstalledAtUtc),
            UpdatedAtUnixMs = FontThemeUnixMs(item.UpdatedAtUtc),
            Enabled = item.Enabled ? (byte)1 : (byte)0,
            InstallState = ThemeInstallStateCode(item.InstallState),
            ThemeId = AppendFontThemeText(item.ThemeId, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.ThemeId)),
            Name = AppendFontThemeText(item.Name, blob, FontThemeAdminContractLimits.MaxLabelBytes, false, nameof(item.Name)),
            Version = AppendFontThemeText(item.Version, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.Version)),
            Author = AppendFontThemeText(item.Author, blob, FontThemeAdminContractLimits.MaxLabelBytes, false, nameof(item.Author)),
            Description = AppendFontThemeText(item.Description, blob, FontThemeAdminContractLimits.MaxLabelBytes, true, nameof(item.Description)),
            Type = AppendFontThemeText(item.Type, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.Type)),
            PackageHash = AppendFontThemeText(item.PackageHash, blob, FontThemeAdminContractLimits.MaxHashBytes, false, nameof(item.PackageHash)),
            PackageLocation = AppendFontThemeText(item.PackageLocation, blob, FontThemeAdminContractLimits.MaxPathBytes, false, nameof(item.PackageLocation))
        });
    }

    private static ThemeRegistryDetailPod CreateThemeRegistryDetailPod(ThemeRegistryDetailResponse response, ArrayBufferWriter<byte> blob)
    {
        ThemeRegistryItemResponse item = response.Theme;
        ThemeBudgetResponse budget = response.Budgets;
        if (budget.CssBytes < 0 || budget.AssetBytes < 0 || budget.PreviewBytes < 0 ||
            budget.MaxSelectors < 0 || budget.MaxSelectorDepth < 0 || budget.MaxImportant < 0 || budget.MaxMotionDurationMs < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(response.Budgets));
        }
        return CastFontThemePod<MutableThemeRegistryDetailPod, ThemeRegistryDetailPod>(new MutableThemeRegistryDetailPod
        {
            InstalledAtUnixMs = FontThemeUnixMs(item.InstalledAtUtc),
            UpdatedAtUnixMs = FontThemeUnixMs(item.UpdatedAtUtc),
            CssBytes = budget.CssBytes,
            AssetBytes = budget.AssetBytes,
            PreviewBytes = budget.PreviewBytes,
            MaxSelectors = budget.MaxSelectors,
            MaxSelectorDepth = budget.MaxSelectorDepth,
            MaxImportant = budget.MaxImportant,
            MaxMotionDurationMs = budget.MaxMotionDurationMs,
            Enabled = item.Enabled ? (byte)1 : (byte)0,
            InstallState = ThemeInstallStateCode(item.InstallState),
            SupportsPublic = response.Supports.Public ? (byte)1 : (byte)0,
            SupportsAdmin = response.Supports.Admin ? (byte)1 : (byte)0,
            SupportsConsole = response.Supports.Console ? (byte)1 : (byte)0,
            SupportsHighContrast = response.Supports.HighContrast ? (byte)1 : (byte)0,
            SupportsReducedMotion = response.Supports.ReducedMotion ? (byte)1 : (byte)0,
            SupportsRtl = response.Supports.Rtl ? (byte)1 : (byte)0,
            PermissionScript = response.Permissions.Script ? (byte)1 : (byte)0,
            PermissionNetwork = response.Permissions.Network ? (byte)1 : (byte)0,
            PermissionFilesystem = response.Permissions.Filesystem ? (byte)1 : (byte)0,
            ThemeId = AppendFontThemeText(item.ThemeId, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.ThemeId)),
            Name = AppendFontThemeText(item.Name, blob, FontThemeAdminContractLimits.MaxLabelBytes, false, nameof(item.Name)),
            Version = AppendFontThemeText(item.Version, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.Version)),
            Author = AppendFontThemeText(item.Author, blob, FontThemeAdminContractLimits.MaxLabelBytes, false, nameof(item.Author)),
            Description = AppendFontThemeText(item.Description, blob, FontThemeAdminContractLimits.MaxLabelBytes, true, nameof(item.Description)),
            Type = AppendFontThemeText(item.Type, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.Type)),
            PackageHash = AppendFontThemeText(item.PackageHash, blob, FontThemeAdminContractLimits.MaxHashBytes, false, nameof(item.PackageHash)),
            PackageLocation = AppendFontThemeText(item.PackageLocation, blob, FontThemeAdminContractLimits.MaxPathBytes, false, nameof(item.PackageLocation)),
            ManifestJson = AppendFontThemeText(response.ManifestJson, blob, FontThemeAdminContractLimits.MaxJsonBytes, true, nameof(response.ManifestJson)),
            ConfigSchemaJson = AppendFontThemeText(response.ConfigSchemaJson, blob, FontThemeAdminContractLimits.MaxJsonBytes, true, nameof(response.ConfigSchemaJson))
        });
    }

    private static ThemeActivationPod CreateThemeActivationPod(ThemeActivationResponse item, ArrayBufferWriter<byte> blob)
    {
        if (item.ConfigVersion < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(item.ConfigVersion));
        }
        return CastFontThemePod<MutableThemeActivationPod, ThemeActivationPod>(new MutableThemeActivationPod
        {
            ConfigVersion = item.ConfigVersion.GetValueOrDefault(),
            UpdatedAtUnixMs = item.UpdatedAtUtc.HasValue ? FontThemeUnixMs(item.UpdatedAtUtc.Value) : 0,
            HasActiveThemeId = item.ActiveThemeId is null ? (byte)0 : (byte)1,
            HasMode = item.Mode is null ? (byte)0 : (byte)1,
            HasActivationId = item.ActivationId.HasValue ? (byte)1 : (byte)0,
            HasAssetVersion = item.AssetVersion is null ? (byte)0 : (byte)1,
            HasConfigVersion = item.ConfigVersion.HasValue ? (byte)1 : (byte)0,
            HasUpdatedAt = item.UpdatedAtUtc.HasValue ? (byte)1 : (byte)0,
            Scope = AppendFontThemeText(item.Scope, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.Scope)),
            ActiveThemeId = AppendOptionalFontThemeText(item.ActiveThemeId, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, nameof(item.ActiveThemeId)),
            Mode = AppendOptionalFontThemeText(item.Mode, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, nameof(item.Mode)),
            ActivationId = AppendOptionalFontThemeText(item.ActivationId?.ToString("D"), blob, FontThemeAdminContractLimits.MaxIdentifierBytes, nameof(item.ActivationId)),
            AssetVersion = AppendOptionalFontThemeText(item.AssetVersion, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, nameof(item.AssetVersion))
        });
    }

    private static ThemeActivationHistoryPod CreateThemeActivationHistoryPod(ThemeActivationHistoryItemResponse item, ArrayBufferWriter<byte> blob)
    {
        if (item.ConfigVersion < 0 || item.PreviousConfigVersion < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(item));
        }
        return CastFontThemePod<MutableThemeActivationHistoryPod, ThemeActivationHistoryPod>(new MutableThemeActivationHistoryPod
        {
            ConfigVersion = item.ConfigVersion.GetValueOrDefault(),
            PreviousConfigVersion = item.PreviousConfigVersion.GetValueOrDefault(),
            StartedAtUnixMs = FontThemeUnixMs(item.StartedAtUtc),
            CompletedAtUnixMs = FontThemeUnixMs(item.CompletedAtUtc),
            HasThemeId = item.ThemeId is null ? (byte)0 : (byte)1,
            HasPreviousThemeId = item.PreviousThemeId is null ? (byte)0 : (byte)1,
            HasAssetVersion = item.AssetVersion is null ? (byte)0 : (byte)1,
            HasPreviousAssetVersion = item.PreviousAssetVersion is null ? (byte)0 : (byte)1,
            HasConfigVersion = item.ConfigVersion.HasValue ? (byte)1 : (byte)0,
            HasPreviousConfigVersion = item.PreviousConfigVersion.HasValue ? (byte)1 : (byte)0,
            HasMode = item.Mode is null ? (byte)0 : (byte)1,
            HasPreviousMode = item.PreviousMode is null ? (byte)0 : (byte)1,
            HasFailureReason = item.FailureReason is null ? (byte)0 : (byte)1,
            Status = ThemeActivationStatusCode(item.Status),
            Id = AppendFontThemeText(item.Id.ToString("D"), blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.Id)),
            Scope = AppendFontThemeText(item.Scope, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, false, nameof(item.Scope)),
            ThemeId = AppendOptionalFontThemeText(item.ThemeId, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, nameof(item.ThemeId)),
            PreviousThemeId = AppendOptionalFontThemeText(item.PreviousThemeId, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, nameof(item.PreviousThemeId)),
            AssetVersion = AppendOptionalFontThemeText(item.AssetVersion, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, nameof(item.AssetVersion)),
            PreviousAssetVersion = AppendOptionalFontThemeText(item.PreviousAssetVersion, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, nameof(item.PreviousAssetVersion)),
            Mode = AppendOptionalFontThemeText(item.Mode, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, nameof(item.Mode)),
            PreviousMode = AppendOptionalFontThemeText(item.PreviousMode, blob, FontThemeAdminContractLimits.MaxIdentifierBytes, nameof(item.PreviousMode)),
            FailureReason = AppendOptionalFontThemeText(item.FailureReason, blob, FontThemeAdminContractLimits.MaxFailureReasonBytes, nameof(item.FailureReason)),
            ActivatedBy = AppendFontThemeText(item.ActivatedBy, blob, FontThemeAdminContractLimits.MaxActorBytes, false, nameof(item.ActivatedBy))
        });
    }

    private static void ValidateFontSummary(FontRegistryItemResponse item)
    {
        if (item.TotalSizeBytes < 0 || item.FaceCount < 0 || item.FaceCount > FontThemeAdminContractLimits.MaxFontFaces ||
            item.CriticalFaceCount < 0 || item.CriticalFaceCount > item.FaceCount)
        {
            throw new ArgumentOutOfRangeException(nameof(item));
        }
    }

    private static bool TryDecodeFontRegistryItem(FontRegistryItemPod pod, ReadOnlySpan<byte> blob, ref int cursor, out FontRegistryItemResponse item)
    {
        item = null!;
        if (pod.TotalSizeBytes < 0 || pod.FaceCount < 0 || pod.FaceCount > FontThemeAdminContractLimits.MaxFontFaces ||
            pod.CriticalFaceCount < 0 || pod.CriticalFaceCount > pod.FaceCount || pod.Enabled > 1 || pod.BuiltIn > 1 || pod.Reserved0 != 0 ||
            !TryReadFontThemeText(pod.FontId, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string fontId) ||
            !TryReadFontThemeText(pod.Name, blob, ref cursor, FontThemeAdminContractLimits.MaxLabelBytes, false, out string name) ||
            !TryReadFontThemeText(pod.Family, blob, ref cursor, FontThemeAdminContractLimits.MaxFamilyBytes, false, out string family) ||
            !TryReadFontThemeText(pod.Category, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string category) ||
            !TryReadFontThemeText(pod.Version, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string version))
        {
            return false;
        }
        item = new FontRegistryItemResponse(fontId, name, family, category, version, FontInstallStateName(pod.InstallState), pod.Enabled == 1, pod.BuiltIn == 1, pod.FaceCount, pod.CriticalFaceCount, pod.TotalSizeBytes, FontThemeDateTime(pod.InstalledAtUnixMs), FontThemeDateTime(pod.UpdatedAtUnixMs));
        return true;
    }

    private static bool TryDecodeFontRegistryDetail(FontRegistryDetailPod pod, ReadOnlySpan<byte> blob, ref int cursor, out FontRegistryItemResponse font, out string licenseText, out string licenseSourceJson, out string manifestJson)
    {
        font = null!;
        licenseText = licenseSourceJson = manifestJson = string.Empty;
        if (pod.TotalSizeBytes < 0 || pod.FaceCount < 0 || pod.FaceCount > FontThemeAdminContractLimits.MaxFontFaces ||
            pod.CriticalFaceCount < 0 || pod.CriticalFaceCount > pod.FaceCount || pod.Enabled > 1 || pod.BuiltIn > 1 || pod.Reserved0 != 0 ||
            !TryReadFontThemeText(pod.FontId, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string fontId) ||
            !TryReadFontThemeText(pod.Name, blob, ref cursor, FontThemeAdminContractLimits.MaxLabelBytes, false, out string name) ||
            !TryReadFontThemeText(pod.Family, blob, ref cursor, FontThemeAdminContractLimits.MaxFamilyBytes, false, out string family) ||
            !TryReadFontThemeText(pod.Category, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string category) ||
            !TryReadFontThemeText(pod.Version, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string version) ||
            !TryReadFontThemeText(pod.LicenseText, blob, ref cursor, FontThemeAdminContractLimits.MaxLicenseBytes, true, out licenseText) ||
            !TryReadFontThemeText(pod.LicenseSourceJson, blob, ref cursor, FontThemeAdminContractLimits.MaxJsonBytes, true, out licenseSourceJson) ||
            !TryReadFontThemeText(pod.ManifestJson, blob, ref cursor, FontThemeAdminContractLimits.MaxJsonBytes, true, out manifestJson))
        {
            return false;
        }
        font = new FontRegistryItemResponse(fontId, name, family, category, version, FontInstallStateName(pod.InstallState), pod.Enabled == 1, pod.BuiltIn == 1, pod.FaceCount, pod.CriticalFaceCount, pod.TotalSizeBytes, FontThemeDateTime(pod.InstalledAtUnixMs), FontThemeDateTime(pod.UpdatedAtUnixMs));
        return true;
    }

    private static bool TryDecodeFontFace(FontFacePod pod, ReadOnlySpan<byte> blob, ref int cursor, out FontFaceResponse face)
    {
        face = null!;
        if (pod.SizeBytes < 0 || pod.Weight <= 0 || pod.Critical > 1 || pod.HasUnicodeRange > 1 || pod.Reserved0 != 0 ||
            !TryReadFontThemeText(pod.Style, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string style) ||
            !TryReadFontThemeText(pod.FilePath, blob, ref cursor, FontThemeAdminContractLimits.MaxPathBytes, false, out string filePath) ||
            !TryReadFontThemeText(pod.ContentHash, blob, ref cursor, FontThemeAdminContractLimits.MaxHashBytes, false, out string contentHash) ||
            !TryReadOptionalFontThemeText(pod.HasUnicodeRange, pod.UnicodeRange, blob, ref cursor, FontThemeAdminContractLimits.MaxUnicodeRangeBytes, out string? unicodeRange) ||
            !TryReadFontThemeText(pod.FontDisplay, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string fontDisplay))
        {
            return false;
        }
        face = new FontFaceResponse(pod.Weight, style, filePath, contentHash, pod.SizeBytes, unicodeRange, pod.Critical == 1, fontDisplay);
        return true;
    }

    private static bool TryDecodeFontActivation(FontActivationPod pod, ReadOnlySpan<byte> blob, ref int cursor, out FontActivationResponse item)
    {
        item = null!;
        if (pod.ConfigVersion < 0 ||
            !TryReadFontThemeText(pod.Scope, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string scope) ||
            !TryReadFontThemeText(pod.UiFontId, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string uiFontId) ||
            !TryReadFontThemeText(pod.ProseFontId, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string proseFontId) ||
            !TryReadFontThemeText(pod.CodeFontId, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string codeFontId) ||
            !TryReadFontThemeText(pod.CjkFontId, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string cjkFontId) ||
            !TryReadFontThemeText(pod.EmojiFontId, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string emojiFontId))
        {
            return false;
        }
        item = new FontActivationResponse(scope, uiFontId, proseFontId, codeFontId, cjkFontId, emojiFontId, pod.ConfigVersion, FontThemeDateTime(pod.UpdatedAtUnixMs));
        return true;
    }

    private static bool TryDecodeThemeRegistryItem(ThemeRegistryItemPod pod, ReadOnlySpan<byte> blob, ref int cursor, out ThemeRegistryItemResponse item)
    {
        item = null!;
        if (pod.Enabled > 1 || pod.Reserved0 != 0 ||
            !TryReadFontThemeText(pod.ThemeId, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string themeId) ||
            !TryReadFontThemeText(pod.Name, blob, ref cursor, FontThemeAdminContractLimits.MaxLabelBytes, false, out string name) ||
            !TryReadFontThemeText(pod.Version, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string version) ||
            !TryReadFontThemeText(pod.Author, blob, ref cursor, FontThemeAdminContractLimits.MaxLabelBytes, false, out string author) ||
            !TryReadFontThemeText(pod.Description, blob, ref cursor, FontThemeAdminContractLimits.MaxLabelBytes, true, out string description) ||
            !TryReadFontThemeText(pod.Type, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string type) ||
            !TryReadFontThemeText(pod.PackageHash, blob, ref cursor, FontThemeAdminContractLimits.MaxHashBytes, false, out string packageHash) ||
            !TryReadFontThemeText(pod.PackageLocation, blob, ref cursor, FontThemeAdminContractLimits.MaxPathBytes, false, out string packageLocation))
        {
            return false;
        }
        item = new ThemeRegistryItemResponse(themeId, name, version, author, description, type, ThemeInstallStateName(pod.InstallState), pod.Enabled == 1, packageHash, packageLocation, FontThemeDateTime(pod.InstalledAtUnixMs), FontThemeDateTime(pod.UpdatedAtUnixMs));
        return true;
    }

    private static bool TryDecodeThemeRegistryDetail(ThemeRegistryDetailPod pod, ReadOnlySpan<byte> blob, ref int cursor, out ThemeRegistryItemResponse theme, out string manifestJson, out string configSchemaJson, out ThemeSupportResponse supports, out ThemeBudgetResponse budgets, out ThemePermissionResponse permissions)
    {
        theme = null!;
        manifestJson = configSchemaJson = string.Empty;
        supports = null!;
        budgets = null!;
        permissions = null!;
        byte[] flags = [pod.Enabled, pod.SupportsPublic, pod.SupportsAdmin, pod.SupportsConsole, pod.SupportsHighContrast, pod.SupportsReducedMotion, pod.SupportsRtl, pod.PermissionScript, pod.PermissionNetwork, pod.PermissionFilesystem];
        if (flags.Any(static value => value > 1) || pod.Reserved0 != 0 || pod.CssBytes < 0 || pod.AssetBytes < 0 || pod.PreviewBytes < 0 ||
            pod.MaxSelectors < 0 || pod.MaxSelectorDepth < 0 || pod.MaxImportant < 0 || pod.MaxMotionDurationMs < 0 ||
            !TryReadFontThemeText(pod.ThemeId, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string themeId) ||
            !TryReadFontThemeText(pod.Name, blob, ref cursor, FontThemeAdminContractLimits.MaxLabelBytes, false, out string name) ||
            !TryReadFontThemeText(pod.Version, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string version) ||
            !TryReadFontThemeText(pod.Author, blob, ref cursor, FontThemeAdminContractLimits.MaxLabelBytes, false, out string author) ||
            !TryReadFontThemeText(pod.Description, blob, ref cursor, FontThemeAdminContractLimits.MaxLabelBytes, true, out string description) ||
            !TryReadFontThemeText(pod.Type, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string type) ||
            !TryReadFontThemeText(pod.PackageHash, blob, ref cursor, FontThemeAdminContractLimits.MaxHashBytes, false, out string packageHash) ||
            !TryReadFontThemeText(pod.PackageLocation, blob, ref cursor, FontThemeAdminContractLimits.MaxPathBytes, false, out string packageLocation) ||
            !TryReadFontThemeText(pod.ManifestJson, blob, ref cursor, FontThemeAdminContractLimits.MaxJsonBytes, true, out manifestJson) ||
            !TryReadFontThemeText(pod.ConfigSchemaJson, blob, ref cursor, FontThemeAdminContractLimits.MaxJsonBytes, true, out configSchemaJson))
        {
            return false;
        }
        theme = new ThemeRegistryItemResponse(themeId, name, version, author, description, type, ThemeInstallStateName(pod.InstallState), pod.Enabled == 1, packageHash, packageLocation, FontThemeDateTime(pod.InstalledAtUnixMs), FontThemeDateTime(pod.UpdatedAtUnixMs));
        supports = new ThemeSupportResponse(pod.SupportsPublic == 1, pod.SupportsAdmin == 1, pod.SupportsConsole == 1, pod.SupportsHighContrast == 1, pod.SupportsReducedMotion == 1, pod.SupportsRtl == 1);
        budgets = new ThemeBudgetResponse(pod.CssBytes, pod.AssetBytes, pod.MaxSelectors, pod.MaxSelectorDepth, pod.MaxImportant, pod.MaxMotionDurationMs, pod.PreviewBytes);
        permissions = new ThemePermissionResponse(pod.PermissionScript == 1, pod.PermissionNetwork == 1, pod.PermissionFilesystem == 1);
        return true;
    }

    private static bool TryDecodeThemeActivation(ThemeActivationPod pod, ReadOnlySpan<byte> blob, ref int cursor, out ThemeActivationResponse item)
    {
        item = null!;
        byte[] flags = [pod.HasActiveThemeId, pod.HasMode, pod.HasActivationId, pod.HasAssetVersion, pod.HasConfigVersion, pod.HasUpdatedAt];
        if (flags.Any(static value => value > 1) || pod.Reserved0 != 0 ||
            (pod.HasConfigVersion == 0 && pod.ConfigVersion != 0) || (pod.HasConfigVersion == 1 && pod.ConfigVersion < 0) ||
            (pod.HasUpdatedAt == 0 && pod.UpdatedAtUnixMs != 0) ||
            !TryReadFontThemeText(pod.Scope, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string scope) ||
            !TryReadOptionalFontThemeText(pod.HasActiveThemeId, pod.ActiveThemeId, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, out string? activeThemeId) ||
            !TryReadOptionalFontThemeText(pod.HasMode, pod.Mode, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, out string? mode) ||
            !TryReadOptionalFontThemeText(pod.HasActivationId, pod.ActivationId, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, out string? activationId) ||
            !TryReadOptionalFontThemeText(pod.HasAssetVersion, pod.AssetVersion, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, out string? assetVersion))
        {
            return false;
        }
        Guid? parsedActivationId = null;
        if (activationId is not null)
        {
            if (!Guid.TryParseExact(activationId, "D", out Guid parsed) ||
                !string.Equals(activationId, parsed.ToString("D"), StringComparison.Ordinal))
            {
                return false;
            }
            parsedActivationId = parsed;
        }
        item = new ThemeActivationResponse(scope, activeThemeId, mode, parsedActivationId, assetVersion, pod.HasConfigVersion == 1 ? pod.ConfigVersion : null, pod.HasUpdatedAt == 1 ? FontThemeDateTime(pod.UpdatedAtUnixMs) : null);
        return true;
    }

    private static bool TryDecodeThemeActivationHistory(ThemeActivationHistoryPod pod, ReadOnlySpan<byte> blob, ref int cursor, out ThemeActivationHistoryItemResponse item)
    {
        item = null!;
        byte[] flags = [pod.HasThemeId, pod.HasPreviousThemeId, pod.HasAssetVersion, pod.HasPreviousAssetVersion, pod.HasConfigVersion, pod.HasPreviousConfigVersion, pod.HasMode, pod.HasPreviousMode, pod.HasFailureReason];
        if (flags.Any(static value => value > 1) || pod.Reserved0 != 0 ||
            (pod.HasConfigVersion == 0 && pod.ConfigVersion != 0) || (pod.HasConfigVersion == 1 && pod.ConfigVersion < 0) ||
            (pod.HasPreviousConfigVersion == 0 && pod.PreviousConfigVersion != 0) || (pod.HasPreviousConfigVersion == 1 && pod.PreviousConfigVersion < 0) ||
            !TryReadFontThemeText(pod.Id, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string id) ||
            !TryReadFontThemeText(pod.Scope, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, false, out string scope) ||
            !TryReadOptionalFontThemeText(pod.HasThemeId, pod.ThemeId, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, out string? themeId) ||
            !TryReadOptionalFontThemeText(pod.HasPreviousThemeId, pod.PreviousThemeId, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, out string? previousThemeId) ||
            !TryReadOptionalFontThemeText(pod.HasAssetVersion, pod.AssetVersion, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, out string? assetVersion) ||
            !TryReadOptionalFontThemeText(pod.HasPreviousAssetVersion, pod.PreviousAssetVersion, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, out string? previousAssetVersion) ||
            !TryReadOptionalFontThemeText(pod.HasMode, pod.Mode, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, out string? mode) ||
            !TryReadOptionalFontThemeText(pod.HasPreviousMode, pod.PreviousMode, blob, ref cursor, FontThemeAdminContractLimits.MaxIdentifierBytes, out string? previousMode) ||
            !TryReadOptionalFontThemeText(pod.HasFailureReason, pod.FailureReason, blob, ref cursor, FontThemeAdminContractLimits.MaxFailureReasonBytes, out string? failureReason) ||
            !TryReadFontThemeText(pod.ActivatedBy, blob, ref cursor, FontThemeAdminContractLimits.MaxActorBytes, false, out string activatedBy))
        {
            return false;
        }
        if (!Guid.TryParseExact(id, "D", out Guid parsedId) ||
            !string.Equals(id, parsedId.ToString("D"), StringComparison.Ordinal))
        {
            return false;
        }
        item = new ThemeActivationHistoryItemResponse(parsedId, scope, themeId, previousThemeId, assetVersion, previousAssetVersion, pod.HasConfigVersion == 1 ? pod.ConfigVersion : null, pod.HasPreviousConfigVersion == 1 ? pod.PreviousConfigVersion : null, mode, previousMode, ThemeActivationStatusName(pod.Status), failureReason, FontThemeDateTime(pod.StartedAtUnixMs), FontThemeDateTime(pod.CompletedAtUnixMs), activatedBy);
        return true;
    }

    private static TTo CastFontThemePod<TFrom, TTo>(TFrom source)
        where TFrom : unmanaged
        where TTo : unmanaged
    {
        if (Marshal.SizeOf<TFrom>() != Marshal.SizeOf<TTo>())
        {
            throw new InvalidOperationException("Font/Theme mutable projection differs from the shared POD size.");
        }
        ReadOnlySpan<TFrom> from = MemoryMarshal.CreateReadOnlySpan(ref source, 1);
        return MemoryMarshal.Cast<byte, TTo>(MemoryMarshal.AsBytes(from))[0];
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableFontThemePayloadHeaderPod
    {
        public int Version;
        public int RecordCount;
        public int PayloadLength;
        public int Reserved0;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableFontRegistryItemPod
    {
        public long InstalledAtUnixMs;
        public long UpdatedAtUnixMs;
        public long TotalSizeBytes;
        public int FaceCount;
        public int CriticalFaceCount;
        public byte Enabled;
        public byte BuiltIn;
        public byte InstallState;
        public byte Reserved0;
        public Utf8SliceRef FontId;
        public Utf8SliceRef Name;
        public Utf8SliceRef Family;
        public Utf8SliceRef Category;
        public Utf8SliceRef Version;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableFontRegistryDetailPod
    {
        public long InstalledAtUnixMs;
        public long UpdatedAtUnixMs;
        public long TotalSizeBytes;
        public int FaceCount;
        public int CriticalFaceCount;
        public byte Enabled;
        public byte BuiltIn;
        public byte InstallState;
        public byte Reserved0;
        public Utf8SliceRef FontId;
        public Utf8SliceRef Name;
        public Utf8SliceRef Family;
        public Utf8SliceRef Category;
        public Utf8SliceRef Version;
        public Utf8SliceRef LicenseText;
        public Utf8SliceRef LicenseSourceJson;
        public Utf8SliceRef ManifestJson;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableFontFacePod
    {
        public long SizeBytes;
        public int Weight;
        public byte Critical;
        public byte HasUnicodeRange;
        public ushort Reserved0;
        public Utf8SliceRef Style;
        public Utf8SliceRef FilePath;
        public Utf8SliceRef ContentHash;
        public Utf8SliceRef UnicodeRange;
        public Utf8SliceRef FontDisplay;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableFontActivationPod
    {
        public long ConfigVersion;
        public long UpdatedAtUnixMs;
        public Utf8SliceRef Scope;
        public Utf8SliceRef UiFontId;
        public Utf8SliceRef ProseFontId;
        public Utf8SliceRef CodeFontId;
        public Utf8SliceRef CjkFontId;
        public Utf8SliceRef EmojiFontId;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableThemeRegistryItemPod
    {
        public long InstalledAtUnixMs;
        public long UpdatedAtUnixMs;
        public byte Enabled;
        public byte InstallState;
        public ushort Reserved0;
        public Utf8SliceRef ThemeId;
        public Utf8SliceRef Name;
        public Utf8SliceRef Version;
        public Utf8SliceRef Author;
        public Utf8SliceRef Description;
        public Utf8SliceRef Type;
        public Utf8SliceRef PackageHash;
        public Utf8SliceRef PackageLocation;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableThemeRegistryDetailPod
    {
        public long InstalledAtUnixMs;
        public long UpdatedAtUnixMs;
        public long CssBytes;
        public long AssetBytes;
        public long PreviewBytes;
        public int MaxSelectors;
        public int MaxSelectorDepth;
        public int MaxImportant;
        public int MaxMotionDurationMs;
        public byte Enabled;
        public byte InstallState;
        public byte SupportsPublic;
        public byte SupportsAdmin;
        public byte SupportsConsole;
        public byte SupportsHighContrast;
        public byte SupportsReducedMotion;
        public byte SupportsRtl;
        public byte PermissionScript;
        public byte PermissionNetwork;
        public byte PermissionFilesystem;
        public byte Reserved0;
        public Utf8SliceRef ThemeId;
        public Utf8SliceRef Name;
        public Utf8SliceRef Version;
        public Utf8SliceRef Author;
        public Utf8SliceRef Description;
        public Utf8SliceRef Type;
        public Utf8SliceRef PackageHash;
        public Utf8SliceRef PackageLocation;
        public Utf8SliceRef ManifestJson;
        public Utf8SliceRef ConfigSchemaJson;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableThemeActivationPod
    {
        public long ConfigVersion;
        public long UpdatedAtUnixMs;
        public byte HasActiveThemeId;
        public byte HasMode;
        public byte HasActivationId;
        public byte HasAssetVersion;
        public byte HasConfigVersion;
        public byte HasUpdatedAt;
        public ushort Reserved0;
        public Utf8SliceRef Scope;
        public Utf8SliceRef ActiveThemeId;
        public Utf8SliceRef Mode;
        public Utf8SliceRef ActivationId;
        public Utf8SliceRef AssetVersion;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableThemeActivationHistoryPod
    {
        public long ConfigVersion;
        public long PreviousConfigVersion;
        public long StartedAtUnixMs;
        public long CompletedAtUnixMs;
        public byte HasThemeId;
        public byte HasPreviousThemeId;
        public byte HasAssetVersion;
        public byte HasPreviousAssetVersion;
        public byte HasConfigVersion;
        public byte HasPreviousConfigVersion;
        public byte HasMode;
        public byte HasPreviousMode;
        public byte HasFailureReason;
        public byte Status;
        public ushort Reserved0;
        public Utf8SliceRef Id;
        public Utf8SliceRef Scope;
        public Utf8SliceRef ThemeId;
        public Utf8SliceRef PreviousThemeId;
        public Utf8SliceRef AssetVersion;
        public Utf8SliceRef PreviousAssetVersion;
        public Utf8SliceRef Mode;
        public Utf8SliceRef PreviousMode;
        public Utf8SliceRef FailureReason;
        public Utf8SliceRef ActivatedBy;
    }
}
