using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthSecurityHardeningTests
{
    [Fact]
    public void UserEntity_DoesNotPersistLegacyPlaintextRefreshToken()
    {
        string source = ReadSource("src/backend/Entities/User.cs");
        string mfaProfile = ReadSource("src/backend/Entities/UserMfaProfile.cs");

        Assert.DoesNotContain("RefreshToken { get; set; }", source, StringComparison.Ordinal);
        Assert.DoesNotContain("RefreshTokenExpiryTime", source, StringComparison.Ordinal);
        Assert.DoesNotContain("MfaPendingSecretEncrypted", source, StringComparison.Ordinal);
        Assert.DoesNotContain("MfaPendingCreatedAt", source, StringComparison.Ordinal);
        Assert.Contains("MfaPendingSecretEncrypted", mfaProfile, StringComparison.Ordinal);
        Assert.Contains("MfaPendingCreatedAt", mfaProfile, StringComparison.Ordinal);
    }

    [Fact]
    public void UserService_AccountDeletionRevokesAllSessionsInTransaction()
    {
        string source = ReadSource("src/backend/Services/UserService.cs");

        Assert.Contains("UseTranAsync", source, StringComparison.Ordinal);
        Assert.Contains("RevokeReason == \"account_deleted\"", source, StringComparison.Ordinal);
        Assert.Contains("DeletedReason == \"self-service\"", source, StringComparison.Ordinal);
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
        string setupAndVerify = ExtractBetween(
            source,
            "public async Task<(bool Success, MfaSetupStartDto? Data, string Message)> StartMfaSetupAsync",
            "public async Task<(bool Success, string Message)> DisableMfaAsync");

        Assert.Contains("profile.MfaPendingSecretEncrypted = protectedSecret", setupAndVerify, StringComparison.Ordinal);
        Assert.Contains("profile.MfaPendingCreatedAt = now", setupAndVerify, StringComparison.Ordinal);
        Assert.Contains("profile.MfaSecretEncrypted = profile.MfaPendingSecretEncrypted", setupAndVerify, StringComparison.Ordinal);
        Assert.Contains("UpsertUserMfaProfileAsync(profile)", setupAndVerify, StringComparison.Ordinal);
        Assert.DoesNotContain("MfaEnabled == false)\n            .Where(u => u.Id == userId)", setupAndVerify, StringComparison.Ordinal);
    }

    [Fact]
    public void MfaChallengeEndpoint_IsRateLimitedAndCountsFailures()
    {
        string endpoint = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string service = ReadSource("src/backend/Services/Security/MfaChallengeService.cs");

        Assert.Contains("RecordFailureAsync", endpoint, StringComparison.Ordinal);
        Assert.Contains(".RequireRateLimiting(\"fixed_ip\")", endpoint, StringComparison.Ordinal);
        Assert.Contains("MaxTicketFailures = 5", service, StringComparison.Ordinal);
        Assert.Contains("fail:subject:", service, StringComparison.Ordinal);
        Assert.DoesNotContain("fail:user:", service, StringComparison.Ordinal);
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
        AssertStepUpBeforeMutation(passkeyRename, "UserSecurityStepUpActions.PasskeyCredentialNameUpdate", "passkeyService.RenameCredentialAsync");

        string helper = ExtractBetween(
            source,
            "private static async Task<(ErrorDetail Error, int StatusCode)?> RequireUserSecurityStepUpAsync",
            "private static ValueTask RecordPasskeyAssertionFailureAsync");
        Assert.Contains("result.StatusCode", helper, StringComparison.Ordinal);
        Assert.Contains("ErrorDetail.Create(result.ErrorCode, result.Message)", helper, StringComparison.Ordinal);
        Assert.Contains("TryReadMfaProof(httpContext, out string token)", helper, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadBinaryRequestPayloadAsync", helper, StringComparison.Ordinal);
    }

    [Fact]
    public void FrontendUserStore_DoesNotPersistAuthorityFields()
    {
        string source = ReadSource("src/frontend/src/store/user.ts");
        string router = ReadSource("src/frontend/src/router/index.ts");

        Assert.Contains("pick: ['accountState', 'lastVerifiedAt', 'authCacheVersion', 'lastFetchedAt']", source, StringComparison.Ordinal);
        Assert.DoesNotContain("pick: ['userInfo'", source, StringComparison.Ordinal);
        Assert.Contains("const isAdmin = computed(() => false)", source, StringComparison.Ordinal);
        Assert.DoesNotContain("adminRoles", source, StringComparison.Ordinal);
        Assert.Contains("route.path.startsWith('/user/manage')", router, StringComparison.Ordinal);
        Assert.Contains("record.meta.accountArea === 'manage'", router, StringComparison.Ordinal);
        Assert.Contains("sessionBootstrap.ensureAccountSession({ reason: 'route'", router, StringComparison.Ordinal);
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
