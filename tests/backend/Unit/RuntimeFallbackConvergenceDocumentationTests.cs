using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RuntimeFallbackConvergenceDocumentationTests
{
    [Fact]
    public void ArchitectureAndSecurityDocs_DoNotPreserveLegacyPlainCookieFallback()
    {
        string architecture = BackendTestPaths.ReadAllTextFromRoot("docs/architecture.md");
        string security = BackendTestPaths.ReadAllTextFromRoot("docs/security.md");
        string combined = string.Join('\n', architecture, security);

        Assert.DoesNotContain("legacy plain fallback 语义保持不变", combined, StringComparison.Ordinal);
        Assert.DoesNotContain("legacy plain fallback semantics remain unchanged", combined, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("legacy plain cookie fallback 已移除", combined, StringComparison.Ordinal);
        Assert.Contains("host-prefixed cookie", combined, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AuthCookies:AllowInsecureTransportCookies", combined, StringComparison.Ordinal);
    }
}
