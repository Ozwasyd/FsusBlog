using System.Text.Json;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class AntiSpamModerationServiceTests
{
    [Fact]
    public void ValidateProviderResultJson_RejectsFinalActionFields()
    {
        string json = """
            {
              "contract_version": "fsusblog-moderation-provider-v1",
              "request_id": "comment:1",
              "provider_id": "mock",
              "model_profile": "mock-v1",
              "status": "scored",
              "label": "risky",
              "confidence": 0.9,
              "severity": "high",
              "categories": [],
              "blocked_regions": ["CN-MAINLAND"]
            }
            """;

        Assert.Throws<InvalidOperationException>(() =>
            AntiSpamModerationService.ValidateProviderResultJson(json, "fsusblog-moderation-provider-v1", "mock", TimeSpan.Zero));
    }

    [Fact]
    public void ValidateProviderResultJson_AcceptsRiskSignalOnlyPayload()
    {
        string json = """
            {
              "contract_version": "fsusblog-moderation-provider-v1",
              "request_id": "comment:1",
              "provider_id": "mock",
              "model_profile": "mock-v1",
              "threshold_profile": "default",
              "status": "scored",
              "label": "risky",
              "confidence": 0.91,
              "severity": "high",
              "primary_reason": "spam_repeat",
              "categories": [
                {
                  "id": "spam_repeat",
                  "confidence": 0.91,
                  "severity": "high",
                  "evidence_policy": "show_category_only"
                }
              ],
              "needs_second_round": true,
              "evidence": []
            }
            """;

        var result = AntiSpamModerationService.ValidateProviderResultJson(json, "fsusblog-moderation-provider-v1", "mock", TimeSpan.FromMilliseconds(3));

        Assert.True(result.Available);
        Assert.Equal("mock", result.Provider);
        Assert.Equal("risky", result.Label);
        Assert.Equal("spam_repeat", result.Categories[0].Id);
    }

    [Theory]
    [InlineData("userId")]
    [InlineData("username")]
    [InlineData("email")]
    [InlineData("ip")]
    [InlineData("authorId")]
    [InlineData("replyToUserId")]
    public void ValidateProviderRequestJson_RejectsLegacyIdentityFields(string forbiddenField)
    {
        string json = $$"""
            {
              "contract_version": "fsusblog-moderation-provider-v1",
              "request_id": "comment:1",
              "content_type": "comment",
              "text": "normal comment",
              "metadata": {
                "source": "fsusblog",
                "{{forbiddenField}}": "legacy-value"
              }
            }
            """;

        var ex = Assert.Throws<InvalidOperationException>(() =>
            AntiSpamModerationService.ValidateProviderRequestJson(json));
        Assert.Contains(forbiddenField, ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ModerationProviderRequestSchema_DocumentsForbiddenIdentityFields()
    {
        string source = File.ReadAllText(Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "schemas/moderation/model-provider-request.schema.json"));

        Assert.Contains("\"not\"", source, StringComparison.Ordinal);
        Assert.Contains("userId", source, StringComparison.Ordinal);
        Assert.Contains("replyToUserId", source, StringComparison.Ordinal);
        Assert.Contains("anonymous_nullifier_hash", source, StringComparison.Ordinal);
    }

    [Fact]
    public void ModerationProviderManifestSchema_AllowsMainlineAndAuditOnlyButRejectsLegacyProduction()
    {
        string source = File.ReadAllText(Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "schemas/moderation/model-provider-manifest.schema.json"));
        using JsonDocument document = JsonDocument.Parse(source);
        string serialized = document.RootElement.GetRawText();

        Assert.Contains("mainline-release", serialized, StringComparison.Ordinal);
        Assert.Contains("audit-only", serialized, StringComparison.Ordinal);
        Assert.Contains("legacy/python", serialized, StringComparison.Ordinal);
        Assert.Contains("\"not\"", serialized, StringComparison.Ordinal);
    }

    [Fact]
    public void SchemaMigrationRegistry_CreatesCommentModerationSignalTableAndIndexes()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs"));

        Assert.Contains("comment_moderation_signal", source);
        Assert.Contains("idx_comment_moderation_signal_comment_id", source);
        Assert.Contains("idx_comment_moderation_signal_label_confidence", source);
        Assert.Contains("idx_comment_moderation_signal_second_round", source);
        Assert.Contains("BuildCommentModerationSignalMigration()", source);
    }
}
