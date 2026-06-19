using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RiskControlTestMatrixTests
{
    private static readonly string[] RequiredDecisions = ["allow", "challenge", "step-up", "queue", "throttle", "block"];
    private static readonly string[] RequiredProviders = ["sha256PowV1", "captchaV1", "argon2idPoSpaceV1", "humanReadProofV1", "passkeyStepUpV1", "adminPasskeyStepUpV1"];
    private static readonly string[] RequiredProofFailures = ["replay", "expired", "action-mismatch", "route-mismatch", "device-mismatch"];
    private static readonly string[] RequiredSurfaces = ["auth", "comment", "public-read", "notification", "admin-policy"];
    private static readonly string[] RequiredBrowserModes = ["desktop", "mobile", "wasm-failure", "canvas-fallback", "worker-failure", "slow-device"];
    private static readonly string[] RequiredFaults = ["redis-unavailable", "postgres-slow-write", "provider-missing", "policy-load-failure"];

    [Fact]
    public void RiskControlTestMatrix_CoversIssue495AcceptanceSurface()
    {
        string matrix = BackendTestPaths.ReadAllTextFromRoot("security/risk-control-test-matrix.yml");

        foreach (string token in RequiredDecisions
            .Concat(RequiredProviders)
            .Concat(RequiredProofFailures)
            .Concat(RequiredSurfaces)
            .Concat(RequiredBrowserModes)
            .Concat(RequiredFaults))
        {
            Assert.Contains(token, matrix, StringComparison.Ordinal);
        }

        Assert.Contains("decisionP99Ms: 5", matrix, StringComparison.Ordinal);
        Assert.Contains("powVerifyP99Ms: 50", matrix, StringComparison.Ordinal);
        Assert.Contains("captchaVerifyP99Ms: 75", matrix, StringComparison.Ordinal);
        Assert.Contains("proofConsumeP99Ms: 15", matrix, StringComparison.Ordinal);
    }

    [Fact]
    public void RiskControlTestMatrix_IsFailClosedInSecurityMatrixCheck()
    {
        string checker = BackendTestPaths.ReadAllTextFromRoot("tools/security/check-security-matrices.mjs");

        Assert.Contains("security/risk-control-test-matrix.yml", checker, StringComparison.Ordinal);
        Assert.Contains("risk-control matrix missing scenario", checker, StringComparison.Ordinal);
        Assert.Contains("budgetLimits", checker, StringComparison.Ordinal);
        Assert.Contains("decisionP99Ms", checker, StringComparison.Ordinal);
        Assert.Contains("proofConsumeP99Ms", checker, StringComparison.Ordinal);
    }

    [Fact]
    public void RiskControlTestMatrix_HasDedicatedCiLaneAndBackendRequirement()
    {
        string matrix = BackendTestPaths.ReadAllTextFromRoot("tests/matrix.yml");
        string coverage = BackendTestPaths.ReadAllTextFromRoot("tests/coverage-registry.json");
        string requirements = BackendTestPaths.ReadAllTextFromRoot("tests/backend/Fixtures/backend-test-requirements.json");

        Assert.Contains("id: risk-control-test-matrix", matrix, StringComparison.Ordinal);
        Assert.Contains("tools/test/lanes/risk-control-test-matrix.sh", matrix, StringComparison.Ordinal);
        Assert.Contains("\"id\": \"risk-control-test-matrix\"", coverage, StringComparison.Ordinal);
        Assert.Contains("\"BACKEND-RISKCONTROL-TEST-MATRIX\"", requirements, StringComparison.Ordinal);
    }
}
