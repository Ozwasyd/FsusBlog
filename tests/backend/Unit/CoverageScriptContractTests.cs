namespace FsusBlog.Server.Tests.Unit;

public sealed class CoverageScriptContractTests
{
    [Fact]
    public void FrontendCoverageCollection_DefaultsLocalVitestThresholdsToArtifactOnly()
    {
        string source = File.ReadAllText(Path.Combine(
            FindRepoRoot(),
            "tools",
            "coverage",
            "collect-frontend-coverage.sh"));

        Assert.Contains(
            "FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD=\"${FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD:-0}\"",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD=\"${FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD:-0}\"",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD=\"${FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD:-0}\"",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD=\"${FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD:-0}\"",
            source,
            StringComparison.Ordinal);
    }

    [Fact]
    public void CoverageMerge_DefaultFileFiltersMatchCurrentRepositoryLayout()
    {
        string source = File.ReadAllText(Path.Combine(
            FindRepoRoot(),
            "tools",
            "coverage",
            "merge-coverage.sh"));

        Assert.Contains("+*/src/core/Algorithms/AedsDecoderValidator.cs", source, StringComparison.Ordinal);
        Assert.Contains("+*/src/core/DependencyInjection/CoreServiceCollectionExtensions.cs", source, StringComparison.Ordinal);
        Assert.Contains("+*/src/core/Mapping/Readers/PodRowMapper.cs", source, StringComparison.Ordinal);
        Assert.Contains("+*/src/frontend/src/utils/appError.ts", source, StringComparison.Ordinal);
        Assert.Contains("+*/tests/frontend/support/playwright/testSession.ts", source, StringComparison.Ordinal);
    }

    [Fact]
    public void FrontendCoverage_IncludesSharedPlaywrightTestSessionHelper()
    {
        string source = File.ReadAllText(Path.Combine(
            FindRepoRoot(),
            "src",
            "frontend",
            "vitest.config.ts"));

        Assert.Contains("allowExternal: true", source, StringComparison.Ordinal);
        Assert.Contains("tests/frontend/support/playwright/testSession.ts", source, StringComparison.Ordinal);
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
