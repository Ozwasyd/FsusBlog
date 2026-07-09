using System.Globalization;
using FsusBlog.Core.Common;
using FsusBlog.Core.Integrity;
using FsusBlog.Server.Entities;
using Microsoft.Extensions.Configuration;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Integrity;

public sealed class IntegrityAdminConsoleService(
    ISqlSugarClient db,
    IConfiguration configuration) : IIntegrityAdminConsoleService
{
    private const int DefaultLimit = 20;
    private const int MaxLimit = 100;

    public async Task<IntegrityAdminConsoleResponse> GetConsoleAsync(
        IntegrityAdminConsoleQuery query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        int limit = Math.Clamp(query.Limit <= 0 ? DefaultLimit : query.Limit, 1, MaxLimit);
        IntegrityAdminKeyRegistryResponse keyRegistry = BuildKeyRegistry(configuration);
        IntegrityAdminTransparencyLogStatusResponse logStatus = await BuildTransparencyLogStatusAsync(cancellationToken)
            .ConfigureAwait(false);
        IntegrityAdminCheckpointStatusResponse checkpoint = await BuildCheckpointStatusAsync(logStatus, cancellationToken)
            .ConfigureAwait(false);
        List<ArticlePublishProof> proofs = await BuildProofQuery(query)
            .OrderByDescending(item => item.UpdatedAt)
            .OrderByDescending(item => item.Id)
            .Take(limit)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        List<ArticlePublishProof> failedOrRetrying = await BuildProofQuery(query)
            .Where(item => item.ProofStatus == "failed" || item.ProofStatus == "retrying")
            .OrderByDescending(item => item.UpdatedAt)
            .OrderByDescending(item => item.Id)
            .Take(limit)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        return new IntegrityAdminConsoleResponse(
            CheckedAtUtc: DateTimeOffset.UtcNow,
            Proofs: await BuildProofSummaryAsync(query, cancellationToken).ConfigureAwait(false),
            TransparencyLog: logStatus,
            Checkpoint: checkpoint,
            KeyRegistry: keyRegistry,
            RecentProofs: proofs.Select(proof => BuildProofRow(proof, keyRegistry, checkpoint)).ToArray(),
            FailedOrRetryingProofs: failedOrRetrying.Select(proof => BuildProofRow(proof, keyRegistry, checkpoint)).ToArray());
    }

    public async Task<IntegrityAdminRetryResponse> RetryProofAsync(long proofId, CancellationToken cancellationToken)
    {
        if (proofId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(proofId), proofId, "Proof id must be positive.");
        }

        ArticlePublishProof? proof = await db.Queryable<ArticlePublishProof>()
            .Where(item => item.Id == proofId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        if (proof is null)
        {
            throw new KeyNotFoundException("Publish proof not found.");
        }

        string current = NormalizeProofStatus(proof.ProofStatus);
        if (current is not ("failed" or "retrying" or "pending"))
        {
            throw new InvalidOperationException("Only failed, retrying or pending proofs can be retried.");
        }

        DateTime retriedAt = DateTime.UtcNow;
        int updated = await db.Updateable<ArticlePublishProof>()
            .SetColumns(item => item.ProofStatus == "retrying")
            .SetColumns(item => item.FailureCode == null)
            .SetColumns(item => item.FailureDetail == null)
            .SetColumns(item => item.UpdatedAt == retriedAt)
            .Where(item => item.Id == proofId)
            .ExecuteCommandAsync(cancellationToken)
            .ConfigureAwait(false);
        if (updated <= 0)
        {
            throw new InvalidOperationException("Publish proof retry update failed.");
        }

        return new IntegrityAdminRetryResponse(
            ProofId: proofId,
            ProofStatus: "retrying",
            RetriedAtUtc: new DateTimeOffset(retriedAt, TimeSpan.Zero));
    }

    private ISugarQueryable<ArticlePublishProof> BuildProofQuery(IntegrityAdminConsoleQuery query)
    {
        ISugarQueryable<ArticlePublishProof> proofs = db.Queryable<ArticlePublishProof>();
        if (query.ArticleId.HasValue)
        {
            int articleId = query.ArticleId.Value;
            proofs = proofs.Where(item => item.ArticleId == articleId);
        }

        if (query.ArticleRevisionId.HasValue)
        {
            long revisionId = query.ArticleRevisionId.Value;
            proofs = proofs.Where(item => item.ArticleRevisionId == revisionId);
        }

        if (query.RevisionNo.HasValue)
        {
            int revisionNo = query.RevisionNo.Value;
            proofs = proofs.Where(item => item.RevisionNo == revisionNo);
        }

        return proofs;
    }

    private async Task<IntegrityAdminProofSummaryResponse> BuildProofSummaryAsync(
        IntegrityAdminConsoleQuery query,
        CancellationToken cancellationToken)
    {
        List<ArticlePublishProof> proofs = await BuildProofQuery(query)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        return new IntegrityAdminProofSummaryResponse(
            Total: proofs.Count,
            Pending: Count(proofs, "pending"),
            Ready: Count(proofs, "ready"),
            Failed: Count(proofs, "failed"),
            Retrying: Count(proofs, "retrying"),
            Superseded: Count(proofs, "superseded"),
            NotPublic: Count(proofs, "not-public"));
    }

    private static int Count(IEnumerable<ArticlePublishProof> proofs, string status)
        => proofs.Count(proof => NormalizeProofStatus(proof.ProofStatus) == status);

    private async Task<IntegrityAdminTransparencyLogStatusResponse> BuildTransparencyLogStatusAsync(
        CancellationToken cancellationToken)
    {
        List<IntegrityTransparencyLogEntry> entries = await db.Queryable<IntegrityTransparencyLogEntry>()
            .OrderBy(item => item.Seq)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (entries.Count == 0)
        {
            return new IntegrityAdminTransparencyLogStatusResponse("missing", null, null, null, null);
        }

        IntegrityTransparencyLogEntry head = entries[^1];
        TransparencyLogVerificationResult result = TransparencyLogChainVerifier.Verify(entries.Select(ToRecord));
        return result.IsValid
            ? new IntegrityAdminTransparencyLogStatusResponse("ready", head.Seq, Hash(head.EntryHash), null, null)
            : new IntegrityAdminTransparencyLogStatusResponse(
                "chain-broken",
                head.Seq,
                Hash(head.EntryHash),
                result.ErrorCode,
                result.FailedSeq);
    }

    private async Task<IntegrityAdminCheckpointStatusResponse> BuildCheckpointStatusAsync(
        IntegrityAdminTransparencyLogStatusResponse logStatus,
        CancellationToken cancellationToken)
    {
        IntegrityMerkleCheckpoint? checkpoint = await db.Queryable<IntegrityMerkleCheckpoint>()
            .OrderByDescending(item => item.CreatedAt)
            .OrderByDescending(item => item.Id)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        if (checkpoint is null)
        {
            return new IntegrityAdminCheckpointStatusResponse("missing", null, null, null, null, null);
        }

        string status = logStatus.Status == "chain-broken"
            ? "blocked"
            : logStatus.HeadSeq.HasValue && checkpoint.LogHeadSeq < logStatus.HeadSeq.Value
                ? "stale"
                : "ready";
        return new IntegrityAdminCheckpointStatusResponse(
            Status: status,
            CheckpointKind: checkpoint.CheckpointKind,
            ScopeKey: checkpoint.ScopeKey,
            LogHeadSeq: checkpoint.LogHeadSeq,
            LogHeadHash: Hash(checkpoint.LogHeadHash),
            CreatedAtUtc: Utc(checkpoint.CreatedAt));
    }

    private IntegrityAdminProofRowResponse BuildProofRow(
        ArticlePublishProof proof,
        IntegrityAdminKeyRegistryResponse keyRegistry,
        IntegrityAdminCheckpointStatusResponse checkpoint)
    {
        string proofStatus = NormalizeProofStatus(proof.ProofStatus);
        return new IntegrityAdminProofRowResponse(
            ProofId: proof.Id,
            ArticleId: proof.ArticleId,
            ArticleRevisionId: proof.ArticleRevisionId,
            RevisionNo: proof.RevisionNo,
            ProofStatus: proofStatus,
            ArtifactStatus: BuildArtifactStatus(proof, proofStatus),
            SignatureStatus: BuildSignatureStatus(proof, proofStatus, keyRegistry),
            TransparencyLogStatus: BuildProofLogStatus(proof, proofStatus),
            CheckpointStatus: checkpoint.Status,
            CanonicalHash: CanExposeProofPayload(proofStatus) ? Hash(proof.CanonicalHash) : null,
            SigningKeyId: string.IsNullOrWhiteSpace(proof.SigningKeyId) ? null : proof.SigningKeyId.Trim(),
            FailureCode: string.IsNullOrWhiteSpace(proof.FailureCode) ? null : proof.FailureCode.Trim(),
            RetryAvailable: proofStatus is "failed" or "retrying" or "pending",
            PublishedAtUtc: Utc(proof.PublishedAt),
            UpdatedAtUtc: Utc(proof.UpdatedAt));
    }

    private static string BuildArtifactStatus(ArticlePublishProof proof, string proofStatus)
    {
        if (proofStatus == "not-public")
        {
            return "not-public";
        }

        string[] hashes =
        [
            proof.CanonicalHash,
            proof.AotHash,
            proof.ArticleDetailAedsHash,
            proof.PublicHotReadHash,
            proof.AssetManifestHash,
            proof.FeedHash
        ];
        return hashes.All(IsSha256Like) ? "ready" : "missing";
    }

    private static string BuildProofLogStatus(ArticlePublishProof proof, string proofStatus)
    {
        if (!CanExposeProofPayload(proofStatus))
        {
            return proofStatus;
        }

        return proof.TransparencyLogEntryId.HasValue && IsSha256Like(proof.TransparencyLogEntryHash)
            ? "logged"
            : "missing";
    }

    private string BuildSignatureStatus(
        ArticlePublishProof proof,
        string proofStatus,
        IntegrityAdminKeyRegistryResponse keyRegistry)
    {
        if (!CanExposeProofPayload(proofStatus))
        {
            return proofStatus;
        }

        if (string.IsNullOrWhiteSpace(proof.SigningKeyId) || string.IsNullOrWhiteSpace(proof.SignatureBase64Url))
        {
            return "signature-missing";
        }

        IntegrityAdminKeyStatusResponse? key = keyRegistry.Keys
            .FirstOrDefault(item => string.Equals(item.KeyId, proof.SigningKeyId, StringComparison.Ordinal));
        if (key is null)
        {
            return "key-missing";
        }

        if (key.Status is IntegrityAdminKeyStatuses.Revoked)
        {
            return "key-revoked";
        }

        if (key.Status is IntegrityAdminKeyStatuses.Compromised)
        {
            return "key-compromised";
        }

        try
        {
            SiteSigningKeyRegistry registry = SiteSigningKeyRegistry.Create(
                keyRegistry.Keys
                    .Where(item => item.KeyId == proof.SigningKeyId)
                    .Select(item => new SiteSigningKeyRecord(
                        item.KeyId,
                        item.Version ?? 1,
                        item.Algorithm,
                        DateTimeOffset.UnixEpoch,
                        null,
                        null,
                        null,
                        ResolvePublicKey(configuration, item.KeyId) ?? string.Empty,
                        null)),
                proof.SigningKeyId);
            var verifier = new SiteIntegritySigningService(registry);
            SiteIntegritySigningPayload payload = PublishProofCanonicalPayloadV1.BuildSigningPayload(BuildReadyProofInput(proof));
            SiteIntegritySignature signature = new(
                proof.SigningKeyId,
                proof.SigningKeyVersion ?? key.Version ?? 1,
                proof.SigningAlgorithm ?? key.Algorithm,
                proof.SignatureBase64Url,
                Utc(proof.PublishedAt));
            SiteIntegritySignatureVerificationResult result = verifier.Verify(payload, signature);
            return result.Accepted
                ? "signature-valid"
                : result.Code switch
                {
                    "key-revoked" => "key-revoked",
                    "key-compromised" => "key-compromised",
                    _ => "signature-invalid"
                };
        }
        catch (Exception) when (proofStatus is "ready" or "superseded")
        {
            return "signature-invalid";
        }
    }

    private static IntegrityAdminKeyRegistryResponse BuildKeyRegistry(IConfiguration configuration)
    {
        IConfigurationSection signing = configuration.GetSection(SiteIntegritySigningStartupPolicy.SectionName);
        string? currentKeyId = EmptyToNull(signing["CurrentKeyId"]);
        List<IntegrityAdminKeyStatusResponse> keys = [];
        foreach (IConfigurationSection keySection in signing.GetSection("Keys").GetChildren())
        {
            string keyId = keySection.Key.Trim();
            if (keyId.Length == 0)
            {
                continue;
            }

            string? revokedAt = EmptyToNull(keySection["RevokedAtUtc"]);
            string? compromisedAt = EmptyToNull(keySection["CompromisedAtUtc"]);
            keys.Add(new IntegrityAdminKeyStatusResponse(
                KeyId: keyId,
                Version: ParseNullableInt(keySection["Version"]),
                Algorithm: EmptyToNull(keySection["Algorithm"]) ?? "unknown",
                Status: BuildKeyStatus(keyId, currentKeyId, revokedAt, compromisedAt),
                RevokedAtUtc: revokedAt,
                CompromisedAtUtc: compromisedAt));
        }

        return new IntegrityAdminKeyRegistryResponse(
            CurrentKeyId: currentKeyId,
            Keys: keys.OrderBy(static key => key.Version ?? int.MaxValue)
                .ThenBy(static key => key.KeyId, StringComparer.Ordinal)
                .ToArray());
    }

    private static string BuildKeyStatus(
        string keyId,
        string? currentKeyId,
        string? revokedAtUtc,
        string? compromisedAtUtc)
    {
        if (!string.IsNullOrWhiteSpace(compromisedAtUtc))
        {
            return IntegrityAdminKeyStatuses.Compromised;
        }

        if (!string.IsNullOrWhiteSpace(revokedAtUtc))
        {
            return IntegrityAdminKeyStatuses.Revoked;
        }

        return string.Equals(keyId, currentKeyId, StringComparison.Ordinal)
            ? IntegrityAdminKeyStatuses.Active
            : IntegrityAdminKeyStatuses.Old;
    }

    private static PublishProofInput BuildReadyProofInput(ArticlePublishProof proof)
        => new(
            ProofVersion: proof.ProofVersion,
            ArticleId: proof.ArticleId,
            ArticleRevisionId: proof.ArticleRevisionId,
            RevisionNo: proof.RevisionNo,
            CanonicalHash: NormalizeHashForPayload(proof.CanonicalHash),
            AotHash: NormalizeHashForPayload(proof.AotHash),
            ArticleDetailAedsHash: NormalizeHashForPayload(proof.ArticleDetailAedsHash),
            PublicHotReadHash: NormalizeHashForPayload(proof.PublicHotReadHash),
            AssetManifestHash: NormalizeHashForPayload(proof.AssetManifestHash),
            FeedHash: NormalizeHashForPayload(proof.FeedHash),
            PublishedAtUtc: Utc(proof.PublishedAt),
            ProofStatus: PublishProofStatus.Ready,
            PublicationState: PublishProofPublicationState.Public);

    private static TransparencyLogEntryRecord ToRecord(IntegrityTransparencyLogEntry entry)
        => new(
            entry.Seq,
            entry.EntryType,
            entry.ProofId,
            entry.ArticleId,
            entry.ArticleRevisionId,
            entry.RevisionNo,
            entry.EntryPayloadHash,
            entry.PrevEntryHash,
            entry.EntryHash,
            Utc(entry.CreatedAt),
            entry.SigningKeyId,
            entry.SignatureBase64Url);

    private static string? ResolvePublicKey(IConfiguration configuration, string keyId)
        => EmptyToNull(configuration[$"{SiteIntegritySigningStartupPolicy.SectionName}:Keys:{keyId}:PublicKey"]);

    private static int? ParseNullableInt(string? value)
        => int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsed)
            ? parsed
            : null;

    private static string? EmptyToNull(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static bool CanExposeProofPayload(string status)
        => status is "ready" or "superseded";

    private static string NormalizeProofStatus(string? status)
        => string.IsNullOrWhiteSpace(status)
            ? "pending"
            : status.Trim().ToLowerInvariant() switch
            {
                "ready" => "ready",
                "failed" => "failed",
                "retrying" => "retrying",
                "superseded" => "superseded",
                "not-public" => "not-public",
                _ => "pending"
            };

    private static string Hash(string? value)
    {
        string normalized = NormalizeHashForPayload(value);
        return normalized.Length == 0 ? string.Empty : string.Concat("sha256:", normalized);
    }

    private static string NormalizeHashForPayload(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        string trimmed = value.Trim();
        return trimmed.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase)
            ? trimmed["sha256:".Length..].ToLowerInvariant()
            : trimmed.ToLowerInvariant();
    }

    private static bool IsSha256Like(string? value)
    {
        string normalized = NormalizeHashForPayload(value);
        return HexText.IsSha256Hex(normalized);
    }

    private static DateTimeOffset Utc(DateTime value)
        => new(DateTime.SpecifyKind(value, DateTimeKind.Utc), TimeSpan.Zero);
}
