using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousPrivacyMatrixTests
{
    private static readonly string[] RequiredPrivacyCases =
    [
        "no-cookie",
        "no-authorization",
        "cookie-rejected",
        "authorization-rejected",
        "comment.user_id:null",
        "zk-failure-no-anonymous-downgrade",
        "zk-failure-no-public-publish",
        "verifier-unavailable-fail-closed",
        "root-expired-fail-closed",
        "proof-invalid-fail-closed",
        "ticket-consume-once",
        "ticket-expired-rejected",
        "same-article-scope-stable-nullifier",
        "different-article-scope-different-nullifier",
        "blocked-nullifier-rejected",
        "scope-limit-exceeded-rejected",
        "provider-no-userId-username-proof-raw-nullifier",
        "log-redaction-proof-witness-credential-secret-raw-nullifier-cookie-authorization",
        "admin-no-account-reversal",
        "public-signature-explicit-opt-in"
    ];

    private static readonly string[] RequiredConcurrencyCases =
    [
        "concurrent-same-nullifier-scope-policy-limit",
        "concurrent-ticket-consume-once",
        "root-snapshot-cached-high-frequency",
        "verifier-bounded-concurrency",
        "anonymous-ticket-cheap-reject",
        "comment-submit-invalidation-nonblocking"
    ];

    private static readonly string[] RequiredLocalCommands =
    [
        "check:privacy-zk-contract",
        "check:privacy-zk-frontend",
        "check:privacy-zk-backend",
        "check:privacy-zk-concurrency",
        "check:privacy-zk"
    ];

    [Fact]
    public void PrivacyZkCommentMatrix_CoversRequiredPrivacyAndConcurrencyCases()
    {
        string matrix = BackendTestPaths.ReadAllTextFromRoot("security/privacy-zk-comment-matrix.yml");

        foreach (string token in RequiredPrivacyCases.Concat(RequiredConcurrencyCases).Concat(RequiredLocalCommands))
        {
            Assert.Contains(token, matrix, StringComparison.Ordinal);
        }

        Assert.Contains("id: PRIVACY-ZK-TRANSPORT", matrix, StringComparison.Ordinal);
        Assert.Contains("id: PRIVACY-ZK-FAIL-CLOSED", matrix, StringComparison.Ordinal);
        Assert.Contains("id: PRIVACY-ZK-TICKET-NULLIFIER", matrix, StringComparison.Ordinal);
        Assert.Contains("id: PRIVACY-ZK-MODERATION-LOGGING", matrix, StringComparison.Ordinal);
        Assert.Contains("id: PRIVACY-ZK-FRONTEND-RUNTIME", matrix, StringComparison.Ordinal);
        Assert.Contains("id: PRIVACY-ZK-CONCURRENCY", matrix, StringComparison.Ordinal);
    }

    [Fact]
    public void PrivacyZkCommentMatrix_IsFailClosedBySecurityMatrixChecker()
    {
        string checker = BackendTestPaths.ReadAllTextFromRoot("tools/security/check-security-matrices.mjs");

        Assert.Contains("security/privacy-zk-comment-matrix.yml", checker, StringComparison.Ordinal);
        Assert.Contains("verifyPrivacyZkCommentMatrix", checker, StringComparison.Ordinal);
        Assert.Contains("privacy-zk matrix missing required case", checker, StringComparison.Ordinal);
        Assert.Contains("privacy-zk matrix missing concurrency case", checker, StringComparison.Ordinal);
    }

    [Fact]
    public void PrivacyZkCommentMatrix_HasLocalCommandsAndCiGate()
    {
        string packageJson = BackendTestPaths.ReadAllTextFromRoot("src/frontend/package.json");
        string testMatrix = BackendTestPaths.ReadAllTextFromRoot("tests/matrix.yml");
        string coverageRegistry = BackendTestPaths.ReadAllTextFromRoot("tests/coverage-registry.json");
        string workflow = BackendTestPaths.ReadAllTextFromRoot(".github/workflows/quality-gate.yml");
        string requirements = BackendTestPaths.ReadAllTextFromRoot("tests/backend/Fixtures/backend-test-requirements.json");

        foreach (string command in RequiredLocalCommands)
        {
            Assert.Contains($"\"{command}\"", packageJson, StringComparison.Ordinal);
        }

        Assert.Contains("id: privacy-zk-comment-matrix", testMatrix, StringComparison.Ordinal);
        Assert.Contains("tools/test/lanes/privacy-zk-comment-matrix.sh", testMatrix, StringComparison.Ordinal);
        Assert.Contains("\"id\": \"privacy-zk-comment-matrix\"", coverageRegistry, StringComparison.Ordinal);
        Assert.Contains("privacy-zk-comment-matrix --no-deps", workflow, StringComparison.Ordinal);
        Assert.Contains("\"BACKEND-PRIVACY-ZK-COMMENT-GATE\"", requirements, StringComparison.Ordinal);
        Assert.Contains("RejectIdentifiedPrincipalFilterTests", packageJson, StringComparison.Ordinal);
        Assert.Contains("PodBinaryCodecTests", packageJson, StringComparison.Ordinal);
        Assert.Contains("BackendGoldenCatalogTests", packageJson, StringComparison.Ordinal);
    }

    [Fact]
    public void PrivacyZkCommentEvidence_PointsAtExecutableBackendAndFrontendTests()
    {
        string backendConcurrency = BackendTestPaths.ReadAllTextFromRoot("tests/backend/Unit/AnonymousPrivacyConcurrencyTests.cs");
        string frontendGate = BackendTestPaths.ReadAllTextFromRoot("tests/frontend/unit/privacy/commentPrivacyReleaseGate.test.ts");
        string runtimeTest = BackendTestPaths.ReadAllTextFromRoot("tests/frontend/unit/privacy/commentPrivacyRuntime.test.ts");

        Assert.Contains("Task.WhenAll", backendConcurrency, StringComparison.Ordinal);
        Assert.Contains("Barrier", backendConcurrency, StringComparison.Ordinal);
        Assert.Contains("SemaphoreSlim", backendConcurrency, StringComparison.Ordinal);
        Assert.Contains("vi.useFakeTimers", runtimeTest, StringComparison.Ordinal);
        Assert.Contains("credentials: 'omit'", frontendGate, StringComparison.Ordinal);
        Assert.Contains("transfers proof input buffers", frontendGate, StringComparison.Ordinal);
        Assert.Contains("Abort", frontendGate, StringComparison.Ordinal);
        Assert.Contains("ui-no-zk-terms", frontendGate, StringComparison.Ordinal);
    }
}
