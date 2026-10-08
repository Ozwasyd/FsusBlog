namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Defines the content-addressed operation and append-only checkpoint protocol.</summary>
public static class ArticleVaultOperationSchemas
{
    public const string Identity = "fsusblog.article-vault.operation-identity.v1";
    public const string Checkpoint = "fsusblog.article-vault.operation-checkpoint.v1";
    public const int Version = 1;
}

/// <summary>Describes operation progress independently of server execution success.</summary>
public enum VaultOperationState
{
    Planned,
    Validating,
    ExecutingServer,
    MaterializingLocal,
    RecoveryRequired,
    Cancelled,
    Failed,
    Synced,
    Blocked
}

/// <summary>Distinguishes an unattempted server stage from an uncertain committed outcome.</summary>
public enum VaultServerCommitDisposition
{
    NotStarted,
    Unknown,
    Accepted,
    Rejected
}

/// <summary>References exact immutable bytes; it never denotes a directory or latest result.</summary>
public sealed record VaultOperationStageReference(string Reference, string ContentSha256);

/// <summary>
/// Binds a request to the complete sealed plan, including its groups and base/local/server facts.
/// Request and idempotency values are digests so receipts do not retain watcher or credential payloads.
/// </summary>
public sealed record ArticleVaultOperationIdentity(
    string Schema,
    int SchemaVersion,
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    string AgentIdentity,
    string PlanReference,
    string PlanSha256,
    string RequestSha256,
    string IdempotencySha256,
    long DeadlineUnixMs,
    string OperationIdentity,
    string ContentSha256);

/// <summary>Records exact article base coordinates without retaining private source bytes.</summary>
public sealed record VaultOperationArticleOutcome(
    string PortableArticleIdentity,
    string BaseBeforeSha256,
    string BaseAfterSha256);

/// <summary>
/// Appends one hash-linked stage fact. An uncertain or accepted server stage requires recovery
/// rather than cancellation of history. Synced admission additionally requires materializer evidence.
/// </summary>
public sealed record ArticleVaultOperationCheckpoint(
    string Schema,
    int SchemaVersion,
    string OperationIdentity,
    string IdentitySha256,
    long Sequence,
    string? PreviousCheckpointSha256,
    long RecordedAtUnixMs,
    VaultOperationState State,
    VaultServerCommitDisposition ServerCommit,
    VaultOperationStageReference? ServerResult,
    VaultOperationStageReference? MaterializationReceipt,
    IReadOnlyList<VaultOperationArticleOutcome> Articles,
    bool CancellationRequested,
    string? ReasonCode,
    string ContentSha256);

/// <summary>
/// Persists immutable identities and checkpoints using expected predecessor comparison. Implementations
/// must serialize competing appends and replay identical retries without changing history.
/// </summary>
public interface IArticleVaultOperationCheckpointStore
{
    Task RegisterAsync(
        ArticleVaultOperationIdentity identity,
        ArticleVaultSyncPlan plan,
        CancellationToken cancellationToken = default);

    Task AppendAsync(
        ArticleVaultOperationIdentity identity,
        ArticleVaultSyncPlan plan,
        ArticleVaultOperationCheckpoint checkpoint,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<ArticleVaultOperationCheckpoint>> ReadThroughAsync(
        ArticleVaultOperationIdentity identity,
        ArticleVaultSyncPlan plan,
        long sequence,
        string checkpointSha256,
        CancellationToken cancellationToken = default);
}
