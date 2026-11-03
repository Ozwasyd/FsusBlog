namespace FsusBlog.Shared.Contracts.DocumentExport;

/// <summary>Unbound source selectors for the catalog's authorized, transactional CaptureAsync operation.</summary>
public sealed record DocumentExportSourceCaptureRequest(IReadOnlyList<DocumentExportSourceSelector> Sources);

/// <summary>Current authorized revision choices; this request creates persisted bindings and requires a write boundary.</summary>
public readonly record struct DocumentExportRevisionChoicesRequest(int ArticleId);

/// <summary>Source selection before a server-owned SourceVersion exists; article identity matches the catalog's Int32 input.</summary>
public sealed record DocumentExportSourceSelector(
    int Kind, int ArticleId, string? DraftKey, long? RevisionId, long? PublicationId);

/// <summary>Exact persisted source coordinate, including its independent Int64 binding version.</summary>
public sealed record DocumentExportSourceCoordinate(
    int Kind, long ArticleId, string? DraftKey, long? RevisionId, long? PublicationId, long SourceVersion);

/// <summary>Public display projection only. Source content, rights, fingerprints and actor/session bindings remain private.</summary>
public sealed record DocumentExportSourceChoiceResponse(
    string ChoiceId, string Label, DocumentExportSourceCoordinate Coordinate);

/// <summary>At most fifty choices; this is independent of job/page projections and the private 512-binding scope cap.</summary>
public sealed record DocumentExportSourceChoicesResponse(IReadOnlyList<DocumentExportSourceChoiceResponse> Choices);

/// <summary>Bounded wire admission; label and draft lengths originate in the actual persisted source columns.</summary>
public static class DocumentExportSourceOptionsLimits
{
    public const int MaximumChoices = 50;
    public const int ChoiceIdLength = 64;
    public const int MaximumDraftKeyUtf16 = 96;
    public const int MaximumLabelUtf16 = 256;
    public const int CaptureFrameBytes = 64 * 1024;
    public const int CapturePayloadBytes = CaptureFrameBytes - 16;
    public const int RevisionChoicesFrameBytes = 1024;
    public const int RevisionChoicesPayloadBytes = RevisionChoicesFrameBytes - 16;
    public const int ChoicesPayloadBytes = 128 * 1024;
    public const int ChoicesFrameBytes = ChoicesPayloadBytes + 16;
}
