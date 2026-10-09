using System.Buffers;
using System.Text;

using FsusBlog.Shared.Contracts.DocumentExport;

namespace FsusBlog.Core.Cache;

/// <summary>Closed source-option payloads. Capturing bindings, authorization and HTTP/PoW remain the Server owner's responsibility.</summary>
public static partial class PodBinaryCodec
{
    public static byte[] EncodeDocumentExportSourceCaptureRequest(DocumentExportSourceCaptureRequest value)
        => EncodeToArray(1024, writer => WriteDocumentExportSourceCaptureRequest(value, writer));

    public static void WriteDocumentExportSourceCaptureRequest(DocumentExportSourceCaptureRequest value, IBufferWriter<byte> destination)
    {
        if (value?.Sources is null || value.Sources.Count > DocumentExportSourceOptionsLimits.MaximumChoices
            || value.Sources.Any(source => !ValidExportSelector(source))
            || value.Sources.Distinct().Count() != value.Sources.Count)
        {
            throw new ArgumentException("document_export_source_options_payload_invalid", nameof(value));
        }
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(1);
        writer.WriteInt32(value.Sources.Count);
        foreach (DocumentExportSourceSelector source in value.Sources)
        {
            WriteExportSelector(ref writer, source);
        }
    }

    public static bool TryDecodeDocumentExportSourceCaptureRequest(ReadOnlyMemory<byte> source, out DocumentExportSourceCaptureRequest value)
    {
        value = null!;
        var reader = new BinaryPodReader(source.Span);
        if (!TryReadDocumentExportVersion(ref reader, source.Length, DocumentExportSourceOptionsLimits.CapturePayloadBytes)
            || !ReadExportChoiceCount(ref reader, out int count))
        {
            return false;
        }
        var sources = new DocumentExportSourceSelector[count];
        var seen = new HashSet<DocumentExportSourceSelector>();
        for (int index = 0; index < count; index++)
        {
            if (!ReadExportSelector(ref reader, out DocumentExportSourceSelector selector) || !seen.Add(selector))
            {
                return false;
            }
            sources[index] = selector;
        }
        if (!reader.IsConsumed)
        {
            return false;
        }
        value = new(sources);
        return true;
    }

    public static byte[] EncodeDocumentExportRevisionChoicesRequest(DocumentExportRevisionChoicesRequest value)
        => EncodeToArray(8, writer => WriteDocumentExportRevisionChoicesRequest(value, writer));

    public static void WriteDocumentExportRevisionChoicesRequest(DocumentExportRevisionChoicesRequest value, IBufferWriter<byte> destination)
    {
        if (value.ArticleId <= 0)
        {
            throw new ArgumentException("document_export_source_options_payload_invalid", nameof(value));
        }
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(1);
        writer.WriteInt32(value.ArticleId);
    }

    public static bool TryDecodeDocumentExportRevisionChoicesRequest(ReadOnlyMemory<byte> source, out DocumentExportRevisionChoicesRequest value)
    {
        value = default;
        var reader = new BinaryPodReader(source.Span);
        if (!TryReadDocumentExportVersion(ref reader, source.Length, DocumentExportSourceOptionsLimits.RevisionChoicesPayloadBytes)
            || !reader.TryReadInt32(out int articleId) || articleId <= 0 || !reader.IsConsumed)
        {
            return false;
        }
        value = new(articleId);
        return true;
    }

    public static byte[] EncodeDocumentExportSourceChoicesResponse(DocumentExportSourceChoicesResponse value)
        => EncodeToArray(4096, writer => WriteDocumentExportSourceChoicesResponse(value, writer));

    public static void WriteDocumentExportSourceChoicesResponse(DocumentExportSourceChoicesResponse value, IBufferWriter<byte> destination)
    {
        if (value?.Choices is null || value.Choices.Count > DocumentExportSourceOptionsLimits.MaximumChoices
            || value.Choices.Any(choice => !ValidExportChoice(choice))
            || value.Choices.Select(choice => choice.ChoiceId).Distinct(StringComparer.Ordinal).Count() != value.Choices.Count)
        {
            throw new ArgumentException("document_export_source_options_payload_invalid", nameof(value));
        }
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(1);
        writer.WriteInt32(value.Choices.Count);
        foreach (DocumentExportSourceChoiceResponse choice in value.Choices)
        {
            WriteDocumentExportText(ref writer, choice.ChoiceId);
            WriteDocumentExportText(ref writer, choice.Label);
            DocumentExportSourceCoordinate coordinate = choice.Coordinate;
            writer.WriteInt32(coordinate.Kind);
            writer.WriteInt64(coordinate.ArticleId);
            WriteExportSelectorTail(ref writer, coordinate.DraftKey, coordinate.RevisionId, coordinate.PublicationId);
            writer.WriteInt64(coordinate.SourceVersion);
        }
    }

    public static bool TryDecodeDocumentExportSourceChoicesResponse(ReadOnlyMemory<byte> source, out DocumentExportSourceChoicesResponse value)
    {
        value = null!;
        var reader = new BinaryPodReader(source.Span);
        if (!TryReadDocumentExportVersion(ref reader, source.Length, DocumentExportSourceOptionsLimits.ChoicesPayloadBytes)
            || !ReadExportChoiceCount(ref reader, out int count))
        {
            return false;
        }
        var choices = new DocumentExportSourceChoiceResponse[count];
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (int index = 0; index < count; index++)
        {
            if (!ReadExportOptionsText(ref reader, DocumentExportSourceOptionsLimits.ChoiceIdLength, out string choiceId)
                || !ReadExportOptionsText(ref reader, DocumentExportSourceOptionsLimits.MaximumLabelUtf16, out string label)
                || !reader.TryReadInt32(out int kind) || !reader.TryReadInt64(out long articleId)
                || !ReadExportSelectorTail(ref reader, out string? draftKey, out long? revisionId, out long? publicationId)
                || !reader.TryReadInt64(out long version))
            {
                return false;
            }
            var choice = new DocumentExportSourceChoiceResponse(choiceId, label, new(kind, articleId, draftKey, revisionId, publicationId, version));
            if (!ValidExportChoice(choice) || !seen.Add(choiceId))
            {
                return false;
            }
            choices[index] = choice;
        }
        if (!reader.IsConsumed)
        {
            return false;
        }
        value = new(choices);
        return true;
    }

    private static bool ReadExportChoiceCount(ref BinaryPodReader reader, out int count)
        => reader.TryReadInt32(out count) && count is >= 0 and <= DocumentExportSourceOptionsLimits.MaximumChoices;

    private static bool ValidExportChoice(DocumentExportSourceChoiceResponse? value)
        => value is not null && value.ChoiceId is { Length: DocumentExportSourceOptionsLimits.ChoiceIdLength }
            && value.ChoiceId.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f')
            && ValidExportOptionsText(value.Label, DocumentExportSourceOptionsLimits.MaximumLabelUtf16)
            && value.Coordinate is { ArticleId: > 0, SourceVersion: > 0 } coordinate
            && ValidExportSelectorTail(coordinate.Kind, coordinate.DraftKey, coordinate.RevisionId, coordinate.PublicationId);

    private static bool ValidExportSelector(DocumentExportSourceSelector? value)
        => value is { ArticleId: > 0 }
            && ValidExportSelectorTail(value.Kind, value.DraftKey, value.RevisionId, value.PublicationId);

    private static bool ValidExportSelectorTail(int kind, string? draft, long? revision, long? publication)
        => kind switch
        {
            1 => ValidExportOptionsText(draft, DocumentExportSourceOptionsLimits.MaximumDraftKeyUtf16)
                && !string.IsNullOrWhiteSpace(draft) && draft.Trim() == draft && revision is null && publication is null,
            2 => draft is null && revision is > 0 && publication is null,
            3 => draft is null && revision is > 0 && publication is > 0,
            _ => false
        };

    private static bool ValidExportOptionsText(string? value, int maximum)
    {
        if (value is null || value.Length > maximum)
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

    private static bool ReadExportOptionsText(ref BinaryPodReader reader, int maximum, out string value)
    {
        value = string.Empty;
        if (!reader.TryReadInt32(out int length) || length < 0 || length > maximum * 4
            || !reader.TryReadSpan(length, out ReadOnlySpan<byte> bytes))
        {
            return false;
        }
        try
        {
            value = s_strictUtf8.GetString(bytes);
            return value.Length <= maximum;
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
    }

    private static void WriteExportSelector(ref BinaryPodWriter writer, DocumentExportSourceSelector value)
    {
        writer.WriteInt32(value.Kind);
        writer.WriteInt32(value.ArticleId);
        WriteExportSelectorTail(ref writer, value.DraftKey, value.RevisionId, value.PublicationId);
    }

    private static void WriteExportSelectorTail(ref BinaryPodWriter writer, string? draft, long? revision, long? publication)
    {
        writer.WriteByte(draft is null ? (byte)0 : (byte)1);
        if (draft is not null)
        {
            WriteDocumentExportText(ref writer, draft);
        }
        WriteDocumentExportOptionalLong(ref writer, revision);
        WriteDocumentExportOptionalLong(ref writer, publication);
    }

    private static bool ReadExportSelector(ref BinaryPodReader reader, out DocumentExportSourceSelector value)
    {
        value = null!;
        if (!reader.TryReadInt32(out int kind) || !reader.TryReadInt32(out int articleId)
            || !ReadExportSelectorTail(ref reader, out string? draft, out long? revision, out long? publication))
        {
            return false;
        }
        value = new(kind, articleId, draft, revision, publication);
        return ValidExportSelector(value);
    }

    private static bool ReadExportSelectorTail(ref BinaryPodReader reader, out string? draft, out long? revision, out long? publication)
    {
        draft = null;
        revision = null;
        publication = null;
        if (!TryReadDocumentExportBoolean(ref reader, out bool hasDraft))
        {
            return false;
        }
        if (hasDraft)
        {
            if (!ReadExportOptionsText(ref reader, DocumentExportSourceOptionsLimits.MaximumDraftKeyUtf16, out string text))
            {
                return false;
            }
            draft = text;
        }
        return TryReadDocumentExportOptionalLong(ref reader, out revision)
            && TryReadDocumentExportOptionalLong(ref reader, out publication);
    }
}
