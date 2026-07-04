using FsusBlog.Core.Integrity;

namespace FsusBlog.Server.Infrastructure.Integrity;

public sealed record IntegrityProofVerificationBundle(
    ArticleCanonicalInput Article,
    PublishProofInput Proof,
    IReadOnlyList<ArtifactDigestEntry> Artifacts,
    SiteIntegritySignature PublishProofSignature,
    SiteSigningKeyRegistry PublicKeyRegistry,
    IReadOnlyList<TransparencyLogEntryRecord> TransparencyLog,
    MerkleCheckpointManifest Checkpoint,
    IReadOnlyList<MerkleLeafInput> CheckpointLeaves,
    IReadOnlyList<MerkleInclusionProof> InclusionProofs);

public sealed record IntegrityProofVerificationCheck(
    string Name,
    bool Accepted,
    string Code,
    string? Detail = null);

public sealed record IntegrityProofVerificationReport(
    bool Accepted,
    IReadOnlyList<IntegrityProofVerificationCheck> Checks);

public static class IntegrityProofVerifier
{
    public static IntegrityProofVerificationReport Verify(IntegrityProofVerificationBundle bundle)
    {
        ArgumentNullException.ThrowIfNull(bundle);

        var checks = new List<IntegrityProofVerificationCheck>
        {
            VerifyCanonicalHash(bundle),
            VerifyArtifactDigests(bundle),
            VerifyPublishProofSignature(bundle),
            VerifyTransparencyLog(bundle),
            VerifyMerkleCheckpoint(bundle),
            VerifyInclusionProofs(bundle),
            VerifyPublicKeyRegistry(bundle)
        };

        return new IntegrityProofVerificationReport(
            checks.All(static check => check.Accepted),
            checks);
    }

    private static IntegrityProofVerificationCheck VerifyCanonicalHash(IntegrityProofVerificationBundle bundle)
    {
        try
        {
            if (bundle.Proof.ArticleId != bundle.Article.ArticleId
                || bundle.Proof.ArticleRevisionId != bundle.Article.ArticleRevisionId
                || bundle.Proof.RevisionNo != bundle.Article.RevisionNo)
            {
                return Reject("canonical-hash", "canonical-coordinates-mismatch");
            }

            string computed = ArticleCanonicalHashV1.ComputeHashHex(bundle.Article);
            return SameHash(computed, bundle.Proof.CanonicalHash)
                ? Accept("canonical-hash")
                : Reject("canonical-hash", "canonical-hash-mismatch");
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            return Reject("canonical-hash", "canonical-hash-invalid", ex.GetType().Name);
        }
    }

    private static IntegrityProofVerificationCheck VerifyArtifactDigests(IntegrityProofVerificationBundle bundle)
    {
        var expected = new Dictionary<ArtifactDigestKind, string>
        {
            [ArtifactDigestKind.PublicAotShell] = bundle.Proof.AotHash,
            [ArtifactDigestKind.ArticleDetailAeds] = bundle.Proof.ArticleDetailAedsHash,
            [ArtifactDigestKind.PublicHotRead] = bundle.Proof.PublicHotReadHash,
            [ArtifactDigestKind.PublicAssetManifest] = bundle.Proof.AssetManifestHash,
            [ArtifactDigestKind.RssFeed] = bundle.Proof.FeedHash
        };

        foreach (KeyValuePair<ArtifactDigestKind, string> item in expected)
        {
            ArtifactDigestEntry? artifact = bundle.Artifacts.FirstOrDefault(entry => entry.Kind == item.Key);
            if (artifact is null)
            {
                return Reject("artifact-digest", $"artifact-missing:{item.Key}");
            }

            if (artifact.State != ArtifactDigestState.Ready || string.IsNullOrWhiteSpace(artifact.Sha256Hex))
            {
                return Reject("artifact-digest", $"artifact-not-ready:{item.Key}");
            }

            if (!SameHash(artifact.Sha256Hex, item.Value))
            {
                return Reject("artifact-digest", $"artifact-digest-mismatch:{item.Key}");
            }
        }

        return Accept("artifact-digest");
    }

    private static IntegrityProofVerificationCheck VerifyPublishProofSignature(IntegrityProofVerificationBundle bundle)
    {
        try
        {
            var service = new SiteIntegritySigningService(bundle.PublicKeyRegistry);
            SiteIntegritySignatureVerificationResult result = service.Verify(
                PublishProofCanonicalPayloadV1.BuildSigningPayload(bundle.Proof),
                bundle.PublishProofSignature);
            return result.Accepted
                ? Accept("publish-proof-signature")
                : Reject("publish-proof-signature", result.Code, result.KeyId);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or FormatException)
        {
            return Reject("publish-proof-signature", "publish-proof-signature-invalid", ex.GetType().Name);
        }
    }

    private static IntegrityProofVerificationCheck VerifyTransparencyLog(IntegrityProofVerificationBundle bundle)
    {
        TransparencyLogVerificationResult result = TransparencyLogChainVerifier.Verify(bundle.TransparencyLog);
        return result.IsValid
            ? Accept("transparency-log-chain", result.LatestHeadHash)
            : Reject("transparency-log-chain", result.ErrorCode ?? "transparency-log-invalid", result.FailedSeq?.ToString());
    }

    private static IntegrityProofVerificationCheck VerifyMerkleCheckpoint(IntegrityProofVerificationBundle bundle)
    {
        try
        {
            MerkleCheckpointBuildResult checkpoint = MerkleCheckpointBuilder.Build(bundle.CheckpointLeaves);
            if (!SameHash(checkpoint.RootHash, bundle.Checkpoint.RootHash))
            {
                return Reject("merkle-checkpoint-root", "checkpoint-root-mismatch");
            }

            if (checkpoint.Leaves.Count != bundle.Checkpoint.EntryCount)
            {
                return Reject("merkle-checkpoint-root", "checkpoint-entry-count-mismatch");
            }

            if (checkpoint.Leaves.Count > 0)
            {
                long fromSeq = checkpoint.Leaves.Min(static leaf => leaf.Seq);
                long toSeq = checkpoint.Leaves.Max(static leaf => leaf.Seq);
                if (bundle.Checkpoint.FromSeq != fromSeq || bundle.Checkpoint.ToSeq != toSeq)
                {
                    return Reject("merkle-checkpoint-root", "checkpoint-range-mismatch");
                }
            }

            TransparencyLogVerificationResult log = TransparencyLogChainVerifier.Verify(bundle.TransparencyLog);
            if (log.IsValid && !SameHash(log.LatestHeadHash, bundle.Checkpoint.LogHeadHash))
            {
                return Reject("merkle-checkpoint-root", "checkpoint-log-head-mismatch");
            }

            return Accept("merkle-checkpoint-root");
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            return Reject("merkle-checkpoint-root", "checkpoint-invalid", ex.GetType().Name);
        }
    }

    private static IntegrityProofVerificationCheck VerifyInclusionProofs(IntegrityProofVerificationBundle bundle)
    {
        if (bundle.CheckpointLeaves.Count > 0 && bundle.InclusionProofs.Count == 0)
        {
            return Reject("inclusion-proof", "inclusion-proof-missing");
        }

        foreach (MerkleInclusionProof proof in bundle.InclusionProofs)
        {
            if (!MerkleCheckpointVerifier.VerifyInclusion(bundle.Checkpoint.RootHash, proof))
            {
                return Reject("inclusion-proof", "inclusion-proof-invalid", proof.Seq.ToString());
            }
        }

        return Accept("inclusion-proof");
    }

    private static IntegrityProofVerificationCheck VerifyPublicKeyRegistry(IntegrityProofVerificationBundle bundle)
    {
        if (!bundle.PublicKeyRegistry.TryGetCurrentKey(out SiteSigningKeyRecord? currentKey))
        {
            return Reject("public-key-registry", "current-key-missing");
        }

        if (string.IsNullOrWhiteSpace(currentKey.PublicKeySubjectPublicKeyInfoBase64Url))
        {
            return Reject("public-key-registry", "current-public-key-missing");
        }

        if (bundle.PublicKeyRegistry.PublicKeys.Any(static key => key.PrivateKeyAvailable))
        {
            return Reject("public-key-registry", "private-key-exposed");
        }

        return Accept("public-key-registry", currentKey.KeyId);
    }

    private static IntegrityProofVerificationCheck Accept(string name, string? detail = null)
        => new(name, true, "accepted", detail);

    private static IntegrityProofVerificationCheck Reject(string name, string code, string? detail = null)
        => new(name, false, code, detail);

    private static bool SameHash(string? left, string? right)
        => !string.IsNullOrWhiteSpace(left)
            && !string.IsNullOrWhiteSpace(right)
            && StringComparer.Ordinal.Equals(left.Trim().ToLowerInvariant(), right.Trim().ToLowerInvariant());
}
