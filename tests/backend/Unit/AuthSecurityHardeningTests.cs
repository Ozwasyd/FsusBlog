using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

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
        Assert.Contains("IsUserHandleOwnerOfCredential", source, StringComparison.Ordinal);
        Assert.Contains("通行密钥验证失败，请重试", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Console.WriteLine", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ex.Message}", source, StringComparison.Ordinal);
    }

    [Fact]
    public void PasskeyService_RegistrationUsesAnonymousSafeMetadataInAnonymousMode()
    {
        string source = ReadSource("src/backend/Services/Security/PasskeyService.cs");

        Assert.Contains("BuildAnonymousSafeMetadata", source, StringComparison.Ordinal);
        Assert.Contains("AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled()", source, StringComparison.Ordinal);
        Assert.Contains("PublicHandle", source, StringComparison.Ordinal);
        Assert.Contains("RecoveryEnabled", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Name = username", source, StringComparison.Ordinal);
        Assert.DoesNotContain("DisplayName = username", source, StringComparison.Ordinal);
    }

    [Fact]
    public void PasskeyCredentialRemoval_ProtectsLastCredentialInAnonymousMode()
    {
        string source = ReadSource("src/backend/Services/Security/PasskeyService.cs");

        Assert.Contains("CannotRemoveLastCredentialWithoutRecovery", source, StringComparison.Ordinal);
        Assert.Contains("RecoveryEnabled", source, StringComparison.Ordinal);
        Assert.Contains("AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled()", source, StringComparison.Ordinal);
    }

    [Fact]
    public void CredentialMutationEndpoints_VerifyStepUpBeforeDomainMutation()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");

        string recoveryCreate = ExtractBetween(
            source,
            "group.MapPost(\"/auth/recovery-key/create\"",
            "group.MapPost(\"/auth/recovery-key/rotate\"");
        string recoveryRotate = ExtractBetween(
            source,
            "group.MapPost(\"/auth/recovery-key/rotate\"",
            "group.MapPost(\"/auth/recovery-key/verify\"");
        string passkeyDelete = ExtractBetween(
            source,
            "group.MapDelete(\"/auth/passkey/credentials/{id:int}\"",
            "group.MapPut(\"/auth/passkey/credentials/{id:int}/name\"");
        string passkeyRename = ExtractBetween(
            source,
            "group.MapPut(\"/auth/passkey/credentials/{id:int}/name\"",
            "private static BinaryFrameResult RecoveryKeyError");

        AssertStepUpBeforeMutation(recoveryCreate, "UserSecurityStepUpActions.RecoveryKeyCreate", "recoveryKeys.CreateAsync");
        AssertStepUpBeforeMutation(recoveryRotate, "UserSecurityStepUpActions.RecoveryKeyRotate", "recoveryKeys.RotateAsync");
        AssertStepUpBeforeMutation(passkeyDelete, "UserSecurityStepUpActions.PasskeyDelete", "passkeyService.RemoveCredentialAsync");
        AssertStepUpBeforeMutation(passkeyRename, "UserSecurityStepUpActions.PasskeyRename", "passkeyService.RenameCredentialAsync");

        string helper = ExtractBetween(
            source,
            "private static async Task<(ErrorDetail Error, int StatusCode)?> RequireUserSecurityStepUpAsync",
            "private static async Task<(UserSecurityStepUpProof Proof, ErrorDetail Error)> ReadUserSecurityStepUpProofAsync");
        Assert.Contains("result.StatusCode", helper, StringComparison.Ordinal);
        Assert.Contains("ErrorDetail.Create(result.ErrorCode, result.Message)", helper, StringComparison.Ordinal);
    }

    [Fact]
    public void FrontendUserStore_DoesNotPersistAuthorityFields()
    {
        string source = ReadSource("src/frontend/src/store/user.ts");
        string router = ReadSource("src/frontend/src/router/index.ts");

        Assert.Contains("pick: ['isAuthChecked']", source, StringComparison.Ordinal);
        Assert.DoesNotContain("pick: ['userInfo'", source, StringComparison.Ordinal);
        Assert.Contains("const adminRoles = ['admin'];", source, StringComparison.Ordinal);
        Assert.Contains("route.path.startsWith('/user/manage')", router, StringComparison.Ordinal);
        Assert.Contains("record.meta.accountArea === 'manage'", router, StringComparison.Ordinal);
        Assert.Contains("ensureUserInfoFresh({ maxAgeMs: 30_000, forceWhenUnknown: true })", router, StringComparison.Ordinal);
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

    private static void AssertStepUpBeforeMutation(string handler, string action, string mutationCall)
    {
        int stepUpIndex = handler.IndexOf("RequireUserSecurityStepUpAsync(", StringComparison.Ordinal);
        int mutationIndex = handler.IndexOf(mutationCall, StringComparison.Ordinal);
        Assert.True(stepUpIndex >= 0, $"Missing step-up call for {action}.");
        Assert.True(mutationIndex >= 0, $"Missing mutation call for {action}.");
        Assert.True(stepUpIndex < mutationIndex, $"{action} must verify step-up before domain mutation.");
        Assert.Contains(action, handler, StringComparison.Ordinal);
    }
}
