using System.Collections.Immutable;

namespace FsusBlog.Server.Services.DocumentExport.Jobs;

/// <summary>
/// Authenticated request identity supplied by the existing session/site adapter.
/// It is never populated from a public request body or provider input.
/// </summary>
public sealed record DocumentExportJobActor(long UserId, long SiteId, string SessionId);

public enum DocumentExportJobOperation
{
    Create = 1,
    Read = 2,
    Cancel = 3,
    Retry = 4,
    Download = 5,
    Delete = 6
}

/// <summary>
/// Adapter to the canonical identity/site/article permission authority. Recheck
/// current permission on admission, execution, commit and every delivery access.
/// No permissive default implementation is provided.
/// </summary>
public interface IDocumentExportJobAuthorization
{
    ValueTask<bool> IsAllowedAsync(
        DocumentExportJobActor actor,
        DocumentExportArticleCoordinate coordinate,
        DocumentExportJobOperation operation,
        CancellationToken cancellationToken);
}

/// <summary>
/// A format owner's adapter to its existing sandbox and independent result
/// verifier. Implementations must verify actual artifacts, tool/build identity
/// and the canonical sandbox receipt; digest validation alone is insufficient.
/// This interface registers no providers and launches no second sandbox.
/// </summary>
public interface IDocumentExportJobProvider
{
    string ProviderId
    {
        get;
    }

    Task<DocumentExportProviderResult> ExportAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        CancellationToken cancellationToken);

    Task VerifyAsync(
        DocumentExportProviderResult result,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        CancellationToken cancellationToken);
}

/// <summary>
/// Closed, sealed custody record. Object identity is opaque and unique per job;
/// equal content digests never merge permissions or retention across owners.
/// No path, plaintext grant or private source is exposed to consumers.
/// </summary>
public sealed record DocumentExportOutputRecord(
    string Schema,
    string OutputId,
    string TaskId,
    long UserId,
    long SiteId,
    string InputDigest,
    string ProviderId,
    string ProviderVersion,
    string ResultReceiptDigest,
    string ObjectId,
    string MediaType,
    string Extension,
    string OutputDigest,
    long Length,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? DeletedAt,
    string ContentDigest);

public sealed record DocumentExportJobAttempt(
    int Number,
    bool Diagnostic,
    DateTimeOffset StartedAt,
    DateTimeOffset? FinishedAt,
    DocumentExportTaskStatus Status,
    string Reason);

/// <summary>
/// Source-free projection for authenticated API/UI consumers. The exact frozen
/// identity and attempt history remain stable through status transitions/retry.
/// A diagnostic retry can never produce a downloadable success.
/// </summary>
public sealed record DocumentExportJobSnapshot(
    string Schema,
    DocumentExportTask Task,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    ImmutableArray<DocumentExportJobAttempt> Attempts,
    DocumentExportOutputRecord? Output,
    string Reason,
    long Version);

/// <summary>
/// Opaque single-use download capability returned once to the authorized API.
/// Transport only in a protected POST body/header; never a URL or log field.
/// </summary>
public sealed record DocumentExportDownloadGrant(string Token, DateTimeOffset ExpiresAt);

/// <summary>
/// Authorized bounded byte snapshot. GET consumes a single-use grant before
/// delivery; HEAD checks it without consumption. Range is explicitly disabled.
/// Apply all headers on the dedicated authenticated route with no SPA fallback.
/// </summary>
public sealed record DocumentExportDownload(
    byte[] Bytes,
    long ContentLength,
    ImmutableDictionary<string, string> Headers);

public sealed record DocumentExportJobUsage(int Jobs, int Outputs, long OutputBytes, int CleanupRequired);

/// <summary>
/// Bounded private audit facts contain opaque identities and fixed reasons, never
/// source text, storage paths, session IDs or plaintext capability tokens.
/// </summary>
public sealed record DocumentExportJobAuditEvent(string Kind, DateTimeOffset At,
    DocumentExportTaskStatus Status, string? OutputId, string? OutputDigest, long OutputBytes, string Reason);

/// <summary>
/// Recovery consults the original execution/process authority. Only an explicit
/// quiescence proof permits release of an interrupted worker; elapsed time or a
/// missing PID alone cannot admit retry or cleanup of its frozen input.
/// </summary>
public interface IDocumentExportJobRecovery
{
    Task<bool> IsQuiescentAsync(DocumentExportTask executionTask, CancellationToken cancellationToken);
}

/// <summary>
/// The sole durable job API for all catalog formats and authenticated consumers.
/// Worker execution is a separate internal capability, never a browser action.
/// </summary>
public interface IDocumentExportJobs
{
    Task<DocumentExportJobSnapshot> CreateAsync(DocumentExportJobActor actor, DocumentExportTask task,
        DocumentExportFrozenInput input, CancellationToken cancellationToken);
    Task<ImmutableArray<DocumentExportJobSnapshot>> ListAsync(DocumentExportJobActor actor, CancellationToken cancellationToken);
    Task<DocumentExportJobSnapshot> GetAsync(DocumentExportJobActor actor, string taskId, CancellationToken cancellationToken);
    Task<DocumentExportJobSnapshot> CancelAsync(DocumentExportJobActor actor, string taskId, CancellationToken cancellationToken);
    Task<DocumentExportJobSnapshot> RetryAsync(DocumentExportJobActor actor, string taskId, CancellationToken cancellationToken);
    Task DeleteAsync(DocumentExportJobActor actor, string taskId, CancellationToken cancellationToken);
    Task<DocumentExportDownloadGrant> GrantAsync(DocumentExportJobActor actor, string taskId, CancellationToken cancellationToken);
    Task<DocumentExportDownload> DownloadAsync(DocumentExportJobActor actor, string token, bool head, CancellationToken cancellationToken);
    Task RevokeSessionAsync(DocumentExportJobActor actor, CancellationToken cancellationToken);
}

/// <summary>
/// Uniform privacy-safe denial for missing, unauthorized, expired, altered and
/// already-consumed capabilities. Internal failures do not disclose paths.
/// </summary>
public sealed class DocumentExportJobDeniedException : Exception
{
    public DocumentExportJobDeniedException() : base("document_export_unavailable")
    {
    }
}
