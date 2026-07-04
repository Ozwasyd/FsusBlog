using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RightsV3DocumentationContractTests
{
    [Fact]
    public void ArchitectureDocs_DescribeFinalRightsV3DataFlow()
    {
        string architecture = ReadRepoFile("docs/architecture.md");

        Assert.Contains("Rights V3 final data flow", architecture, StringComparison.Ordinal);
        Assert.Contains("admin write", architecture, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("policy snapshot", architecture, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("ArticleDetail AEDS V3", architecture, StringComparison.Ordinal);
        Assert.Contains("PublicAOT hydration", architecture, StringComparison.Ordinal);
        Assert.Contains("rights proof", architecture, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("transparency log", architecture, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("no separate public rights endpoint", architecture, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ApiAndIntegrityDocs_DescribeFinalRightsV3Contracts()
    {
        string api = ReadRepoFile("docs/api/contracts.md");
        string canonicalHash = ReadRepoFile("docs/integrity/article-rights-canonical-hash.md");
        string proof = ReadRepoFile("docs/integrity/article-rights-proof.md");

        Assert.Contains("ArticleWriteRequest V3", api, StringComparison.Ordinal);
        Assert.Contains("ArticleDetail AEDS V3", api, StringComparison.Ordinal);
        Assert.Contains("does not request a separate rights endpoint", api, StringComparison.Ordinal);
        Assert.Contains("legacy ArticleDetail", api, StringComparison.OrdinalIgnoreCase);

        Assert.Contains("Rights V3 canonical hash", canonicalHash, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("frozen rights policy snapshot", canonicalHash, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("content canonical hash", canonicalHash, StringComparison.OrdinalIgnoreCase);

        Assert.Contains("Article Rights Proof", proof, StringComparison.Ordinal);
        Assert.Contains("rightsPolicyHash", proof, StringComparison.Ordinal);
        Assert.Contains("contentCanonicalHash", proof, StringComparison.Ordinal);
        Assert.Contains("transparency log", proof, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CutoverRunbook_StatesExactNoCompatDeploymentOrderAndOperatorChecks()
    {
        string runbook = ReadRepoFile("docs/rights-v3-cutover-runbook.md");

        string[] orderedSteps =
        [
            "backup database",
            "backup runtime artifacts",
            "apply DB migration",
            "recompute-article-rights",
            "clear-legacy-public-artifacts",
            "rebuild-article-detail-aeds-v3",
            "rebuild PublicAOT output",
            "run verification tests"
        ];

        int previousIndex = -1;
        foreach (string step in orderedSteps)
        {
            int index = runbook.IndexOf(step, StringComparison.OrdinalIgnoreCase);
            Assert.True(index > previousIndex, $"runbook step missing or out of order: {step}");
            previousIndex = index;
        }

        Assert.Contains("legacy public article artifacts must be cleared and rebuilt", runbook, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("no separate public rights endpoint", runbook, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("missing rights snapshot", runbook, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("failed rights proof", runbook, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("stale ArticleDetail artifact", runbook, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("hydration mismatch", runbook, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("./tools/test.sh ci-tier rights-v3-test-matrix --no-deps", runbook, StringComparison.Ordinal);
    }

    [Fact]
    public void DocumentationIndex_LinksRightsV3FinalDocs()
    {
        string index = ReadRepoFile("docs/index.md");
        string operations = ReadRepoFile("docs/operations.md");
        string integrity = ReadRepoFile("docs/integrity/index.md");

        Assert.Contains("rights-v3-cutover-runbook.md", index, StringComparison.Ordinal);
        Assert.Contains("rights-v3-schema.md", index, StringComparison.Ordinal);
        Assert.Contains("api/contracts.md", index, StringComparison.Ordinal);
        Assert.Contains("integrity/article-rights-canonical-hash.md", index, StringComparison.Ordinal);
        Assert.Contains("integrity/article-rights-proof.md", index, StringComparison.Ordinal);
        Assert.Contains("rights-v3-cutover-runbook.md", operations, StringComparison.Ordinal);
        Assert.Contains("Article Rights Canonical Hash", integrity, StringComparison.Ordinal);
        Assert.Contains("Article Rights Proof", integrity, StringComparison.Ordinal);
    }

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));
}
