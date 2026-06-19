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

    private static readonly string[] RequiredCryptoDecisionTokens =
    [
        "BBS+",
        "Groth16",
        "fsus.anonymous.comment.v1",
        "public_input_layout_version",
        "verifying_key_hash",
        "nullifier = PRF(credential_secret, action_context, scope)",
        "credential root",
        "revocation root",
        "trusted setup",
        "vk hash",
        "fail-closed"
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
    public void PrivacyZkCryptoDecisionDocs_StayAlignedWithMatrixAndContractConstants()
    {
        string adrPath = BackendTestPaths.FromRoot("docs", "architecture", "decisions", "ADR-ZK-BBS-Groth16.md");
        Assert.True(File.Exists(adrPath), "docs/architecture/decisions/ADR-ZK-BBS-Groth16.md must document the BBS+/Groth16 production ZK decision.");

        string adr = File.ReadAllText(adrPath);
        string security = BackendTestPaths.ReadAllTextFromRoot("docs/security.md");
        string architecture = BackendTestPaths.ReadAllTextFromRoot("docs/architecture.md");
        string matrix = BackendTestPaths.ReadAllTextFromRoot("security/privacy-zk-comment-matrix.yml");
        string verifierContracts = BackendTestPaths.ReadAllTextFromRoot("tests/backend/Unit/ZkAnonymousProofVerifierContractTests.cs");

        foreach (string token in RequiredCryptoDecisionTokens)
        {
            Assert.Contains(token, adr, StringComparison.Ordinal);
            Assert.Contains(token, matrix, StringComparison.Ordinal);
        }

        foreach (string doc in new[] { security, architecture })
        {
            Assert.Contains("ADR-ZK-BBS-Groth16.md", doc, StringComparison.Ordinal);
            Assert.Contains("BBS+", doc, StringComparison.Ordinal);
            Assert.Contains("Groth16", doc, StringComparison.Ordinal);
            Assert.Contains("fsus.anonymous.comment.v1", doc, StringComparison.Ordinal);
            Assert.Contains("fail-closed", doc, StringComparison.Ordinal);
        }

        Assert.Contains("valid credential", adr, StringComparison.Ordinal);
        Assert.Contains("current credential root", adr, StringComparison.Ordinal);
        Assert.Contains("not revoked", adr, StringComparison.Ordinal);
        Assert.Contains("qualification", adr, StringComparison.Ordinal);
        Assert.Contains("nullifier correctness", adr, StringComparison.Ordinal);
        Assert.Contains("credential_level", adr, StringComparison.Ordinal);
        Assert.Contains("account identity not disclosed", adr, StringComparison.Ordinal);
        Assert.Contains("PS+Plonk", adr, StringComparison.Ordinal);
        Assert.Contains("Semaphore-style", adr, StringComparison.Ordinal);
        Assert.Contains("external hosted network", adr, StringComparison.Ordinal);
        Assert.Contains("private const string CircuitId = \"fsus.anonymous.comment.v1\";", verifierContracts, StringComparison.Ordinal);
        Assert.Contains("private const ushort PublicInputLayoutVersion = 2;", verifierContracts, StringComparison.Ordinal);
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
