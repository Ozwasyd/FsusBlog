using System.Text.RegularExpressions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class EndpointPolicyContractTests
{
    [Fact]
    public void AuthoringAndSecurityAdminBinaryEndpoints_AreNativeAedsRoutesWithoutBridgePipeline()
    {
        string composition = ReadRepoFile(
            "src",
            "backend",
            "Infrastructure",
            "Bootstrap",
            "WebApplicationCompositionExtensions.cs");
        Assert.DoesNotContain("AuthoringBinaryBridgeMiddleware", composition, StringComparison.Ordinal);
        Assert.DoesNotContain("SecurityBinaryBridgeMiddleware", composition, StringComparison.Ordinal);

        string authoring = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "AuthoringEndpoints.cs");
        Assert.Contains("private const string BinaryPrefix = \"/api/binary/author\"", authoring, StringComparison.Ordinal);
        Assert.Contains("app.MapGroup(BinaryPrefix)", authoring, StringComparison.Ordinal);
        Assert.DoesNotContain("BinaryBridgeInternalRequest.AuthoringPrefix", authoring, StringComparison.Ordinal);
        Assert.DoesNotContain("BinaryBridgeInternalOnlyFilter", authoring, StringComparison.Ordinal);
        Assert.DoesNotContain("JsonApiResponse<", authoring, StringComparison.Ordinal);

        string security = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "SecurityEndpoints.cs");
        Assert.Contains("private const string BinaryPrefix = \"/api/binary/admin/security\"", security, StringComparison.Ordinal);
        Assert.Contains("app.MapGroup(BinaryPrefix)", security, StringComparison.Ordinal);
        Assert.DoesNotContain("BinaryBridgeInternalRequest.SecurityPrefix", security, StringComparison.Ordinal);
        Assert.DoesNotContain("BinaryBridgeInternalOnlyFilter", security, StringComparison.Ordinal);
        Assert.DoesNotContain("JsonApiResponse<", security, StringComparison.Ordinal);
    }

    [Fact]
    public void AedsOnlyPolicy_DoesNotAllowRuntimeBinaryBridgeCompatibility()
    {
        string allowlist = ReadRepoFile("tools", "contracts", "aeds-only-policy.allowlist.json");
        string scanner = ReadRepoFile("tools", "contracts", "check-aeds-only-policy.mjs");
        string policy = ReadRepoFile("docs", "api", "aeds-only-policy.md");

        Assert.DoesNotContain("migration-legacy-temporary", allowlist, StringComparison.Ordinal);
        Assert.DoesNotContain("binary-bridge/author", allowlist, StringComparison.Ordinal);
        Assert.DoesNotContain("binary-bridge/admin/security", allowlist, StringComparison.Ordinal);
        Assert.DoesNotContain("migration-legacy-temporary", scanner, StringComparison.Ordinal);
        Assert.DoesNotContain("binary-bridge/author", policy, StringComparison.Ordinal);
        Assert.DoesNotContain("binary-bridge/admin/security", policy, StringComparison.Ordinal);
    }

    [Fact]
    public void BinaryAuthPowChallenge_RequiresNoStoreResponse()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Auth.cs");

        Assert.Matches(
            new Regex(
                @"MapGet\(""/auth/pow-challenge""[\s\S]*?\.AllowAnonymous\(\)\s*\.RequireNoStoreResponse\(\);",
                RegexOptions.CultureInvariant),
            source);
    }

    [Fact]
    public void SecurityChallengeVerifyRateLimiter_DoesNotUseStaticConcurrentDictionary()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.SecurityChallenge.cs");

        Assert.DoesNotContain("SecurityChallengeVerifyRateBuckets", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ConcurrentDictionary<string, SecurityChallengeVerifyRateBucket>", source, StringComparison.Ordinal);
        Assert.DoesNotContain("PruneSecurityChallengeVerifyRateBuckets", source, StringComparison.Ordinal);
        Assert.DoesNotContain("SecurityChallengeVerifyRateBucket", source, StringComparison.Ordinal);
        Assert.Contains("ISecurityChallengeVerifyRateLimiter", source, StringComparison.Ordinal);
        Assert.Contains("verifyRateLimiter.TryAcquireAsync", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AccountSecurityCredentialMutations_RequireUnifiedStepUpBoundary()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Auth.cs");

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

        AssertStepUpBoundary(recoveryCreate, "UserSecurityStepUpActions.RecoveryKeyCreate");
        AssertStepUpBoundary(recoveryRotate, "UserSecurityStepUpActions.RecoveryKeyRotate");
        AssertStepUpBoundary(passkeyDelete, "UserSecurityStepUpActions.PasskeyDelete");
        AssertStepUpBoundary(passkeyRename, "UserSecurityStepUpActions.PasskeyCredentialNameUpdate");
        AssertAnonymousCredentialMutationRejectsBodyProof(recoveryCreate);
        AssertAnonymousCredentialMutationRejectsBodyProof(recoveryRotate);
        AssertAnonymousCredentialMutationRejectsBodyProof(passkeyDelete);
        AssertAnonymousCredentialMutationRejectsBodyProof(passkeyRename);

        string stepUpReader = ExtractBetween(
            source,
            "private static async Task<(UserSecurityStepUpProof Proof, ErrorDetail Error)> ReadUserSecurityStepUpProofAsync",
            "private static bool HasBinaryRequestBody");
        Assert.Contains("AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled()", stepUpReader, StringComparison.Ordinal);
        Assert.Contains("ANONYMOUS_STEP_UP_BODY_PROOF_REJECTED", stepUpReader, StringComparison.Ordinal);
        Assert.Matches(
            new Regex(
                @"allowPasswordBody\s*&&\s*!AnonymousIdentityRuntime[.]IsAnonymousIdentityModeEnabled[(][)]\s*&&\s*HasBinaryRequestBody",
                RegexOptions.CultureInvariant),
            stepUpReader);

        string serviceRegistration = ReadRepoFile(
            "src",
            "backend",
            "Infrastructure",
            "Bootstrap",
            "RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs");
        Assert.Contains(
            "services.AddScoped<IUserSecurityStepUpService, UserSecurityStepUpService>();",
            serviceRegistration,
            StringComparison.Ordinal);
    }

    [Fact]
    public void BinaryArticleAdminRoutes_AreUnderAdminPrefix()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Articles.cs");

        Assert.Contains("MapGet(\"/admin/article\"", source, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/admin/article/{id:int}\"", source, StringComparison.Ordinal);
        Assert.Contains("MapPost(\"/admin/article\"", source, StringComparison.Ordinal);
        Assert.Contains("MapPut(\"/admin/article/{id:int}\"", source, StringComparison.Ordinal);
        Assert.DoesNotContain("MapGet(\"/article/{id:int}\"", source, StringComparison.Ordinal);
        Assert.DoesNotContain("MapPost(\"/article\"", source, StringComparison.Ordinal);
    }

    [Fact]
    public void RestrictedAccountActions_AreExplicitAndDoNotBypassMessages()
    {
        string policySource = ReadRepoFile(
            "src",
            "backend",
            "Infrastructure",
            "Policies",
            "EndpointPolicyMetadata.cs");
        Assert.DoesNotContain("BannedUserWriteBypassMetadata", policySource, StringComparison.Ordinal);
        Assert.DoesNotContain("AllowBannedUserWrite", policySource, StringComparison.Ordinal);
        Assert.Contains("public enum RestrictedAccountAction", policySource, StringComparison.Ordinal);
        Assert.Contains("Logout", policySource, StringComparison.Ordinal);
        Assert.Contains("DeleteOwnAccount", policySource, StringComparison.Ordinal);
        Assert.Contains("RevokeOwnSession", policySource, StringComparison.Ordinal);
        Assert.Contains("RevokeOtherSessions", policySource, StringComparison.Ordinal);
        Assert.Contains("Appeal", policySource, StringComparison.Ordinal);

        string authSource = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Auth.cs");
        Assert.Matches(
            new Regex(
                @"MapPost\(""/auth/delete-account""[\s\S]*?AllowRestrictedAccountAction\(RestrictedAccountAction\.DeleteOwnAccount\)",
                RegexOptions.CultureInvariant),
            authSource);
        string deleteAccount = ExtractBetween(
            authSource,
            "group.MapPost(\"/auth/delete-account\"",
            "group.MapGet(\"/auth/sessions\"");
        Assert.Contains("IUserSecurityStepUpService stepUp", deleteAccount, StringComparison.Ordinal);
        Assert.Contains("RequireUserSecurityStepUpAsync(", deleteAccount, StringComparison.Ordinal);
        Assert.Contains("UserSecurityStepUpActions.AccountDelete", deleteAccount, StringComparison.Ordinal);
        Assert.Contains("TryReadMfaProof(httpContext, out string proofToken)", deleteAccount, StringComparison.Ordinal);
        Assert.DoesNotContain("Password = request.Password", deleteAccount, StringComparison.Ordinal);
        Assert.Matches(
            new Regex(
                @"MapPost\(""/auth/logout""[\s\S]*?AllowRestrictedAccountAction\(RestrictedAccountAction\.Logout\)",
                RegexOptions.CultureInvariant),
            authSource);
        Assert.Matches(
            new Regex(
                @"MapPost\(""/auth/sessions/\{id\}/revoke""[\s\S]*?AllowRestrictedAccountAction\(RestrictedAccountAction\.RevokeOwnSession\)",
                RegexOptions.CultureInvariant),
            authSource);
        Assert.Matches(
            new Regex(
                @"MapPost\(""/auth/sessions/revoke-others""[\s\S]*?AllowRestrictedAccountAction\(RestrictedAccountAction\.RevokeOtherSessions\)",
                RegexOptions.CultureInvariant),
            authSource);

        string messageSource = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Messages.cs");
        Assert.DoesNotContain("AllowRestrictedAccountAction", messageSource, StringComparison.Ordinal);
        Assert.DoesNotContain("AllowBannedUserWrite", messageSource, StringComparison.Ordinal);
    }

    [Fact]
    public void BannedUserMiddleware_UsesStableLockedWriteError()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Infrastructure",
            "Filters",
            "BannedUserMiddleware.cs");

        Assert.Contains("RestrictedAccountActionMetadata", source, StringComparison.Ordinal);
        Assert.Contains("ACCOUNT_BANNED_WRITE_LOCKED", source, StringComparison.Ordinal);
        Assert.Contains("StatusCodes.Status423Locked", source, StringComparison.Ordinal);
        Assert.DoesNotContain("banState.Message", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AuthenticationBoundaries_DoNotRejectBannedAccountsBeforeSessionIssue()
    {
        string userServiceSource = ReadRepoFile(
            "src",
            "backend",
            "Services",
            "UserService.cs");
        string completeLoginSource = ExtractBetween(
            userServiceSource,
            "public async Task<(bool Success, string Message, SessionTokenResponseDto? Data, User? UserEntity)> CompleteLoginAsync",
            "string refreshToken = _jwtHelper.GenerateRefreshToken();");
        Assert.Contains("login.restricted", completeLoginSource, StringComparison.Ordinal);
        Assert.Contains("LogBannedUserLogin", completeLoginSource, StringComparison.Ordinal);
        Assert.DoesNotContain("账户已被封禁", completeLoginSource, StringComparison.Ordinal);

        string refreshSource = ExtractBetween(
            userServiceSource,
            "var user = await _db.Queryable<User>().InSingleAsync(session.UserId);",
            "string newRefreshToken = _jwtHelper.GenerateRefreshToken();");
        Assert.DoesNotContain("user.Status == UserStatusBanned ||", refreshSource, StringComparison.Ordinal);
        Assert.Contains("LogBannedUserTokenRefresh", refreshSource, StringComparison.Ordinal);

        string passkeySource = ReadRepoFile(
            "src",
            "backend",
            "Services",
            "Security",
            "PasskeyService.cs");
        string assertionSource = ExtractBetween(
            passkeySource,
            "public async Task<(bool Success, string Message, User? User)> CompleteAssertionAsync",
            "byte[] storedPublicKey");
        Assert.DoesNotContain("账户已被封禁", assertionSource, StringComparison.Ordinal);
        Assert.DoesNotContain("user.Status == 1", assertionSource, StringComparison.Ordinal);
    }

    [Fact]
    public void PasskeyRegistrationEndpoint_DoesNotPassLegacyUsernameToService()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Auth.cs");

        string handler = ExtractBetween(
            source,
            "group.MapPost(\"/auth/passkey/register/begin\"",
            "group.MapPost(\"/auth/passkey/register/complete\"");

        Assert.Contains("BeginRegistrationAsync(user.Value.Id, cancellationToken)", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("BeginRegistrationAsync(user.Value.Id, user.Value.Username", handler, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentModerationEndpoints_RequireCommentModeratePermission()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "AuthoringEndpoints.cs");

        string queue = ExtractBetween(
            source,
            "group.MapGet(\"/comments/moderation\"",
            "group.MapPost(\"/comments/moderation/bulk\"");
        string bulk = ExtractBetween(
            source,
            "group.MapPost(\"/comments/moderation/bulk\"",
            "group.MapPost(\"/comments/{commentId:long}/moderation\"");
        string single = ExtractBetween(
            source,
            "group.MapPost(\"/comments/{commentId:long}/moderation\"",
            "group.MapGet(\"/content/export\"");

        Assert.Contains(".RequireAdminPermission(AdminPermissions.CommentModerate)", queue, StringComparison.Ordinal);
        Assert.DoesNotContain("RequireAdminSensitiveStepUpAsync", queue, StringComparison.Ordinal);
        Assert.Contains(".RequireRateLimiting(\"fixed_ip\")", queue, StringComparison.Ordinal);

        Assert.Contains(".RequireAdminPermission(AdminPermissions.CommentModerate)", bulk, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync", bulk, StringComparison.Ordinal);
        Assert.Contains("AuditActionCatalog.CommentBulkModerated", bulk, StringComparison.Ordinal);
        Assert.Contains(".RequireRateLimiting(\"fixed_ip\")", bulk, StringComparison.Ordinal);

        Assert.Contains(".RequireAdminPermission(AdminPermissions.CommentModerate)", single, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync", single, StringComparison.Ordinal);
        Assert.Contains("AuditActionCatalog.CommentModerated", single, StringComparison.Ordinal);
        Assert.Contains(".RequireRateLimiting(\"fixed_ip\")", single, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminControlPlaneEndpoints_DoNotUseBareAdminRole()
    {
        string[] files =
        [
            .. Directory.EnumerateFiles(
                BackendTestPaths.FromRoot("src", "backend", "Modules", "Endpoints", "Binary"),
                "*.cs",
                SearchOption.AllDirectories),
            BackendTestPaths.FromRoot("src", "backend", "Modules", "Endpoints", "AuthoringEndpoints.cs"),
            BackendTestPaths.FromRoot("src", "backend", "Modules", "Endpoints", "SecurityEndpoints.cs"),
            BackendTestPaths.FromRoot("src", "backend", "Infrastructure", "Operations", "ProductionHealth.cs")
        ];

        foreach (string file in files)
        {
            string source = File.ReadAllText(file);

            Assert.DoesNotContain("RequireRole(\"admin\")", source, StringComparison.Ordinal);
            Assert.DoesNotContain("RequireRole('admin')", source, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void CommentDeleteRoute_UsesAdminPrincipalPermissionForModeratorBranch()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Comments.cs");

        string deleteRoute = ExtractBetween(
            source,
            "group.MapDelete(\"/comment/{id:long}\"",
            "internal static async Task<BinaryFrameResult> HandleAnonymousCommentTicketAsync");

        Assert.Contains("IsAdminPrincipal()", deleteRoute, StringComparison.Ordinal);
        Assert.Contains("HasAdminPermission(AdminPermissions.CommentModerate)", deleteRoute, StringComparison.Ordinal);
        Assert.DoesNotContain("IsInRole(\"admin\")", deleteRoute, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentModerationAndAnonymousGovernancePermissions_DoNotReplaceEachOther()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "AuthoringEndpoints.cs");

        string queue = ExtractBetween(
            source,
            "group.MapGet(\"/comments/moderation\"",
            "group.MapPost(\"/comments/moderation/bulk\"");
        string bulk = ExtractBetween(
            source,
            "group.MapPost(\"/comments/moderation/bulk\"",
            "group.MapPost(\"/comments/{commentId:long}/moderation\"");
        string single = ExtractBetween(
            source,
            "group.MapPost(\"/comments/{commentId:long}/moderation\"",
            "group.MapGet(\"/content/export\"");
        string nullifierBlock = ExtractBetween(
            source,
            "group.MapPost(\"/comments/moderation/nullifiers/block\"",
            "group.MapPost(\"/comments/moderation/anonymous-credentials/{credentialId:long}/revoke\"");
        string credentialRevoke = ExtractBetween(
            source,
            "group.MapPost(\"/comments/moderation/anonymous-credentials/{credentialId:long}/revoke\"",
            "group.MapGet(\"/moderation/dictionaries\"");

        foreach (string normalModerationRoute in new[] { queue, bulk, single })
        {
            Assert.Contains("AdminPermissions.CommentModerate", normalModerationRoute, StringComparison.Ordinal);
            Assert.DoesNotContain("AdminPermissions.AnonymousCommentConfigure", normalModerationRoute, StringComparison.Ordinal);
            Assert.DoesNotContain("AdminPermissions.AnonymousNullifierBlock", normalModerationRoute, StringComparison.Ordinal);
            Assert.DoesNotContain("AdminPermissions.AnonymousCredentialRevoke", normalModerationRoute, StringComparison.Ordinal);
            Assert.DoesNotContain("AdminPermissions.SystemConfig", normalModerationRoute, StringComparison.Ordinal);
        }

        Assert.Contains("AdminPermissions.AnonymousNullifierBlock", nullifierBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("AdminPermissions.CommentModerate", nullifierBlock, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync", nullifierBlock, StringComparison.Ordinal);

        Assert.Contains("AdminPermissions.AnonymousCredentialRevoke", credentialRevoke, StringComparison.Ordinal);
        Assert.DoesNotContain("AdminPermissions.CommentModerate", credentialRevoke, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync", credentialRevoke, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousMfaMutations_RequireHeaderProofAndDoNotReadPasswordBody()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Auth.cs");

        string setupStart = ExtractBetween(
            source,
            "group.MapPost(\"/auth/mfa/setup/start\"",
            "group.MapGet(\"/auth/mfa/profile\"");
        string disable = ExtractBetween(
            source,
            "group.MapPost(\"/auth/mfa/disable\"",
            "group.MapPost(\"/auth/mfa/recovery/regenerate\"");
        string regenerate = ExtractBetween(
            source,
            "group.MapPost(\"/auth/mfa/recovery/regenerate\"",
            "group.MapPost(\"/auth/mfa/challenge/start\"");

        AssertAnonymousMfaStepUpBoundary(setupStart, "mfa_setup_rebind");
        AssertAnonymousMfaStepUpBoundary(disable, "mfa_disable");
        AssertAnonymousMfaStepUpBoundary(regenerate, "mfa_recovery_regenerate");
    }

    private static string ReadRepoFile(params string[] segments)
    {
        string relativePath = Path.Combine(segments);
        string fullPath = BackendTestPaths.FromRoot(segments);
        Assert.True(File.Exists(fullPath), $"{relativePath} must exist.");
        return File.ReadAllText(fullPath);
    }

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex, StringComparison.Ordinal);
        Assert.True(endIndex >= 0, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }

    private static void AssertStepUpBoundary(string handler, string action)
    {
        Assert.Contains("IUserSecurityStepUpService stepUp", handler, StringComparison.Ordinal);
        Assert.Contains("RequireUserSecurityStepUpAsync(", handler, StringComparison.Ordinal);
        Assert.Contains(action, handler, StringComparison.Ordinal);
        Assert.DoesNotContain("ValidateAndConsumeProofTokenAsync", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("MfaEnabled", handler, StringComparison.Ordinal);
    }

    private static void AssertAnonymousCredentialMutationRejectsBodyProof(string handler)
    {
        Assert.Contains("allowPasswordBody: false", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("allowPasswordBody: true", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("MfaPasswordProofRequest", handler, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.MfaPasswordProofRequest", handler, StringComparison.Ordinal);
    }

    private static void AssertAnonymousMfaStepUpBoundary(string handler, string action)
    {
        string anonymousBranch = ExtractBetween(
            handler,
            "if (AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled())",
            "else");

        Assert.Contains("IMfaChallengeService mfaChallengeService", handler, StringComparison.Ordinal);
        Assert.Contains("TryReadMfaProof(httpContext, out string proofToken)", anonymousBranch, StringComparison.Ordinal);
        Assert.Contains(action, anonymousBranch, StringComparison.Ordinal);
        Assert.Contains("ValidateAndConsumeProofTokenAsync(userId,", anonymousBranch, StringComparison.Ordinal);
        Assert.Contains("proofToken)", anonymousBranch, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadBinaryRequestPayloadAsync", anonymousBranch, StringComparison.Ordinal);
        Assert.DoesNotContain("MfaPasswordProofRequest", anonymousBranch, StringComparison.Ordinal);
        Assert.DoesNotContain("IsMfaVerified()", anonymousBranch, StringComparison.Ordinal);
    }
}
