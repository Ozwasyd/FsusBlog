using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthRiskControlEndpointContractTests
{
    [Fact]
    public void PasswordLoginEndpoint_RoutesThroughRiskControlAndRecordsFailures()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string handler = ExtractBetween(
            source,
            "group.MapPost(\"/auth/login\"",
            "group.MapPost(\"/auth/register\"");

        Assert.Contains("ISecurityRiskSignalSink riskSignals", handler, StringComparison.Ordinal);
        Assert.Contains("RecordAuthLoginFailureAsync(httpContext, riskSignals, cancellationToken)", handler, StringComparison.Ordinal);
        Assert.Contains(".WithRiskAction(RiskActionNames.AuthLogin)", handler, StringComparison.Ordinal);
        Assert.Contains(".AddEndpointFilter<RequiresRiskControlFilter>()", handler, StringComparison.Ordinal);
        Assert.Contains(".AddEndpointFilter<RequiresPowFilter>()", handler, StringComparison.Ordinal);
    }

    [Fact]
    public void PasskeyLoginEndpoints_RouteThroughRiskControlAndUpdateAuthRisk()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string begin = ExtractBetween(
            source,
            "group.MapPost(\"/auth/passkey/login/begin\"",
            "group.MapPost(\"/auth/passkey/login/complete\"");
        string complete = ExtractBetween(
            source,
            "group.MapPost(\"/auth/passkey/login/complete\"",
            "group.MapGet(\"/auth/passkey/credentials\"");

        Assert.Contains(".WithRiskAction(RiskActionNames.AuthPasskeyBegin)", begin, StringComparison.Ordinal);
        Assert.Contains(".AddEndpointFilter<RequiresRiskControlFilter>()", begin, StringComparison.Ordinal);
        Assert.Contains("ISecurityRiskSignalSink riskSignals", complete, StringComparison.Ordinal);
        Assert.Contains("RecordPasskeyAssertionFailureAsync(httpContext, riskSignals, cancellationToken)", complete, StringComparison.Ordinal);
        Assert.Contains("RecordPasskeyAssertionAcceptedAsync(httpContext, riskSignals, cancellationToken)", complete, StringComparison.Ordinal);
        Assert.Contains("mfaVerified: true", complete, StringComparison.Ordinal);
        Assert.Contains(".WithRiskAction(RiskActionNames.AuthPasskeyComplete)", complete, StringComparison.Ordinal);
        Assert.Contains(".AddEndpointFilter<RequiresRiskControlFilter>()", complete, StringComparison.Ordinal);
    }

    [Fact]
    public void RecoveryKeyVerifyEndpoint_RequiresRiskControlChallengeAndRetainsPow()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string handler = ExtractBetween(
            source,
            "group.MapPost(\"/auth/recovery-key/verify\"",
            "group.MapPost(\"/auth/recovery-key/passkey/register/begin\"");

        Assert.Contains(".AllowAnonymous()", handler, StringComparison.Ordinal);
        Assert.Contains(".RequireRateLimiting(\"fixed_ip\")", handler, StringComparison.Ordinal);
        Assert.Contains(".WithRiskAction(RiskActionNames.RecoveryKeyVerify)", handler, StringComparison.Ordinal);
        Assert.Contains(".AddEndpointFilter<RequiresRiskControlFilter>()", handler, StringComparison.Ordinal);
        Assert.Contains(".AddEndpointFilter<RequiresPowFilter>()", handler, StringComparison.Ordinal);
        Assert.Contains(".RequireNoStoreResponse()", handler, StringComparison.Ordinal);
    }

    [Fact]
    public void AuthRiskSignals_UseDedicatedReasonsSourcesAndActions()
    {
        string abstractions = ReadSource("src/backend/Infrastructure/Security/SecurityRiskAbstractions.cs");
        string endpoints = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");

        Assert.Contains("AuthLoginFailed", abstractions, StringComparison.Ordinal);
        Assert.Contains("PasskeyAssertionFailed", abstractions, StringComparison.Ordinal);
        Assert.Contains("PasskeyAssertionAccepted", abstractions, StringComparison.Ordinal);
        Assert.Contains("public const string Auth = \"auth\"", abstractions, StringComparison.Ordinal);
        Assert.Contains("public const string Passkey = \"passkey\"", abstractions, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskReason.AuthLoginFailed", endpoints, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskReason.PasskeyAssertionFailed", endpoints, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskReason.PasskeyAssertionAccepted", endpoints, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskSources.Auth", endpoints, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskSources.Passkey", endpoints, StringComparison.Ordinal);
    }

    private static string ReadSource(string relativePath, [CallerFilePath] string sourceFilePath = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex, StringComparison.Ordinal);
        Assert.True(endIndex >= 0, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }
}
