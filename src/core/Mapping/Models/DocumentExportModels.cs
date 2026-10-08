namespace FsusBlog.Core.Mapping.Models;

/// <summary>Exact source coordinate supplied to the server's existing freeze authority.</summary>
public readonly record struct DocumentExportSourceCoreModel(
    int Kind,
    long ArticleId,
    string? DraftKey,
    long? RevisionId,
    long? PublicationId,
    long SourceVersion);

/// <summary>
/// Closed admission intent. Identity, source bytes, provider/renderer selection,
/// task allocation and receipts are supplied only by existing server authorities.
/// </summary>
public sealed record DocumentExportRequestCoreModel(
    string RequestId,
    string IdempotencyKey,
    DocumentExportSourceCoreModel Source,
    string FormatId,
    string LayoutProfile,
    string ThemeProfile,
    string Locale);

/// <summary>Opaque task identity; the authenticated server determines the operation.</summary>
public readonly record struct DocumentExportTaskRequestCoreModel(string TaskId);

/// <summary>Display projection of an actual durable attempt, not a lifecycle authority.</summary>
public readonly record struct DocumentExportAttemptCoreModel(
    int Number,
    bool Diagnostic,
    long StartedAtUnixMs,
    long? FinishedAtUnixMs,
    int Status,
    string Reason);

/// <summary>
/// Display projection of canonical output custody. It excludes object paths,
/// owner/session identities, filenames and download capabilities.
/// </summary>
public sealed record DocumentExportOutputCoreModel(
    string OutputId,
    string MediaType,
    string Extension,
    string OutputDigest,
    string ResultReceiptDigest,
    long Length,
    long CreatedAtUnixMs,
    long ExpiresAtUnixMs,
    long? DeletedAtUnixMs);

/// <summary>
/// Source-free display facts from the sole IDocumentExportJobs snapshot.
/// Missing warnings and filenames remain unavailable; this DTO creates neither.
/// </summary>
public sealed record DocumentExportJobResponseCoreModel(
    string TaskId,
    string RequestId,
    DocumentExportSourceCoreModel Source,
    string InputDigest,
    string TaskDigest,
    string FormatId,
    string ProviderId,
    string ProviderVersion,
    string LayoutProfile,
    string ThemeProfile,
    string Locale,
    int Status,
    long Version,
    long CreatedAtUnixMs,
    long ExpiresAtUnixMs,
    string Reason,
    IReadOnlyList<DocumentExportAttemptCoreModel> Attempts,
    DocumentExportOutputCoreModel? Output);

/// <summary>One bounded page derived from the authority's authorized list.</summary>
public sealed record DocumentExportPageResponseCoreModel(
    int Offset,
    int Limit,
    bool HasMore,
    IReadOnlyList<DocumentExportJobResponseCoreModel> Jobs);
