using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Observations.Tests;

[Trait("Category", "ArticleVaultAtomicWriteAssessment")]
public sealed class LinuxVaultTemporarySourcePreparerTests
{
    [Fact]
    public void PreparationRejectsNormalizedBytesAndTamperedInstructionBeforeCreation()
    {
        byte[] desired = [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("article  \r\n")];
        ArticleVaultMaterializationInstruction instruction = Instruction(desired);
        Assert.True(LinuxVaultTemporarySourcePreparer.ValidateDesiredBytes(instruction, desired).IsValid);
        Assert.False(LinuxVaultTemporarySourcePreparer.ValidateDesiredBytes(instruction,
            Encoding.UTF8.GetBytes("article\n")).IsValid);
        Assert.False(LinuxVaultTemporarySourcePreparer.ValidateDesiredBytes(instruction with
        {
            PlanSha256 = new string('b', 64)
        }, desired).IsValid);
        Assert.False(LinuxVaultTemporarySourcePreparer.ValidateDesiredBytes(instruction with
        {
            SchemaVersion = 2
        }, desired).IsValid);
    }

    [Fact]
    public void PreparationCannotCreateTemporaryForRemoveUnchangedOrEmptySource()
    {
        byte[] bytes = Encoding.UTF8.GetBytes("source");
        ArticleVaultMaterializationInstruction instruction = Instruction(bytes);
        foreach (VaultMaterializationSourceAction action in new[]
        {
            VaultMaterializationSourceAction.Remove, VaultMaterializationSourceAction.VerifyUnchanged, (VaultMaterializationSourceAction)99
        })
        {
            Assert.False(LinuxVaultTemporarySourcePreparer.ValidateDesiredBytes(instruction with
            {
                Action = action
            }, bytes).IsValid);
        }

        Assert.False(LinuxVaultTemporarySourcePreparer.ValidateDesiredBytes(Instruction([]), []).IsValid);
        Assert.False(LinuxVaultTemporarySourcePreparer.ValidateDesiredBytes(instruction,
            new byte[ArticleVaultSnapshotAssessor.MaxSourceBytes + 1]).IsValid);
    }

    private static ArticleVaultMaterializationInstruction Instruction(byte[] bytes)
    {
        const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        var instruction = new ArticleVaultMaterializationInstruction(
            ArticleVaultMaterializationInstructionCodec.Schema, 1, "site", "vault", "device", "agent", "plan-ref", Digest,
            Digest, "result-ref", Digest, "group", "operation", "article", new("articles/first.md",
                ArticleVaultManifestCodec.ComputeProjectionSha256("articles/first.md")), VaultMaterializationSourceAction.Create,
            null, ArticleVaultManifestCodec.CaptureSourceBytes(bytes), null, Digest, "journal", string.Empty);
        return instruction with
        {
            ContentSha256 = ArticleVaultMaterializationInstructionCodec.ComputeContentSha256(instruction)
        };
    }
}
