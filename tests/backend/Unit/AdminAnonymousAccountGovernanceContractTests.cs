using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminAnonymousAccountGovernanceContractTests
{
    [Fact]
    public void AdminUserBinaryEndpoints_DoNotExposeLegacyPasswordReset()
    {
        string endpoints = Read("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.AdminUsers.cs");

        Assert.DoesNotContain("/admin/users/reset-pwd", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("AdminResetUserPasswordRequest", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("TryDecodeAdminResetUserPasswordRequest", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("AdminResetPasswordAsync", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("AdminResetPwdDto", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("UserPasswordReset", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("管理员强制重置用户密码", endpoints, StringComparison.Ordinal);

        Assert.Contains("AuditActionCatalog.AnonymousAccountStatusChanged", endpoints, StringComparison.Ordinal);
        Assert.Contains("管理员变更匿名账号状态", endpoints, StringComparison.Ordinal);
        Assert.Contains("TargetType: \"anonymous_account\"", endpoints, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminAccountListContract_UsesAnonymousAccountFields()
    {
        string outputs = Read("src/shared/Contracts/Outputs/ServerResponseContracts.cs");
        string authContracts = Read("src/shared/Contracts/AuthSystem/AuthSystemContracts.cs");
        string userPods = Read("src/shared/Contracts/Models/UserPods.cs");
        string adapter = Read("src/frontend/src/adapters/binary/userAdapter.ts");
        string api = Read("src/frontend/src/api/admin.ts");

        foreach (string source in new[] { outputs, authContracts, userPods })
        {
            Assert.Contains("AccountId", source, StringComparison.Ordinal);
            Assert.Contains("IdentityKind", source, StringComparison.Ordinal);
            Assert.Contains("PublicHandle", source, StringComparison.Ordinal);
            Assert.Contains("Passkey", source, StringComparison.Ordinal);
            Assert.Contains("Recovery", source, StringComparison.Ordinal);
            Assert.Contains("AnonymousCredentialStatus", source, StringComparison.Ordinal);
            Assert.Contains("AnonymousCredentialLevel", source, StringComparison.Ordinal);
            Assert.Contains("RiskFlags", source, StringComparison.Ordinal);
        }

        Assert.DoesNotContain("LastLoginIp", ExtractDeclaration(outputs, "public readonly record struct AdminAccountListItemDto"), StringComparison.Ordinal);
        Assert.DoesNotContain("LastLoginIp", ExtractDeclaration(authContracts, "public readonly record struct AdminAccountListItemContract"), StringComparison.Ordinal);
        Assert.DoesNotContain("LastLoginIp", ExtractTypeBlock(userPods, "public readonly struct UserListItemPod"), StringComparison.Ordinal);

        foreach (string source in new[] { adapter, api })
        {
            Assert.Contains("accountId", source, StringComparison.Ordinal);
            Assert.Contains("identityKind", source, StringComparison.Ordinal);
            Assert.Contains("publicHandle", source, StringComparison.Ordinal);
            Assert.Contains("passkeyInitialized", source, StringComparison.Ordinal);
            Assert.Contains("recoveryInitialized", source, StringComparison.Ordinal);
            Assert.Contains("anonymousCredentialStatus", source, StringComparison.Ordinal);
            Assert.Contains("anonymousCredentialLevel", source, StringComparison.Ordinal);
            Assert.Contains("riskFlags", source, StringComparison.Ordinal);
            Assert.DoesNotContain("lastLoginIp", source, StringComparison.Ordinal);
        }

        Assert.Contains("public readonly record struct AdminAccountListItemDto", outputs, StringComparison.Ordinal);
        Assert.DoesNotContain("public readonly record struct UserListDto", outputs, StringComparison.Ordinal);
        Assert.Contains("public readonly record struct AdminAccountListItemContract", authContracts, StringComparison.Ordinal);
        Assert.DoesNotContain("public readonly record struct UserListItemContract", authContracts, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminAccountListQuery_DoesNotSearchUsernameOrProjectRole()
    {
        string userService = Read("src/backend/Services/UserService.cs");
        string method = ExtractMethod(userService, "public async Task<PageResult<AdminAccountListItemDto>> GetAdminUserListAsync");
        string observability = Read("src/backend/Infrastructure/Observability/FsusObservability.cs");
        string migrations = Read("src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs");

        Assert.Contains("identity_kind AS", userService, StringComparison.Ordinal);
        Assert.Contains("public_handle AS", userService, StringComparison.Ordinal);
        Assert.Contains("passkey_enabled AS", userService, StringComparison.Ordinal);
        Assert.Contains("recovery_enabled AS", userService, StringComparison.Ordinal);
        Assert.Contains("anonymous_credential_status AS", userService, StringComparison.Ordinal);
        Assert.Contains("anonymous_credential_level AS", userService, StringComparison.Ordinal);
        Assert.Contains("riskflags AS", userService, StringComparison.Ordinal);
        Assert.Contains("privacy_initialized_at AS", userService, StringComparison.Ordinal);

        Assert.DoesNotContain("u.Username.Contains", method, StringComparison.Ordinal);
        Assert.DoesNotContain("u.Role", method, StringComparison.Ordinal);
        Assert.DoesNotContain("u.LastLoginIp", method, StringComparison.Ordinal);
        Assert.DoesNotContain("u.Password", method, StringComparison.Ordinal);
        Assert.DoesNotContain(".Skip(", method, StringComparison.Ordinal);
        Assert.DoesNotContain(".CountAsync()", method, StringComparison.Ordinal);
        Assert.DoesNotContain(".Contains(keyword)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("IdentityKind.Contains", method, StringComparison.Ordinal);
        Assert.Contains("ORDER BY createtime DESC, id DESC", userService, StringComparison.Ordinal);
        Assert.Contains("public_handle LIKE @SearchPublicHandlePrefix", userService, StringComparison.Ordinal);
        Assert.Contains("ApplyAdminAccountSearch", method, StringComparison.Ordinal);
        Assert.Contains("LoadAdminAccountListWindowAsync", method, StringComparison.Ordinal);
        Assert.Contains("RecordAdminAccountListQuery", method, StringComparison.Ordinal);
        Assert.Contains("fsus.admin.account_list.query_elapsed_ms", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.admin.account_list.count_used", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.admin.account_list.count_skipped", observability, StringComparison.Ordinal);
        Assert.Contains("idx_user_admin_list_time_id", migrations, StringComparison.Ordinal);
        Assert.Contains("idx_user_admin_list_status_time_id", migrations, StringComparison.Ordinal);
        Assert.Contains("idx_user_admin_list_identity_time_id", migrations, StringComparison.Ordinal);
        Assert.Contains("idx_user_public_handle_prefix", migrations, StringComparison.Ordinal);
        Assert.Contains("public_handle text_pattern_ops", migrations, StringComparison.Ordinal);
    }

    [Fact]
    public void BinaryAuthEndpoints_DoNotExposeUsernameLookupRoute()
    {
        string authEndpoints = Read("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string applicationPorts = Read("src/backend/Interfaces/UserApplicationPorts.cs");
        string userPorts = Read("src/backend/Services/UserService.Ports.cs");
        string openApi = Read("src/shared/Contracts/Validation/fsusblog.openapi.json");
        string residue = Read("tools/check-historical-residue.sh");

        Assert.DoesNotContain("/auth/find/{username}", authEndpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAccountByUsernameAsync", authEndpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAccountByUsernameAsync", applicationPorts, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAccountByUsernameAsync", userPorts, StringComparison.Ordinal);
        Assert.DoesNotContain("/api/binary/auth/find/{username}", openApi, StringComparison.Ordinal);
        Assert.Contains("legacy username account lookup endpoint", residue, StringComparison.Ordinal);
    }

    [Fact]
    public void UserApplicationPorts_DoNotCarryLegacyAdminResetPasswordPath()
    {
        foreach (string path in new[]
        {
            "src/backend/Interfaces/IUserService.cs",
            "src/backend/Interfaces/UserApplicationPorts.cs",
            "src/backend/Services/UserService.Ports.cs",
            "src/backend/Infrastructure/CoreBridge/Adapters/UserServiceCoreAdapter.cs",
            "src/backend/Infrastructure/CoreBridge/Gateways/UserCoreGateway.cs",
            "src/core/Services/Abstractions/IUserCoreService.cs",
            "src/core/Services/Gateways/IUserCoreGateway.cs",
            "src/core/Services/Implementations/UserCoreService.cs"
        })
        {
            string source = Read(path);
            Assert.DoesNotContain("AdminResetPasswordAsync", source, StringComparison.Ordinal);
            Assert.DoesNotContain("AdminResetPwdDto", source, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void DangerousOperationPolicy_DoesNotAdvertisePasswordResetGovernance()
    {
        string operations = Read("src/backend/Infrastructure/Operations/AdminOperationsService.cs");

        Assert.DoesNotContain("重置密码", operations, StringComparison.Ordinal);
        Assert.DoesNotContain("password-reset", operations, StringComparison.Ordinal);
        Assert.Contains("批量封禁匿名账号", operations, StringComparison.Ordinal);
        Assert.Contains("撤销账号会话", operations, StringComparison.Ordinal);
        Assert.Contains("anonymous-account-suspend", operations, StringComparison.Ordinal);
        Assert.Contains("session-revoke", operations, StringComparison.Ordinal);
    }

    private static string Read(string relativePath)
        => BackendTestPaths.ReadAllTextFromRoot(relativePath);

    private static string ExtractMethod(string source, string signature)
        => ExtractTypeBlock(source, signature);

    private static string ExtractTypeBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Unable to locate method signature: {signature}");
        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart > start, $"Unable to locate method body: {signature}");

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
                    return source.Substring(braceStart, i - braceStart + 1);
                }
            }
        }

        throw new InvalidOperationException($"Unable to extract method body: {signature}");
    }

    private static string ExtractDeclaration(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Unable to locate declaration: {signature}");
        int end = source.IndexOf(");", start, StringComparison.Ordinal);
        Assert.True(end > start, $"Unable to locate declaration end: {signature}");
        return source.Substring(start, end - start + 2);
    }
}
