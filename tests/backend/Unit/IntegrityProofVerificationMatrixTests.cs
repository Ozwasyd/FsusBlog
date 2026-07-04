using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class IntegrityProofVerificationMatrixTests
{
    [Fact]
    public void ToolingMatrixAndDocsExposeIntegrityProofVerificationGate()
    {
        string matrix = ReadRepoFile("tests/matrix.yml");
        string coverage = ReadRepoFile("tests/coverage-registry.json");
        string tool = ReadRepoFile("tools/integrity/verify-proof-fixtures.mjs");
        string lane = ReadRepoFile("tools/test/lanes/integrity-proof-verification.sh");
        string docs = ReadRepoFile("docs/integrity/verification.md");

        Assert.Contains("id: integrity-proof-verification", matrix, StringComparison.Ordinal);
        Assert.Contains("command: tools/test/lanes/integrity-proof-verification.sh", matrix, StringComparison.Ordinal);
        Assert.Contains("coverage: [integrity-proof-verification, integrity-proof-tamper-matrix, integrity-proof-schema-migration, integrity-proof-release-evidence]", matrix, StringComparison.Ordinal);
        Assert.Contains(".tmp/release-evidence/integrity-proof-verification.json", matrix, StringComparison.Ordinal);
        Assert.Contains("integrity-proof-verification", ReadRepoFile("tools/run-test-matrix.mjs"), StringComparison.Ordinal);

        Assert.Contains("\"id\": \"integrity-proof-verification\"", coverage, StringComparison.Ordinal);
        Assert.Contains("\"id\": \"integrity-proof-tamper-matrix\"", coverage, StringComparison.Ordinal);
        Assert.Contains("\"id\": \"integrity-proof-schema-migration\"", coverage, StringComparison.Ordinal);
        Assert.Contains("\"id\": \"integrity-proof-release-evidence\"", coverage, StringComparison.Ordinal);

        Assert.Contains("dotnet", tool, StringComparison.Ordinal);
        Assert.Contains("FullyQualifiedName~IntegrityProofVerification", tool, StringComparison.Ordinal);
        Assert.Contains("tamperMatrix", tool, StringComparison.Ordinal);
        Assert.Contains("releaseEvidence", tool, StringComparison.Ordinal);
        Assert.Contains("externalNetwork: false", tool, StringComparison.Ordinal);
        Assert.DoesNotContain("http://", tool, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("https://", tool, StringComparison.OrdinalIgnoreCase);

        Assert.Contains("verify-proof-fixtures.mjs", lane, StringComparison.Ordinal);
        Assert.Contains("articleRevisionId", docs, StringComparison.Ordinal);
        Assert.Contains("revisionNo", docs, StringComparison.Ordinal);
        Assert.Contains("ArticleDetailAeds", docs, StringComparison.Ordinal);
        Assert.Contains("PublicHotRead", docs, StringComparison.Ordinal);
        Assert.Contains("PublicAOT", docs, StringComparison.Ordinal);
        Assert.Contains("payload tamper", docs, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("signature tamper", docs, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("checkpoint tamper", docs, StringComparison.OrdinalIgnoreCase);
    }

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));
}
