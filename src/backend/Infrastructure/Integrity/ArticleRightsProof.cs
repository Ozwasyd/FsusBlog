using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.Integrity;

public sealed record ArticleRightsProofInput(
    int ProofVersion,
    int ArticleId,
    long ArticleRevisionId,
    int RevisionNo,
    long ArticleRightsSnapshotId,
    long? PublishProofId,
    string RightsPolicyHash,
    string ContentCanonicalHash,
    DateTimeOffset IssuedAtUtc,
    PublishProofStatus ProofStatus,
    PublishProofPublicationState PublicationState);

public sealed record ArticleRightsProofReadiness(
    PublishProofStatus Status,
    string? Reason)
{
    public static ArticleRightsProofReadiness Evaluate(
        ArticleRightsProofInput proof,
        bool rightsSnapshotAvailable,
        bool contentHashReady,
        bool publishProofReady)
    {
        ArgumentNullException.ThrowIfNull(proof);

        if (proof.PublicationState != PublishProofPublicationState.Public)
        {
            return new ArticleRightsProofReadiness(PublishProofStatus.NotPublic, "article-not-public");
        }

        if (!rightsSnapshotAvailable)
        {
            return new ArticleRightsProofReadiness(PublishProofStatus.Pending, "rights-snapshot-missing");
        }

        if (!contentHashReady)
        {
            return new ArticleRightsProofReadiness(PublishProofStatus.Pending, "content-canonical-hash-pending");
        }

        if (!publishProofReady)
        {
            return new ArticleRightsProofReadiness(PublishProofStatus.Pending, "publish-proof-pending");
        }

        return new ArticleRightsProofReadiness(PublishProofStatus.Ready, null);
    }
}

public static class ArticleRightsProofIdempotency
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
                "ArticleRevision.Id is required.");
        }

        if (proofVersion <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(proofVersion), proofVersion, "Proof version must be positive.");
        }

        return string.Create(
            CultureInfo.InvariantCulture,
            $"article:{articleId}:revision:{articleRevisionId}:rights:{proofVersion}");
    }
}

public static class ArticleRightsProofCanonicalPayloadV1
{
    public const int ProofVersion = 1;
    public const int SignaturePayloadVersion = SiteIntegritySigningPayloadCanonicalizer.PayloadVersion;
    public const string DomainSeparator = "fsusblog.integrity.article-rights-proof-record.v1";

    public static string BuildRecordPayloadUtf8(ArticleRightsProofInput proof)
    {
        ValidateProof(proof);
        var builder = new StringBuilder(512);
        AppendRawLine(builder, DomainSeparator);
        AppendRawLine(builder, $"proofVersion:i:{proof.ProofVersion.ToString(CultureInfo.InvariantCulture)}");
        AppendRawLine(builder, $"signaturePayloadVersion:i:{SignaturePayloadVersion.ToString(CultureInfo.InvariantCulture)}");
        AppendRawLine(builder, $"articleId:i:{proof.ArticleId.ToString(CultureInfo.InvariantCulture)}");
        AppendRawLine(builder, $"articleRevisionId:i:{proof.ArticleRevisionId.ToString(CultureInfo.InvariantCulture)}");
        AppendRawLine(builder, $"revisionNo:i:{proof.RevisionNo.ToString(CultureInfo.InvariantCulture)}");
        AppendRawLine(builder, $"articleRightsSnapshotId:i:{proof.ArticleRightsSnapshotId.ToString(CultureInfo.InvariantCulture)}");
        AppendNullableLong(builder, "publishProofId", proof.PublishProofId);
        AppendRawLine(builder, $"rightsPolicyHash:h:{NormalizeSha256(proof.RightsPolicyHash)}");
        AppendRawLine(builder, $"contentCanonicalHash:h:{NormalizeSha256(proof.ContentCanonicalHash)}");
        AppendRawLine(builder, $"issuedAt:t:{CanonicalUtc(proof.IssuedAtUtc)}");
        AppendRawLine(builder, $"proofStatus:s:{ToStatusToken(proof.ProofStatus)}");
        return builder.ToString();
    }

    public static byte[] BuildRecordPayloadBytes(ArticleRightsProofInput proof)
        => Encoding.UTF8.GetBytes(BuildRecordPayloadUtf8(proof));

    public static string ComputeRecordDigestHex(ArticleRightsProofInput proof)
        => Convert.ToHexString(SHA256.HashData(BuildRecordPayloadBytes(proof))).ToLowerInvariant();

    public static SiteIntegritySigningPayload BuildSigningPayload(ArticleRightsProofInput proof)
    {
        ValidateReadyProof(proof);
        return new SiteIntegritySigningPayload(
            ProofKind: "article-rights-proof",
            Subject: string.Create(
                CultureInfo.InvariantCulture,
                $"article:{proof.ArticleId}:revision:{proof.ArticleRevisionId}:rights:{proof.ArticleRightsSnapshotId}"),
            DigestSha256Hex: ComputeRecordDigestHex(proof),
            IssuedAtUtc: proof.IssuedAtUtc.ToUniversalTime(),
            Fields: new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["articleId"] = proof.ArticleId.ToString(CultureInfo.InvariantCulture),
                ["articleRevisionId"] = proof.ArticleRevisionId.ToString(CultureInfo.InvariantCulture),
                ["articleRightsSnapshotId"] = proof.ArticleRightsSnapshotId.ToString(CultureInfo.InvariantCulture),
                ["proofVersion"] = proof.ProofVersion.ToString(CultureInfo.InvariantCulture),
                ["publishProofId"] = proof.PublishProofId!.Value.ToString(CultureInfo.InvariantCulture),
                ["revisionNo"] = proof.RevisionNo.ToString(CultureInfo.InvariantCulture),
                ["signaturePayloadVersion"] = SignaturePayloadVersion.ToString(CultureInfo.InvariantCulture)
            });
    }

    private static void ValidateReadyProof(ArticleRightsProofInput proof)
    {
        ValidateProof(proof);
        if (proof.ProofStatus != PublishProofStatus.Ready)
        {
            throw new ArgumentException("Only ready article rights proofs can be signed.", nameof(proof));
        }

        if (proof.PublicationState != PublishProofPublicationState.Public)
        {
            throw new ArgumentException("Only public articles can produce ready article rights proofs.", nameof(proof));
        }

        if (!proof.PublishProofId.HasValue || proof.PublishProofId.Value <= 0)
        {
            throw new ArgumentException("Ready article rights proof requires a publish proof pointer.", nameof(proof));
        }
    }

    private static void ValidateProof(ArticleRightsProofInput proof)
    {
        if (proof.ProofVersion != ProofVersion)
        {
            throw new ArgumentOutOfRangeException(nameof(proof), proof.ProofVersion, "Unsupported article rights proof version.");
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

        if (proof.ArticleRightsSnapshotId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(proof), proof.ArticleRightsSnapshotId, "ArticleRightsSnapshot.Id is required.");
        }
    }

    private static void AppendRawLine(StringBuilder builder, string value)
        => builder.Append(value).Append('\n');

    private static void AppendNullableLong(StringBuilder builder, string field, long? value)
    {
        if (value.HasValue)
        {
            AppendRawLine(builder, $"{field}:i:{value.Value.ToString(CultureInfo.InvariantCulture)}");
            return;
        }

        AppendRawLine(builder, $"{field}:n");
    }

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
            _ => throw new ArgumentOutOfRangeException(nameof(status), status, "Unsupported article rights proof status.")
        };

    private static string NormalizeSha256(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        string trimmed = value.Trim();
        if (trimmed.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
        {
            trimmed = trimmed["sha256:".Length..];
        }

        if (trimmed.Length != 64 || trimmed.Any(static ch => !Uri.IsHexDigit(ch)))
        {
            throw new ArgumentException("Article rights proof digest must be a SHA-256 hex value.", nameof(value));
        }

        return trimmed.ToLowerInvariant();
    }
}
