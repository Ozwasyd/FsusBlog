using System.Buffers;
using System.Text;

using FsusBlog.Core.Mapping.Models;

namespace FsusBlog.Core.Cache;

/// <summary>
/// Closed display/intent payloads over the existing POD reader/writer. The Shared
/// owner registers outer AEDS frames; this domain allocates no frame or error ID.
/// </summary>
public static partial class PodBinaryCodec
{
    /// <summary>Admission frame budget includes the canonical sixteen-byte AEDS header.</summary>
    public const int MaximumDocumentExportRequestFrameBytes = 16 * 1024;
    /// <summary>Opaque task frame budget includes the canonical AEDS header.</summary>
    public const int MaximumDocumentExportTaskRequestFrameBytes = 1024;
    /// <summary>Admission payload budget excludes the canonical AEDS header.</summary>
    public const int MaximumDocumentExportRequestPayloadBytes = MaximumDocumentExportRequestFrameBytes - AedsFrameHeader.Size;
    /// <summary>Opaque task payload budget excludes the canonical AEDS header.</summary>
    public const int MaximumDocumentExportTaskRequestPayloadBytes = MaximumDocumentExportTaskRequestFrameBytes - AedsFrameHeader.Size;
    /// <summary>Bounded single-job response payload budget, excluding the outer header.</summary>
    public const int MaximumDocumentExportJobResponsePayloadBytes = 32 * 1024;
    /// <summary>Bounded fifty-job response payload budget, excluding the outer header.</summary>
    public const int MaximumDocumentExportPageResponsePayloadBytes = 2 * 1024 * 1024;
    /// <summary>Single-job response frame budget includes its outer AEDS header.</summary>
    public const int MaximumDocumentExportJobResponseFrameBytes = MaximumDocumentExportJobResponsePayloadBytes + AedsFrameHeader.Size;
    /// <summary>Page response frame budget includes its outer AEDS header.</summary>
    public const int MaximumDocumentExportPageResponseFrameBytes = MaximumDocumentExportPageResponsePayloadBytes + AedsFrameHeader.Size;
    /// <summary>Largest root budget; each decoder additionally enforces its narrower family budget.</summary>
    public const int MaximumDocumentExportPayloadBytes = MaximumDocumentExportPageResponsePayloadBytes;
    public const int MaximumDocumentExportPageSize = 50;
    private const int DocumentExportPayloadVersion = 1;
    private const int DocumentExportIdentifierLength = 192;
    private const int DocumentExportReasonLength = 2048;
    private const int DocumentExportMaximumAttempts = 3;

    /// <summary>Encodes one validated admission intent as a payload without an outer frame.</summary>
    public static byte[] EncodeDocumentExportRequest(DocumentExportRequestCoreModel value)
        => EncodeToArray(512, writer => WriteDocumentExportRequest(value, writer));

    /// <summary>Validates the complete admission intent before writing to the existing POD destination.</summary>
    public static void WriteDocumentExportRequest(DocumentExportRequestCoreModel value, IBufferWriter<byte> destination)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (!ValidDocumentExportRequest(value))
        {
            throw new ArgumentException("document_export_request_invalid", nameof(value));
        }
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(DocumentExportPayloadVersion);
        WriteDocumentExportText(ref writer, value.RequestId);
        WriteDocumentExportText(ref writer, value.IdempotencyKey);
        WriteDocumentExportSource(ref writer, value.Source);
        WriteDocumentExportText(ref writer, value.FormatId);
        WriteDocumentExportText(ref writer, value.LayoutProfile);
        WriteDocumentExportText(ref writer, value.ThemeProfile);
        WriteDocumentExportText(ref writer, value.Locale);
    }

    /// <summary>Refuses malformed, oversized or trailing data when decoding one admission intent.</summary>
    public static bool TryDecodeDocumentExportRequest(ReadOnlyMemory<byte> source, out DocumentExportRequestCoreModel value)
    {
        value = null!;
        var reader = new BinaryPodReader(source.Span);
        if (!TryReadDocumentExportVersion(ref reader, source.Length, MaximumDocumentExportRequestPayloadBytes)
            || !TryReadDocumentExportText(ref reader, out string requestId)
            || !TryReadDocumentExportText(ref reader, out string idempotencyKey)
            || !TryReadDocumentExportSource(ref reader, out DocumentExportSourceCoreModel coordinate)
            || !TryReadDocumentExportText(ref reader, out string formatId)
            || !TryReadDocumentExportText(ref reader, out string layout)
            || !TryReadDocumentExportText(ref reader, out string theme)
            || !TryReadDocumentExportText(ref reader, out string locale)
            || !reader.IsConsumed)
        {
            return false;
        }
        var decoded = new DocumentExportRequestCoreModel(requestId, idempotencyKey, coordinate, formatId, layout, theme, locale);
        if (!ValidDocumentExportRequest(decoded))
        {
            return false;
        }
        value = decoded;
        return true;
    }

    /// <summary>Encodes one validated opaque task identity as a payload without an outer frame.</summary>
    public static byte[] EncodeDocumentExportTaskRequest(DocumentExportTaskRequestCoreModel value)
        => EncodeToArray(256, writer => WriteDocumentExportTaskRequest(value, writer));

    /// <summary>Validates the complete opaque task identity before writing to the existing POD destination.</summary>
    public static void WriteDocumentExportTaskRequest(DocumentExportTaskRequestCoreModel value, IBufferWriter<byte> destination)
    {
        if (!ValidDocumentExportText(value.TaskId))
        {
            throw new ArgumentException("document_export_task_request_invalid", nameof(value));
        }
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(DocumentExportPayloadVersion);
        WriteDocumentExportText(ref writer, value.TaskId);
    }

    /// <summary>Refuses malformed, oversized or trailing data when decoding one opaque task identity.</summary>
    public static bool TryDecodeDocumentExportTaskRequest(ReadOnlyMemory<byte> source, out DocumentExportTaskRequestCoreModel value)
    {
        value = default;
        var reader = new BinaryPodReader(source.Span);
        if (!TryReadDocumentExportVersion(ref reader, source.Length, MaximumDocumentExportTaskRequestPayloadBytes)
            || !TryReadDocumentExportText(ref reader, out string taskId) || !reader.IsConsumed)
        {
            return false;
        }
        value = new DocumentExportTaskRequestCoreModel(taskId);
        return true;
    }

    /// <summary>Encodes one validated actual job display projection as a payload without an outer frame.</summary>
    public static byte[] EncodeDocumentExportJobResponse(DocumentExportJobResponseCoreModel value)
        => EncodeToArray(1024, writer => WriteDocumentExportJobResponse(value, writer));

    /// <summary>Validates the complete actual job display projection before writing to the existing POD destination.</summary>
    public static void WriteDocumentExportJobResponse(DocumentExportJobResponseCoreModel value, IBufferWriter<byte> destination)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (!ValidDocumentExportJob(value))
        {
            throw new ArgumentException("document_export_job_response_invalid", nameof(value));
        }
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(DocumentExportPayloadVersion);
        WriteDocumentExportJob(ref writer, value);
    }

    /// <summary>Refuses malformed, oversized or trailing data when decoding one actual job display projection.</summary>
    public static bool TryDecodeDocumentExportJobResponse(ReadOnlyMemory<byte> source, out DocumentExportJobResponseCoreModel value)
    {
        value = null!;
        var reader = new BinaryPodReader(source.Span);
        if (!TryReadDocumentExportVersion(ref reader, source.Length, MaximumDocumentExportJobResponsePayloadBytes)
            || !TryReadDocumentExportJob(ref reader, out DocumentExportJobResponseCoreModel decoded) || !reader.IsConsumed)
        {
            return false;
        }
        value = decoded;
        return true;
    }

    /// <summary>Encodes one validated bounded authorized job page as a payload without an outer frame.</summary>
    public static byte[] EncodeDocumentExportPageResponse(DocumentExportPageResponseCoreModel value)
        => EncodeToArray(4096, writer => WriteDocumentExportPageResponse(value, writer));

    /// <summary>Validates the complete bounded authorized job page before writing to the existing POD destination.</summary>
    public static void WriteDocumentExportPageResponse(DocumentExportPageResponseCoreModel value, IBufferWriter<byte> destination)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (!ValidDocumentExportPage(value))
        {
            throw new ArgumentException("document_export_page_response_invalid", nameof(value));
        }
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(DocumentExportPayloadVersion);
        writer.WriteInt32(value.Offset);
        writer.WriteInt32(value.Limit);
        writer.WriteByte(value.HasMore ? (byte)1 : (byte)0);
        writer.WriteInt32(value.Jobs.Count);
        foreach (DocumentExportJobResponseCoreModel job in value.Jobs)
        {
            WriteDocumentExportJob(ref writer, job);
        }
    }

    /// <summary>Refuses malformed, oversized or trailing data when decoding one bounded authorized job page.</summary>
    public static bool TryDecodeDocumentExportPageResponse(ReadOnlyMemory<byte> source, out DocumentExportPageResponseCoreModel value)
    {
        value = null!;
        var reader = new BinaryPodReader(source.Span);
        if (!TryReadDocumentExportVersion(ref reader, source.Length, MaximumDocumentExportPageResponsePayloadBytes)
            || !reader.TryReadInt32(out int offset) || offset < 0
            || !reader.TryReadInt32(out int limit) || limit is < 1 or > MaximumDocumentExportPageSize
            || !TryReadDocumentExportBoolean(ref reader, out bool hasMore)
            || !reader.TryReadInt32(out int count) || count < 0 || count > limit)
        {
            return false;
        }
        var jobs = new DocumentExportJobResponseCoreModel[count];
        for (int i = 0; i < count; i++)
        {
            if (!TryReadDocumentExportJob(ref reader, out jobs[i]))
            {
                return false;
            }
        }
        var decoded = new DocumentExportPageResponseCoreModel(offset, limit, hasMore, Array.AsReadOnly(jobs));
        if (!reader.IsConsumed || !ValidDocumentExportPage(decoded))
        {
            return false;
        }
        value = decoded;
        return true;
    }

    private static bool TryReadDocumentExportVersion(ref BinaryPodReader reader, int length, int maximum)
        => length <= maximum && reader.TryReadInt32(out int version)
            && version == DocumentExportPayloadVersion;

    private static bool ValidDocumentExportRequest(DocumentExportRequestCoreModel value)
        => ValidDocumentExportText(value.RequestId) && ValidDocumentExportText(value.IdempotencyKey)
            && ValidDocumentExportSource(value.Source) && ValidDocumentExportFormat(value.FormatId)
            && ValidDocumentExportText(value.LayoutProfile) && ValidDocumentExportText(value.ThemeProfile)
            && ValidDocumentExportText(value.Locale);

    private static bool ValidDocumentExportSource(DocumentExportSourceCoreModel source)
        => source.ArticleId > 0 && source.SourceVersion > 0 && (source.Kind switch
        {
            1 => ValidDocumentExportText(source.DraftKey) && source.RevisionId is null && source.PublicationId is null,
            2 => source.DraftKey is null && source.RevisionId > 0 && source.PublicationId is null,
            3 => source.DraftKey is null && source.RevisionId > 0 && source.PublicationId > 0,
            _ => false
        });

    private static bool ValidDocumentExportFormat(string value)
        => value is "self-contained-html" or "pdf" or "docx" or "epub";

    private static bool ValidDocumentExportDigest(string value)
        => value is { Length: 71 } && value.StartsWith("sha256:", StringComparison.Ordinal)
            && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    private static bool ValidDocumentExportTime(long value)
        => value is >= -62135596800000 and <= 253402300799999;

    private static bool ValidDocumentExportText(string? value, bool allowEmpty = false, int maximum = DocumentExportIdentifierLength)
    {
        if (value is null || value.Length > maximum || value.Any(char.IsControl)
            || (!allowEmpty && string.IsNullOrWhiteSpace(value)))
        {
            return false;
        }
        try
        {
            _ = s_strictUtf8.GetByteCount(value);
            return true;
        }
        catch (EncoderFallbackException)
        {
            return false;
        }
    }

    private static void WriteDocumentExportText(ref BinaryPodWriter writer, string value)
        => writer.WriteBytes(s_strictUtf8.GetBytes(value));

    private static bool TryReadDocumentExportText(ref BinaryPodReader reader, out string value,
        bool allowEmpty = false, int maximum = DocumentExportIdentifierLength)
    {
        value = string.Empty;
        // Read the bounded length before calling the shared span primitive, so
        // hostile lengths cannot overflow offset arithmetic or allocate memory.
        if (!reader.TryReadInt32(out int length) || length < 0 || length > maximum * 4
            || !reader.TryReadSpan(length, out ReadOnlySpan<byte> bytes))
        {
            return false;
        }
        try
        {
            value = s_strictUtf8.GetString(bytes);
            return ValidDocumentExportText(value, allowEmpty, maximum);
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
    }

    private static bool TryReadDocumentExportBoolean(ref BinaryPodReader reader, out bool value)
    {
        value = false;
        if (!reader.TryReadByte(out byte tag) || tag > 1)
        {
            return false;
        }
        value = tag == 1;
        return true;
    }

    private static void WriteDocumentExportOptionalLong(ref BinaryPodWriter writer, long? value)
    {
        writer.WriteByte(value.HasValue ? (byte)1 : (byte)0);
        if (value.HasValue)
        {
            writer.WriteInt64(value.Value);
        }
    }

    private static bool TryReadDocumentExportOptionalLong(ref BinaryPodReader reader, out long? value)
    {
        value = null;
        if (!TryReadDocumentExportBoolean(ref reader, out bool present))
        {
            return false;
        }
        if (!present)
        {
            return true;
        }
        if (!reader.TryReadInt64(out long number))
        {
            return false;
        }
        value = number;
        return true;
    }

    private static void WriteDocumentExportSource(ref BinaryPodWriter writer, DocumentExportSourceCoreModel value)
    {
        writer.WriteInt32(value.Kind);
        writer.WriteInt64(value.ArticleId);
        writer.WriteByte(value.DraftKey is null ? (byte)0 : (byte)1);
        if (value.DraftKey is not null)
        {
            WriteDocumentExportText(ref writer, value.DraftKey);
        }
        WriteDocumentExportOptionalLong(ref writer, value.RevisionId);
        WriteDocumentExportOptionalLong(ref writer, value.PublicationId);
        writer.WriteInt64(value.SourceVersion);
    }

    private static bool TryReadDocumentExportSource(ref BinaryPodReader reader, out DocumentExportSourceCoreModel value)
    {
        value = default;
        if (!reader.TryReadInt32(out int kind) || !reader.TryReadInt64(out long articleId)
            || !TryReadDocumentExportBoolean(ref reader, out bool hasDraft))
        {
            return false;
        }
        string? draftKey = null;
        if (hasDraft)
        {
            if (!TryReadDocumentExportText(ref reader, out string draft))
            {
                return false;
            }
            draftKey = draft;
        }
        if (!TryReadDocumentExportOptionalLong(ref reader, out long? revision)
            || !TryReadDocumentExportOptionalLong(ref reader, out long? publication)
            || !reader.TryReadInt64(out long sourceVersion))
        {
            return false;
        }
        value = new DocumentExportSourceCoreModel(kind, articleId, draftKey, revision, publication, sourceVersion);
        return ValidDocumentExportSource(value);
    }

    private static bool ValidDocumentExportJob(DocumentExportJobResponseCoreModel value)
        => ValidDocumentExportText(value.TaskId) && ValidDocumentExportText(value.RequestId)
            && ValidDocumentExportSource(value.Source) && ValidDocumentExportDigest(value.InputDigest)
            && ValidDocumentExportDigest(value.TaskDigest) && ValidDocumentExportFormat(value.FormatId)
            && ValidDocumentExportText(value.ProviderId) && ValidDocumentExportText(value.ProviderVersion)
            && ValidDocumentExportText(value.LayoutProfile) && ValidDocumentExportText(value.ThemeProfile)
            && ValidDocumentExportText(value.Locale) && value.Status is >= 1 and <= 10 && value.Version > 0
            && ValidDocumentExportTime(value.CreatedAtUnixMs) && ValidDocumentExportTime(value.ExpiresAtUnixMs)
            && value.ExpiresAtUnixMs > value.CreatedAtUnixMs
            && ValidDocumentExportText(value.Reason, true, DocumentExportReasonLength)
            && value.Attempts is not null && value.Attempts.Count <= DocumentExportMaximumAttempts
            && value.Attempts.Select((attempt, index) => attempt.Number == index + 1 && ValidDocumentExportAttempt(attempt)).All(valid => valid)
            && (value.Output is null || ValidDocumentExportOutput(value.Output));

    private static bool ValidDocumentExportAttempt(DocumentExportAttemptCoreModel value)
        => value.Status is >= 1 and <= 10 && ValidDocumentExportTime(value.StartedAtUnixMs)
            && (value.FinishedAtUnixMs is null || (ValidDocumentExportTime(value.FinishedAtUnixMs.Value)
                && value.FinishedAtUnixMs.Value >= value.StartedAtUnixMs))
            && ValidDocumentExportText(value.Reason, true, DocumentExportReasonLength);

    private static bool ValidDocumentExportOutput(DocumentExportOutputCoreModel value)
        => ValidDocumentExportText(value.OutputId) && ValidDocumentExportText(value.MediaType)
            && ValidDocumentExportText(value.Extension) && ValidDocumentExportDigest(value.OutputDigest)
            && ValidDocumentExportDigest(value.ResultReceiptDigest) && value.Length >= 0
            && ValidDocumentExportTime(value.CreatedAtUnixMs) && ValidDocumentExportTime(value.ExpiresAtUnixMs)
            && value.ExpiresAtUnixMs > value.CreatedAtUnixMs
            && (value.DeletedAtUnixMs is null || ValidDocumentExportTime(value.DeletedAtUnixMs.Value));

    private static bool ValidDocumentExportPage(DocumentExportPageResponseCoreModel value)
        => value.Offset >= 0 && value.Limit is >= 1 and <= MaximumDocumentExportPageSize
            && value.Jobs is not null && value.Jobs.Count <= value.Limit
            && (!value.HasMore || value.Jobs.Count == value.Limit)
            && value.Jobs.All(job => job is not null && ValidDocumentExportJob(job))
            && value.Jobs.Select(job => job.TaskId).Distinct(StringComparer.Ordinal).Count() == value.Jobs.Count;

    private static void WriteDocumentExportJob(ref BinaryPodWriter writer, DocumentExportJobResponseCoreModel value)
    {
        WriteDocumentExportText(ref writer, value.TaskId);
        WriteDocumentExportText(ref writer, value.RequestId);
        WriteDocumentExportSource(ref writer, value.Source);
        WriteDocumentExportText(ref writer, value.InputDigest);
        WriteDocumentExportText(ref writer, value.TaskDigest);
        WriteDocumentExportText(ref writer, value.FormatId);
        WriteDocumentExportText(ref writer, value.ProviderId);
        WriteDocumentExportText(ref writer, value.ProviderVersion);
        WriteDocumentExportText(ref writer, value.LayoutProfile);
        WriteDocumentExportText(ref writer, value.ThemeProfile);
        WriteDocumentExportText(ref writer, value.Locale);
        writer.WriteInt32(value.Status);
        writer.WriteInt64(value.Version);
        writer.WriteInt64(value.CreatedAtUnixMs);
        writer.WriteInt64(value.ExpiresAtUnixMs);
        WriteDocumentExportText(ref writer, value.Reason);
        writer.WriteInt32(value.Attempts.Count);
        foreach (DocumentExportAttemptCoreModel attempt in value.Attempts)
        {
            writer.WriteInt32(attempt.Number);
            writer.WriteByte(attempt.Diagnostic ? (byte)1 : (byte)0);
            writer.WriteInt64(attempt.StartedAtUnixMs);
            WriteDocumentExportOptionalLong(ref writer, attempt.FinishedAtUnixMs);
            writer.WriteInt32(attempt.Status);
            WriteDocumentExportText(ref writer, attempt.Reason);
        }
        writer.WriteByte(value.Output is null ? (byte)0 : (byte)1);
        if (value.Output is { } output)
        {
            WriteDocumentExportText(ref writer, output.OutputId);
            WriteDocumentExportText(ref writer, output.MediaType);
            WriteDocumentExportText(ref writer, output.Extension);
            WriteDocumentExportText(ref writer, output.OutputDigest);
            WriteDocumentExportText(ref writer, output.ResultReceiptDigest);
            writer.WriteInt64(output.Length);
            writer.WriteInt64(output.CreatedAtUnixMs);
            writer.WriteInt64(output.ExpiresAtUnixMs);
            WriteDocumentExportOptionalLong(ref writer, output.DeletedAtUnixMs);
        }
    }

    private static bool TryReadDocumentExportJob(ref BinaryPodReader reader, out DocumentExportJobResponseCoreModel value)
    {
        value = null!;
        if (!TryReadDocumentExportText(ref reader, out string taskId)
            || !TryReadDocumentExportText(ref reader, out string requestId)
            || !TryReadDocumentExportSource(ref reader, out DocumentExportSourceCoreModel source)
            || !TryReadDocumentExportText(ref reader, out string inputDigest)
            || !TryReadDocumentExportText(ref reader, out string taskDigest)
            || !TryReadDocumentExportText(ref reader, out string format)
            || !TryReadDocumentExportText(ref reader, out string provider)
            || !TryReadDocumentExportText(ref reader, out string providerVersion)
            || !TryReadDocumentExportText(ref reader, out string layout)
            || !TryReadDocumentExportText(ref reader, out string theme)
            || !TryReadDocumentExportText(ref reader, out string locale)
            || !reader.TryReadInt32(out int status) || !reader.TryReadInt64(out long version)
            || !reader.TryReadInt64(out long created) || !reader.TryReadInt64(out long expires)
            || !TryReadDocumentExportText(ref reader, out string reason, true, DocumentExportReasonLength)
            || !reader.TryReadInt32(out int count) || count is < 0 or > DocumentExportMaximumAttempts)
        {
            return false;
        }
        var attempts = new DocumentExportAttemptCoreModel[count];
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadInt32(out int number) || !TryReadDocumentExportBoolean(ref reader, out bool diagnostic)
                || !reader.TryReadInt64(out long started) || !TryReadDocumentExportOptionalLong(ref reader, out long? finished)
                || !reader.TryReadInt32(out int attemptStatus)
                || !TryReadDocumentExportText(ref reader, out string attemptReason, true, DocumentExportReasonLength))
            {
                return false;
            }
            attempts[i] = new DocumentExportAttemptCoreModel(number, diagnostic, started, finished, attemptStatus, attemptReason);
        }
        if (!TryReadDocumentExportBoolean(ref reader, out bool hasOutput))
        {
            return false;
        }
        DocumentExportOutputCoreModel? output = null;
        if (hasOutput)
        {
            if (!TryReadDocumentExportText(ref reader, out string outputId)
                || !TryReadDocumentExportText(ref reader, out string mediaType)
                || !TryReadDocumentExportText(ref reader, out string extension)
                || !TryReadDocumentExportText(ref reader, out string outputDigest)
                || !TryReadDocumentExportText(ref reader, out string resultReceiptDigest)
                || !reader.TryReadInt64(out long length) || !reader.TryReadInt64(out long outputCreated)
                || !reader.TryReadInt64(out long outputExpires)
                || !TryReadDocumentExportOptionalLong(ref reader, out long? deleted))
            {
                return false;
            }
            output = new DocumentExportOutputCoreModel(outputId, mediaType, extension, outputDigest, resultReceiptDigest,
                length, outputCreated, outputExpires, deleted);
        }
        var decoded = new DocumentExportJobResponseCoreModel(taskId, requestId, source, inputDigest, taskDigest, format,
            provider, providerVersion, layout, theme, locale, status, version, created, expires, reason,
            Array.AsReadOnly(attempts), output);
        if (!ValidDocumentExportJob(decoded))
        {
            return false;
        }
        value = decoded;
        return true;
    }
}
