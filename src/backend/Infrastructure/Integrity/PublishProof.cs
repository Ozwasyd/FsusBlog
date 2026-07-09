using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Core.Integrity;

namespace FsusBlog.Server.Infrastructure.Integrity;

public enum PublishProofStatus
{
    Pending = 1,
    Ready = 2,
    Failed = 3,
    Retrying = 4,
    Superseded = 5,
    NotPublic = 6
}

public enum PublishProofPublicationState
{
    Public = 1,
    Draft = 2,
    Scheduled = 3,
    Archived = 4,
    Deleted = 5
}

public sealed record PublishProofInput(
    int ProofVersion,
    int ArticleId,
    long ArticleRevisionId,
    int RevisionNo,
    string CanonicalHash,
    string AotHash,
    string ArticleDetailAedsHash,
    string PublicHotReadHash,
    string AssetManifestHash,
    string FeedHash,
    DateTimeOffset PublishedAtUtc,
    PublishProofStatus ProofStatus,
    PublishProofPublicationState PublicationState);

public sealed record PublishProofReadiness(
    PublishProofStatus Status,
    string? Reason)
{
    public static PublishProofReadiness Evaluate(
        PublishProofInput proof,
        IEnumerable<ArtifactDigestEntry> artifacts)
    {
        ArgumentNullException.ThrowIfNull(artifacts);

        if (proof.PublicationState != PublishProofPublicationState.Public)
        {
            return new PublishProofReadiness(PublishProofStatus.NotPublic, "article-not-public");
        }

        if (proof.ArticleRevisionId <= 0 || proof.RevisionNo <= 0)
        {
            return new PublishProofReadiness(PublishProofStatus.Pending, "revision-required");
        }

        foreach (ArtifactDigestEntry artifact in artifacts)
        {
            switch (artifact.State)
            {
                case ArtifactDigestState.Ready:
                    break;
                case ArtifactDigestState.NotPublic:
                    return new PublishProofReadiness(PublishProofStatus.NotPublic, "artifact-not-public");
                case ArtifactDigestState.Stale:
                case ArtifactDigestState.HashMismatch:
                    return new PublishProofReadiness(PublishProofStatus.Failed, ToArtifactReason(artifact.State));
                case ArtifactDigestState.Missing:
                case ArtifactDigestState.Pending:
                case ArtifactDigestState.Unknown:
                case ArtifactDigestState.Unavailable:
                    return new PublishProofReadiness(PublishProofStatus.Pending, ToArtifactReason(artifact.State));
                default:
                    return new PublishProofReadiness(PublishProofStatus.Pending, "artifact-unready");
            }
        }

        return new PublishProofReadiness(PublishProofStatus.Ready, null);
    }

    private static string ToArtifactReason(ArtifactDigestState state)
        => state switch
        {
            ArtifactDigestState.Missing => "artifact-missing",
            ArtifactDigestState.Pending => "artifact-pending",
            ArtifactDigestState.Stale => "artifact-stale",
            ArtifactDigestState.Unknown => "artifact-unknown",
            ArtifactDigestState.Unavailable => "artifact-unavailable",
            ArtifactDigestState.HashMismatch => "artifact-hash-mismatch",
            _ => "artifact-unready"
        };
}

public static class PublishProofIdempotency
{
    public static string BuildKey(int articleId, long articleRevisionId, int proofVersion)
    {
        if (articleId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(articleId), articleId, "Article id must be positive.");
        }

        if (articleRevisionId <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(articleRevisionId),
                articleRevisionId,
                "Ready publish proof requires ArticleRevision.Id.");
        }

        if (proofVersion <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(proofVersion), proofVersion, "Proof version must be positive.");
        }

        return string.Create(
            CultureInfo.InvariantCulture,
            $"article:{articleId}:revision:{articleRevisionId}:proof:{proofVersion}");
    }
}

public static class PublishProofStateMachine
{
    public static bool CanTransition(PublishProofStatus from, PublishProofStatus to)
        => from switch
        {
            PublishProofStatus.Pending => to is PublishProofStatus.Ready
                or PublishProofStatus.Failed
                or PublishProofStatus.Retrying
                or PublishProofStatus.Superseded
                or PublishProofStatus.NotPublic,
            PublishProofStatus.Retrying => to is PublishProofStatus.Ready
                or PublishProofStatus.Failed
                or PublishProofStatus.Superseded
                or PublishProofStatus.NotPublic,
            PublishProofStatus.Failed => to is PublishProofStatus.Retrying
                or PublishProofStatus.Superseded
                or PublishProofStatus.NotPublic,
            PublishProofStatus.Ready => to is PublishProofStatus.Superseded
                or PublishProofStatus.NotPublic,
            PublishProofStatus.NotPublic => to is PublishProofStatus.Pending
                or PublishProofStatus.Superseded,
            PublishProofStatus.Superseded => false,
            _ => false
        };
}

public static class PublishProofCanonicalPayloadV1
{
    public const int ProofVersion = 1;
    public const int SignaturePayloadVersion = SiteIntegritySigningPayloadCanonicalizer.PayloadVersion;
    public const string DomainSeparator = "fsusblog.integrity.publish-proof-record.v1";

    public static string BuildRecordPayloadUtf8(PublishProofInput proof)
    {
        ValidateProof(proof);
        var builder = new StringBuilder(768);
        AppendRawLine(builder, DomainSeparator);
        AppendRawLine(builder, $"proofVersion:i:{proof.ProofVersion.ToString(CultureInfo.InvariantCulture)}");
        AppendRawLine(builder, $"signaturePayloadVersion:i:{SignaturePayloadVersion.ToString(CultureInfo.InvariantCulture)}");
        AppendRawLine(builder, $"articleId:i:{proof.ArticleId.ToString(CultureInfo.InvariantCulture)}");
        AppendRawLine(builder, $"articleRevisionId:i:{proof.ArticleRevisionId.ToString(CultureInfo.InvariantCulture)}");
        AppendRawLine(builder, $"revisionNo:i:{proof.RevisionNo.ToString(CultureInfo.InvariantCulture)}");
        AppendRawLine(builder, $"canonicalHash:h:{NormalizeSha256(proof.CanonicalHash)}");
        AppendRawLine(builder, $"aotHash:h:{NormalizeSha256(proof.AotHash)}");
        AppendRawLine(builder, $"articleDetailAedsHash:h:{NormalizeSha256(proof.ArticleDetailAedsHash)}");
        AppendRawLine(builder, $"publicHotReadHash:h:{NormalizeSha256(proof.PublicHotReadHash)}");
        AppendRawLine(builder, $"assetManifestHash:h:{NormalizeSha256(proof.AssetManifestHash)}");
        AppendRawLine(builder, $"feedHash:h:{NormalizeSha256(proof.FeedHash)}");
        AppendRawLine(builder, $"publishedAt:t:{CanonicalUtc(proof.PublishedAtUtc)}");
        AppendRawLine(builder, $"proofStatus:s:{ToStatusToken(proof.ProofStatus)}");
        return builder.ToString();
    }

    public static byte[] BuildRecordPayloadBytes(PublishProofInput proof)
        => Encoding.UTF8.GetBytes(BuildRecordPayloadUtf8(proof));

    public static string ComputeRecordDigestHex(PublishProofInput proof)
        => Convert.ToHexString(SHA256.HashData(BuildRecordPayloadBytes(proof))).ToLowerInvariant();

    public static SiteIntegritySigningPayload BuildSigningPayload(PublishProofInput proof)
    {
        ValidateReadyProof(proof);
        return new SiteIntegritySigningPayload(
            ProofKind: "publish-proof",
            Subject: string.Create(
                CultureInfo.InvariantCulture,
                $"article:{proof.ArticleId}:revision:{proof.ArticleRevisionId}"),
            DigestSha256Hex: ComputeRecordDigestHex(proof),
            IssuedAtUtc: proof.PublishedAtUtc.ToUniversalTime(),
            Fields: new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["articleId"] = proof.ArticleId.ToString(CultureInfo.InvariantCulture),
                ["articleRevisionId"] = proof.ArticleRevisionId.ToString(CultureInfo.InvariantCulture),
                ["proofVersion"] = proof.ProofVersion.ToString(CultureInfo.InvariantCulture),
                ["revisionNo"] = proof.RevisionNo.ToString(CultureInfo.InvariantCulture),
                ["signaturePayloadVersion"] = SignaturePayloadVersion.ToString(CultureInfo.InvariantCulture)
            });
    }

    private static void ValidateReadyProof(PublishProofInput proof)
    {
        ValidateProof(proof);
        if (proof.ProofStatus != PublishProofStatus.Ready)
        {
            throw new ArgumentException("Only ready publish proofs can be signed.", nameof(proof));
        }

        if (proof.PublicationState != PublishProofPublicationState.Public)
        {
            throw new ArgumentException("Only public articles can produce ready publish proofs.", nameof(proof));
        }
    }

    private static void ValidateProof(PublishProofInput proof)
    {
        if (proof.ProofVersion != ProofVersion)
        {
            throw new ArgumentOutOfRangeException(nameof(proof), proof.ProofVersion, "Unsupported publish proof version.");
        }

        if (proof.ArticleId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(proof), proof.ArticleId, "Article id must be positive.");
        }

        if (proof.ArticleRevisionId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(proof), proof.ArticleRevisionId, "ArticleRevision.Id is required.");
        }

        if (proof.RevisionNo <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(proof), proof.RevisionNo, "RevisionNo is required.");
        }
    }

    private static void AppendRawLine(StringBuilder builder, string value)
        => builder.Append(value).Append('\n');

    private static string CanonicalUtc(DateTimeOffset value)
        => value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);

    private static string ToStatusToken(PublishProofStatus status)
        => status switch
        {
            PublishProofStatus.Pending => "pending",
            PublishProofStatus.Ready => "ready",
            PublishProofStatus.Failed => "failed",
            PublishProofStatus.Retrying => "retrying",
            PublishProofStatus.Superseded => "superseded",
            PublishProofStatus.NotPublic => "not-public",
            _ => throw new ArgumentOutOfRangeException(nameof(status), status, "Unsupported publish proof status.")
        };

    private static string NormalizeSha256(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        string trimmed = value.Trim();
        if (trimmed.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
        {
            trimmed = trimmed[7..];
        }

        if (!HexText.IsSha256Hex(trimmed))
        {
            throw new ArgumentException("Publish proof digest must be a SHA-256 hex value.", nameof(value));
        }

        return trimmed.ToLowerInvariant();
    }
}
