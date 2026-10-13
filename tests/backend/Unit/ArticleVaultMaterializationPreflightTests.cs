using System.Text;

using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultMaterializationPreflightTests
{
    public static IEnumerable<object[]> Sources()
    {
        foreach (string text in new[] { "body", "body\n", "body\r\n", "body  \r\n", "body\nnext\r\n" })
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            yield return [bytes];
            yield return [new byte[] { 0xef, 0xbb, 0xbf }.Concat(bytes).ToArray()];
        }
    }

    [Theory]
    [MemberData(nameof(Sources))]
    public void Preflight_PreservesExactSourceFactsAndCannotCommitBase(byte[] source)
    {
        ArticleVaultSealedExecutionBundle bundle = ArticleVaultOperationFixture.Bundle(source);
        ArticleVaultExecutionResult server = ArticleVaultOperationFixture.NoOpResult(bundle);
        ArticleVaultMaterializationPreflight preflight = ArticleVaultMaterializationPreflightVerifier.Prepare(
            bundle, server, ArticleVaultOperationFixture.Identity(bundle.Plan));
        ArticleVaultMaterializationInstruction instruction = Assert.Single(preflight.SourceInstructions);
        Assert.Equal(VaultMaterializationSourceAction.VerifyUnchanged, instruction.Action);
        Assert.Equal(ArticleVaultManifestCodec.CaptureSourceBytes(source), instruction.NewSource);
        Assert.True(ArticleVaultMaterializationInstructionCodec.VerifyBytes(instruction, source).IsValid);
        Assert.False(ArticleVaultMaterializationInstructionCodec.VerifyBytes(instruction, source.Concat(new byte[] { 32 }).ToArray()).IsValid);
        Assert.Equal(bundle.PlanReference, instruction.PlanReference);
        Assert.Equal(bundle.RootManifest.ContentSha256, instruction.RootManifestSha256);
        Assert.Equal(bundle.Plan.Groups[0].Items[0].Local.MetadataManifestSha256, instruction.ExpectedOldMetadataManifestSha256);
        Assert.Equal(server.ResultReference, instruction.ServerResultReference);
        Assert.Equal(server.ContentSha256, instruction.ServerResultSha256);
        Assert.False(preflight.CanCommitBase);
        Assert.Contains("native_conditional_write_and_readback", preflight.MissingCapabilities);
    }

    [Fact]
    public void Preflight_RejectsResealedCrossSiteResultAndForeignOperationBeforeInstructions()
    {
        ArticleVaultSealedExecutionBundle bundle = ArticleVaultOperationFixture.Bundle("body"u8.ToArray());
        ArticleVaultExecutionResult result = ArticleVaultOperationFixture.NoOpResult(bundle);
        ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(bundle.Plan);
        ArticleVaultExecutionResult foreign = result with { SiteIdentity = "site-other" };
        foreign = foreign with { ContentSha256 = ArticleVaultExecutionIntegrity.SealResult(foreign) };
        Assert.Throws<ArticleVaultExecutionRejectedException>(() => ArticleVaultMaterializationPreflightVerifier.Prepare(bundle, foreign, identity));
        Assert.Throws<InvalidDataException>(() => ArticleVaultMaterializationPreflightVerifier.Prepare(
            bundle, result, identity with { VaultIdentity = "vault-other" }));
        Assert.Throws<ArticleVaultExecutionRejectedException>(() => ArticleVaultMaterializationPreflightVerifier.Prepare(
            bundle, result with { ResultReference = "latest" }, identity));
    }

    [Fact]
    public void Preflight_RejectsWriterReceiptSourceTamperEvenWhenNestedDigestsAreResealed()
    {
        ArticleVaultSealedExecutionBundle bundle = ArticleVaultOperationFixture.Bundle("body"u8.ToArray());
        ArticleVaultExecutionResult result = ArticleVaultOperationFixture.NoOpResult(bundle);
        ArticleVaultGroupResultReceipt group = Assert.Single(result.Groups);
        ArticleVaultOperationResultReceipt item = Assert.Single(group.Operations) with { ArticleContentSha256 = ArticleVaultOperationFixture.DigestC };
        item = item with { ContentSha256 = ArticleVaultExecutionIntegrity.SealOperationReceipt(item) };
        group = group with { Operations = [item] };
        group = group with { ContentSha256 = ArticleVaultExecutionIntegrity.SealGroupReceipt(group) };
        result = result with { Groups = [group] };
        result = result with { ContentSha256 = ArticleVaultExecutionIntegrity.SealResult(result) };
        Assert.Throws<ArticleVaultExecutionRejectedException>(() => ArticleVaultMaterializationPreflightVerifier.Prepare(
            bundle, result, ArticleVaultOperationFixture.Identity(bundle.Plan)));
    }
}
