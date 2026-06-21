using System.Reflection;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousAccountOutputContractTests
{
    [Fact]
    public void AuthMeEndpoint_EmitsAnonymousAccountSnapshotWithoutLegacyIdentityFields()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Auth.cs");
        string handler = ExtractEndpointBlock(source, "group.MapGet(\"/auth/me\"");

        Assert.Contains("AedsFrameType.IdentityAccountSnapshot", handler, StringComparison.Ordinal);
        Assert.Contains("PodBinaryCodec.WriteIdentityAccountSnapshot", handler, StringComparison.Ordinal);
        Assert.Contains("UserAccountReader.ToAnonymousAccountSnapshot", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("CurrentUserSnapshotDto", handler, StringComparison.Ordinal);
        Assert.DoesNotContain(".Username", handler, StringComparison.Ordinal);
        Assert.DoesNotContain(".Role", handler, StringComparison.Ordinal);
    }

    [Fact]
    public void AuthProtocolContracts_DoNotExposeUsernameOrRoleAsIdentityFields()
    {
        string outputs = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "shared",
            "Contracts",
            "Outputs",
            "ServerResponseContracts.cs");
        string userPods = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "shared",
            "Contracts",
            "Models",
            "UserPods.cs");
        string codec = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "core",
            "Cache",
            "PodBinaryCodec.User.cs");

        string authIdentity = ExtractRecord(outputs, "public readonly record struct AuthIdentitySnapshotDto");
        string authFlow = ExtractRecord(outputs, "public readonly record struct AuthLoginFlowDto");
        string currentUser = ExtractRecord(outputs, "public readonly record struct CurrentUserSnapshotDto");
        string mfaChallenge = ExtractRecord(outputs, "public readonly record struct MfaChallengeResultDto");
        string authLoginPod = ExtractStruct(userPods, "public readonly struct AuthLoginFlowPod");
        string currentUserPod = ExtractStruct(userPods, "public readonly struct CurrentUserSnapshotPod");
        string mfaChallengePod = ExtractStruct(userPods, "public readonly struct MfaChallengeResultPod");
        string authLoginCodec = ExtractBetween(codec, "public static void WriteAuthLoginFlow", "public static void WriteCurrentUserSnapshot");
        string mfaChallengeCodec = ExtractBetween(codec, "public static void WriteMfaChallengeResult", "public static void WriteMfaPasswordProofRequest");

        foreach (string block in new[] { authIdentity, authFlow, currentUser, mfaChallenge, authLoginPod, currentUserPod, mfaChallengePod, authLoginCodec, mfaChallengeCodec })
        {
            Assert.DoesNotContain("Username", block, StringComparison.Ordinal);
            Assert.DoesNotContain("UserName", block, StringComparison.Ordinal);
            Assert.DoesNotContain("Role", block, StringComparison.Ordinal);
            Assert.DoesNotContain("UserId", block, StringComparison.Ordinal);
        }

        Assert.Contains("AccountId", authFlow, StringComparison.Ordinal);
        Assert.Contains("IdentityKind", authFlow, StringComparison.Ordinal);
        Assert.Contains("AccountId", currentUser, StringComparison.Ordinal);
        Assert.Contains("IdentityKind", currentUser, StringComparison.Ordinal);
        Assert.Contains("AccountId", authLoginPod, StringComparison.Ordinal);
        Assert.Contains("IdentityKind", authLoginPod, StringComparison.Ordinal);
    }

    [Fact]
    public void UserSessionContracts_DoNotExposeRawIpToAnonymousAccountClients()
    {
        string outputs = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "shared",
            "Contracts",
            "Outputs",
            "ServerResponseContracts.cs");
        string userPods = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "shared",
            "Contracts",
            "Models",
            "UserPods.cs");
        string codec = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "core",
            "Cache",
            "PodBinaryCodec.User.cs");
        string userService = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "backend",
            "Services",
            "UserService.cs");

        string userSessionDto = ExtractRecord(outputs, "public readonly record struct UserSessionSummaryDto");
        string userSessionPod = ExtractStruct(userPods, "public readonly struct UserSessionSummaryPod");
        string writeUserSessions = ExtractBetween(codec, "public static void WriteUserSessions", "public static byte[] EncodeUserSessions");
        string decodeUserSessions = ExtractBetween(codec, "public static bool TryDecodeUserSessions", "public static void WriteAdminSessions");
        string getUserSessions = ExtractBetween(userService, "public async Task<List<UserSessionSummaryDto>> GetUserSessionsAsync", "private sealed record UserSessionSummaryRow");

        foreach (string block in new[] { userSessionDto, userSessionPod, writeUserSessions, decodeUserSessions, getUserSessions })
        {
            Assert.DoesNotContain("LastIp", block, StringComparison.Ordinal);
            Assert.DoesNotContain("lastIp", block, StringComparison.Ordinal);
        }

        Assert.Contains("SessionId", userSessionDto, StringComparison.Ordinal);
        Assert.Contains("DeviceFingerprint", userSessionDto, StringComparison.Ordinal);
        Assert.Contains("DeviceLabel", userSessionDto, StringComparison.Ordinal);
        Assert.Contains("LastSeenAt", userSessionDto, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicHandleEndpoint_UsesDedicatedFrameValidationAndProfileCommand()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Auth.cs");
        string handler = ExtractEndpointBlock(source, "group.MapPut(\"/auth/public-handle\"");

        Assert.Contains("AedsFrameType.AuthUpdatePublicHandleRequest", handler, StringComparison.Ordinal);
        Assert.Contains("PodBinaryCodec.TryDecodeStringMutationRequest", handler, StringComparison.Ordinal);
        Assert.Contains("contentFilterService.ValidateContent(publicHandle)", handler, StringComparison.Ordinal);
        Assert.Contains("profileCommands.UpdatePublicHandleAsync", handler, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.EmptySuccess", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("UpdateUsernameAsync", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("GenerateAccessToken", handler, StringComparison.Ordinal);
    }

    [Fact]
    public void AuthUsernameMutationRuntimePath_IsNotReachable()
    {
        string endpoints = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Auth.cs");
        string profilePorts = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "backend",
            "Interfaces",
            "UserApplicationPorts.cs");
        string userService = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "backend",
            "Services",
            "UserService.cs");
        string authApi = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "frontend",
            "src",
            "api",
            "auth.ts");

        Assert.DoesNotContain("/auth/update-username", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("AuthUpdateUsernameRequest", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("UpdateUsernameAsync", profilePorts, StringComparison.Ordinal);
        Assert.DoesNotContain("UpdateUsernameAsync", userService, StringComparison.Ordinal);
        Assert.DoesNotContain("UpdateUsernameDto", authApi, StringComparison.Ordinal);
        Assert.DoesNotContain("updateUsername", authApi, StringComparison.Ordinal);
    }

    [Fact]
    public void PasswordAuthRuntimeContracts_AreNotProductionPorts()
    {
        string[] productionFiles =
        [
            "src/backend/Models/Dtos/UserDto.cs",
            "src/backend/Interfaces/IUserAuthService.cs",
            "src/backend/Interfaces/IUserService.cs",
            "src/backend/Interfaces/UserApplicationPorts.cs",
            "src/backend/Services/UserService.cs",
            "src/backend/Services/UserService.Ports.cs",
            "src/backend/Services/Security/UserSecurityStepUpService.cs",
            "src/backend/Infrastructure/CoreBridge/Gateways/UserCoreGateway.cs",
            "src/backend/Infrastructure/CoreBridge/Adapters/UserServiceCoreAdapter.cs",
            "src/core/Services/Abstractions/IUserCoreService.cs",
            "src/core/Services/Gateways/IUserCoreGateway.cs",
            "src/core/Services/Implementations/UserCoreService.cs",
            "src/frontend/src/api/auth.ts"
        ];

        string source = string.Join(
            '\n',
            productionFiles.Select(static path => $"// {path}\n{BackendTestPaths.ReadAllTextFromRoot(path)}"));

        foreach (string forbidden in new[]
        {
            "LoginDto",
            "RegisterDto",
            "UpdatePasswordDto",
            "RegisterAsync(RegisterDto",
            "LoginAsync(LoginDto",
            "GetByUsernameAsync",
            "UpdatePasswordAsync",
            "/auth/update-password",
            "AuthUpdatePasswordRequest",
            "encodeAuthUpdatePasswordRequest",
            "updatePassword"
        })
        {
            Assert.DoesNotContain(forbidden, source, StringComparison.Ordinal);
        }

        Assert.DoesNotContain("RegisterAsync(string username", source, StringComparison.Ordinal);
        Assert.DoesNotContain("LoginAsync(string username", source, StringComparison.Ordinal);
        Assert.DoesNotContain("UpdatePasswordAsync(int userId, string oldPassword", source, StringComparison.Ordinal);
    }

    [Fact]
    public void LegacyPasswordAuthFrames_AreRetiredFromProtocolCatalogsAndCodecs()
    {
        string[] protocolFiles =
        [
            "src/shared/Contracts/Validation/aeds-protocol.json",
            "src/core/Algorithms/AedsFrameType.cs",
            "src/shared/AedsFrameHeader.cs",
            "src/frontend/wasm/web/protocol/frame.ts",
            "tests/backend/Fixtures/aeds-golden-catalog.json",
            "src/shared/Contracts/Models/UserPods.cs",
            "src/shared/Contracts/Validation/PodContractValidation.cs",
            "src/shared/Contracts/Validation/PodSizeCatalog.cs",
            "src/core/Mapping/Models/ReadModels.cs",
            "src/core/Cache/PodBinaryCodec.User.cs"
        ];

        string source = string.Join(
            '\n',
            protocolFiles.Select(static path => $"// {path}\n{BackendTestPaths.ReadAllTextFromRoot(path)}"));

        foreach (string forbidden in new[]
        {
            "AuthLoginRequest",
            "AuthRegisterRequest",
            "AuthUpdatePasswordRequest",
            "AuthUpdateUsernameRequest",
            "AuthLoginRequestPod",
            "AuthRegisterRequestPod",
            "AuthUpdatePasswordRequestPod",
            "AuthLoginRequestCoreModel",
            "AuthRegisterRequestCoreModel",
            "AuthUpdatePasswordRequestCoreModel",
            "WriteAuthLoginRequest",
            "WriteAuthRegisterRequest",
            "WriteAuthUpdatePasswordRequest",
            "TryDecodeAuthLoginRequest",
            "TryDecodeAuthRegisterRequest",
            "TryDecodeAuthUpdatePasswordRequest",
            "EncodeAuthLoginRequest",
            "EncodeAuthRegisterRequest",
            "EncodeAuthUpdatePasswordRequest"
        })
        {
            Assert.DoesNotContain(forbidden, source, StringComparison.Ordinal);
        }

        foreach (string required in new[]
        {
            "AuthAnonymousBootstrapRequest",
            "PasskeyRegisterBegin",
            "PasskeyRegisterCompleteRequest",
            "PasskeyLoginBegin",
            "PasskeyLoginCompleteRequest",
            "RecoveryKeyCreateResponse",
            "RecoveryKeyVerifyRequest",
            "RecoveryKeyVerifyResponse",
            "MfaChallengeStartRequest",
            "MfaChallengeVerifyRequest",
            "AdminPrincipalSnapshot"
        })
        {
            Assert.Contains(required, source, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void AdminUsernameLookupRuntimeContracts_AreRemoved()
    {
        string[] productionFiles =
        [
            "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs",
            "src/backend/Interfaces/UserApplicationPorts.cs",
            "src/backend/Services/UserService.Ports.cs",
            "src/shared/Contracts/Validation/fsusblog.openapi.json",
            "src/frontend/src/generated/fsusBinaryRoutes.ts",
            "tests/frontend/fixtures/cross-stack-contract-matrix.json",
            "tests/frontend/fixtures/cross-stack-contract-matrix.generated.json"
        ];

        string source = string.Join(
            '\n',
            productionFiles.Select(static path => $"// {path}\n{BackendTestPaths.ReadAllTextFromRoot(path)}"));

        foreach (string forbidden in new[]
        {
            "group.MapGet(\"/auth/find/{username}\"",
            "/auth/find/{username}",
            "binary_get_auth_find_username",
            "GetAccountByUsernameAsync"
        })
        {
            Assert.DoesNotContain(forbidden, source, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void SharedCoreIdentityContracts_UseAccountSnapshotInsteadOfUserSnapshot()
    {
        string authContracts = BackendTestPaths.ReadAllTextFromRoot("src/shared/Contracts/AuthSystem/AuthSystemContracts.cs");
        string[] productionFiles =
        [
            "src/shared/Contracts/AuthSystem/AuthSystemContracts.cs",
            "src/core/Services/Abstractions/IUserCoreService.cs",
            "src/core/Services/Gateways/IUserCoreGateway.cs",
            "src/core/Services/Implementations/UserCoreService.cs",
            "src/backend/Infrastructure/CoreBridge/Gateways/UserCoreGateway.cs",
            "src/backend/Infrastructure/CoreBridge/Adapters/UserServiceCoreAdapter.cs"
        ];

        string source = string.Join(
            '\n',
            productionFiles.Select(static path => $"// {path}\n{BackendTestPaths.ReadAllTextFromRoot(path)}"));

        foreach (string forbidden in new[]
        {
            "UserSnapshotContract",
            "AuthLoginResultContract",
            "LastLoginIp",
            "string Username",
            "string Role"
        })
        {
            Assert.DoesNotContain(forbidden, source, StringComparison.Ordinal);
        }

        string accountSnapshot = ExtractRecord(authContracts, "public readonly record struct AccountSnapshotContract");
        foreach (string expected in new[]
        {
            "int AccountId",
            "string IdentityKind",
            "string? PublicHandle",
            "bool PasskeyEnabled",
            "bool RecoveryEnabled",
            "bool TotpStepUpEnabled",
            "string? AnonymousCredentialStatus",
            "string? AnonymousCredentialLevel",
            "int Status",
            "DateTime? DeletedAt"
        })
        {
            Assert.Contains(expected, accountSnapshot, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void SysUserLegacyIdentityFields_AreInternalOnly()
    {
        string entity = BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/User.cs");
        string userPorts = BackendTestPaths.ReadAllTextFromRoot("src/backend/Interfaces/UserApplicationPorts.cs");
        string accountReader = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.Ports.cs");
        string userService = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.cs");
        string authoring = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Authoring/AuthoringWorkflowService.cs");
        string publicAot = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/PublicAot/PublicAotBootstrapProviders.cs");
        string passkey = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/PasskeyService.cs");
        string identityRuntime = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Auth/AnonymousIdentityRuntime.cs");

        Assert.Contains("ColumnName = \"username\"", entity, StringComparison.Ordinal);
        Assert.Contains("InternalSubject", entity, StringComparison.Ordinal);
        Assert.Contains("ColumnName = \"password\"", entity, StringComparison.Ordinal);
        Assert.Contains("LegacyPasswordHash", entity, StringComparison.Ordinal);
        Assert.Contains("ColumnName = \"role\"", entity, StringComparison.Ordinal);
        Assert.Contains("LegacyProjectRole", entity, StringComparison.Ordinal);
        Assert.Contains("ColumnName = \"last_username_update_time\"", entity, StringComparison.Ordinal);
        Assert.Contains("InternalSubjectRotatedAt", entity, StringComparison.Ordinal);

        foreach (string forbidden in new[]
        {
            "public string Username",
            "public string Password",
            "public string Role",
            "LastUsernameUpdateTime"
        })
        {
            Assert.DoesNotContain(forbidden, entity, StringComparison.Ordinal);
        }

        foreach (string forbidden in new[]
        {
            "string Username",
            "string Role"
        })
        {
            Assert.DoesNotContain(forbidden, userPorts, StringComparison.Ordinal);
        }

        Assert.DoesNotContain("user.Username", accountReader, StringComparison.Ordinal);
        Assert.DoesNotContain("user.Role", accountReader, StringComparison.Ordinal);
        Assert.DoesNotContain("Role == \"admin\"", userService, StringComparison.Ordinal);
        Assert.DoesNotContain("Role.Equals(\"admin\"", userService, StringComparison.Ordinal);
        Assert.DoesNotContain("LastUsernameUpdateTime", userService, StringComparison.Ordinal);
        Assert.DoesNotContain("user.Username", authoring, StringComparison.Ordinal);
        Assert.DoesNotContain("u.Username", authoring, StringComparison.Ordinal);
        Assert.DoesNotContain("ru.Username", authoring, StringComparison.Ordinal);
        Assert.DoesNotContain("user.Role != \"admin\"", authoring, StringComparison.Ordinal);
        Assert.DoesNotContain("user.Username", publicAot, StringComparison.Ordinal);
        Assert.DoesNotContain("Username { get; init; }", publicAot, StringComparison.Ordinal);
        Assert.DoesNotContain("user.Username", passkey, StringComparison.Ordinal);
        Assert.DoesNotContain("user.Role", identityRuntime, StringComparison.Ordinal);
    }

    [Fact]
    public void UserAccountReader_ProjectsSysUserAsAnonymousAccountContainer()
    {
        var deletedAt = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var user = new User
        {
            Id = 42,
            InternalSubject = "legacy-admin",
            LegacyPasswordHash = "legacy-password-hash",
            LegacyProjectRole = "admin",
            Status = 1,
            BanReason = "limited",
            DeletedAt = deletedAt,
            PublicHandle = "Public Alice",
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            PasskeyEnabled = true,
            RecoveryEnabled = true,
            MfaEnabled = true,
            AnonymousCredentialStatus = "active",
            AnonymousCredentialLevel = "strong_anonymous"
        };

        UserAccountSnapshot account = UserAccountReader.ToAccountSnapshot(user);
        Assert.Equal("active", ReadProperty<string?>(account, "AnonymousCredentialStatus"));
        Assert.Equal("strong_anonymous", ReadProperty<string?>(account, "AnonymousCredentialLevel"));

        MethodInfo? mapper = typeof(UserAccountReader).GetMethod(
            "ToAnonymousAccountSnapshot",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(mapper);

        object anonymous = mapper.Invoke(null, [account])!;
        string[] propertyNames = anonymous.GetType().GetProperties().Select(property => property.Name).ToArray();
        Assert.DoesNotContain("Username", propertyNames);
        Assert.DoesNotContain("Role", propertyNames);
        Assert.DoesNotContain("InternalUserId", propertyNames);
        Assert.Equal(42, ReadProperty<int>(anonymous, "AccountId"));
        Assert.Equal(AnonymousIdentityRuntime.AnonymousAccountKind, ReadProperty<string>(anonymous, "IdentityKind"));
        Assert.Equal("Public Alice", ReadProperty<string?>(anonymous, "PublicHandle"));
        Assert.True(ReadProperty<bool>(anonymous, "PasskeyEnabled"));
        Assert.True(ReadProperty<bool>(anonymous, "RecoveryEnabled"));
        Assert.True(ReadProperty<bool?>(anonymous, "TotpStepUpEnabled"));
        Assert.Equal("active", ReadProperty<string?>(anonymous, "AnonymousCredentialStatus"));
        Assert.Equal("strong_anonymous", ReadProperty<string?>(anonymous, "AnonymousCredentialLevel"));
        Assert.Equal(1, ReadProperty<int>(anonymous, "Status"));
        Assert.Equal("limited", ReadProperty<string?>(anonymous, "BanReason"));
        Assert.Equal(deletedAt, ReadProperty<DateTime?>(anonymous, "DeletedAt"));
    }

    private static T? ReadProperty<T>(object instance, string propertyName)
    {
        PropertyInfo? property = instance.GetType().GetProperty(propertyName);
        Assert.NotNull(property);
        return (T?)property.GetValue(instance);
    }

    private static string ExtractEndpointBlock(string source, string marker)
    {
        int start = source.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing endpoint marker {marker}");
        int end = source.IndexOf(".Require", start, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing endpoint terminator after {marker}");
        int nextSemicolon = source.IndexOf(';', end);
        Assert.True(nextSemicolon > end, $"Missing endpoint semicolon after {marker}");
        return source[start..(nextSemicolon + 1)];
    }

    private static string ExtractRecord(string source, string marker)
    {
        int start = source.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing record marker {marker}");
        int end = source.IndexOf(";", start, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing record terminator after {marker}");
        return source[start..(end + 1)];
    }

    private static string ExtractStruct(string source, string marker)
    {
        int start = source.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing struct marker {marker}");
        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart > start, $"Missing struct body after {marker}");
        int depth = 0;
        for (int i = braceStart; i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[start..(i + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Missing struct terminator after {marker}");
    }

    private static string ExtractBetween(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start marker {startMarker}");
        int end = source.IndexOf(endMarker, start, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing end marker {endMarker}");
        return source[start..end];
    }
}
