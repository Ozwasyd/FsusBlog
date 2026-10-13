using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Describes observed bytes without asserting native file admission or editor completion.</summary>
public enum VaultSnapshotAssessmentState
{
    StableCandidate,
    IncompleteWrite,
    PermissionBlocked,
    UnknownFile,
    PathBlocked
}

/// <summary>Contains descriptor diagnostics supplied by the platform reader, never article identity.</summary>
public sealed record VaultFileMetadataObservation(
    string FileIdentityDiagnostic,
    long ByteLength,
    string PermissionSha256,
    bool IsRegularFile,
    bool IsReadable);

/// <summary>
/// Records bounded byte comparison and path analysis without retaining body bytes or granting filesystem
/// authorization. A stable candidate still requires the native reader's use-boundary receipt.
/// </summary>
public sealed record VaultSnapshotAssessment(
    string Schema,
    int SchemaVersion,
    VaultPathStructuralScope Scope,
    VaultPathProjection PathProjection,
    string? PortableArticleIdentityCandidate,
    VaultSnapshotAssessmentState State,
    VaultSourceByteIdentity? Source,
    VaultFileMetadataObservation? Metadata,
    string PathAnalysisSha256,
    string? FirstSourceSha256,
    string? SecondSourceSha256,
    bool SamplesAgree,
    bool CompletionBoundaryObserved,
    string ReasonCode,
    string ContentSha256)
{
    /// <summary>Pure comparisons do not prove realpath, permissions, file kind or native completion.</summary>
    public bool RequiresNativeAdmission => true;

    /// <summary>Assessment results are never clean synchronization inputs.</summary>
    public bool CanAdmitSynchronization => false;
}

/// <summary>
/// Assesses byte-preserving samples and independently replays their finite rules. This type performs
/// no I/O; root/path native admission and atomic materialization remain platform-owned boundaries.
/// </summary>
public static class ArticleVaultSnapshotAssessor
{
    public const string Schema = "fsusblog.article-vault.snapshot-assessment.v1";
    public const int MaxSourceBytes = 16 * 1024 * 1024;

    /// <summary>
    /// Compares two complete bounded samples. Equal size or equal bytes without a completion boundary
    /// cannot mark a paused editor save complete. Even a stable candidate grants no native authority.
    /// </summary>
    public static VaultSnapshotAssessment Assess(
        ArticleVaultRootManifest root,
        VaultPathStructuralScope scope,
        string relativePath,
        IReadOnlyList<string> observedPaths,
        VaultFileMetadataObservation? firstMetadata,
        ReadOnlySpan<byte> firstBytes,
        VaultFileMetadataObservation? secondMetadata,
        ReadOnlySpan<byte> secondBytes,
        bool completionBoundaryObserved)
    {
        if (firstBytes.Length > MaxSourceBytes || secondBytes.Length > MaxSourceBytes)
        {
            throw new InvalidDataException("vault_snapshot_source_bound_exceeded");
        }

        VaultPathStructuralAnalysis path = ArticleVaultPathStructureValidator.Analyze(
            root, scope, relativePath, observedPaths);
        VaultSnapshotAssessmentState state;
        string reason;
        VaultSourceByteIdentity? source = null;
        string firstDigest = Hash(firstBytes);
        string secondDigest = Hash(secondBytes);
        bool agree = firstMetadata is not null
            && secondMetadata is not null
            && firstMetadata == secondMetadata
            && firstMetadata.ByteLength == firstBytes.Length
            && secondMetadata.ByteLength == secondBytes.Length
            && firstBytes.SequenceEqual(secondBytes);
        if (path.Classification != VaultPathStructuralClass.ManifestSourceProjection)
        {
            state = path.RuleIdentity == ArticleVaultPathStructureValidator.UnknownRule
                ? VaultSnapshotAssessmentState.UnknownFile : VaultSnapshotAssessmentState.PathBlocked;
            reason = path.ReasonCode ?? "vault_snapshot_control_path_rejected";
        }
        else if (firstMetadata is null || secondMetadata is null)
        {
            state = VaultSnapshotAssessmentState.IncompleteWrite;
            reason = "vault_snapshot_sample_missing";
        }
        else if (!firstMetadata.IsReadable || !secondMetadata.IsReadable)
        {
            state = VaultSnapshotAssessmentState.PermissionBlocked;
            reason = "vault_snapshot_permission_blocked";
        }
        else if (!ValidMetadata(firstMetadata) || !ValidMetadata(secondMetadata))
        {
            state = VaultSnapshotAssessmentState.PathBlocked;
            reason = "vault_snapshot_file_metadata_invalid";
        }
        else if (!agree || !completionBoundaryObserved || firstBytes.IsEmpty)
        {
            state = VaultSnapshotAssessmentState.IncompleteWrite;
            reason = !agree ? "vault_snapshot_observation_changed"
                : firstBytes.IsEmpty ? "vault_snapshot_empty_save_unproven"
                : "vault_snapshot_completion_unproven";
        }
        else
        {
            try
            {
                source = ArticleVaultManifestCodec.CaptureSourceBytes(secondBytes);
                state = VaultSnapshotAssessmentState.StableCandidate;
                reason = "vault_snapshot_native_admission_required";
            }
            catch (DecoderFallbackException)
            {
                state = VaultSnapshotAssessmentState.IncompleteWrite;
                reason = "vault_snapshot_utf8_incomplete";
            }
        }

        var assessment = new VaultSnapshotAssessment(
            Schema, ArticleVaultSchemas.Version, scope,
            new VaultPathProjection(relativePath, Hash(Encoding.UTF8.GetBytes(relativePath))),
            path.PortableArticleIdentity, state, source, secondMetadata,
            path.ContentSha256, firstDigest, secondDigest, agree,
            completionBoundaryObserved, reason, string.Empty);
        return assessment with
        {
            ContentSha256 = ComputeContentSha256(assessment)
        };
    }

    /// <summary>Replays the assessment using independently supplied scope, metadata and byte samples.</summary>
    public static ArticleVaultValidationResult Verify(
        ArticleVaultRootManifest root,
        VaultPathStructuralScope scope,
        string relativePath,
        IReadOnlyList<string> observedPaths,
        VaultFileMetadataObservation? firstMetadata,
        ReadOnlySpan<byte> firstBytes,
        VaultFileMetadataObservation? secondMetadata,
        ReadOnlySpan<byte> secondBytes,
        bool completionBoundaryObserved,
        VaultSnapshotAssessment? assessment)
    {
        if (assessment is null || !ArticleVaultManifestValidator.IsSha256(assessment.ContentSha256))
        {
            return ArticleVaultValidationResult.Invalid("vault_snapshot_assessment_invalid");
        }

        try
        {
            VaultSnapshotAssessment expected = Assess(root, scope, relativePath, observedPaths,
                firstMetadata, firstBytes, secondMetadata, secondBytes, completionBoundaryObserved);
            return expected.ContentSha256 == assessment.ContentSha256
                && ComputeContentSha256(assessment) == assessment.ContentSha256
                ? ArticleVaultValidationResult.Valid()
                : ArticleVaultValidationResult.Invalid("vault_snapshot_assessment_mismatch");
        }
        catch (Exception exception) when (exception is InvalidDataException or ArgumentException
            or System.Text.Json.JsonException)
        {
            return ArticleVaultValidationResult.Invalid("vault_snapshot_assessment_invalid");
        }
    }

    /// <summary>Content-addresses privacy-safe observations, excluding the digest slot itself.</summary>
    public static string ComputeContentSha256(VaultSnapshotAssessment assessment)
        => Hash(ArticleVaultManifestCodec.SerializeCanonical(assessment with
        {
            ContentSha256 = string.Empty
        }));

    private static bool ValidMetadata(VaultFileMetadataObservation metadata)
        => metadata.IsRegularFile
            && ArticleVaultManifestValidator.IsIdentity(metadata.FileIdentityDiagnostic)
            && metadata.ByteLength is >= 0 and <= MaxSourceBytes
            && ArticleVaultManifestValidator.IsSha256(metadata.PermissionSha256);

    private static string Hash(ReadOnlySpan<byte> bytes)
        => Convert.ToHexStringLower(SHA256.HashData(bytes));
}
