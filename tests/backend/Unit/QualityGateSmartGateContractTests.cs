using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class QualityGateSmartGateContractTests
{
    [Fact]
    public void MatrixSchema_AllowsSmartGateAndRetentionMetadata()
    {
        string schema = BackendTestPaths.ReadAllTextFromRoot("tests/matrix.schema.json");

        Assert.Contains("\"prDefault\"", schema, StringComparison.Ordinal);
        Assert.Contains("\"triggerPaths\"", schema, StringComparison.Ordinal);
        Assert.Contains("\"triggerFiles\"", schema, StringComparison.Ordinal);
        Assert.Contains("\"triggerCoverage\"", schema, StringComparison.Ordinal);
        Assert.Contains("\"triggerReason\"", schema, StringComparison.Ordinal);
        Assert.Contains("\"smartGateMode\"", schema, StringComparison.Ordinal);
        Assert.Contains("\"retentionClass\"", schema, StringComparison.Ordinal);
    }

    [Fact]
    public void MatrixTool_ExposesPrSmartGatePlanningAndSkipEvidence()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tools/run-test-matrix.mjs");

        Assert.Contains("ci-pr-plan", source, StringComparison.Ordinal);
        Assert.Contains("ci-pr-smart", source, StringComparison.Ordinal);
        Assert.Contains("fsusblog.pr-smart-gate.v1", source, StringComparison.Ordinal);
        Assert.Contains(".tmp/release-evidence/pr-smart-gate-summary.json", source, StringComparison.Ordinal);
        Assert.Contains("retentionReport", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Matrix_UsesConditionalSmartGateForProductionHeavyLanes()
    {
        string matrix = BackendTestPaths.ReadAllTextFromRoot("tests/matrix.yml");

        Assert.Contains("id: coverage-backend", matrix, StringComparison.Ordinal);
        Assert.Contains("smartGateMode: always", TierBlock(matrix, "coverage-backend"), StringComparison.Ordinal);
        Assert.Contains("smartGateMode: conditional", TierBlock(matrix, "integration"), StringComparison.Ordinal);
        Assert.Contains("smartGateMode: conditional", TierBlock(matrix, "security"), StringComparison.Ordinal);
        Assert.Contains("smartGateMode: conditional", TierBlock(matrix, "acceptance"), StringComparison.Ordinal);
        Assert.Contains("smartGateMode: conditional", TierBlock(matrix, "cross-browser-smoke"), StringComparison.Ordinal);
        Assert.Contains("smartGateMode: conditional", TierBlock(matrix, "backend-qps-cache-hit"), StringComparison.Ordinal);
        Assert.Contains("prDefault: true", TierBlock(matrix, "backend-qps-cache-hit"), StringComparison.Ordinal);
        Assert.Contains("prDefault: true", TierBlock(matrix, "backend-qps-hotread"), StringComparison.Ordinal);
        Assert.Contains("prDefault: true", TierBlock(matrix, "backend-qps-cache-miss-singleflight"), StringComparison.Ordinal);
        Assert.Contains("smartGateMode: full-only", TierBlock(matrix, "production"), StringComparison.Ordinal);
    }

    [Fact]
    public void Workflow_HasPrRiskPlanJobAndConditionsHeavyJobs()
    {
        string workflow = BackendTestPaths.ReadAllTextFromRoot(".github/workflows/quality-gate.yml");

        Assert.Contains("plan-pr-risk:", workflow, StringComparison.Ordinal);
        Assert.Contains("ci-pr-plan", workflow, StringComparison.Ordinal);
        Assert.Contains("pr_smart_gate_summary", workflow, StringComparison.Ordinal);
        Assert.Contains("./tools/test.sh ci-job fast-backend --fresh", workflow, StringComparison.Ordinal);
        Assert.Contains("./tools/test.sh ci-job fast-frontend-unit --fresh", workflow, StringComparison.Ordinal);
        Assert.Contains("needs: [plan-pr-risk, fast-backend, fast-frontend-unit]", workflow, StringComparison.Ordinal);
        Assert.Contains("needs.plan-pr-risk.outputs.backend_qps_collectors", workflow, StringComparison.Ordinal);
        Assert.Contains("github.event_name != 'pull_request'", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void StaticGovernance_RecordsTestRetentionAuditEvidence()
    {
        string matrix = BackendTestPaths.ReadAllTextFromRoot("tests/matrix.yml");
        string registry = BackendTestPaths.ReadAllTextFromRoot("tests/coverage-registry.json");
        string lane = BackendTestPaths.ReadAllTextFromRoot("tools/test/lanes/static-governance.sh");

        Assert.Contains("test-retention-classification", TierBlock(matrix, "static-governance"), StringComparison.Ordinal);
        Assert.Contains(".tmp/release-evidence/test-retention-audit.json", TierBlock(matrix, "static-governance"), StringComparison.Ordinal);
        Assert.Contains("\"id\": \"test-retention-classification\"", registry, StringComparison.Ordinal);
        Assert.Contains("tools/check-test-retention.mjs", lane, StringComparison.Ordinal);
    }

    private static string TierBlock(string matrix, string tierId)
    {
        string marker = $"  - id: {tierId}";
        int start = matrix.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"missing tier {tierId}");
        int next = matrix.IndexOf("\n  - id: ", start + marker.Length, StringComparison.Ordinal);
        return next >= 0 ? matrix[start..next] : matrix[start..];
    }
}
