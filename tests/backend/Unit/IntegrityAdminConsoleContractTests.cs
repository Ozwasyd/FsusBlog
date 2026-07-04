using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class IntegrityAdminConsoleContractTests
{
    [Fact]
    public void AdminIntegrityConsoleEndpoints_UseSystemConfigAndAdminStepUpForRetry()
    {
        string endpoints = ReadRepoFile("src", "backend", "Modules", "Endpoints", "AdminIntegrityConsoleEndpoints.cs");
        string composition = ReadRepoFile("src", "backend", "Infrastructure", "Bootstrap", "WebApplicationCompositionExtensions.cs");
        string serviceRegistration = ReadRepoFile("src", "backend", "Infrastructure", "Bootstrap", "RuntimeDomainServiceCollectionExtensions.cs");

        Assert.Contains("MapAdminIntegrityConsoleEndpoints", composition, StringComparison.Ordinal);
        Assert.Contains("MapGroup(\"/api/admin/integrity/console\")", endpoints, StringComparison.Ordinal);
        Assert.Contains("RequireAdminPermission(AdminPermissions.SystemConfig)", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapGet(string.Empty", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapPost(\"/proofs/{proofId:long}/retry\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("ValidateAndConsumeAdminStepUpProofTokenAsync", endpoints, StringComparison.Ordinal);
        Assert.Contains("\"X-Fsus-Mfa-Proof\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("\"admin-sensitive\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("TrustedRequestOrigin.RequireTrustedOriginOrReferer", endpoints, StringComparison.Ordinal);
        Assert.Contains("AddScoped<IIntegrityAdminConsoleService, IntegrityAdminConsoleService>", serviceRegistration, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminIntegrityConsoleDtos_DoNotExposePrivateKeysOrInternalFailureDetails()
    {
        string dto = ReadRepoFile("src", "backend", "Infrastructure", "Integrity", "IntegrityAdminConsole.cs");

        foreach (string forbidden in new[]
        {
            "PrivateKeyPkcs8Base64Url",
            "PrivateKeyAvailable",
            "FailureDetail",
            "CreatedByAdminPrincipalId",
            "IpAddress",
            "SessionId",
            "DeviceFingerprint"
        })
        {
            Assert.DoesNotContain(forbidden, dto, StringComparison.Ordinal);
        }

        Assert.Contains("IntegrityAdminKeyStatusResponse", dto, StringComparison.Ordinal);
        Assert.Contains("IntegrityAdminProofRowResponse", dto, StringComparison.Ordinal);
        Assert.Contains("\"active\"", dto, StringComparison.Ordinal);
        Assert.Contains("\"old\"", dto, StringComparison.Ordinal);
        Assert.Contains("\"revoked\"", dto, StringComparison.Ordinal);
        Assert.Contains("\"compromised\"", dto, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminIntegrityConsoleFrontend_HasRouteApiViewAndGovernanceText()
    {
        string router = ReadRepoFile("src", "frontend", "src", "router", "index.ts");
        string api = ReadRepoFile("src", "frontend", "src", "api", "integrityConsole.ts");
        string view = ReadRepoFile("src", "frontend", "src", "views", "admin", "IntegrityProofConsole.vue");
        string docs = ReadRepoFile("docs", "integrity", "admin-console.md");

        Assert.Contains("manage/integrity-proof", router, StringComparison.Ordinal);
        Assert.Contains("ManageIntegrityProof", router, StringComparison.Ordinal);
        Assert.Contains("system.config", router, StringComparison.Ordinal);
        Assert.Contains("getIntegrityAdminConsole", api, StringComparison.Ordinal);
        Assert.Contains("retryIntegrityProof", api, StringComparison.Ordinal);
        Assert.Contains("X-Fsus-Mfa-Proof", api, StringComparison.Ordinal);
        Assert.Contains("useAdminSensitiveProof", view, StringComparison.Ordinal);
        Assert.Contains("暂无 proof", view, StringComparison.Ordinal);
        Assert.Contains("failed", docs, StringComparison.Ordinal);
        Assert.Contains("retrying", docs, StringComparison.Ordinal);
        Assert.Contains("chain-broken", docs, StringComparison.Ordinal);
        Assert.Contains("key-revoked", docs, StringComparison.Ordinal);
        Assert.Contains("system.config", docs, StringComparison.Ordinal);
        Assert.Contains("step-up", docs, StringComparison.OrdinalIgnoreCase);
    }

    private static string ReadRepoFile(params string[] segments)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, Path.Combine(segments)));
}
