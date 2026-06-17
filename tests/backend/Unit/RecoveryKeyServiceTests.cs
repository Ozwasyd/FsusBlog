using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RecoveryKeyServiceTests
{
    [Fact]
    public void RecoveryKeyService_SourceUsesIndependentPepperedHashing()
    {
        string source = ReadSource("src/backend/Services/Security/RecoveryKeyService.cs");

        Assert.Contains("RecoveryKeyPepper", source, StringComparison.Ordinal);
        Assert.Contains("Rfc2898DeriveBytes.Pbkdf2", source, StringComparison.Ordinal);
        Assert.Contains("HMACSHA256", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ITotpService", source, StringComparison.Ordinal);
        Assert.DoesNotContain("MfaRecoveryCodesHash", source, StringComparison.Ordinal);
        Assert.DoesNotContain("HashRecoveryCodes", source, StringComparison.Ordinal);
        Assert.DoesNotContain("TryConsumeRecoveryCode", source, StringComparison.Ordinal);
    }

    [Fact]
    public void RecoveryKeyEndpoints_SourceExposeBinaryAedsRecoveryFlow()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");

        Assert.Contains("\"/auth/recovery-key/create\"", source, StringComparison.Ordinal);
        Assert.Contains("\"/auth/recovery-key/rotate\"", source, StringComparison.Ordinal);
        Assert.Contains("\"/auth/recovery-key/verify\"", source, StringComparison.Ordinal);
        Assert.Contains("\"/auth/recovery-key/passkey/register/begin\"", source, StringComparison.Ordinal);
        Assert.Contains("\"/auth/recovery-key/passkey/register/complete\"", source, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.RecoveryKeyCreateResponse", source, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.RecoveryKeyVerifyRequest", source, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.RecoveryKeyVerifyResponse", source, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.RecoveryKeySessionRequest", source, StringComparison.Ordinal);
    }

    [Fact]
    public void RecoveryKeyVerifyEndpoint_IsAnonymousPowAndRateLimited()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string handler = ExtractBetween(
            source,
            "group.MapPost(\"/auth/recovery-key/verify\"",
            "group.MapPost(\"/auth/recovery-key/passkey/register/begin\"");

        Assert.Contains(".AllowAnonymous()", handler, StringComparison.Ordinal);
        Assert.Contains(".RequireRateLimiting(\"fixed_ip\")", handler, StringComparison.Ordinal);
        Assert.Contains(".AddEndpointFilter<RequiresPowFilter>()", handler, StringComparison.Ordinal);
        Assert.Contains(".RequireNoStoreResponse()", handler, StringComparison.Ordinal);
    }

    [Fact]
    public void RecoveryKeyEntity_DoesNotPersistPlaintextMaterial()
    {
        string source = ReadSource("src/backend/Entities/RecoveryKeyCredential.cs");

        Assert.Contains("KeyHash", source, StringComparison.Ordinal);
        Assert.Contains("KeyVersion", source, StringComparison.Ordinal);
        Assert.Contains("UsedAt", source, StringComparison.Ordinal);
        Assert.Contains("RevokedAt", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Plaintext", source, StringComparison.Ordinal);
        Assert.DoesNotContain("RecoveryKey { get; set; }", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousMfaManagement_RequiresSessionStepUpInsteadOfLegacyPasswordProof()
    {
        string endpoints = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string userService = ReadSource("src/backend/Services/UserService.cs");

        Assert.Contains("ANONYMOUS_MFA_STEP_UP_REQUIRED", endpoints, StringComparison.Ordinal);
        Assert.Contains("httpContext.User.IsMfaVerified()", endpoints, StringComparison.Ordinal);
        Assert.Contains("stepUpVerified", userService, StringComparison.Ordinal);
        Assert.Contains("AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled()", userService, StringComparison.Ordinal);
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
