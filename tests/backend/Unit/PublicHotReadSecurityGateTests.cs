using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicHotReadSecurityGateTests
{
    [Fact]
    public void SecurityGate_SourceUsesPublicReadRiskDecisionAndTelemetry()
    {
        string path = BackendTestPaths.FromRoot(
            "src",
            "backend",
            "Infrastructure",
            "PublicReadArtifacts",
            "PublicHotReadSecurityGateMiddleware.cs");
        Assert.True(File.Exists(path), "Public hot-read must have a pre-fast-path security gate middleware.");

        string source = File.ReadAllText(path);

        Assert.Contains("PublicHotReadFastPath.RequiresSecurityGateForRequest", source, StringComparison.Ordinal);
        Assert.Contains("ISecurityRiskSignalSink", source, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskSources.PublicRead", source, StringComparison.Ordinal);
        Assert.Contains("RiskDecisionKind.Block", source, StringComparison.Ordinal);
        Assert.Contains("RiskDecisionKind.Throttle", source, StringComparison.Ordinal);
        Assert.Contains("RiskDecisionKind.QueueForModeration", source, StringComparison.Ordinal);
        Assert.Contains("PowValidationLogic.ValidateAsync", source, StringComparison.Ordinal);
        Assert.Contains("EndpointFilterResults.FromActionResult", source, StringComparison.Ordinal);
    }
}
