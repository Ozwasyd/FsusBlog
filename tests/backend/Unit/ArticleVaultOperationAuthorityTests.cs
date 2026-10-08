using System.Text.Json;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultOperationAuthorityTests
{
    [Fact]
    public void PlanAndArticleStateCases_AreEnumeratedFromCanonicalSchemas()
    {
        using JsonDocument plan = Schema("article-vault-sync-plan.schema.json");
        JsonElement properties = plan.RootElement.GetProperty("properties");
        AssertEnum<VaultSyncDirection>(properties.GetProperty("direction").GetProperty("enum"));
        AssertEnum<VaultSyncPlanStatus>(properties.GetProperty("status").GetProperty("enum"));
        AssertEnum<VaultSyncDecision>(plan.RootElement.GetProperty("$defs").GetProperty("item")
            .GetProperty("properties").GetProperty("decision").GetProperty("enum"));
        using JsonDocument article = Schema("article-vault-article-manifest.schema.json");
        AssertEnum<VaultArticleState>(article.RootElement.GetProperty("properties").GetProperty("state").GetProperty("enum"));
    }

    [Fact]
    public void EveryState_IsRejectedAsInitialHistoryUnlessItIsPlanned()
    {
        ArticleVaultSyncPlan plan = ArticleVaultOperationFixture.Plan();
        ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(plan);
        foreach (VaultOperationState state in Enum.GetValues<VaultOperationState>())
        {
            ArticleVaultOperationCheckpoint checkpoint = ArticleVaultOperationFixture.Checkpoint(identity, plan, state: state);
            Assert.Equal(state == VaultOperationState.Planned,
                ArticleVaultOperationVerifier.VerifyHistory(identity, plan, [checkpoint], 0, checkpoint.ContentSha256).IsValid);
        }
    }

    [Fact]
    public void ResealedHistory_CannotSkipServerStageOrAdvanceMaterializedBase()
    {
        ArticleVaultSyncPlan plan = ArticleVaultOperationFixture.Plan();
        ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(plan);
        ArticleVaultOperationCheckpoint planned = ArticleVaultOperationFixture.Checkpoint(identity, plan);
        ArticleVaultOperationCheckpoint skipped = ArticleVaultOperationFixture.Checkpoint(identity, plan, planned,
            VaultOperationState.MaterializingLocal, VaultServerCommitDisposition.Accepted,
            new VaultOperationStageReference(plan.ResultCandidateIdentity, ArticleVaultOperationFixture.DigestA));
        Assert.False(ArticleVaultOperationVerifier.VerifyHistory(identity, plan, [planned, skipped], 1, skipped.ContentSha256).IsValid);
        foreach (VaultOperationState state in Enum.GetValues<VaultOperationState>())
        {
            ArticleVaultOperationCheckpoint advanced = ArticleVaultOperationFixture.Seal(planned with
            {
                State = state,
                Articles = [planned.Articles[0] with { BaseAfterSha256 = ArticleVaultOperationFixture.DigestC }]
            });
            Assert.False(ArticleVaultOperationVerifier.VerifyHistory(identity, plan, [advanced], 0, advanced.ContentSha256).IsValid);
        }
    }

    private static JsonDocument Schema(string name)
    {
        Stream stream = typeof(ArticleVaultSchemas).Assembly.GetManifestResourceStream($"FsusBlog.Contracts.ArticleVault.{name}")
            ?? throw new InvalidDataException("canonical_vault_schema_missing");
        using (stream)
        {
            return JsonDocument.Parse(stream);
        }
    }

    private static void AssertEnum<T>(JsonElement cases) where T : struct, Enum
        => Assert.Equal(cases.EnumerateArray().Select(static item => item.GetString()).Order(StringComparer.Ordinal),
            Enum.GetNames<T>().Select(JsonNamingPolicy.KebabCaseLower.ConvertName).Order(StringComparer.Ordinal));
}
