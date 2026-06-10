using FsusBlog.Server.Services.Moderation;

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

    [Fact]
    public void SchemaMigrationRegistry_CreatesCommentModerationSignalTableAndIndexes()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs"));

        Assert.Contains("comment_moderation_signal", source);
        Assert.Contains("idx_comment_moderation_signal_comment_id", source);
        Assert.Contains("idx_comment_moderation_signal_label_confidence", source);
        Assert.Contains("idx_comment_moderation_signal_second_round", source);
        Assert.Contains("BuildCommentModerationSignalMigration()", source);
    }

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }
}
