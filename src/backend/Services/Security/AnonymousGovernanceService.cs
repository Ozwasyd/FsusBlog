using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IAnonymousGovernanceService
{
    Task<AnonymousGovernanceStatusResponse> GetStatusAsync(CancellationToken cancellationToken = default);

    Task<AnonymousGovernanceNullifierListResponse> ListNullifiersAsync(CancellationToken cancellationToken = default);

    Task<Result<AnonymousGovernanceActionResponse>> BlockNullifierAsync(
        AnonymousNullifierBlockRequest request,
        CancellationToken cancellationToken = default);

    Task<Result<AnonymousGovernanceActionResponse>> RevokeCredentialAsync(
        AnonymousGovernanceCredentialRevokeRequest request,
        string? actorId,
        CancellationToken cancellationToken = default);
}

public sealed class AnonymousGovernanceService(
    ISqlSugarClient db,
    IAnonymousCredentialRootService rootService,
    ICommentAnonymousNullifierService? nullifierService = null,
    IAnonymousCredentialRevocationService? revocationService = null) : IAnonymousGovernanceService
{
    private const int MaxNullifierRows = 100;
    private const int MaxRootRows = 20;

    public async Task<AnonymousGovernanceStatusResponse> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Result<AnonymousCredentialRootSnapshotCoreModel> rootResult = await rootService.GetCurrentSnapshotAsync(cancellationToken);
        AnonymousGovernanceRootStatus root = ToRootStatus(rootResult);

        List<AnonymousCredentialRoot> roots = await db.Queryable<AnonymousCredentialRoot>()
            .OrderBy(static item => item.Epoch, OrderByType.Desc)
            .Take(MaxRootRows)
            .ToListAsync(cancellationToken);
        List<AnonymousCredentialRevocation> revocations = await db.Queryable<AnonymousCredentialRevocation>()
            .OrderBy(static item => item.RevokedAtUtc, OrderByType.Desc)
            .Take(500)
            .ToListAsync(cancellationToken);

        AnonymousGovernanceCommentStats commentStats = await LoadCommentStatsAsync(cancellationToken);
        AnonymousGovernanceRevocationStatus revocation = ToRevocationStatus(rootResult, revocations);
        IReadOnlyList<AnonymousGovernanceCredentialRow> credentials = ToCredentialRows(roots, revocations);
        AnonymousGovernanceVerifierStatus verifier = ToVerifierStatus(rootResult);

        return new AnonymousGovernanceStatusResponse(root, verifier, revocation, commentStats, credentials);
    }

    public async Task<AnonymousGovernanceNullifierListResponse> ListNullifiersAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        List<CommentAnonymousNullifier> rows = await db.Queryable<CommentAnonymousNullifier>()
            .OrderBy(static item => item.Blocked, OrderByType.Desc)
            .OrderBy(static item => item.UpdatedAtUtc, OrderByType.Desc)
            .Take(MaxNullifierRows)
            .ToListAsync(cancellationToken);

        return new AnonymousGovernanceNullifierListResponse(
            [.. rows.Select(static item => new AnonymousGovernanceNullifierRow(
                Normalize(item.Scope),
                Normalize(item.NullifierHash),
                MaskHash(item.NullifierHash),
                item.Blocked ? "blocked" : item.UseCount > 0 ? "active" : "observed",
                Math.Max(0, item.UseCount),
                item.FirstCommentId,
                item.LastCommentId,
                TextHelpers.NormalizeNullable(item.BlockReason, 128),
                ToUtcOffset(item.CreatedAtUtc),
                ToUtcOffset(item.UpdatedAtUtc),
                item.Blocked
                    ? [new AnonymousGovernanceBlockHistoryItem("blocked", TextHelpers.NormalizeNullable(item.BlockReason, 128), ToUtcOffset(item.UpdatedAtUtc))]
                    : []))]);
    }

    public async Task<Result<AnonymousGovernanceActionResponse>> BlockNullifierAsync(
        AnonymousNullifierBlockRequest request,
        CancellationToken cancellationToken = default)
    {
        if (nullifierService is null)
        {
            return Result<AnonymousGovernanceActionResponse>.Failure(ErrorCode.InfraFailure, "anonymous_nullifier_service_unavailable");
        }

        string hash = Normalize(request.NullifierHash);
        string scope = Normalize(request.Scope);
        if (hash.Length == 0 || scope.Length == 0)
        {
            return Result<AnonymousGovernanceActionResponse>.Failure(ErrorCode.Validation, "anonymous_nullifier_block_request_invalid");
        }

        string reason = TextHelpers.NormalizeNullable(request.Reason, 128) ?? "blocked_by_admin";
        bool applied = await nullifierService.BlockAsync(hash, scope, reason, cancellationToken);
        return applied
            ? Result<AnonymousGovernanceActionResponse>.Success(new AnonymousGovernanceActionResponse(true))
            : Result<AnonymousGovernanceActionResponse>.Failure(ErrorCode.NotFound, "anonymous_nullifier_not_found");
    }

    public async Task<Result<AnonymousGovernanceActionResponse>> RevokeCredentialAsync(
        AnonymousGovernanceCredentialRevokeRequest request,
        string? actorId,
        CancellationToken cancellationToken = default)
    {
        if (revocationService is null)
        {
            return Result<AnonymousGovernanceActionResponse>.Failure(ErrorCode.InfraFailure, "anonymous_revocation_service_unavailable");
        }

        string rootHash = Normalize(request.RootHash);
        string handleHash = Normalize(request.RevocationHandleHash);
        string revocationRoot = Normalize(request.RevocationRootHash);
        if (request.Epoch <= 0 || rootHash.Length == 0 || handleHash.Length == 0 || revocationRoot.Length == 0)
        {
            return Result<AnonymousGovernanceActionResponse>.Failure(ErrorCode.Validation, "anonymous_credential_revoke_request_invalid");
        }

        Result result = await revocationService.RevokeAsync(
            new AnonymousCredentialRevocationRequest(
                request.Epoch,
                handleHash,
                revocationRoot,
                rootHash,
                TextHelpers.NormalizeNullable(request.Reason, 128),
                TextHelpers.NormalizeNullable(actorId, 128)),
            cancellationToken);
        return result.IsSuccess
            ? Result<AnonymousGovernanceActionResponse>.Success(new AnonymousGovernanceActionResponse(true))
            : Result<AnonymousGovernanceActionResponse>.Failure(result.Error);
    }

    private async Task<AnonymousGovernanceCommentStats> LoadCommentStatsAsync(CancellationToken cancellationToken)
    {
        ISugarQueryable<Comment> anonymous = db.Queryable<Comment>()
            .Where(static item => item.AuthorMode == CommentAuthorModes.ZkAnonymous);

        int total = await anonymous.CountAsync(cancellationToken);
        int pending = await anonymous.Clone().Where(static item => item.ModerationStatus == CommentModerationStatus.Pending).CountAsync(cancellationToken);
        int approved = await anonymous.Clone().Where(static item => item.ModerationStatus == CommentModerationStatus.Approved).CountAsync(cancellationToken);
        int rejected = await anonymous.Clone().Where(static item => item.ModerationStatus == CommentModerationStatus.Rejected).CountAsync(cancellationToken);
        int hidden = await anonymous.Clone().Where(static item => item.ModerationStatus == CommentModerationStatus.Hidden).CountAsync(cancellationToken);
        int zk = await anonymous.Clone().Where(static item => item.AuthorMode == CommentAuthorModes.ZkAnonymous).CountAsync(cancellationToken);
        int legacy = await db.Queryable<Comment>()
            .Where(static item => item.AuthorMode == CommentAuthorModes.LegacyServerVisiblePseudonymous)
            .CountAsync(cancellationToken);
        return new AnonymousGovernanceCommentStats(total, pending, approved, rejected, hidden, zk, legacy);
    }

    private static AnonymousGovernanceRootStatus ToRootStatus(Result<AnonymousCredentialRootSnapshotCoreModel> rootResult)
    {
        if (rootResult.IsFailure)
        {
            return new AnonymousGovernanceRootStatus(
                false,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                "unavailable");
        }

        AnonymousCredentialRootSnapshotCoreModel value = rootResult.Value;
        string rootHash = Convert.ToHexStringLower(value.CredentialRoot ?? []);
        return new AnonymousGovernanceRootStatus(
            true,
            value.CredentialEpoch,
            rootHash,
            MaskHash(rootHash),
            TextHelpers.NormalizeNullable(value.CircuitId, AnonymousCredentialIssuerLimits.MaxCircuitIdChars),
            TextHelpers.NormalizeNullable(value.VerifyingKeyHash, 128),
            value.PublicInputLayoutVersion,
            DateTimeOffset.FromUnixTimeMilliseconds(value.RootExpiresAtUnixMs),
            DateTimeOffset.FromUnixTimeMilliseconds(value.RootGraceExpiresAtUnixMs),
            "ready");
    }

    private static AnonymousGovernanceVerifierStatus ToVerifierStatus(Result<AnonymousCredentialRootSnapshotCoreModel> rootResult)
    {
        if (rootResult.IsFailure)
        {
            return new AnonymousGovernanceVerifierStatus(false, false, "root_unavailable", true);
        }

        AnonymousCredentialRootSnapshotCoreModel value = rootResult.Value;
        string status = value.ZkAnonymousEnabled && value.VerifierConfigured
            ? "configured"
            : value.ZkAnonymousEnabled
                ? "verifier_unavailable"
                : "zk_disabled";
        return new AnonymousGovernanceVerifierStatus(
            value.ZkAnonymousEnabled,
            value.VerifierConfigured,
            status,
            !value.ZkAnonymousEnabled || !value.VerifierConfigured);
    }

    private static AnonymousGovernanceRevocationStatus ToRevocationStatus(
        Result<AnonymousCredentialRootSnapshotCoreModel> rootResult,
        IReadOnlyList<AnonymousCredentialRevocation> revocations)
    {
        string? root = rootResult.IsSuccess
            ? Convert.ToHexStringLower(rootResult.Value.RevocationRoot ?? [])
            : null;
        DateTimeOffset? latest = revocations.Count == 0
            ? null
            : ToUtcOffset(revocations.Max(static item => item.RevokedAtUtc));
        return new AnonymousGovernanceRevocationStatus(
            string.IsNullOrWhiteSpace(root) ? "unavailable" : "ready",
            string.IsNullOrWhiteSpace(root) ? null : root,
            string.IsNullOrWhiteSpace(root) ? null : MaskHash(root),
            revocations.Count,
            latest);
    }

    private static IReadOnlyList<AnonymousGovernanceCredentialRow> ToCredentialRows(
        IReadOnlyList<AnonymousCredentialRoot> roots,
        IReadOnlyList<AnonymousCredentialRevocation> revocations)
    {
        Dictionary<string, int> revocationCounts = revocations
            .GroupBy(static item => string.Concat(item.Epoch.ToString(System.Globalization.CultureInfo.InvariantCulture), "\n", item.RootHash.Trim()))
            .ToDictionary(static group => group.Key, static group => group.Count(), StringComparer.Ordinal);

        return [.. roots.Select(root =>
        {
            string rootHash = Normalize(root.RootHash);
            string revocationRoot = Normalize(root.RevocationRootHash);
            revocationCounts.TryGetValue(string.Concat(root.Epoch.ToString(System.Globalization.CultureInfo.InvariantCulture), "\n", rootHash), out int count);
            return new AnonymousGovernanceCredentialRow(
                root.Epoch,
                rootHash,
                MaskHash(rootHash),
                revocationRoot,
                MaskHash(revocationRoot),
                Normalize(root.Status),
                count,
                ToUtcOffset(root.UpdatedAtUtc),
                ToUtcOffset(root.ExpiresAtUtc),
                ToUtcOffset(root.GraceExpiresAtUtc));
        })];
    }

    private static string Normalize(string? value)
        => string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();

    private static string MaskHash(string? value)
    {
        string normalized = Normalize(value);
        if (normalized.Length <= 16)
        {
            return normalized;
        }

        return string.Concat(normalized.AsSpan(0, 8), "...", normalized.AsSpan(normalized.Length - 8, 8));
    }

    private static DateTimeOffset ToUtcOffset(DateTime value)
    {
        DateTime utc = value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };
        return new DateTimeOffset(utc);
    }
}
