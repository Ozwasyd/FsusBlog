using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Observations.Tests;

[Trait("Category", "ArticleVaultAtomicWriteAssessment")]
public sealed class ArticleVaultAtomicWriteAssessmentTests
{
    private const string PathA = "articles/first.md";
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Theory]
    [InlineData(VaultMaterializationSourceAction.Create)]
    [InlineData(VaultMaterializationSourceAction.Update)]
    [InlineData(VaultMaterializationSourceAction.Remove)]
    [InlineData(VaultMaterializationSourceAction.VerifyUnchanged)]
    public void CanonicalInstructions_PreserveBytePreconditionsWithoutGrantingNativeWrite(VaultMaterializationSourceAction action)
    {
        ArticleVaultRootManifest root = Root();
        byte[] oldBytes = Encoding.UTF8.GetBytes("old  \r\n");
        byte[] newBytes = [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("new\t\r\n")];
        bool present = action != VaultMaterializationSourceAction.Create;
        byte[] desired = action == VaultMaterializationSourceAction.Remove ? []
            : action == VaultMaterializationSourceAction.VerifyUnchanged ? oldBytes : newBytes;
        ArticleVaultMaterializationInstruction instruction = Instruction(root, action,
            present ? ArticleVaultManifestCodec.CaptureSourceBytes(oldBytes) : null,
            action == VaultMaterializationSourceAction.Remove ? null : ArticleVaultManifestCodec.CaptureSourceBytes(desired));
        VaultFilesystemObservation current = Current(root, present, oldBytes);
        VaultAtomicWriteAssessment result = ArticleVaultAtomicWriteAssessor.Assess(root, Scope(root), instruction, current, desired);
        Assert.Empty(result.BlockedReasonCodes);
        Assert.False(result.CanExecuteAtomicWrite);
        Assert.False(result.CanCommitBase);
        Assert.Contains("native_expected_old_conditional_atomic_mutation", result.RequiredNativeCapabilities);
        Assert.Contains("native_file_and_directory_flush", result.RequiredNativeCapabilities);
        Assert.True(ArticleVaultAtomicWriteAssessor.Verify(root, Scope(root), instruction, current, desired, result).IsValid);
    }

    [Fact]
    public void ByteNormalizationAndConcurrentUserEdit_InvalidateInstructionPreconditions()
    {
        ArticleVaultRootManifest root = Root();
        byte[] oldBytes = Encoding.UTF8.GetBytes("before\r\n");
        byte[] desired = [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("after  \r\n")];
        ArticleVaultMaterializationInstruction instruction = Instruction(root, VaultMaterializationSourceAction.Update,
            ArticleVaultManifestCodec.CaptureSourceBytes(oldBytes), ArticleVaultManifestCodec.CaptureSourceBytes(desired));
        VaultAtomicWriteAssessment normalization = ArticleVaultAtomicWriteAssessor.Assess(root, Scope(root), instruction,
            Current(root, true, oldBytes), Encoding.UTF8.GetBytes("after\n"));
        Assert.Contains("vault_atomic_desired_bytes_mismatch", normalization.BlockedReasonCodes);
        VaultAtomicWriteAssessment edit = ArticleVaultAtomicWriteAssessor.Assess(root, Scope(root), instruction,
            Current(root, true, Encoding.UTF8.GetBytes("user concurrent edit")), desired);
        Assert.Contains("vault_atomic_current_source_changed_or_unverified", edit.BlockedReasonCodes);
        Assert.False(edit.CanExecuteAtomicWrite);
    }

    [Fact]
    public void UnexpectedExistingAndRemovedOldSource_AreBlocked()
    {
        ArticleVaultRootManifest root = Root();
        byte[] bytes = Encoding.UTF8.GetBytes("complete");
        VaultSourceByteIdentity source = ArticleVaultManifestCodec.CaptureSourceBytes(bytes);
        ArticleVaultMaterializationInstruction create = Instruction(root, VaultMaterializationSourceAction.Create, null, source);
        VaultAtomicWriteAssessment occupied = ArticleVaultAtomicWriteAssessor.Assess(root, Scope(root), create,
            Current(root, true, bytes), bytes);
        Assert.Contains("vault_atomic_unexpected_existing_source", occupied.BlockedReasonCodes);
        ArticleVaultMaterializationInstruction remove = Instruction(root, VaultMaterializationSourceAction.Remove, source, null);
        VaultAtomicWriteAssessment missing = ArticleVaultAtomicWriteAssessor.Assess(root, Scope(root), remove,
            Current(root, false, []), []);
        Assert.Contains("vault_atomic_expected_existing_source_missing", missing.BlockedReasonCodes);
    }

    [Fact]
    public void ResealedCrossScopeAndContradictoryActions_AreRejected()
    {
        ArticleVaultRootManifest root = Root();
        byte[] bytes = Encoding.UTF8.GetBytes("complete");
        ArticleVaultMaterializationInstruction instruction = Instruction(root, VaultMaterializationSourceAction.Create,
            null, ArticleVaultManifestCodec.CaptureSourceBytes(bytes));
        foreach (ArticleVaultMaterializationInstruction altered in new[]
        {
            instruction with { AgentIdentity = "other" },
            instruction with { RootManifestSha256 = new string('b', 64) },
            instruction with { PortableArticleIdentity = "other" },
            instruction with { Action = VaultMaterializationSourceAction.Remove },
            instruction with { Action = VaultMaterializationSourceAction.Update },
            instruction with { OperationIdentity = string.Empty },
            instruction with { PathProjection = instruction.PathProjection with { RelativePath = ".fsus/vault.json" } }
        })
        {
            ArticleVaultMaterializationInstruction resealed = Seal(altered);
            VaultAtomicWriteAssessment result = ArticleVaultAtomicWriteAssessor.Assess(root, Scope(root), resealed,
                Current(root, false, []), bytes);
            Assert.NotEmpty(result.BlockedReasonCodes);
            Assert.False(result.CanExecuteAtomicWrite);
        }
    }

    [Fact]
    public void AssessmentTamper_CannotRemoveNativeRequirementsOrAlterInstructionBinding()
    {
        ArticleVaultRootManifest root = Root();
        byte[] bytes = Encoding.UTF8.GetBytes("complete");
        ArticleVaultMaterializationInstruction instruction = Instruction(root, VaultMaterializationSourceAction.Create,
            null, ArticleVaultManifestCodec.CaptureSourceBytes(bytes));
        VaultFilesystemObservation current = Current(root, false, []);
        VaultAtomicWriteAssessment result = ArticleVaultAtomicWriteAssessor.Assess(root, Scope(root), instruction, current, bytes);
        foreach (VaultAtomicWriteAssessment altered in new[]
        {
            result with { RequiredNativeCapabilities = [] },
            result with { InstructionSha256 = new string('b', 64) },
            result with { RelativePath = "outside.md" }
        })
        {
            VaultAtomicWriteAssessment resealed = altered with
            {
                ContentSha256 = ArticleVaultAtomicWriteAssessor.ComputeContentSha256(altered)
            };
            Assert.False(ArticleVaultAtomicWriteAssessor.Verify(root, Scope(root), instruction, current, bytes, resealed).IsValid);
        }
    }

    [Theory]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "vault_atomic_metadata_observation_unavailable")]
    [InlineData("invalid", "vault_atomic_metadata_expectation_invalid")]
    public void CanonicalMetadataExpectation_CannotBeIgnoredOrInferredFromSourceBytes(string metadataDigest, string reason)
    {
        ArticleVaultRootManifest root = Root();
        byte[] bytes = Encoding.UTF8.GetBytes("complete");
        ArticleVaultMaterializationInstruction instruction = Instruction(root, VaultMaterializationSourceAction.VerifyUnchanged,
            ArticleVaultManifestCodec.CaptureSourceBytes(bytes), ArticleVaultManifestCodec.CaptureSourceBytes(bytes));
        instruction = Seal(instruction with
        {
            ExpectedOldMetadataManifestSha256 = metadataDigest
        });
        VaultAtomicWriteAssessment result = ArticleVaultAtomicWriteAssessor.Assess(root, Scope(root), instruction,
            Current(root, true, bytes), bytes);
        Assert.Contains(reason, result.BlockedReasonCodes);
        Assert.False(result.CanExecuteAtomicWrite);
        Assert.False(result.CanCommitBase);
    }

    private static ArticleVaultRootManifest Root()
        => ArticleVaultSnapshotAssessmentTests.CreateRoot();

    private static VaultPathStructuralScope Scope(ArticleVaultRootManifest root)
        => ArticleVaultSnapshotAssessmentTests.Scope(root);

    private static VaultFilesystemObservation Current(ArticleVaultRootManifest root, bool present, byte[] bytes)
    {
        VaultSnapshotAssessment? assessment = null;
        if (present)
        {
            VaultFileMetadataObservation metadata = ArticleVaultSnapshotAssessmentTests.Metadata(bytes.Length);
            assessment = ArticleVaultSnapshotAssessor.Assess(root, Scope(root), PathA, [], metadata, bytes, metadata, bytes, true);
        }

        return new(PathA, present, assessment);
    }

    private static ArticleVaultMaterializationInstruction Instruction(ArticleVaultRootManifest root,
        VaultMaterializationSourceAction action, VaultSourceByteIdentity? oldSource, VaultSourceByteIdentity? newSource)
        => Seal(new ArticleVaultMaterializationInstruction(ArticleVaultMaterializationInstructionCodec.Schema, 1,
            root.SiteIdentity, root.VaultIdentity, root.DeviceIdentity, Scope(root).AgentIdentity,
            "plan-ref", Digest, root.ContentSha256, "result-ref", Digest, "group", "operation", "portable-a",
            new(PathA, Digest), action, oldSource, newSource, null, Digest, "journal", string.Empty));

    private static ArticleVaultMaterializationInstruction Seal(ArticleVaultMaterializationInstruction instruction)
        => instruction with
        {
            ContentSha256 = ArticleVaultMaterializationInstructionCodec.ComputeContentSha256(instruction)
        };
}
