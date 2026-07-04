using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using FsusBlog.Server.Entities;
using Microsoft.Extensions.Configuration;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Integrity;

public static class IntegrityVerificationJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
}

public static class IntegrityVerificationCacheHeaders
{
    public const string ImmutableProof = "public, max-age=31536000, immutable";
    public const string PublicManifest = "public, max-age=60, stale-while-revalidate=300";
    public const string NoStore = "no-store";
    public const string Vary = "Accept-Encoding";
}

public sealed record IntegrityManifestResult(int StatusCode, string CacheControl, object Body);

public sealed record IntegrityPublicErrorResponse(
    int ManifestVersion,
    string Code,
    string Message)
{
    public static IntegrityPublicErrorResponse NotFound(string code = "integrity_manifest_not_found")
        => new(1, code, "Integrity verification manifest not found.");

    public static IntegrityPublicErrorResponse InvalidDate()
        => new(1, "integrity_manifest_invalid_date", "Checkpoint date must use yyyy-MM-dd.");
}

public sealed record IntegrityKeysManifestResponse(
    int ManifestVersion,
    string Kind,
    string HashAlgorithm,
    string? CurrentKeyId,
    IReadOnlyList<IntegrityPublicKeyManifest> Keys)
{
    public static IntegrityKeysManifestResponse FromConfiguration(IConfiguration configuration)
    {
        IConfigurationSection signing = configuration.GetSection(SiteIntegritySigningStartupPolicy.SectionName);
        string? currentKeyId = EmptyToNull(signing["CurrentKeyId"]);
        List<IntegrityPublicKeyManifest> keys = [];
        foreach (IConfigurationSection keySection in signing.GetSection("Keys").GetChildren())
        {
            string keyId = keySection.Key;
            string? publicKey = EmptyToNull(keySection["PublicKey"]);
            if (string.IsNullOrWhiteSpace(keyId) || string.IsNullOrWhiteSpace(publicKey))
            {
                continue;
            }

            keys.Add(new IntegrityPublicKeyManifest(
                KeyId: keyId,
                Algorithm: EmptyToNull(keySection["Algorithm"]) ?? "unknown",
                Version: ParseNullableInt(keySection["Version"]),
                PublicKey: publicKey,
                RevokedAtUtc: EmptyToNull(keySection["RevokedAtUtc"]),
                CompromisedAtUtc: EmptyToNull(keySection["CompromisedAtUtc"])));
        }

        return new IntegrityKeysManifestResponse(
            ManifestVersion: 1,
            Kind: "integrity-key-registry",
            HashAlgorithm: "sha256",
            CurrentKeyId: currentKeyId,
            Keys: keys.OrderBy(static key => key.KeyId, StringComparer.Ordinal).ToArray());
    }

    private static int? ParseNullableInt(string? value)
        => int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsed)
            ? parsed
            : null;

    private static string? EmptyToNull(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

public sealed record IntegrityPublicKeyManifest(
    string KeyId,
    string Algorithm,
    int? Version,
    string PublicKey,
    string? RevokedAtUtc,
    string? CompromisedAtUtc);

public sealed record IntegrityProofManifestResponse(
    int ManifestVersion,
    string Kind,
    string Status,
    int ProofVersion,
    string HashAlgorithm,
    int ArticleId,
    long ArticleRevisionId,
    int RevisionNo,
    string? CanonicalHash,
    IntegrityArtifactDigestManifest? ArtifactDigests,
    IntegritySignatureManifest? Signature,
    IntegrityTransparencyLogPointer? TransparencyLog,
    IntegrityCheckpointPointer? Checkpoint = null,
    IReadOnlyList<IntegrityInclusionProofStep>? InclusionProof = null)
{
    public static IntegrityProofManifestResponse FromProof(ArticlePublishProof proof)
    {
        ArgumentNullException.ThrowIfNull(proof);
        string status = NormalizeStatus(proof.ProofStatus);
        bool exposePayload = IsPayloadPublic(status);

        return new IntegrityProofManifestResponse(
            ManifestVersion: 1,
            Kind: "article-publish-proof",
            Status: status,
            ProofVersion: proof.ProofVersion,
            HashAlgorithm: "sha256",
            ArticleId: proof.ArticleId,
            ArticleRevisionId: proof.ArticleRevisionId,
            RevisionNo: proof.RevisionNo,
            CanonicalHash: exposePayload ? Digest(proof.CanonicalHash) : null,
            ArtifactDigests: exposePayload ? new IntegrityArtifactDigestManifest(
                Aot: Digest(proof.AotHash),
                ArticleDetailAeds: Digest(proof.ArticleDetailAedsHash),
                PublicHotRead: Digest(proof.PublicHotReadHash),
                AssetManifest: Digest(proof.AssetManifestHash),
                Feed: Digest(proof.FeedHash)) : null,
            Signature: exposePayload && !string.IsNullOrWhiteSpace(proof.SigningKeyId) && !string.IsNullOrWhiteSpace(proof.SignatureBase64Url)
                ? new IntegritySignatureManifest(
                    PayloadVersion: proof.SignaturePayloadVersion,
                    KeyId: proof.SigningKeyId!,
                    KeyVersion: proof.SigningKeyVersion,
                    Algorithm: proof.SigningAlgorithm ?? "unknown",
                    Value: proof.SignatureBase64Url!)
                : null,
            TransparencyLog: exposePayload && proof.TransparencyLogEntryId.HasValue && !string.IsNullOrWhiteSpace(proof.TransparencyLogEntryHash)
                ? new IntegrityTransparencyLogPointer(proof.TransparencyLogEntryId.Value, NormalizeHash(proof.TransparencyLogEntryHash))
                : null);
    }

    public static bool IsPayloadPublic(string status)
        => string.Equals(status, "ready", StringComparison.Ordinal)
            || string.Equals(status, "superseded", StringComparison.Ordinal);

    public static string NormalizeStatus(string? status)
        => string.IsNullOrWhiteSpace(status)
            ? "pending"
            : status.Trim().ToLowerInvariant() switch
            {
                "ready" => "ready",
                "superseded" => "superseded",
                "failed" => "failed",
                "retrying" => "pending",
                "not-public" => "not-public",
                _ => "pending"
            };

    private static string Digest(string value)
        => string.Concat("sha256:", NormalizeHash(value));

    private static string NormalizeHash(string value)
    {
        string trimmed = value.Trim();
        return trimmed.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase)
            ? trimmed["sha256:".Length..].ToLowerInvariant()
            : trimmed.ToLowerInvariant();
    }
}

public sealed record IntegrityArtifactDigestManifest(
    string Aot,
    string ArticleDetailAeds,
    string PublicHotRead,
    string AssetManifest,
    string Feed);

public sealed record IntegritySignatureManifest(
    int PayloadVersion,
    string KeyId,
    int? KeyVersion,
    string Algorithm,
    string Value);

public sealed record IntegrityTransparencyLogPointer(
    long EntryId,
    string EntryHash);

public sealed record IntegrityCheckpointPointer(
    string CheckpointKind,
    string ScopeKey,
    string RootHash,
    long LogHeadSeq,
    string LogHeadHash);

public sealed record IntegrityInclusionProofStep(
    string Position,
    string Hash);

public sealed record IntegrityCheckpointManifestResponse(
    int ManifestVersion,
    string Kind,
    string CheckpointKind,
    string ScopeKey,
    long FromSeq,
    long ToSeq,
    int EntryCount,
    string RootHash,
    long LogHeadSeq,
    string LogHeadHash,
    string ManifestHash,
    IntegritySignatureManifest Signature,
    DateTimeOffset CreatedAtUtc)
{
    public static IntegrityCheckpointManifestResponse FromEntity(IntegrityMerkleCheckpoint checkpoint)
    {
        ArgumentNullException.ThrowIfNull(checkpoint);
        return new IntegrityCheckpointManifestResponse(
            ManifestVersion: 1,
            Kind: "merkle-checkpoint",
            CheckpointKind: checkpoint.CheckpointKind,
            ScopeKey: checkpoint.ScopeKey,
            FromSeq: checkpoint.FromSeq,
            ToSeq: checkpoint.ToSeq,
            EntryCount: checkpoint.EntryCount,
            RootHash: Digest(checkpoint.RootHash),
            LogHeadSeq: checkpoint.LogHeadSeq,
            LogHeadHash: Digest(checkpoint.LogHeadHash),
            ManifestHash: Digest(checkpoint.ManifestHash),
            Signature: new IntegritySignatureManifest(
                PayloadVersion: SiteIntegritySigningPayloadCanonicalizer.PayloadVersion,
                KeyId: checkpoint.SigningKeyId,
                KeyVersion: null,
                Algorithm: checkpoint.SigningAlgorithm,
                Value: checkpoint.SignatureBase64Url),
            CreatedAtUtc: new DateTimeOffset(DateTime.SpecifyKind(checkpoint.CreatedAt, DateTimeKind.Utc)));
    }

    private static string Digest(string value)
        => string.Concat("sha256:", value.Trim().ToLowerInvariant());
}

public sealed record IntegrityLogHeadManifestResponse(
    int ManifestVersion,
    string Kind,
    long Seq,
    string EntryType,
    long? ProofId,
    int? ArticleId,
    long? ArticleRevisionId,
    int? RevisionNo,
    string EntryPayloadHash,
    string PrevEntryHash,
    string EntryHash,
    DateTimeOffset CreatedAtUtc,
    IntegritySignatureManifest? Signature)
{
    public static IntegrityLogHeadManifestResponse FromEntity(IntegrityTransparencyLogEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        return new IntegrityLogHeadManifestResponse(
            ManifestVersion: 1,
            Kind: "transparency-log-head",
            Seq: entry.Seq,
            EntryType: entry.EntryType,
            ProofId: entry.ProofId,
            ArticleId: entry.ArticleId,
            ArticleRevisionId: entry.ArticleRevisionId,
            RevisionNo: entry.RevisionNo,
            EntryPayloadHash: Digest(entry.EntryPayloadHash),
            PrevEntryHash: Digest(entry.PrevEntryHash),
            EntryHash: Digest(entry.EntryHash),
            CreatedAtUtc: new DateTimeOffset(DateTime.SpecifyKind(entry.CreatedAt, DateTimeKind.Utc)),
            Signature: !string.IsNullOrWhiteSpace(entry.SigningKeyId) && !string.IsNullOrWhiteSpace(entry.SignatureBase64Url)
                ? new IntegritySignatureManifest(
                    PayloadVersion: SiteIntegritySigningPayloadCanonicalizer.PayloadVersion,
                    KeyId: entry.SigningKeyId!,
                    KeyVersion: null,
                    Algorithm: "transparency-log-entry",
                    Value: entry.SignatureBase64Url!)
                : null);
    }

    private static string Digest(string value)
        => string.Concat("sha256:", value.Trim().ToLowerInvariant());
}

public interface IIntegrityVerificationManifestService
{
    Task<IntegrityManifestResult> GetKeysAsync(CancellationToken cancellationToken);

    Task<IntegrityManifestResult> GetCurrentArticleProofAsync(int articleId, CancellationToken cancellationToken);

    Task<IntegrityManifestResult> GetArticleRevisionProofAsync(int articleId, int revisionNo, CancellationToken cancellationToken);

    Task<IntegrityManifestResult> GetRevisionProofAsync(long articleRevisionId, CancellationToken cancellationToken);

    Task<IntegrityManifestResult> GetLatestCheckpointAsync(CancellationToken cancellationToken);

    Task<IntegrityManifestResult> GetCheckpointAsync(DateOnly date, CancellationToken cancellationToken);

    Task<IntegrityManifestResult> GetLogHeadAsync(CancellationToken cancellationToken);
}

public sealed class IntegrityVerificationManifestService(
    ISqlSugarClient db,
    IConfiguration configuration) : IIntegrityVerificationManifestService
{
    public Task<IntegrityManifestResult> GetKeysAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(Ok(
            IntegrityKeysManifestResponse.FromConfiguration(configuration),
            IntegrityVerificationCacheHeaders.PublicManifest));
    }

    public async Task<IntegrityManifestResult> GetCurrentArticleProofAsync(int articleId, CancellationToken cancellationToken)
    {
        ArticlePublishProof? proof = await db.Queryable<ArticlePublishProof>()
            .Where(item => item.ArticleId == articleId)
            .OrderByDescending(item => item.PublishedAt)
            .OrderByDescending(item => item.RevisionNo)
            .OrderByDescending(item => item.Id)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

        return await BuildProofResultAsync(proof, cancellationToken).ConfigureAwait(false);
    }

    public async Task<IntegrityManifestResult> GetArticleRevisionProofAsync(
        int articleId,
        int revisionNo,
        CancellationToken cancellationToken)
    {
        ArticlePublishProof? proof = await db.Queryable<ArticlePublishProof>()
            .Where(item => item.ArticleId == articleId && item.RevisionNo == revisionNo)
            .OrderByDescending(item => item.Id)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

        return await BuildProofResultAsync(proof, cancellationToken).ConfigureAwait(false);
    }

    public async Task<IntegrityManifestResult> GetRevisionProofAsync(long articleRevisionId, CancellationToken cancellationToken)
    {
        ArticlePublishProof? proof = await db.Queryable<ArticlePublishProof>()
            .Where(item => item.ArticleRevisionId == articleRevisionId)
            .OrderByDescending(item => item.Id)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

        return await BuildProofResultAsync(proof, cancellationToken).ConfigureAwait(false);
    }

    public async Task<IntegrityManifestResult> GetLatestCheckpointAsync(CancellationToken cancellationToken)
    {
        IntegrityMerkleCheckpoint? checkpoint = await db.Queryable<IntegrityMerkleCheckpoint>()
            .OrderByDescending(item => item.CreatedAt)
            .OrderByDescending(item => item.Id)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

        return checkpoint is null
            ? NotFound()
            : Ok(IntegrityCheckpointManifestResponse.FromEntity(checkpoint), IntegrityVerificationCacheHeaders.PublicManifest);
    }

    public async Task<IntegrityManifestResult> GetCheckpointAsync(DateOnly date, CancellationToken cancellationToken)
    {
        string scopeKey = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        IntegrityMerkleCheckpoint? checkpoint = await db.Queryable<IntegrityMerkleCheckpoint>()
            .Where(item => item.CheckpointKind == "daily" && item.ScopeKey == scopeKey)
            .OrderByDescending(item => item.Id)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

        return checkpoint is null
            ? NotFound()
            : Ok(IntegrityCheckpointManifestResponse.FromEntity(checkpoint), IntegrityVerificationCacheHeaders.PublicManifest);
    }

    public async Task<IntegrityManifestResult> GetLogHeadAsync(CancellationToken cancellationToken)
    {
        IntegrityTransparencyLogEntry? head = await db.Queryable<IntegrityTransparencyLogEntry>()
            .OrderByDescending(item => item.Seq)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

        return head is null
            ? NotFound()
            : Ok(IntegrityLogHeadManifestResponse.FromEntity(head), IntegrityVerificationCacheHeaders.PublicManifest);
    }

    private async Task<IntegrityManifestResult> BuildProofResultAsync(
        ArticlePublishProof? proof,
        CancellationToken cancellationToken)
    {
        if (proof is null)
        {
            return NotFound();
        }

        if (!await IsArticlePublicAsync(proof.ArticleId, cancellationToken).ConfigureAwait(false))
        {
            return NotFound("integrity_manifest_not_public");
        }

        IntegrityProofManifestResponse manifest = IntegrityProofManifestResponse.FromProof(proof);
        string cache = IntegrityProofManifestResponse.IsPayloadPublic(manifest.Status)
            ? IntegrityVerificationCacheHeaders.ImmutableProof
            : IntegrityVerificationCacheHeaders.NoStore;

        return Ok(manifest, cache);
    }

    private async Task<bool> IsArticlePublicAsync(int articleId, CancellationToken cancellationToken)
    {
        Article? article = await db.Queryable<Article>()
            .Where(item => item.Id == articleId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

        return article is not null && ArticlePublication.IsPubliclyVisible(article, DateTime.UtcNow);
    }

    private static IntegrityManifestResult Ok(object body, string cacheControl)
        => new(StatusCodes.Status200OK, cacheControl, body);

    private static IntegrityManifestResult NotFound(string code = "integrity_manifest_not_found")
        => new(
            StatusCodes.Status404NotFound,
            IntegrityVerificationCacheHeaders.NoStore,
            IntegrityPublicErrorResponse.NotFound(code));
}
