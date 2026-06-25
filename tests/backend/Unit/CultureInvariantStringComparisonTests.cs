using System.Text.RegularExpressions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed partial class CultureInvariantStringComparisonTests
{
    [Fact]
    public void BackendPathAndExtensionChecks_UseExplicitOrdinalComparisons()
    {
        SourceFile[] files =
        [
            new("src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs"),
            new("src/backend/Services/FileService.cs"),
            new("src/backend/Services/SearchIndexService.cs"),
            new("src/backend/Services/SystemService.cs"),
            new("src/backend/Services/Moderation/ModerationDictionaryService.cs"),
            new("src/backend/Services/Moderation/ModerationRegionCatalogService.cs"),
            new("src/backend/Services/Authoring/AuthoringWorkflowService.cs")
        ];

        foreach (SourceFile file in files)
        {
            string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, file.RelativePath));
            AssertNoCultureSensitivePrefixSuffixCall(file.RelativePath, source);
        }

        string composition = Read("src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs");
        foreach (string extension in new[] { ".js", ".css", ".wasm", ".woff", ".woff2", ".ttf", ".otf" })
        {
            Assert.Contains($"EndsWith(\"{extension}\", StringComparison.OrdinalIgnoreCase)", composition, StringComparison.Ordinal);
        }
    }

    private static string Read(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static void AssertNoCultureSensitivePrefixSuffixCall(string relativePath, string source)
    {
        Match match = CultureSensitivePrefixSuffixCallRegex().Match(source);
        Assert.False(
            match.Success,
            $"{relativePath} contains culture-sensitive string comparison: {match.Value}");
    }

    [GeneratedRegex(@"\.(?:StartsWith|EndsWith)\((?![^;\n]*(?:StringComparison|StringComparer))[^;\n]+\)")]
    private static partial Regex CultureSensitivePrefixSuffixCallRegex();

    private sealed record SourceFile(string RelativePath);
}
