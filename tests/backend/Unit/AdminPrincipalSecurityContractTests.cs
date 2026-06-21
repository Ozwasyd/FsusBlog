using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminPrincipalSecurityContractTests
{
    [Fact]
    public void AdminPrincipalPlane_DefinesIndependentTablesAndMigration()
    {
        string entities = string.Join(
            "\n",
            BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/AdminPrincipal.cs"),
            BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/AdminSession.cs"),
            BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/AdminPasskeyCredential.cs"),
            BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/AdminAuditLog.cs"));
        string migrations = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs");

        Assert.Contains("[SugarTable(\"admin_principal\")]", entities, StringComparison.Ordinal);
        Assert.Contains("[SugarTable(\"admin_session\")]", entities, StringComparison.Ordinal);
        Assert.Contains("[SugarTable(\"admin_passkey_credential\")]", entities, StringComparison.Ordinal);
        Assert.Contains("[SugarTable(\"admin_audit_log\")]", entities, StringComparison.Ordinal);
        Assert.Contains("BuildAdminPrincipalPlaneMigration()", migrations, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS admin_principal", migrations, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS admin_session", migrations, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS admin_passkey_credential", migrations, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS admin_audit_log", migrations, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminPrincipalPlane_UsesSeparateCookiesAndJwtClaims()
    {
        string cookies = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Auth/AuthCookieService.cs");
        string jwt = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Helpers/JwtHelper.cs");
        string claims = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Helpers/ClaimsPrincipalExtensions.cs");

        Assert.Contains("__Host-AdminAccessToken", cookies, StringComparison.Ordinal);
        Assert.Contains("__Host-AdminSessionId", cookies, StringComparison.Ordinal);
        Assert.Contains("SetAdminSessionCookies", cookies, StringComparison.Ordinal);
        Assert.Contains("TryReadAdminAccessToken", cookies, StringComparison.Ordinal);
        Assert.Contains("GenerateAdminAccessToken", jwt, StringComparison.Ordinal);
        Assert.Contains("admin_id", jwt, StringComparison.Ordinal);
        Assert.Contains("admin_sid", jwt, StringComparison.Ordinal);
        Assert.Contains("AdminPermissions.PermissionClaimType", jwt, StringComparison.Ordinal);
        Assert.Contains("ShouldPreferAdminCookie", jwt, StringComparison.Ordinal);
        Assert.Contains("TryGetAdminPrincipalId", claims, StringComparison.Ordinal);
        Assert.Contains("GetAdminSessionId", claims, StringComparison.Ordinal);
        Assert.Contains("HasAdminPermission", claims, StringComparison.Ordinal);
    }

    [Fact]
    public void UserTokenAndRequestContext_DoNotExposeLegacyAdminAuthority()
    {
        string jwt = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Helpers/JwtHelper.cs");
        string userToken = ExtractMethodBlock(jwt, "public string GenerateAccessToken(User user");
        string context = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Auth/EndpointUserContext.cs");

        Assert.DoesNotContain("ClaimTypes.Role", userToken, StringComparison.Ordinal);
        Assert.DoesNotContain("new(ClaimTypes.Name,", userToken, StringComparison.Ordinal);
        Assert.DoesNotContain("ResolveBackendRole", userToken, StringComparison.Ordinal);
        Assert.DoesNotContain("UserName", context, StringComparison.Ordinal);
        Assert.DoesNotContain("IsAdmin", context, StringComparison.Ordinal);
        Assert.DoesNotContain("IsInRole", context, StringComparison.Ordinal);
    }

    [Fact]
    public void ProductionAdminJudgments_DoNotUseRoleBasedAdminChecks()
    {
        string[] files =
        [
            "src/backend/Infrastructure/Auth/EndpointUserContext.cs",
            "src/backend/Infrastructure/NotificationStream/NotificationStreamAudienceResolver.cs",
            "src/backend/Infrastructure/Bootstrap/ServiceCollectionExtensions.cs",
            "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs",
            "src/backend/Infrastructure/Audit/AuditRecord.cs"
        ];

        foreach (string file in files)
        {
            string source = BackendTestPaths.ReadAllTextFromRoot(file);
            Assert.DoesNotContain("IsInRole(\"admin\")", source, StringComparison.Ordinal);
            Assert.DoesNotContain("FindFirst(ClaimTypes.Role)", source, StringComparison.Ordinal);
        }

        string notification = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/NotificationStream/NotificationStreamAudienceResolver.cs");
        string rateLimiting = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Bootstrap/ServiceCollectionExtensions.cs");
        Assert.Contains("IsAdminPrincipal()", notification, StringComparison.Ordinal);
        Assert.Contains("TryGetAdminPrincipalId", notification, StringComparison.Ordinal);
        Assert.Contains("IsAdminPrincipal()", rateLimiting, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminPrincipalPlane_BootstrapIsGuardedAndPasskeyOnly()
    {
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AdminPrincipalService.cs");
        string endpoints = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");

        Assert.Contains("FSUSBLOG_ADMIN_BOOTSTRAP_TOKEN", service, StringComparison.Ordinal);
        Assert.Contains("BeginBootstrapPasskeyRegistrationAsync", service, StringComparison.Ordinal);
        Assert.Contains("CompleteBootstrapPasskeyRegistrationAsync", service, StringComparison.Ordinal);
        Assert.Contains("BeginAdminAssertionAsync", service, StringComparison.Ordinal);
        Assert.Contains("CompleteAdminAssertionAsync", service, StringComparison.Ordinal);
        Assert.Contains("Root admin already exists", service, StringComparison.Ordinal);
        Assert.DoesNotContain("AdminPassword", service, StringComparison.Ordinal);
        Assert.DoesNotContain("VerifyPassword", service, StringComparison.Ordinal);
        Assert.Contains("/auth/admin/bootstrap/passkey/begin", endpoints, StringComparison.Ordinal);
        Assert.Contains("/auth/admin/bootstrap/passkey/complete", endpoints, StringComparison.Ordinal);
        Assert.Contains("/auth/admin/login/passkey/begin", endpoints, StringComparison.Ordinal);
        Assert.Contains("/auth/admin/login/passkey/complete", endpoints, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminPasskeyChallenges_AreConsumedAtomicallyBeforeWebAuthn()
    {
        string cache = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Cache/IUnifiedCache.cs");
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AdminPrincipalService.cs");
        string bootstrapComplete = ExtractMethodBlock(service, "public async Task<(bool Success, string Message, AdminSessionTokens? Tokens)> CompleteBootstrapPasskeyRegistrationAsync");
        string loginComplete = ExtractMethodBlock(service, "public async Task<(bool Success, string Message, AdminSessionTokens? Tokens)> CompleteAdminAssertionAsync");
        string stepUpComplete = ExtractMethodBlock(service, "public async Task<(bool Success, string Message, string? ProofToken)> CompleteAdminStepUpAssertionAsync");

        Assert.Contains("ConsumeOnceAndGetAsync<T>", cache, StringComparison.Ordinal);
        Assert.Contains("ConsumeChallengeAsync<AdminBootstrapChallenge>", bootstrapComplete, StringComparison.Ordinal);
        Assert.Contains("ConsumeChallengeAsync<PasskeyLoginBeginCoreModel>", loginComplete, StringComparison.Ordinal);
        Assert.Contains("ConsumeChallengeAsync<AdminStepUpChallenge>", stepUpComplete, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadChallengeAsync<", bootstrapComplete, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadChallengeAsync<", loginComplete, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadChallengeAsync<", stepUpComplete, StringComparison.Ordinal);
        Assert.DoesNotContain("cache.RemoveAsync(CachePolicyId.SecurityPasskeyRegChallenge", bootstrapComplete, StringComparison.Ordinal);
        Assert.DoesNotContain("cache.RemoveAsync(CachePolicyId.SecurityPasskeyAuthChallenge", loginComplete, StringComparison.Ordinal);
        Assert.DoesNotContain("cache.RemoveAsync(CachePolicyId.SecurityPasskeyAuthChallenge", stepUpComplete, StringComparison.Ordinal);
    }

    [Fact]
    public void RootAdminBootstrap_UsesDatabaseUniquenessAndTransaction()
    {
        string migrations = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs");
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AdminPrincipalService.cs");
        string bootstrapComplete = ExtractMethodBlock(service, "public async Task<(bool Success, string Message, AdminSessionTokens? Tokens)> CompleteBootstrapPasskeyRegistrationAsync");

        Assert.Contains(
            "CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_admin_principal_active_root ON admin_principal(isroot) WHERE isroot = true AND status = 'active';",
            migrations,
            StringComparison.Ordinal);
        Assert.Contains("db.Ado.UseTranAsync(async () =>", bootstrapComplete, StringComparison.Ordinal);
        AssertContainsAfter(bootstrapComplete, "db.Ado.UseTranAsync(async () =>", "AcquireRootBootstrapLockAsync(cancellationToken)");
        AssertContainsAfter(bootstrapComplete, "db.Ado.UseTranAsync(async () =>", "RootAdminExistsAsync(cancellationToken)");
        AssertContainsAfter(bootstrapComplete, "db.Ado.UseTranAsync(async () =>", "db.Insertable(principal).ExecuteReturnIdentityAsync()");
        AssertContainsAfter(bootstrapComplete, "db.Ado.UseTranAsync(async () =>", "db.Insertable(credential).ExecuteCommandAsync()");
        AssertContainsAfter(bootstrapComplete, "db.Ado.UseTranAsync(async () =>", "CreateSessionAndTokenAsync(principal, clientContext, stepUpVerified: false, cancellationToken)");
        AssertContainsAfter(bootstrapComplete, "db.Ado.UseTranAsync(async () =>", "WriteAuditAsync(principal.Id, tokens.SessionId, \"admin.bootstrap.completed\"");
        Assert.Contains("if (!bootstrap.IsSuccess)", bootstrapComplete, StringComparison.Ordinal);
        Assert.Contains("IsUniqueViolation(bootstrap.ErrorException)", bootstrapComplete, StringComparison.Ordinal);
        Assert.Contains("return (false, \"Root admin already exists\", null);", bootstrapComplete, StringComparison.Ordinal);
        Assert.Contains("pg_advisory_xact_lock", service, StringComparison.Ordinal);
        Assert.Contains("private static bool IsUniqueViolation(Exception? exception)", service, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminPrincipalPlane_AuditAndPermissionsAreExplicit()
    {
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AdminPrincipalService.cs");
        string auth = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Auth/AdminPermissions.cs");
        string endpoints = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");

        foreach (string permission in AdminPermissions.All)
        {
            Assert.Contains(permission, auth, StringComparison.Ordinal);
        }

        Assert.Contains("AdminAuditLog", service, StringComparison.Ordinal);
        Assert.Contains("admin.bootstrap.completed", service, StringComparison.Ordinal);
        Assert.Contains("admin.login.completed", service, StringComparison.Ordinal);
        Assert.Contains("RequireAdminPermission", endpoints, StringComparison.Ordinal);
        Assert.Contains("AdminPermissions.AdminManage", endpoints, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminPrincipalMe_ReturnsIndependentPrincipalSnapshot()
    {
        string endpoints = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");

        Assert.Contains("/auth/admin/me", endpoints, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.AdminPrincipalSnapshot", endpoints, StringComparison.Ordinal);
        Assert.Contains("AdminPrincipalSnapshotDto", endpoints, StringComparison.Ordinal);
        Assert.Contains("AdminPermissions.PermissionClaimType", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("group.MapGet(\"/auth/admin/me\", static (IAedsEncoder aeds) =>", endpoints, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousIdentityRuntime_DoesNotGrantAdminFromLegacyUserRole()
    {
        string resolved = AnonymousIdentityRuntime.ResolveBackendRole("admin", AnonymousIdentityRuntime.AnonymousAccountKind, anonymousIdentityModeEnabled: true);

        Assert.Equal(AnonymousIdentityRuntime.AuthenticatedRole, resolved);
    }

    [Fact]
    public void AdminPrincipalCookie_IsOnlyPreferredForAdminAuthorizationMetadata()
    {
        var userContext = new DefaultHttpContext();
        userContext.Request.Path = "/api/binary/auth/me";
        userContext.SetEndpoint(new Endpoint(
            static _ => Task.CompletedTask,
            new EndpointMetadataCollection(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build()),
            "user"));

        Assert.False(JwtServiceExtensions.ShouldPreferAdminCookie(userContext));

        var roleAdminContext = new DefaultHttpContext();
        roleAdminContext.Request.Path = "/api/binary/auth/me";
        roleAdminContext.SetEndpoint(new Endpoint(
            static _ => Task.CompletedTask,
            new EndpointMetadataCollection(new AuthorizationPolicyBuilder().RequireRole("admin").Build()),
            "role-admin"));

        Assert.False(JwtServiceExtensions.ShouldPreferAdminCookie(roleAdminContext));

        var principalAdminContext = new DefaultHttpContext();
        principalAdminContext.Request.Path = "/api/binary/auth/admin/me";
        principalAdminContext.SetEndpoint(new Endpoint(
            static _ => Task.CompletedTask,
            new EndpointMetadataCollection(new AuthorizationPolicyBuilder()
                .RequireAuthenticatedUser()
                .RequireClaim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind)
                .RequireClaim(AdminPermissions.PermissionClaimType, AdminPermissions.AdminManage)
                .Build()),
            "principal-admin"));

        Assert.True(JwtServiceExtensions.ShouldPreferAdminCookie(principalAdminContext));
    }

    [Fact]
    public void AdminJwtAndCookieSelection_DoNotRetainRoleBasedAdminCompatibility()
    {
        string jwt = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Helpers/JwtHelper.cs");

        Assert.DoesNotContain("new(ClaimTypes.Role, \"admin\")", jwt, StringComparison.Ordinal);
        Assert.DoesNotContain("PolicyRequiresAdminRole", jwt, StringComparison.Ordinal);
        Assert.DoesNotContain("ContainsAdminRole", jwt, StringComparison.Ordinal);
        Assert.DoesNotContain("RolesAuthorizationRequirement", jwt, StringComparison.Ordinal);
        Assert.DoesNotContain("RequireRole(\"admin\")", jwt, StringComparison.Ordinal);
    }

    private static string ExtractMethodBlock(string source, string signature)
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
                    return source[start..(i + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Unable to extract method body: {signature}");
    }

    private static void AssertContainsAfter(string source, string marker, string expected)
    {
        int markerIndex = source.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(markerIndex >= 0, $"Unable to locate marker: {marker}");
        int expectedIndex = source.IndexOf(expected, markerIndex, StringComparison.Ordinal);
        Assert.True(expectedIndex > markerIndex, $"Expected to find '{expected}' after '{marker}'.");
    }
}
