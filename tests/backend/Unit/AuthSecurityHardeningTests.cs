using System.Reflection;
using Fido2NetLib.Objects;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthSecurityHardeningTests
{
    [Fact]
    public void UserEntity_DoesNotPersistLegacyPlaintextRefreshToken()
    {
        string[] userProperties = typeof(User).GetProperties().Select(static property => property.Name).ToArray();
        string[] mfaProperties = typeof(UserMfaProfile).GetProperties().Select(static property => property.Name).ToArray();
        Assert.DoesNotContain("RefreshToken", userProperties);
        Assert.DoesNotContain("RefreshTokenExpiryTime", userProperties);
        Assert.DoesNotContain("MfaPendingSecretEncrypted", userProperties);
        Assert.DoesNotContain("MfaPendingCreatedAt", userProperties);
        Assert.Contains("MfaPendingSecretEncrypted", mfaProperties);
        Assert.Contains("MfaPendingCreatedAt", mfaProperties);

        Assert.NotNull(typeof(UserSession).GetProperty("RefreshTokenHash"));
        Assert.Null(typeof(UserSession).GetProperty("RefreshToken"));
    }

    [Fact]
    public void UserService_AccountDeletionRuntimeRevokesAllSessionsInTransaction()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(UserService),
            nameof(UserService.DeleteAccountAsync));

        Assert.Contains("UseTranAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("account_deleted", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("self-service", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void UserService_RefreshRotationRuntimeUsesCasAndReplayRevocation()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(UserService),
            nameof(UserService.RefreshTokenAsync),
            "RevokeLikelyRefreshReplayAsync");

        Assert.Contains("get_RefreshTokenHash", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("get_RevokedAt", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("get_IdleExpiresAt", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("RevokeLikelyRefreshReplayAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("refresh_token_reuse", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("User.set_RefreshToken", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void UserService_MfaSetupRuntimeUsesPendingSecretUntilVerification()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(UserService),
            nameof(UserService.StartMfaSetupAsync),
            nameof(UserService.VerifyMfaSetupAsync),
            "UpsertUserMfaProfileAsync");

        Assert.Contains("set_MfaPendingSecretEncrypted", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("set_MfaPendingCreatedAt", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("get_MfaPendingSecretEncrypted", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("set_MfaSecretEncrypted", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("UpsertUserMfaProfileAsync", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void UserService_MfaStateMutationsRuntimeAreTransactionalAndLockUserRow()
    {
        foreach (string methodName in new[]
        {
            nameof(UserService.VerifyMfaSetupAsync),
            nameof(UserService.DisableMfaAsync),
            nameof(UserService.ResetMfaByAdminAsync)
        })
        {
            string runtimeShape = RuntimeMetadataInspection.DescribeMethods(typeof(UserService), methodName);
            Assert.Contains("UseTranAsync", runtimeShape, StringComparison.Ordinal);
            Assert.Contains("LockUserMfaStateForUpdateAsync", runtimeShape, StringComparison.Ordinal);
            Assert.Contains("set_MfaEnabled", runtimeShape, StringComparison.Ordinal);
        }

        string lockHelper = RuntimeMetadataInspection.DescribeMethods(
            typeof(UserService),
            "LockUserMfaStateForUpdateAsync");
        Assert.Contains("FOR UPDATE", lockHelper, StringComparison.Ordinal);
    }

    [Fact]
    public async Task MfaChallengeEndpoint_IsRateLimitedAndCountsFailures()
    {
        await using WebApplication app = EndpointContractApplication.Create();
        foreach (string route in new[]
        {
            "/api/binary/auth/mfa/challenge/start",
            "/api/binary/auth/mfa/challenge"
        })
        {
            RouteEndpoint endpoint = EndpointContractApplication.Find(app, route, HttpMethods.Post);
            Assert.Equal(
                "fixed_ip",
                Assert.IsType<EnableRateLimitingAttribute>(
                    endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);
        }

        int maxFailures = (int)typeof(MfaChallengeService)
            .GetField("MaxTicketFailures", BindingFlags.Static | BindingFlags.NonPublic)!
            .GetRawConstantValue()!;
        Assert.Equal(5, maxFailures);
        string endpointRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(BinaryEndpoints),
            "MapBinaryAuthEndpoints");
        string serviceRuntime = RuntimeMetadataInspection.DescribeType(typeof(MfaChallengeService));
        Assert.Contains("RecordFailureAsync", endpointRuntime, StringComparison.Ordinal);
        Assert.Contains("fail:subject:", serviceRuntime, StringComparison.Ordinal);
        Assert.DoesNotContain("fail:user:", serviceRuntime, StringComparison.Ordinal);
        Assert.Contains("fail:ip:", serviceRuntime, StringComparison.Ordinal);
    }

    [Fact]
    public void PasskeyService_RuntimeRequiresUserVerificationAndSanitizesErrors()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(PasskeyService));

        Assert.Contains("AuthenticatorSelection.set_UserVerification", runtimeShape, StringComparison.Ordinal);
        Assert.Contains(nameof(UserVerificationRequirement), runtimeShape, StringComparison.Ordinal);
        Assert.Contains("IsUserHandleOwnerOfCredential", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("通行密钥验证失败，请重试", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("Console.WriteLine", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void PasskeyService_RegistrationRuntimeUsesAnonymousSafeMetadataInAnonymousMode()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(PasskeyService),
            "BeginRegistrationAsync",
            "BuildAnonymousSafeMetadata");

        Assert.Contains("BuildAnonymousSafeMetadata", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("get_PublicHandle", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("get_RecoveryEnabled", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("username", runtimeShape, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void PasskeyCredentialRemoval_RuntimeProtectsLastCredentialInAnonymousMode()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(PasskeyService),
            nameof(PasskeyService.RemoveCredentialAsync));

        Assert.Contains("CannotRemoveLastCredentialWithoutRecovery", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("get_RecoveryEnabled", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void CredentialMutationEndpoints_RuntimeVerifyStepUpBeforeDomainMutation()
    {
        var mutations = new (string MutationMember, string Action)[]
        {
            ("IRecoveryKeyService.CreateAsync", UserSecurityStepUpActions.RecoveryKeyCreate),
            ("IRecoveryKeyService.RotateAsync", UserSecurityStepUpActions.RecoveryKeyRotate),
            ("IPasskeyService.RemoveCredentialAsync", UserSecurityStepUpActions.PasskeyDelete),
            ("IPasskeyService.RenameCredentialAsync", UserSecurityStepUpActions.PasskeyCredentialNameUpdate),
            ("IPasskeyService.CompleteRegistrationAsync", UserSecurityStepUpActions.PasskeyRegister)
        };
        foreach ((string mutationMember, string action) in mutations)
        {
            string handler = RuntimeMetadataInspection.DescribeMethodClosureContaining(
                typeof(BinaryEndpoints),
                "RequireUserSecurityStepUpAsync",
                mutationMember,
                action);
            Assert.Contains("RequireUserSecurityStepUpAsync", handler, StringComparison.Ordinal);
            Assert.Contains(mutationMember, handler, StringComparison.Ordinal);
            Assert.Contains(action, handler, StringComparison.Ordinal);
        }

        string recoveryPasskeyBind = RuntimeMetadataInspection.DescribeMethodClosureContaining(
            typeof(BinaryEndpoints),
            "CompletePasskeyBindAsync");
        Assert.Contains("CompletePasskeyBindAsync", recoveryPasskeyBind, StringComparison.Ordinal);
        Assert.DoesNotContain("ConsumeRecoverySessionAsync", recoveryPasskeyBind, StringComparison.Ordinal);
        Assert.DoesNotContain("CompleteRegistrationAsync", recoveryPasskeyBind, StringComparison.Ordinal);
        Assert.DoesNotContain("ApplyPostPasskeyBindAsync", recoveryPasskeyBind, StringComparison.Ordinal);

        string helper = RuntimeMetadataInspection.DescribeMethods(
            typeof(BinaryEndpoints),
            "RequireUserSecurityStepUpAsync");
        Assert.Contains("get_StatusCode", helper, StringComparison.Ordinal);
        Assert.Contains("get_ErrorCode", helper, StringComparison.Ordinal);
        Assert.Contains("get_Message", helper, StringComparison.Ordinal);
        Assert.Contains("TryReadMfaProof", helper, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadBinaryRequestPayloadAsync", helper, StringComparison.Ordinal);

        Assert.Equal("passkey.register", UserSecurityStepUpActions.PasskeyRegister);
        Assert.True(UserSecurityStepUpActions.IsCredentialMutation(UserSecurityStepUpActions.PasskeyRegister));
    }

    [Fact]
    public async Task OrdinaryAccountRuntimeContract_DoesNotPersistOrInferAdminAuthorityFields()
    {
        string[] ordinarySnapshotProperties = typeof(CurrentUserSnapshotDto)
            .GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Select(static property => property.Name)
            .ToArray();
        Assert.DoesNotContain("IsAdmin", ordinarySnapshotProperties);
        Assert.DoesNotContain("AdminRoles", ordinarySnapshotProperties);
        Assert.DoesNotContain("Permissions", ordinarySnapshotProperties);

        await using WebApplication app = EndpointContractApplication.Create();
        RouteEndpoint ordinary = EndpointContractApplication.Find(app, "/api/binary/auth/me", HttpMethods.Get);
        RouteEndpoint admin = EndpointContractApplication.Find(app, "/api/binary/admin/users", HttpMethods.Get);
        ClaimsAuthorizationRequirement ordinaryIdentity = Assert.Single(ordinary.Metadata
            .GetOrderedMetadata<AuthorizationPolicy>()
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>()
            .Where(static requirement => requirement.ClaimType == "identity_kind"));
        ClaimsAuthorizationRequirement adminPermission = Assert.Single(admin.Metadata
            .GetOrderedMetadata<AuthorizationPolicy>()
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>()
            .Where(static requirement => requirement.ClaimType == AdminPermissions.PermissionClaimType));
        Assert.Contains(AnonymousIdentityRuntime.AnonymousAccountKind, ordinaryIdentity.AllowedValues ?? []);
        Assert.Contains(AdminPermissions.AdminManage, adminPermission.AllowedValues ?? []);
    }
}
