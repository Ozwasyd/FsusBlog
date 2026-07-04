namespace FsusBlog.Server.Infrastructure.Integrity;

public sealed record IntegrityAdminConsoleQuery(
    int? ArticleId,
    long? ArticleRevisionId,
    int? RevisionNo,
    int Limit = 20);

public sealed record IntegrityAdminConsoleResponse(
    DateTimeOffset CheckedAtUtc,
    IntegrityAdminProofSummaryResponse Proofs,
    IntegrityAdminTransparencyLogStatusResponse TransparencyLog,
    IntegrityAdminCheckpointStatusResponse Checkpoint,
    IntegrityAdminKeyRegistryResponse KeyRegistry,
    IReadOnlyList<IntegrityAdminProofRowResponse> RecentProofs,
    IReadOnlyList<IntegrityAdminProofRowResponse> FailedOrRetryingProofs);

public sealed record IntegrityAdminProofSummaryResponse(
    int Total,
    int Pending,
    int Ready,
    int Failed,
    int Retrying,
    int Superseded,
    int NotPublic);

public sealed record IntegrityAdminTransparencyLogStatusResponse(
    string Status,
    long? HeadSeq,
    string? HeadHash,
    string? ErrorCode,
    long? FailedSeq);

public sealed record IntegrityAdminCheckpointStatusResponse(
    string Status,
    string? CheckpointKind,
    string? ScopeKey,
    long? LogHeadSeq,
    string? LogHeadHash,
    DateTimeOffset? CreatedAtUtc);

public sealed record IntegrityAdminKeyRegistryResponse(
    string? CurrentKeyId,
    IReadOnlyList<IntegrityAdminKeyStatusResponse> Keys);

public sealed record IntegrityAdminKeyStatusResponse(
    string KeyId,
    int? Version,
    string Algorithm,
    string Status,
    string? RevokedAtUtc,
    string? CompromisedAtUtc);

public sealed record IntegrityAdminProofRowResponse(
    long ProofId,
    int ArticleId,
    long ArticleRevisionId,
    int RevisionNo,
    string ProofStatus,
    string ArtifactStatus,
    string SignatureStatus,
    string TransparencyLogStatus,
    string CheckpointStatus,
    string? CanonicalHash,
    string? SigningKeyId,
    string? FailureCode,
    bool RetryAvailable,
    DateTimeOffset PublishedAtUtc,
    DateTimeOffset UpdatedAtUtc);

public sealed record IntegrityAdminRetryResponse(
    long ProofId,
    string ProofStatus,
    DateTimeOffset RetriedAtUtc);

public interface IIntegrityAdminConsoleService
{
    Task<IntegrityAdminConsoleResponse> GetConsoleAsync(
        IntegrityAdminConsoleQuery query,
        CancellationToken cancellationToken);

    Task<IntegrityAdminRetryResponse> RetryProofAsync(long proofId, CancellationToken cancellationToken);
}

public static class IntegrityAdminKeyStatuses
{
    public const string Active = "active";
    public const string Old = "old";
    public const string Revoked = "revoked";
    public const string Compromised = "compromised";
}
