namespace FsusBlog.Server.Tests.Unit;

public sealed class ModerationConsoleContractTests
{
    [Fact]
    public void AuthoringEndpoints_ExposeModerationConsoleSurfacesWithMfaForHighRiskReload()
    {
        string endpoints = ReadRepoFile("src/backend/Modules/Endpoints/AuthoringEndpoints.cs");

        Assert.Contains("MapGet(\"/moderation/overview\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/moderation/dictionaries\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapPost(\"/moderation/dictionaries/reload\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/moderation/policies\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapPost(\"/moderation/replay/preview\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/moderation/model/status\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync(context, mfaChallengeService)", endpoints, StringComparison.Ordinal);
        Assert.Contains("RecordHighValueAsync", endpoints, StringComparison.Ordinal);
        Assert.Contains("admin.moderation.dictionary_reloaded", endpoints, StringComparison.Ordinal);
        Assert.Contains("admin.moderation.replay_previewed", endpoints, StringComparison.Ordinal);
    }

    [Fact]
    public void RuntimeDictionaryMetadata_DoesNotExposeRawTermsToAdminConsole()
    {
        string models = ReadRepoFile("src/backend/Models/Moderation/ModerationDictionaryModels.cs");
        string service = ReadRepoFile("src/backend/Services/Moderation/ModerationDictionaryService.cs");

        Assert.Contains("string EvidencePolicy", models, StringComparison.Ordinal);
        Assert.Contains("int TermCount", models, StringComparison.Ordinal);
        Assert.Contains("ResolveEvidencePolicy(item.Terms)", service, StringComparison.Ordinal);
        Assert.DoesNotContain("IReadOnlyList<ModerationDictionaryTerm> Terms", ExtractRuntimeItem(models), StringComparison.Ordinal);
    }

    [Fact]
    public void RegionPolicyChecks_ProtectCnMainlandMandatoryRules()
    {
        string endpoints = ReadRepoFile("src/backend/Modules/Endpoints/AuthoringEndpoints.cs");

        Assert.Contains("cn-mainland.political-sensitive", endpoints, StringComparison.Ordinal);
        Assert.Contains("cn-mainland.porn-strict", endpoints, StringComparison.Ordinal);
        Assert.Contains("cn-mainland.public-order", endpoints, StringComparison.Ordinal);
        Assert.Contains("cn-mainland.national-security", endpoints, StringComparison.Ordinal);
        Assert.Contains("ModerationRiskCategories.PoliticalSensitive", endpoints, StringComparison.Ordinal);
        Assert.Contains("ModerationRiskCategories.Pornographic", endpoints, StringComparison.Ordinal);
        Assert.Contains("ModerationDictionaryActions.RejectSubmit", endpoints, StringComparison.Ordinal);
        Assert.Contains("ModerationDictionaryActions.GeoBlock", endpoints, StringComparison.Ordinal);
    }

    private static string ExtractRuntimeItem(string source)
    {
        int start = source.IndexOf("public sealed record ModerationDictionaryRuntimeItem", StringComparison.Ordinal);
        int end = source.IndexOf("public sealed record ModerationRegionPolicyRuntimeItem", StringComparison.Ordinal);
        Assert.True(start >= 0 && end > start);
        return source[start..end];
    }

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(FindRepoRoot(), relativePath));

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            current = Directory.GetParent(current)?.FullName ?? string.Empty;
        }

        throw new InvalidOperationException("Repository root not found.");
    }
}
