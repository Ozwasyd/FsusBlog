namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthSecurityHardeningTests
{
    [Fact]
    public void UserEntity_DoesNotPersistLegacyPlaintextRefreshToken()
    {
        string source = ReadSource("src/backend/Entities/User.cs");

        Assert.DoesNotContain("RefreshToken { get; set; }", source, StringComparison.Ordinal);
        Assert.DoesNotContain("RefreshTokenExpiryTime", source, StringComparison.Ordinal);
        Assert.Contains("MfaPendingSecretEncrypted", source, StringComparison.Ordinal);
        Assert.Contains("MfaPendingCreatedAt", source, StringComparison.Ordinal);
    }

    [Fact]
    public void UserService_PasswordChangeRevokesAllSessionsInTransaction()
    {
        string source = ReadSource("src/backend/Services/UserService.cs");

        Assert.Contains("UseTranAsync", source, StringComparison.Ordinal);
        Assert.Contains("RevokeReason == \"password_changed\"", source, StringComparison.Ordinal);
        Assert.Contains("AuditAction\", \"password_changed\"", source, StringComparison.Ordinal);
    }

    [Fact]
    public void UserService_RefreshRotationUsesCasAndReplayRevocation()
    {
        string source = ReadSource("src/backend/Services/UserService.cs");

        Assert.Contains("s.RefreshTokenHash == hash", source, StringComparison.Ordinal);
        Assert.Contains("s.RevokedAt == null", source, StringComparison.Ordinal);
        Assert.Contains("s.IdleExpiresAt > now", source, StringComparison.Ordinal);
        Assert.Contains("RevokeLikelyRefreshReplayAsync", source, StringComparison.Ordinal);
        Assert.Contains("refresh_token_reuse", source, StringComparison.Ordinal);
        Assert.DoesNotContain("SetColumns(u => u.RefreshToken", source, StringComparison.Ordinal);
    }

    [Fact]
    public void UserService_MfaSetupUsesPendingSecretUntilVerification()
    {
        string source = ReadSource("src/backend/Services/UserService.cs");

        Assert.Contains("MfaPendingSecretEncrypted == protectedSecret", source, StringComparison.Ordinal);
        Assert.Contains("MfaPendingCreatedAt == now", source, StringComparison.Ordinal);
        Assert.Contains("MfaSecretEncrypted == user.MfaPendingSecretEncrypted", source, StringComparison.Ordinal);
        Assert.DoesNotContain("MfaEnabled == false)\n            .Where(u => u.Id == userId)", source, StringComparison.Ordinal);
    }

    [Fact]
    public void MfaChallengeEndpoint_IsRateLimitedAndCountsFailures()
    {
        string endpoint = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string service = ReadSource("src/backend/Services/Security/MfaChallengeService.cs");

        Assert.Contains("RecordFailureAsync", endpoint, StringComparison.Ordinal);
        Assert.Contains(".RequireRateLimiting(\"fixed_ip\")", endpoint, StringComparison.Ordinal);
        Assert.Contains("MaxTicketFailures = 5", service, StringComparison.Ordinal);
        Assert.Contains("fail:user:", service, StringComparison.Ordinal);
        Assert.Contains("fail:ip:", service, StringComparison.Ordinal);
    }

    [Fact]
    public void PasskeyService_RequiresUserVerificationAndSanitizesErrors()
    {
        string source = ReadSource("src/backend/Services/Security/PasskeyService.cs");

        Assert.Contains("UserVerificationRequirement.Required", source, StringComparison.Ordinal);
        Assert.Contains("param.UserHandle is null || param.UserHandle.Length != sizeof(int)", source, StringComparison.Ordinal);
        Assert.Contains("通行密钥验证失败，请重试", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Console.WriteLine", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ex.Message}", source, StringComparison.Ordinal);
    }

    [Fact]
    public void FrontendUserStore_DoesNotPersistAuthorityFields()
    {
        string source = ReadSource("src/frontend/src/store/user.ts");
        string router = ReadSource("src/frontend/src/router/index.ts");

        Assert.Contains("pick: ['isAuthChecked']", source, StringComparison.Ordinal);
        Assert.DoesNotContain("pick: ['userInfo'", source, StringComparison.Ordinal);
        Assert.Contains("const adminRoles = ['admin'];", source, StringComparison.Ordinal);
        Assert.Contains("to.path.startsWith('/user/manage')", router, StringComparison.Ordinal);
        Assert.Contains("ensureUserInfoFresh({ maxAgeMs: 30_000, forceWhenUnknown: true })", router, StringComparison.Ordinal);
    }

    private static string ReadSource(string relativePath)
        => File.ReadAllText(Path.Combine(FindRepoRoot(), relativePath));

    private static string FindRepoRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "FsusBlog.slnx")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException("Repository root not found.");
    }
}
