using System.Runtime.CompilerServices;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthorizationAccessControlHardeningTests
{
    [Fact]
    public void ApplicationPipeline_RegistersAntiforgeryAndCsrfOriginGuard()
    {
        string services = ReadSource("src/backend/Infrastructure/Bootstrap/ServiceCollectionExtensions.cs");
        string pipeline = ReadSource("src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs");

        Assert.Contains("services.AddAntiforgery", services, StringComparison.Ordinal);
        Assert.Contains("HeaderName = \"X-Fsus-Csrf-Token\"", services, StringComparison.Ordinal);
        Assert.Contains("UseAntiforgery()", pipeline, StringComparison.Ordinal);
        Assert.Contains("UseFsusCsrfOriginGuard", pipeline, StringComparison.Ordinal);
        AssertOrder(pipeline, "UseCors()", "UseFsusCsrfOriginGuard");
        AssertOrder(pipeline, "UseFsusCsrfOriginGuard", "UseAuthorization()");
    }

    [Fact]
    public void LocalAuthFixture_RequiresDevelopmentSecretAndLoopbackAndFailsClosedInProduction()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/LocalAuthFixtureEndpoints.cs");

        Assert.Contains("app.Environment.IsDevelopment()", source, StringComparison.Ordinal);
        Assert.Contains("RequireLocalFixtureSecret", source, StringComparison.Ordinal);
        Assert.Contains("RequireLoopbackCaller", source, StringComparison.Ordinal);
        Assert.Contains("IsLoopback", source, StringComparison.Ordinal);

        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["fsus:allowLocalAuthFixture"] = "true"
            })
            .Build();

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);
        Assert.Contains(errors, static error => error.Contains("fsus:allowLocalAuthFixture", StringComparison.Ordinal));
    }

    [Fact]
    public void UploadPartAndComplete_RequireUploadSessionToken()
    {
        string endpoints = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Uploads.cs");
        string root = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.cs");
        string dto = ReadSource("src/shared/Contracts/Outputs/ServerResponseContracts.cs");
        string model = ReadSource("src/backend/Models/Dtos/UploadDtos.cs");
        string fileService = ReadSource("src/backend/Services/FileService.cs");

        Assert.Contains("UploadTokenHeader", root, StringComparison.Ordinal);
        Assert.Contains("X-Fsus-Upload-Token", root, StringComparison.Ordinal);
        Assert.Contains("UploadToken", dto, StringComparison.Ordinal);
        Assert.Contains("UploadToken", model, StringComparison.Ordinal);
        Assert.Contains("CreateUploadSessionToken", fileService, StringComparison.Ordinal);
        Assert.Contains("ValidateUploadSessionTokenAsync", fileService, StringComparison.Ordinal);
        Assert.Contains("uploadToken", fileService, StringComparison.Ordinal);

        string part = ExtractBetween(endpoints, "uploadGroup.MapPut(\"/{uploadId}/part\"", "uploadGroup.MapPost(\"/{uploadId}/complete\"");
        string complete = ExtractBetween(endpoints, "uploadGroup.MapPost(\"/{uploadId}/complete\"", "uploadGroup.MapDelete(\"/{uploadId}\"");
        Assert.Contains("ReadUploadToken(httpContext)", part, StringComparison.Ordinal);
        Assert.Contains("ValidateUploadSessionTokenAsync(uploadId, uploadToken", part, StringComparison.Ordinal);
        Assert.Contains("ReadUploadToken(httpContext)", complete, StringComparison.Ordinal);
        Assert.Contains("ValidateUploadSessionTokenAsync(uploadId, uploadToken", complete, StringComparison.Ordinal);
        Assert.DoesNotContain(".DisableAntiforgery()", endpoints, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicNavigationSnapshot_IsRateLimitedAndLengthBound()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/PublicAotEndpoints.cs");

        string endpoint = ExtractBetween(source, "publicGroup.MapGet(\"/navigation-snapshot.aeds\"", "var group = app.MapGroup(\"/internal/public-aot\")");
        Assert.Contains(".RequireRateLimiting(\"public_read\")", endpoint, StringComparison.Ordinal);
        Assert.Contains("MaxNavigationPathChars", source, StringComparison.Ordinal);
        Assert.Contains("rawPath.Length > MaxNavigationPathChars", source, StringComparison.Ordinal);
        Assert.Contains("normalized.Length > MaxNavigationPathChars", source, StringComparison.Ordinal);
    }

    [Fact]
    public void NotificationStreamDrill_RequiresSignedTimestampedNonce()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/NotificationStreamDrillEndpoints.cs");

        Assert.Contains("DrillTimestampHeader", source, StringComparison.Ordinal);
        Assert.Contains("DrillNonceHeader", source, StringComparison.Ordinal);
        Assert.Contains("DrillSignatureHeader", source, StringComparison.Ordinal);
        Assert.Contains("ValidateSignedDrillRequestAsync", source, StringComparison.Ordinal);
        Assert.Contains("TryAcquireLeaseAsync(CachePolicyId.NotificationStreamDrillNonce", source, StringComparison.Ordinal);
        Assert.Contains("TimeSpan.FromSeconds(60)", source, StringComparison.Ordinal);
        Assert.DoesNotContain("context.Request.ReadFromJsonAsync<NotificationStreamDrillPublishRequest>", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminSessionRevoke_VerifiesSessionOwnershipBeforeMutation()
    {
        string endpoints = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string service = ReadSource("src/backend/Services/Security/AdminPrincipalService.cs");

        string revoke = ExtractBetween(endpoints, "group.MapPost(\"/auth/admin/sessions/{sessionId}/revoke\"", "group.MapPost(\"/auth/admin/sessions/revoke-others\"");
        Assert.Contains("EnsureAdminSessionBelongsToPrincipalAsync", revoke, StringComparison.Ordinal);
        Assert.Contains("RevokeAdminSessionAsync", revoke, StringComparison.Ordinal);
        AssertOrder(revoke, "EnsureAdminSessionBelongsToPrincipalAsync", "RevokeAdminSessionAsync");
        Assert.Contains("Task<bool> EnsureAdminSessionBelongsToPrincipalAsync", service, StringComparison.Ordinal);
    }

    [Fact]
    public void DistributionFeeds_VaryByEncodingCountryAndRegion()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/DistributionEndpoints.cs");

        Assert.Contains("DistributionVaryHeader", source, StringComparison.Ordinal);
        Assert.Contains("Accept-Encoding", source, StringComparison.Ordinal);
        Assert.Contains("CF-IPCountry", source, StringComparison.Ordinal);
        Assert.Contains("X-Fsus-Region", source, StringComparison.Ordinal);
        Assert.Contains("ctx.Response.Headers.Vary = DistributionVaryHeader", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminSensitiveStepUp_RequiresTrustedOriginAndShortSingleUseProof()
    {
        string binary = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.cs");
        string authoring = ReadSource("src/backend/Modules/Endpoints/AuthoringEndpoints.cs");
        string security = ReadSource("src/backend/Modules/Endpoints/SecurityEndpoints.cs");
        string service = ReadSource("src/backend/Services/Security/AdminPrincipalService.cs");

        Assert.Contains("RequireTrustedOriginOrReferer", binary, StringComparison.Ordinal);
        Assert.Contains("RequireTrustedOriginOrReferer", authoring, StringComparison.Ordinal);
        Assert.Contains("RequireTrustedOriginOrReferer", security, StringComparison.Ordinal);
        Assert.Contains("TimeSpan.FromSeconds(45)", service, StringComparison.Ordinal);
        Assert.Contains("ConsumeOnceAsync(CachePolicyId.SecurityMfaProof", service, StringComparison.Ordinal);
        Assert.DoesNotContain("StepUpProofTtl = TimeSpan.FromMinutes(5)", service, StringComparison.Ordinal);
    }

    [Fact]
    public void FileDeletePath_UsesCanonicalPrefixAndRejectsWindowsSeparators()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.cs");
        string helper = ExtractBetween(source, "private static bool TryNormalizeImageDeletePath", "private static UploadInitRequestDto ToServerDto");

        Assert.Contains("CanonicalIllustrationUploadPrefix", helper, StringComparison.Ordinal);
        Assert.Contains("StartsWith(CanonicalIllustrationUploadPrefix", helper, StringComparison.Ordinal);
        Assert.Contains("Contains('\\\\'", helper, StringComparison.Ordinal);
        Assert.Contains("Contains(':', StringComparison.Ordinal)", helper, StringComparison.Ordinal);
        Assert.DoesNotContain("Contains(\"/uploads/illustration/\"", helper, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleDeleteRestoreMutationEndpoints_AreRateLimitedAndStepUpProtected()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs");

        AssertArticleMutationProtected(source, "group.MapDelete(\"/admin/article/{id:int}\"", "group.MapPut(\"/admin/article/restore/{id:int}\"");
        AssertArticleMutationProtected(source, "group.MapPut(\"/admin/article/restore/{id:int}\"", "group.MapDelete(\"/admin/article/permanent/{id:int}\"");
        AssertArticleMutationProtected(source, "group.MapDelete(\"/admin/article/permanent/{id:int}\"", "private static bool TryBindArticleListPagination");
    }

    private static void AssertArticleMutationProtected(string source, string start, string end)
    {
        string endpoint = ExtractBetween(source, start, end);
        Assert.Contains("RequireAdminSensitiveStepUpAsync", endpoint, StringComparison.Ordinal);
        Assert.Contains(".RequireRateLimiting(\"fixed_ip\")", endpoint, StringComparison.Ordinal);
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

    private static void AssertOrder(string source, string first, string second)
    {
        int firstIndex = source.IndexOf(first, StringComparison.Ordinal);
        int secondIndex = source.IndexOf(second, StringComparison.Ordinal);
        Assert.True(firstIndex >= 0, $"Missing '{first}'.");
        Assert.True(secondIndex >= 0, $"Missing '{second}'.");
        Assert.True(firstIndex < secondIndex, $"Expected '{first}' before '{second}'.");
    }
}
