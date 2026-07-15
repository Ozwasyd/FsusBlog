namespace FsusBlog.Server.Models.Dtos;

public sealed record class AnonymousGovernanceStatusResponse(
    AnonymousGovernanceRootStatus Root,
    AnonymousGovernanceVerifierStatus Verifier,
    AnonymousGovernanceRevocationStatus Revocation,
    AnonymousGovernanceCommentStats CommentStats,
    IReadOnlyList<AnonymousGovernanceCredentialRow> Credentials);

public sealed record class AnonymousGovernanceRootStatus(
    bool Available,
    long? CredentialEpoch,
    string? RootHash,
    string? MaskedRootHash,
    string? CircuitId,
    string? VerifyingKeyHash,
    ushort? PublicInputLayoutVersion,
    DateTimeOffset? ExpiresAtUtc,
    DateTimeOffset? GraceExpiresAtUtc,
    string Status);

public sealed record class AnonymousGovernanceVerifierStatus(
    bool ZkAnonymousEnabled,
    bool Configured,
    string CircuitStatus,
    bool FailClosed);

public sealed record class AnonymousGovernanceRevocationStatus(
    string Status,
    string? RevocationRootHash,
    string? MaskedRevocationRootHash,
    int RevocationCount,
    DateTimeOffset? LatestRevokedAtUtc);

public sealed record class AnonymousGovernanceCommentStats(
    int TotalAnonymous,
    int PendingAnonymous,
    int ApprovedAnonymous,
    int RejectedAnonymous,
    int HiddenAnonymous,
    int ZkAnonymous,
    int LegacyServerVisiblePseudonymous);

public sealed record class AnonymousGovernanceCredentialRow(
    long Epoch,
    string RootHash,
    string MaskedRootHash,
    string RevocationRootHash,
    string MaskedRevocationRootHash,
    string Status,
    int RevocationCount,
    DateTimeOffset UpdatedAtUtc,
    DateTimeOffset ExpiresAtUtc,
    DateTimeOffset GraceExpiresAtUtc);

public sealed record class AnonymousGovernanceNullifierListResponse(
    IReadOnlyList<AnonymousGovernanceNullifierRow> Items);

public sealed record class AnonymousGovernanceNullifierRow(
    string Scope,
    string NullifierHash,
    string MaskedHash,
    string Status,
    int UseCount,
    long? FirstCommentId,
    long? LastCommentId,
    string? BlockReason,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset UpdatedAtUtc,
    IReadOnlyList<AnonymousGovernanceBlockHistoryItem> BlockHistory);

public sealed record class AnonymousGovernanceBlockHistoryItem(
    string Status,
    string? Reason,
    DateTimeOffset UpdatedAtUtc);

public sealed record class AnonymousGovernanceCredentialRevokeRequest(
    long Epoch,
    string RootHash,
    string RevocationHandleHash,
    string RevocationRootHash,
    string? Reason);
