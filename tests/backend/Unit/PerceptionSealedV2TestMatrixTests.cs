using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PerceptionSealedV2TestMatrixTests
{
    private static readonly string[] RequiredScenarioIds =
    [
        "PERCEPTION-V2-CONTRACTS",
        "PERCEPTION-V2-UNIT-CRYPTO",
        "PERCEPTION-V2-INTEGRATION-HOTPATH",
        "PERCEPTION-V2-E2E-FRONTEND",
        "PERCEPTION-V2-PERFORMANCE-BUDGETS",
        "PERCEPTION-V2-FAILURE-MODES"
    ];

    private static readonly string[] RequiredCoverageTokens =
    [
        "AEDS frame",
        "forbidden-fields",
        "answer",
        "glyphIds",
        "charIds",
        "expectedPoint",
        "recipeHash",
        "sealedToken",
        "AEAD",
        "O(1) verify",
        "constant-time compare",
        "challengeId-mismatch",
        "action-mismatch",
        "routeKey-mismatch",
        "subjectHash-mismatch",
        "clientIpHash-mismatch",
        "deviceFpHash-mismatch",
        "policyVersion-mismatch",
        "recipeHash-mismatch",
        "solveDuration",
        "issue-no-db-redis-write",
        "verify-redis-setnx-incr",
        "async-audit",
        "verify-no-image-recompute",
        "text-task",
        "localization",
        "micro-interaction-disabled",
        "micro-interaction-enabled",
        "worker-failure",
        "mobile-fallback",
        "redis-unavailable",
        "postgres-slow-write",
        "provider-missing",
        "policy-load-failure"
    ];

    [Fact]
    public void PerceptionSealedV2Matrix_CoversIssue523AcceptanceSurface()
    {
        string matrix = BackendTestPaths.ReadAllTextFromRoot("security/perception-v2-test-matrix.yml");

        foreach (string scenarioId in RequiredScenarioIds)
        {
            Assert.Contains($"id: {scenarioId}", matrix, StringComparison.Ordinal);
        }

        foreach (string token in RequiredCoverageTokens)
        {
            Assert.Contains(token, matrix, StringComparison.Ordinal);
        }

        Assert.Contains("issueP99Ms: 8", matrix, StringComparison.Ordinal);
        Assert.Contains("verifyP99Ms: 32", matrix, StringComparison.Ordinal);
        Assert.Contains("payloadP95Bytes: 6200", matrix, StringComparison.Ordinal);
        Assert.Contains("clientRenderP95Ms: 55", matrix, StringComparison.Ordinal);
    }

    [Fact]
    public void PerceptionSealedV2Matrix_IsFailClosedInSecurityMatrixCheck()
    {
        string checker = BackendTestPaths.ReadAllTextFromRoot("tools/security/check-security-matrices.mjs");

        Assert.Contains("security/perception-v2-test-matrix.yml", checker, StringComparison.Ordinal);
        Assert.Contains("perception-v2 matrix missing scenario", checker, StringComparison.Ordinal);
        Assert.Contains("perceptionBudgetLimits", checker, StringComparison.Ordinal);
        Assert.Contains("issueP99Ms", checker, StringComparison.Ordinal);
        Assert.Contains("clientRenderP95Ms", checker, StringComparison.Ordinal);
    }

    [Fact]
    public void PerceptionSealedV2Matrix_HasDedicatedCiLaneAndBackendRequirement()
    {
        string matrix = BackendTestPaths.ReadAllTextFromRoot("tests/matrix.yml");
        string coverage = BackendTestPaths.ReadAllTextFromRoot("tests/coverage-registry.json");
        string requirements = BackendTestPaths.ReadAllTextFromRoot("tests/backend/Fixtures/backend-test-requirements.json");
        string workflow = BackendTestPaths.ReadAllTextFromRoot(".github/workflows/quality-gate.yml");

        Assert.Contains("id: perception-v2-test-matrix", matrix, StringComparison.Ordinal);
        Assert.Contains("tools/test/lanes/perception-v2-test-matrix.sh", matrix, StringComparison.Ordinal);
        Assert.Contains("\"id\": \"perception-v2-test-matrix\"", coverage, StringComparison.Ordinal);
        Assert.Contains("\"BACKEND-PERCEPTION-V2-TEST-MATRIX\"", requirements, StringComparison.Ordinal);
        Assert.Contains("./tools/test.sh perception-v2-test-matrix --no-deps", workflow, StringComparison.Ordinal);
    }
}
