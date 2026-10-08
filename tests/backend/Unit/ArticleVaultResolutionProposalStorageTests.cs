using System.Text;

using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultResolutionProposalStorageTests
{
    [Fact]
    public void SoleClosedCodec_ReturnsExplicitRefusalsAndPreservesExecutionGate()
    {
        ArticleVaultResolutionPlanInput input = ArticleVaultResolutionProposalFixture.Create();
        ArticleVaultResolutionPlan proposal = ArticleVaultResolutionPlanner.Build(input).Plan!;
        byte[] bytes = ArticleVaultResolutionPlanner.Serialize(proposal);
        Assert.Equal(proposal.ContentSha256, ArticleVaultResolutionPlanner.TryDeserialize(bytes).Plan!.ContentSha256);
        string json = Encoding.UTF8.GetString(bytes);
        foreach (byte[] rejected in new[]
        {
            "null"u8.ToArray(), "{"u8.ToArray(), "[]"u8.ToArray(),
            Encoding.UTF8.GetBytes(json[..^1] + ",\"writer\":\"arbitrary\"}"),
            new byte[ArticleVaultGitFactDecoder.MaxOutputBytes + 1]
        })
        {
            ArticleVaultResolutionPlanResult result = ArticleVaultResolutionPlanner.TryDeserialize(rejected);
            Assert.Null(result.Plan);
            Assert.False(string.IsNullOrWhiteSpace(result.ReasonCode));
        }
        Assert.Equal("article_vault_resolution_canonical_execution_admission_missing",
            ArticleVaultResolutionPlanner.RequireExecutionAdmission(proposal, input).ReasonCode);
    }

    [Fact]
    public void CompiledProposalStore_CannotCallArticleOperationOrLocalWriters()
    {
        Type owner = typeof(PostgresArticleVaultResolutionProposalStore);
        RuntimeMetadataInspection.RuntimeMemberSite[] references = new[] { owner }
            .Concat(owner.GetNestedTypes(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic))
            .SelectMany(static type => RuntimeMetadataInspection.ReadMemberSites(type)).ToArray();
        Assert.NotEmpty(references);
        Assert.DoesNotContain(references, static site =>
        {
            Type? declaring = site.Member as Type ?? site.Member.DeclaringType;
            string name = declaring?.FullName ?? string.Empty;
            return name.StartsWith("System.IO.", StringComparison.Ordinal)
                || name.StartsWith("System.Diagnostics.Process", StringComparison.Ordinal)
                || name.Contains("IArticleVaultCanonicalGroupWriter", StringComparison.Ordinal)
                || name.Contains("IArticleVaultOperationCheckpointStore", StringComparison.Ordinal)
                || site.Member.Name is "ExecuteGroupAsync" or "ExecuteAsync" or "SaveResultAsync" or "SaveGroupResultAsync";
        });
        Assert.DoesNotContain(references, static site => site.Member.DeclaringType == typeof(IArticleVaultExecutionStore)
            && site.Member.Name != "LoadSealedAsync");
    }
}
