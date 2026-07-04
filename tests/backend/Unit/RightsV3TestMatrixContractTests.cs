using System.Text.Json;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RightsV3TestMatrixContractTests
{
    private const string LaneId = "rights-v3-test-matrix";
    private const string LaneScript = "tools/test/lanes/rights-v3-test-matrix.sh";
    private const string EvidencePath = ".tmp/release-evidence/rights-v3-test-matrix.json";

    [Fact]
    public void Matrix_DeclaresDedicatedRightsV3LaneAndCoverageEvidence()
    {
        string matrix = ReadRepoFile("tests/matrix.yml");
        string registry = ReadRepoFile("tests/coverage-registry.json");

        Assert.Contains("- id: rights-v3-test-matrix", matrix, StringComparison.Ordinal);
        Assert.Contains($"command: {LaneScript}", matrix, StringComparison.Ordinal);
        Assert.Contains("dependsOn: [validate-matrix]", matrix, StringComparison.Ordinal);
        Assert.Contains("requiresNode: true", matrix, StringComparison.Ordinal);
        Assert.Contains("requiresDotnet: true", matrix, StringComparison.Ordinal);
        Assert.Contains("risk: critical", matrix, StringComparison.Ordinal);
        Assert.Contains("coverage: [rights-v3-test-matrix]", matrix, StringComparison.Ordinal);
        Assert.Contains($"evidence: [{EvidencePath}]", matrix, StringComparison.Ordinal);

        using JsonDocument document = JsonDocument.Parse(registry);
        JsonElement entries = document.RootElement.GetProperty("entries");
        JsonElement entry = entries.EnumerateArray().Single(item => item.GetProperty("id").GetString() == LaneId);

        Assert.Equal("integration", entry.GetProperty("assertionType").GetString());
        Assert.Contains(EvidencePath, entry.GetProperty("evidencePaths").EnumerateArray().Select(item => item.GetString()));
        Assert.Contains("backend", entry.GetProperty("minimumRequirement").GetString(), StringComparison.OrdinalIgnoreCase);
        Assert.Contains("frontend", entry.GetProperty("minimumRequirement").GetString(), StringComparison.OrdinalIgnoreCase);
        Assert.Contains("performance", entry.GetProperty("minimumRequirement").GetString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void LaneScript_RunsEveryRightsV3AcceptanceSlice()
    {
        string script = ReadRepoFile(LaneScript);

        string[] backendCoverage =
        [
            "SchemaMigrationRegistryTests",
            "SchemaMigrationIntegrationTests",
            "ArticleRightsCanonicalHashTests",
            "ArticleRightsWritePathTests",
            "PodBinaryCodecTests",
            "ArticleServiceValidationTests",
            "PublicContentInvalidationFlowTests",
            "IntegrityProofPipelineTests",
            "ArticleRightsProofModelTests",
            "PublicHotReadFastPathTests",
            "RightsV3TestMatrixContractTests"
        ];
        string[] frontendCoverage =
        [
            "tests/frontend/unit/protocol/aeds-contract.test.ts",
            "tests/frontend/unit/api/article.test.ts",
            "tests/frontend/unit/api/authoring.test.ts",
            "tests/frontend/unit/view-contracts/articleDetailRights.test.ts",
            "tests/frontend/unit/view-contracts/articleRightsEditorWorkflow.test.ts",
            "tests/frontend/unit/view-contracts/articleRightsPublicWorkflow.test.ts",
            "tests/frontend/unit/composables/useCodeBlockCopy.test.ts",
            "tests/frontend/unit/public-renderers/publicEntryRegistry.test.ts",
            "tests/frontend/unit/public-renderers/publicPayloadNormalizer.test.ts",
            "tests/frontend/unit/bootstrap/publicSeedReaders.test.ts",
            "tests/frontend/unit/services/publicReadHydrationGuard.test.ts"
        ];

        foreach (string testName in backendCoverage)
        {
            Assert.Contains(testName, script, StringComparison.Ordinal);
        }

        foreach (string testPath in frontendCoverage)
        {
            Assert.Contains(testPath, script, StringComparison.Ordinal);
        }

        Assert.Contains("dotnet test tests/backend/FsusBlog.Server.Tests.csproj", script, StringComparison.Ordinal);
        Assert.Contains("vitest run", script, StringComparison.Ordinal);
        Assert.Contains(EvidencePath, script, StringComparison.Ordinal);
    }

    [Fact]
    public void Contracts_PinArticleDetailArtifactHitAndLegacyRejection()
    {
        string endpoint = ReadRepoFile("src/backend/Services/ArticleEndpointService.cs");
        string artifactStore = ReadRepoFile("src/backend/Infrastructure/PublicReadArtifacts/ArticleDetailAedsArtifactStore.cs");
        string codecTests = ReadRepoFile("tests/backend/Unit/PodBinaryCodecTests.cs");
        string publicWorkflow = ReadRepoFile("tests/frontend/unit/view-contracts/articleRightsPublicWorkflow.test.ts");
        string fastPathTests = ReadRepoFile("tests/backend/Unit/PublicHotReadFastPathTests.cs");

        string artifactHitMethod = Slice(
            endpoint,
            "public async Task<ArticleDetailArtifactPayload> GetPublicArtifactBackedDetailAsync",
            "public async Task<ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>>> GetHotArticlesAsync");
        Assert.Contains("detailArtifacts.TryReadAsync", artifactHitMethod, StringComparison.Ordinal);
        Assert.Contains("if (artifact.Found)", artifactHitMethod, StringComparison.Ordinal);
        Assert.Contains("BackfillQueued: false", artifactHitMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("core.GetByIdAsync", artifactHitMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("articles.GetByIdAsync", artifactHitMethod, StringComparison.Ordinal);

        string tryReadMethod = Slice(
            artifactStore,
            "public async Task<ArticleDetailAedsArtifact> TryReadAsync",
            "public async Task WriteAsync");
        Assert.DoesNotContain("article_rights_snapshot", tryReadMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("article_rights_proof", tryReadMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("db.", tryReadMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("Queryable", tryReadMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("Ado.", tryReadMethod, StringComparison.Ordinal);

        Assert.Contains("ArticleDetail_DecodeRejectsLegacyPayloadWithoutV3Envelope", codecTests, StringComparison.Ordinal);
        Assert.Contains("LegacyPublicArticleArtifact_IsNotAcceptedAsArticleDetailV3", codecTests, StringComparison.Ordinal);
        Assert.Contains("does not add a separate public rights endpoint or side channel", publicWorkflow, StringComparison.Ordinal);
        Assert.Contains("PreencodedArticleDetailHotPath", fastPathTests, StringComparison.Ordinal);
    }

    [Fact]
    public void Documentation_ExplainsLocalRightsV3MatrixRun()
    {
        string docs = ReadRepoFile("docs/testing.md");

        Assert.Contains("Rights V3 test matrix", docs, StringComparison.Ordinal);
        Assert.Contains("./tools/test.sh ci-tier rights-v3-test-matrix --no-deps", docs, StringComparison.Ordinal);
        Assert.Contains("tools/test/lanes/rights-v3-test-matrix.sh", docs, StringComparison.Ordinal);
        Assert.Contains("artifact-hit public read does not query rights tables", docs, StringComparison.Ordinal);
        Assert.Contains("legacy public article artifact is not accepted as V3", docs, StringComparison.Ordinal);
        Assert.Contains("preencoded ArticleDetail artifact hot path", docs, StringComparison.Ordinal);
    }

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string Slice(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"missing start marker: {startMarker}");
        int end = source.IndexOf(endMarker, start, StringComparison.Ordinal);
        Assert.True(end > start, $"missing end marker: {endMarker}");
        return source[start..end];
    }
}
