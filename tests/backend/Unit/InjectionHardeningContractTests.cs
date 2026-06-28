using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class InjectionHardeningContractTests
{
    [Fact]
    public void LocalAuthFixture_ValidatesScriptPathUnderExpectedFixturesDirectory()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/LocalAuthFixtureEndpoints.cs");

        Assert.Contains("ValidateLocalAuthFixtureScriptPath", source, StringComparison.Ordinal);
        Assert.Contains("\"prepare-auth-smoke-users.mjs\"", source, StringComparison.Ordinal);
        Assert.Contains("Path.GetFullPath", source, StringComparison.Ordinal);
        Assert.Contains("tests", source, StringComparison.Ordinal);
        Assert.Contains("frontend", source, StringComparison.Ordinal);
        Assert.Contains("fixtures", source, StringComparison.Ordinal);
        Assert.Contains("IsPathWithinDirectory", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AotSidecarAndWorkerPaths_StayInsideTheirCanonicalRoots()
    {
        string cache = ReadSource("src/backend/Infrastructure/PublicAot/PublicAotFileShellCache.cs");
        string document = ReadSource("src/backend/Infrastructure/PublicAot/PublicAotDocumentService.cs");
        string renderer = ReadSource("src/backend/Infrastructure/PublicAot/PublicAotNodeSsrRenderer.cs");

        Assert.Contains("TryResolveHydrationSidecarPath", cache, StringComparison.Ordinal);
        Assert.Contains("Path.GetFullPath", cache, StringComparison.Ordinal);
        Assert.Contains("IsPathWithinDirectory", cache, StringComparison.Ordinal);

        Assert.Contains("TryResolveHydrationSidecarPath", document, StringComparison.Ordinal);
        Assert.Contains("Path.GetFullPath", document, StringComparison.Ordinal);
        Assert.Contains("IsPathWithinDirectory", document, StringComparison.Ordinal);

        Assert.Contains("ResolveWorkerScriptPath", renderer, StringComparison.Ordinal);
        Assert.Contains("Path.GetFullPath", renderer, StringComparison.Ordinal);
        Assert.Contains("IsPathWithinDirectory", renderer, StringComparison.Ordinal);
    }

    [Fact]
    public void UploadPathResolution_RejectsTraversalAndUsesCanonicalDirectoryChecks()
    {
        string fileService = ReadSource("src/backend/Services/FileService.cs");
        string adminOps = ReadSource("src/backend/Infrastructure/Operations/AdminOperationsService.cs");

        Assert.Contains("IsPathWithinDirectory", fileService, StringComparison.Ordinal);
        Assert.Contains("Path.GetRelativePath", fileService, StringComparison.Ordinal);
        Assert.Contains("TryResolveUploadPath", adminOps, StringComparison.Ordinal);
        Assert.Contains("Path.GetFullPath", adminOps, StringComparison.Ordinal);
        Assert.Contains("Path.GetRelativePath", adminOps, StringComparison.Ordinal);
    }

    [Fact]
    public void UserControlledLogFields_AreSanitizedBeforeStructuredLogging()
    {
        string humanRead = ReadSource("src/backend/Services/HumanReadProofService.cs");

        Assert.Contains("SanitizeLogValue", humanRead, StringComparison.Ordinal);
        Assert.Contains("SanitizeLogValue(payload.Scope)", humanRead, StringComparison.Ordinal);
        Assert.Contains("SanitizeLogValue(payload.RouteKey)", humanRead, StringComparison.Ordinal);
    }

    private static string ReadSource(string relativePath, [CallerFilePath] string sourceFilePath = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));
}
