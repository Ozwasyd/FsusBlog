using System.Security.Cryptography;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Records source preconditions without claiming an atomic write or native access capability.</summary>
public sealed record VaultAtomicWriteAssessment(
    string Schema,
    int SchemaVersion,
    VaultPathStructuralScope Scope,
    string InstructionSha256,
    string RelativePath,
    VaultMaterializationSourceAction Action,
    string? ObservedSnapshotSha256,
    IReadOnlyList<string> BlockedReasonCodes,
    IReadOnlyList<string> RequiredNativeCapabilities,
    string ContentSha256)
{
    /// <summary>Source consistency checks cannot authorize filesystem mutations.</summary>
    public bool CanExecuteAtomicWrite => false;

    /// <summary>Only the materialization owner can commit a verified base/receipt transaction.</summary>
    public bool CanCommitBase => false;
}

/// <summary>
/// Consumes the canonical #2106 instruction and #2110 byte observations at the local primitive
/// boundary. No file, temp, journal, marker or base is written by this precondition assessment.
/// </summary>
public static class ArticleVaultAtomicWriteAssessor
{
    public const string Schema = "fsusblog.article-vault.atomic-write-assessment.v1";

    /// <summary>
    /// Checks action shape, exact binding, desired original bytes and expected-old byte identity.
    /// Root-bound native admission, conditional replacement and flush/readback remain mandatory.
    /// </summary>
    public static VaultAtomicWriteAssessment Assess(
        ArticleVaultRootManifest root,
        VaultPathStructuralScope scope,
        ArticleVaultMaterializationInstruction instruction,
        VaultFilesystemObservation current,
        ReadOnlySpan<byte> desiredBytes)
    {
        ArgumentNullException.ThrowIfNull(instruction);
        ArgumentNullException.ThrowIfNull(current);
        if (desiredBytes.Length > ArticleVaultSnapshotAssessor.MaxSourceBytes)
        {
            throw new InvalidDataException("vault_snapshot_source_bound_exceeded");
        }

        if (instruction.PathProjection is null)
        {
            throw new InvalidDataException("vault_atomic_instruction_path_missing");
        }

        VaultPathStructuralAnalysis path = ArticleVaultPathStructureValidator.Analyze(root, scope,
            instruction.PathProjection.RelativePath, [current.RelativePath]);
        var blocked = new SortedSet<string>(StringComparer.Ordinal);
        if (instruction.Schema != ArticleVaultMaterializationInstructionCodec.Schema
            || instruction.SchemaVersion != ArticleVaultMaterializationInstructionCodec.Version
            || !Enum.IsDefined(instruction.Action)
            || !ArticleVaultManifestValidator.IsSha256(instruction.ContentSha256)
            || instruction.ContentSha256 != ArticleVaultMaterializationInstructionCodec.ComputeContentSha256(instruction))
        {
            blocked.Add("vault_atomic_instruction_invalid");
        }

        if (instruction.SiteIdentity != scope.SiteIdentity || instruction.VaultIdentity != scope.VaultIdentity
            || instruction.DeviceIdentity != scope.DeviceIdentity || instruction.AgentIdentity != scope.AgentIdentity
            || instruction.RootManifestSha256 != scope.RootManifestSha256
            || instruction.PortableArticleIdentity != path.PortableArticleIdentity
            || current.RelativePath != instruction.PathProjection.RelativePath
            || path.Classification != VaultPathStructuralClass.ManifestSourceProjection
            || !ArticleVaultManifestValidator.IsSha256(instruction.PathProjection.ProjectionSha256))
        {
            blocked.Add("vault_atomic_instruction_binding_invalid");
        }

        if (instruction.ExpectedOldMetadataManifestSha256 is not null)
        {
            blocked.Add(ArticleVaultManifestValidator.IsSha256(instruction.ExpectedOldMetadataManifestSha256)
                ? "vault_atomic_metadata_observation_unavailable" : "vault_atomic_metadata_expectation_invalid");
        }

        if (!ArticleVaultManifestValidator.IsIdentity(instruction.OperationIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(instruction.GroupIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(instruction.JournalIdentity)
            || string.IsNullOrWhiteSpace(instruction.PlanReference) || instruction.PlanReference.Length > 1024
            || string.IsNullOrWhiteSpace(instruction.ServerResultReference) || instruction.ServerResultReference.Length > 1024
            || !ArticleVaultManifestValidator.IsSha256(instruction.PlanSha256)
            || !ArticleVaultManifestValidator.IsSha256(instruction.ServerResultSha256)
            || !ArticleVaultManifestValidator.IsSha256(instruction.BaseBeforeSha256))
        {
            blocked.Add("vault_atomic_instruction_operation_invalid");
        }

        bool actionValid = instruction.Action switch
        {
            VaultMaterializationSourceAction.Create => instruction.ExpectedOldSource is null && instruction.NewSource is not null,
            VaultMaterializationSourceAction.Update => instruction.ExpectedOldSource is not null && instruction.NewSource is not null
                && instruction.ExpectedOldSource != instruction.NewSource,
            VaultMaterializationSourceAction.Remove => instruction.ExpectedOldSource is not null && instruction.NewSource is null,
            VaultMaterializationSourceAction.VerifyUnchanged => instruction.ExpectedOldSource == instruction.NewSource,
            _ => false
        };
        if (!actionValid)
        {
            blocked.Add("vault_atomic_instruction_action_invalid");
        }

        if (instruction.NewSource is null)
        {
            if (!desiredBytes.IsEmpty)
            {
                blocked.Add("vault_atomic_unexpected_new_bytes");
            }
        }
        else if (!ArticleVaultMaterializationInstructionCodec.VerifyBytes(instruction, desiredBytes).IsValid)
        {
            blocked.Add("vault_atomic_desired_bytes_mismatch");
        }

        VaultSnapshotAssessment? observed = current.Assessment;
        if (!current.Present)
        {
            if (current.Assessment is not null || instruction.ExpectedOldSource is not null)
            {
                blocked.Add("vault_atomic_expected_existing_source_missing");
            }
        }
        else if (instruction.ExpectedOldSource is null)
        {
            blocked.Add("vault_atomic_unexpected_existing_source");
        }
        else if (observed is null || observed.Scope != scope || observed.PathProjection?.RelativePath != current.RelativePath
            || observed.State != VaultSnapshotAssessmentState.StableCandidate
            || observed.ContentSha256 != ArticleVaultSnapshotAssessor.ComputeContentSha256(observed)
            || observed.Source != instruction.ExpectedOldSource || !observed.SamplesAgree || !observed.CompletionBoundaryObserved)
        {
            blocked.Add("vault_atomic_current_source_changed_or_unverified");
        }

        var assessment = new VaultAtomicWriteAssessment(Schema, 1, scope, instruction.ContentSha256,
            instruction.PathProjection.RelativePath, instruction.Action, observed?.ContentSha256, blocked.ToArray(),
        [
            "native_root_bound_content_admission",
            "native_expected_old_conditional_atomic_mutation",
            "native_file_and_directory_flush",
            "native_post_write_bytes_metadata_path_identity_verification",
            "native_current_operation_temp_journal_recovery"
        ], string.Empty);
        return assessment with
        {
            ContentSha256 = ComputeContentSha256(assessment)
        };
    }

    /// <summary>Independently replays source preconditions; resealing altered observations is insufficient.</summary>
    public static ArticleVaultValidationResult Verify(
        ArticleVaultRootManifest root,
        VaultPathStructuralScope scope,
        ArticleVaultMaterializationInstruction instruction,
        VaultFilesystemObservation current,
        ReadOnlySpan<byte> desiredBytes,
        VaultAtomicWriteAssessment? assessment)
    {
        try
        {
            if (assessment is null || !ArticleVaultManifestValidator.IsSha256(assessment.ContentSha256))
            {
                return ArticleVaultValidationResult.Invalid("vault_atomic_assessment_invalid");
            }

            VaultAtomicWriteAssessment expected = Assess(root, scope, instruction, current, desiredBytes);
            return expected.ContentSha256 == assessment.ContentSha256
                && ComputeContentSha256(assessment) == assessment.ContentSha256
                ? ArticleVaultValidationResult.Valid()
                : ArticleVaultValidationResult.Invalid("vault_atomic_assessment_mismatch");
        }
        catch (Exception exception) when (exception is InvalidDataException or ArgumentException
            or System.Text.Json.JsonException)
        {
            return ArticleVaultValidationResult.Invalid("vault_atomic_assessment_invalid");
        }
    }

    public static string ComputeContentSha256(VaultAtomicWriteAssessment assessment)
        => Convert.ToHexStringLower(SHA256.HashData(ArticleVaultManifestCodec.SerializeCanonical(
            assessment with
            {
                ContentSha256 = string.Empty
            })));
}
