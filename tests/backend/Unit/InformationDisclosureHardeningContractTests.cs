using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class InformationDisclosureHardeningContractTests
{
    [Fact]
    public void ExceptionMiddleware_DoesNotReturnRawExceptionMessagesOutsideDevelopment()
    {
        string source = ReadSource("src/backend/Infrastructure/Middlewares/GlobalExceptionMiddleware.cs");
        string mapping = ExtractBetween(source, "private static ErrorDetail CreateClientSafeError", "    // ====================================================================");

        Assert.DoesNotContain("ex.Message", mapping, StringComparison.Ordinal);
        Assert.Contains("CreateClientSafeError", source, StringComparison.Ordinal);
    }

    [Fact]
    public void PowAndSecurityLogs_DoNotWriteRawTokensOrAccountIds()
    {
        string pow = ReadSource("src/backend/Services/Security/RedisPowService.cs");
        string mfa = ReadSource("src/backend/Services/Security/MfaChallengeService.cs");
        string admin = ReadSource("src/backend/Services/Security/AdminPrincipalService.cs");
        string issuer = ReadSource("src/backend/Services/Security/AnonymousCredentialIssuerService.cs");
        string passkey = ReadSource("src/backend/Services/Security/PasskeyService.cs");

        Assert.DoesNotContain("Salt: {Salt}", pow, StringComparison.Ordinal);
        Assert.Contains("HashForLog(req.PowSalt)", pow, StringComparison.Ordinal);
        Assert.DoesNotContain("AccountId={AccountId}", mfa, StringComparison.Ordinal);
        Assert.Contains("AccountSubjectHash={AccountSubjectHash}", mfa, StringComparison.Ordinal);
        Assert.DoesNotContain("LogWarning(ex,", admin, StringComparison.Ordinal);
        Assert.DoesNotContain("hasPrivateKey={HasPrivateKey}", issuer, StringComparison.Ordinal);
        Assert.DoesNotContain("AccountId={AccountId}", passkey, StringComparison.Ordinal);
        Assert.Contains("AccountSubjectHash={AccountSubjectHash}", passkey, StringComparison.Ordinal);
    }

    [Fact]
    public void LocalFixtureHealthAndStartup_DoNotExposeDetailedErrors()
    {
        string localFixture = ReadSource("src/backend/Modules/Endpoints/LocalAuthFixtureEndpoints.cs");
        string health = ReadSource("src/backend/Infrastructure/Operations/ProductionHealth.cs");
        string startup = ReadSource("src/backend/Infrastructure/Operations/ProductionStartupValidator.cs");

        string statusMap = ExtractBetween(localFixture, "app.MapGet(\"/api/local/auth-fixture/status\"", "private static async ValueTask<object?> RequireLocalFixtureSecret");
        Assert.Contains("RequireLocalFixtureSecret", statusMap, StringComparison.Ordinal);
        Assert.Contains("RequireLoopbackCaller", statusMap, StringComparison.Ordinal);
        Assert.DoesNotContain("ex.Message", localFixture, StringComparison.Ordinal);
        Assert.DoesNotContain("stderr.ToString()", localFixture, StringComparison.Ordinal);
        Assert.DoesNotContain("depth < 6", localFixture, StringComparison.Ordinal);

        Assert.Contains("RedactConfigurationHealth", health, StringComparison.Ordinal);
        Assert.DoesNotContain("ex.GetType().Name", health, StringComparison.Ordinal);
        Assert.DoesNotContain("string.Join(\"; \", report.Errors)", startup, StringComparison.Ordinal);
        Assert.DoesNotContain("Errors: {Errors}", startup, StringComparison.Ordinal);
    }

    [Fact]
    public void InfrastructureLogs_RedactFailureContext()
    {
        string moderation = ReadSource("src/backend/Services/Moderation/ModerationDictionaryService.cs");
        string audit = ReadSource("src/backend/Infrastructure/Audit/AuditEventService.cs");
        string sql = ReadSource("src/backend/Infrastructure/Helpers/Initializer/SqlSugarInitializer.cs");
        string authCookies = ReadSource("src/backend/Infrastructure/Auth/AuthCookieService.cs");
        string appsettings = ReadSource("src/backend/appsettings.json");
        string productionAppsettings = ReadSource("src/backend/appsettings.Production.json");

        Assert.DoesNotContain("result.Error.Message", moderation, StringComparison.Ordinal);
        Assert.DoesNotContain("TargetId={TargetId}", audit, StringComparison.Ordinal);
        Assert.DoesNotContain("exp.Sql", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("EnvironmentName, \"Local\"", authCookies, StringComparison.Ordinal);
        Assert.DoesNotContain("development-pow-signing-key", appsettings, StringComparison.Ordinal);
        Assert.DoesNotContain("MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES", appsettings, StringComparison.Ordinal);
        Assert.DoesNotContain("MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES", productionAppsettings, StringComparison.Ordinal);
        Assert.DoesNotContain("MUST_BE_OVERRIDDEN_WITH_64_HEX_32_BYTE_KEY", productionAppsettings, StringComparison.Ordinal);
    }

    private static string ReadSource(string relativePath, [CallerFilePath] string sourceFilePath = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex + start.Length, StringComparison.Ordinal);
        Assert.True(endIndex >= 0, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }
}
