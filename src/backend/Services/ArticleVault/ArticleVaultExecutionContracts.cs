using FsusBlog.Core.Mapping.Models;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

public static class ArticleVaultExecutionSchemas
{
    public const string Payload = "fsusblog.article-vault.execution-payload.v1";
    public const string Bundle = "fsusblog.article-vault.sealed-execution-bundle.v1";
    public const string OperationReceipt = "fsusblog.article-vault.operation-result.v1";
    public const string GroupReceipt = "fsusblog.article-vault.group-result.v1";
    public const string Result = "fsusblog.article-vault.execution-result.v1";
    public const int Version = 1;
}

public enum ArticleVaultOperationOutcome
{
    Executed,
    NoOp,
    Failed
}

public enum ArticleVaultExecutionOutcome
{
    Completed,
    NoOp,
    Failed,
    Cancelled
}

/// <summary>
/// Contains only locally editable article facts. Lifecycle, publication, rights and owner fields are
/// deliberately absent and are resolved by the server authority at execution time.
/// </summary>
public sealed record ArticleVaultExecutionPayloadItem(
    string OperationIdentity,
    string PortableArticleIdentity,
    string? ServerArticleIdentity,
    string Title,
    string Content,
    string? Summary,
    string? CoverImageUrl,
    int CategoryId,
    IReadOnlyList<int> TagIds,
    string SourceSha256,
    string MetadataManifestSha256,
    string ContentSha256);

public sealed record ArticleVaultExecutionPayload(
    string Schema,
    int SchemaVersion,
    IReadOnlyList<ArticleVaultExecutionPayloadItem> Items,
    string ContentSha256);

/// <summary>A server-owned immutable plan and payload snapshot.</summary>
public sealed record ArticleVaultSealedExecutionBundle(
    string Schema,
    int SchemaVersion,
    string PlanReference,
    string PlanSha256,
    long AdminPrincipalId,
    ArticleVaultSyncPlan Plan,
    ArticleVaultRootManifest RootManifest,
    IReadOnlyList<ArticleVaultArticleManifest> ArticleManifests,
    IReadOnlyList<ArticleVaultServerObservation> PlannedObservations,
    ArticleVaultExecutionPayload Payload,
    string ContentSha256);

public sealed record ArticleVaultCurrentArticleObservation(
    string PortableArticleIdentity,
    string? ServerArticleIdentity,
    long? ServerRevision,
    string? Lifecycle,
    bool Permitted,
    string? PermissionSha256,
    string? DependencySha256,
    string PublicationBoundarySha256,
    string RightsBoundarySha256,
    string? SourceSha256,
    string ContentSha256);

/// <summary>
/// A command resolved by the canonical server authority. Update/move requests must preserve the
/// observed lifecycle and rights; create requests are always server-policy Draft.
/// </summary>
public sealed record ArticleVaultCanonicalMutationCommand(
    string OperationIdentity,
    VaultSyncDecision Decision,
    int? ArticleId,
    ArticleWriteRequestCoreModel? WriteRequest,
    string ContentSha256);

public sealed record ArticleVaultCanonicalMutationReceipt(
    string OperationIdentity,
    int? ArticleId,
    long? BeforeRevision,
    long? AfterRevision,
    string WriterReference,
    string? OutboxReference,
    string? AuditReference,
    ArticleVaultOperationOutcome Outcome,
    string? ReasonCode,
    string ContentSha256);

public sealed record ArticleVaultOperationResultReceipt(
    string Schema,
    int SchemaVersion,
    string SiteIdentity,
    string VaultIdentity,
    string PlanSha256,
    string GroupIdentity,
    string OperationIdentity,
    string PortableArticleIdentity,
    VaultSyncDecision Decision,
    ArticleVaultOperationOutcome Outcome,
    int? ArticleId,
    long? BeforeRevision,
    long? AfterRevision,
    string WriterReference,
    string? OutboxReference,
    string? AuditReference,
    IReadOnlyList<string> DependencyOperationIdentities,
    IReadOnlyList<string> DependencyOutcomeSha256s,
    string IdempotencySha256,
    string? ArticleContentSha256,
    string? ReasonCode,
    string ContentSha256);

public sealed record ArticleVaultGroupResultReceipt(
    string Schema,
    int SchemaVersion,
    string SiteIdentity,
    string VaultIdentity,
    string PlanSha256,
    string GroupIdentity,
    string IdempotencySha256,
    bool Committed,
    IReadOnlyList<ArticleVaultOperationResultReceipt> Operations,
    string? ReasonCode,
    string ContentSha256);

public sealed record ArticleVaultExecutionResult(
    string Schema,
    int SchemaVersion,
    string ResultReference,
    string SiteIdentity,
    string VaultIdentity,
    string PlanReference,
    string PlanSha256,
    string IdempotencyKey,
    ArticleVaultExecutionOutcome Outcome,
    IReadOnlyList<ArticleVaultGroupResultReceipt> Groups,
    string? ReasonCode,
    long CompletedAtUnixMs,
    string ContentSha256);

public interface IArticleVaultExecutionStore
{
    Task SealAsync(ArticleVaultSealedExecutionBundle bundle, CancellationToken cancellationToken = default);

    Task<ArticleVaultSealedExecutionBundle?> LoadSealedAsync(
        string planReference,
        string planSha256,
        CancellationToken cancellationToken = default);

    Task<ArticleVaultGroupResultReceipt?> LoadGroupResultAsync(
        string siteIdentity,
        string vaultIdentity,
        string planSha256,
        string groupIdentity,
        string idempotencySha256,
        CancellationToken cancellationToken = default);

    Task<ArticleVaultExecutionResult?> LoadResultAsync(
        string resultReference,
        CancellationToken cancellationToken = default);

    Task SaveResultAsync(ArticleVaultExecutionResult result, CancellationToken cancellationToken = default);
}

/// <summary>The caller must invoke this port from the canonical writer's open group transaction.</summary>
public interface IArticleVaultTransactionalGroupResultStore
{
    Task SaveGroupResultAsync(
        ArticleVaultGroupResultReceipt result,
        CancellationToken cancellationToken = default);
}

public interface IArticleVaultCurrentObservationAuthority
{
    Task<IReadOnlyList<ArticleVaultCurrentArticleObservation>> ObserveGroupAsync(
        ArticleVaultSealedExecutionBundle bundle,
        VaultSyncPlanGroup group,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// The implementation is the canonical article writer. It must re-observe and compare every item,
/// mutate the whole group, write outbox/audit records and persist the group receipt in one database
/// transaction.
/// </summary>
public interface IArticleVaultCanonicalGroupWriter
{
    Task<ArticleVaultGroupResultReceipt> ExecuteGroupAsync(
        ArticleVaultSealedExecutionBundle bundle,
        VaultSyncPlanGroup group,
        IReadOnlyList<ArticleVaultCurrentArticleObservation> expectedCurrent,
        CancellationToken cancellationToken = default);
}

public sealed class ArticleVaultExecutionRejectedException(string reasonCode) : Exception(reasonCode)
{
    public string ReasonCode { get; } = reasonCode;
}
