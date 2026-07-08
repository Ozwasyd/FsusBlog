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
        string passkeyRegister = ExtractBetween(
            source,
            "group.MapPost(\"/auth/passkey/register/complete\"",
            "group.MapPost(\"/auth/passkey/login/begin\"");

        AssertStepUpBoundary(recoveryCreate, "UserSecurityStepUpActions.RecoveryKeyCreate");
        AssertStepUpBoundary(recoveryRotate, "UserSecurityStepUpActions.RecoveryKeyRotate");
        AssertStepUpBoundary(passkeyDelete, "UserSecurityStepUpActions.PasskeyDelete");
        AssertStepUpBoundary(passkeyRename, "UserSecurityStepUpActions.PasskeyCredentialNameUpdate");
        AssertStepUpBoundary(passkeyRegister, "UserSecurityStepUpActions.PasskeyRegister");
        AssertAnonymousCredentialMutationRejectsBodyProof(recoveryCreate);
        AssertAnonymousCredentialMutationRejectsBodyProof(recoveryRotate);
        AssertAnonymousCredentialMutationRejectsBodyProof(passkeyDelete);
        AssertAnonymousCredentialMutationRejectsBodyProof(passkeyRename);
        AssertAnonymousCredentialMutationRejectsBodyProof(passkeyRegister);

        string stepUpReader = ExtractBetween(
            source,
            "private static async Task<(ErrorDetail Error, int StatusCode)?> RequireUserSecurityStepUpAsync",
            "private static ValueTask RecordPasskeyAssertionFailureAsync");
        Assert.Contains("TryReadMfaProof(httpContext, out string token)", stepUpReader, StringComparison.Ordinal);
        Assert.Contains("new UserSecurityStepUpProof(proofToken)", stepUpReader, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadBinaryRequestPayloadAsync", stepUpReader, StringComparison.Ordinal);

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

        string ordinaryPasskeyStepUp = ExtractBetween(
            source,
            "group.MapPost(\"/auth/step-up/passkey/begin\"",
            "group.MapPost(\"/auth/mfa/challenge/start\"");
        Assert.Contains("UserSecurityStepUpActions.IsCredentialMutation(action)", ordinaryPasskeyStepUp, StringComparison.Ordinal);
        Assert.Contains("BeginActionStepUpAssertionAsync", ordinaryPasskeyStepUp, StringComparison.Ordinal);
        Assert.Contains("CompleteActionStepUpAssertionAsync", ordinaryPasskeyStepUp, StringComparison.Ordinal);
        Assert.Contains("CreateProofTokenAsync", ordinaryPasskeyStepUp, StringComparison.Ordinal);
        Assert.Contains("RequireAnonymousAccountPrincipal()", ordinaryPasskeyStepUp, StringComparison.Ordinal);
        Assert.Contains("configuration.GetValue<bool>(\"Auth:PasskeyStepUp:Enabled\", true)", ordinaryPasskeyStepUp, StringComparison.Ordinal);
        Assert.Contains("PASSKEY_STEP_UP_DISABLED", ordinaryPasskeyStepUp, StringComparison.Ordinal);
        Assert.Contains("StatusCodes.Status503ServiceUnavailable", ordinaryPasskeyStepUp, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousGatewayHeaderGuard_RunsBeforeAuthentication()
    {
        string composition = ReadRepoFile(
            "src",
            "backend",
            "Infrastructure",
            "Bootstrap",
            "WebApplicationCompositionExtensions.cs");
        string endpointPipeline = ExtractBetween(
            composition,
            "private static void UseFsusEndpointPipeline",
            "private static void UseFsusEndpointMetadataHeaders");

        Assert.Contains("UseMiddleware<AnonymousGatewayHeaderGuardMiddleware>()", endpointPipeline, StringComparison.Ordinal);
        Assert.True(
            endpointPipeline.IndexOf("UseMiddleware<AnonymousGatewayHeaderGuardMiddleware>()", StringComparison.Ordinal)
                < endpointPipeline.IndexOf("UseAuthentication()", StringComparison.Ordinal),
            "anonymous gateway header guard must run before authentication");

        string middleware = ReadRepoFile(
            "src",
            "backend",
            "Infrastructure",
            "Middlewares",
            "AnonymousGatewayHeaderGuardMiddleware.cs");
        Assert.Contains("X-Fsus-Challenge-Proof", middleware, StringComparison.Ordinal);
        Assert.Contains("X-Fsus-Mfa-Proof", middleware, StringComparison.Ordinal);
        Assert.Contains("X-Fsus-Device-Fp", middleware, StringComparison.Ordinal);
        Assert.Contains("traditional_account_header", middleware, StringComparison.Ordinal);
        Assert.Contains("unknown_fsus_header", middleware, StringComparison.Ordinal);
        Assert.Contains("username", middleware, StringComparison.Ordinal);
        Assert.Contains("email", middleware, StringComparison.Ordinal);
        Assert.Contains("role", middleware, StringComparison.Ordinal);
        Assert.Contains("password", middleware, StringComparison.Ordinal);
        Assert.Contains("totp", middleware, StringComparison.Ordinal);
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
    public void BinaryArticleTrashClear_IsDestructiveAdminMutationWithStepUpRateLimitAndHighValueAudit()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Articles.cs");
        string trashClear = ExtractBetween(
            source,
            "group.MapDelete(\"/admin/article/trash\"",
            "group.MapDelete(\"/admin/article/{id:int}\"");

        Assert.Contains("HttpContext httpContext", trashClear, StringComparison.Ordinal);
        Assert.Contains("IAdminPrincipalService adminPrincipals", trashClear, StringComparison.Ordinal);
        Assert.Contains("IAuditEventService auditEvents", trashClear, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync(httpContext, adminPrincipals)", trashClear, StringComparison.Ordinal);
        Assert.Contains("BinaryResults.FromError(stepUp.Value.Error, aeds, stepUp.Value.StatusCode)", trashClear, StringComparison.Ordinal);
        AssertBefore(trashClear, "RequireAdminSensitiveStepUpAsync(httpContext, adminPrincipals)", "articles.ClearTrashAsync(cancellationToken)");
        Assert.Contains(".RequireAdminPermission(AdminPermissions.ArticleWrite)", trashClear, StringComparison.Ordinal);
        Assert.Contains(".RequireRateLimiting(\"fixed_ip\")", trashClear, StringComparison.Ordinal);
        Assert.Contains(".AddEndpointFilter<RequiresPowFilter>()", trashClear, StringComparison.Ordinal);
        Assert.Contains("RecordArticleTrashClearAuditAsync", trashClear, StringComparison.Ordinal);
        Assert.Contains("RecordHighValueAsync(new AuditEvent(", source, StringComparison.Ordinal);
        Assert.Contains("AuditActionCatalog.ArticleTrashCleared", source, StringComparison.Ordinal);
        Assert.Contains("AuditOutcomeCatalog.Success", source, StringComparison.Ordinal);
        Assert.Contains("AuditOutcomeCatalog.Failure", source, StringComparison.Ordinal);
        Assert.Contains("DestroyedCount", source, StringComparison.Ordinal);
        Assert.Contains("TraceIdentifier", source, StringComparison.Ordinal);
        Assert.Contains("AuditActorTypeCatalog.Admin", source, StringComparison.Ordinal);
        Assert.Contains("ResolveAdminPrincipalId", source, StringComparison.Ordinal);
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
        Assert.Contains("TryReadMfaProof(httpContext, out string token)", authSource, StringComparison.Ordinal);
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
        Assert.Contains("LogBannedAccountLogin", completeLoginSource, StringComparison.Ordinal);
        Assert.DoesNotContain("账户已被封禁", completeLoginSource, StringComparison.Ordinal);

        string refreshSource = ExtractBetween(
            userServiceSource,
            "var user = await _db.Queryable<User>().InSingleAsync(session.UserId);",
            "string newRefreshToken = _jwtHelper.GenerateRefreshToken();");
        Assert.DoesNotContain("user.Status == UserStatusBanned ||", refreshSource, StringComparison.Ordinal);
        Assert.Contains("LogBannedAccountTokenRefresh", refreshSource, StringComparison.Ordinal);

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
    public void PasskeyService_UsesCsprngTokensAndConsumesRegistrationChallengeAfterVerification()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Services",
            "Security",
            "PasskeyService.cs");
        string beginRegistration = ExtractBetween(
            source,
            "public async Task<(bool Success, string Message, PasskeyRegBeginData? Data)> BeginRegistrationAsync",
            "public async Task<(bool Success, string Message)> CompleteRegistrationAsync");
        string completeRegistration = ExtractBetween(
            source,
            "public async Task<(bool Success, string Message)> CompleteRegistrationAsync",
            "private async Task<bool> IsCredentialIdUniqueAsync");

        Assert.Contains("RandomNumberGenerator.GetBytes(32)", beginRegistration, StringComparison.Ordinal);
        Assert.DoesNotContain("Guid.NewGuid().ToByteArray()", beginRegistration, StringComparison.Ordinal);
        int verifyIndex = completeRegistration.IndexOf("MakeNewCredentialAsync", StringComparison.Ordinal);
        int removeIndex = completeRegistration.IndexOf("RemoveAsync(CachePolicyId.SecurityPasskeyRegChallenge", StringComparison.Ordinal);
        Assert.True(verifyIndex >= 0, "registration verification call missing");
        Assert.True(removeIndex > verifyIndex, "registration challenge must be removed only after successful verification");
    }

    [Fact]
    public void PasskeyAssertion_RejectsNonMonotonicSignatureCounters()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Services",
            "Security",
            "PasskeyService.cs");
        string assertion = ExtractBetween(
            source,
            "public async Task<(bool Success, string Message, User? User)> CompleteAssertionAsync",
            "public async Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginStepUpAssertionAsync");

        Assert.Contains("IsPasskeySignCountValid", assertion, StringComparison.Ordinal);
        Assert.Contains("verifyResult.SignCount", assertion, StringComparison.Ordinal);
        Assert.Contains("expectedSignCount", assertion, StringComparison.Ordinal);
        Assert.Contains("UserVerificationRequirement.Required", assertion, StringComparison.Ordinal);
    }

    [Fact]
    public void LocalAuthFixtureEndpoints_RequireDevelopmentAndSharedSecretHeader()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "LocalAuthFixtureEndpoints.cs");

        Assert.Contains("app.Environment.IsDevelopment()", source, StringComparison.Ordinal);
        Assert.Contains("LocalAuthFixtureSecretConfigurationKey", source, StringComparison.Ordinal);
        Assert.Contains("X-Fsus-Local-Auth-Fixture-Secret", source, StringComparison.Ordinal);
        Assert.Contains("CryptographicOperations.FixedTimeEquals", source, StringComparison.Ordinal);
        Assert.Contains("RequireLocalFixtureSecret", source, StringComparison.Ordinal);
        Assert.Contains("admin-sensitive-proof", source, StringComparison.Ordinal);
        Assert.Contains("RequireLoopbackCaller", source, StringComparison.Ordinal);
        Assert.Contains("CreateAdminStepUpProofTokenAsync", source, StringComparison.Ordinal);
        Assert.Contains("HasAdminPermission(AdminPermissions.SystemConfig)", source, StringComparison.Ordinal);

        string adminMapBlock = ExtractBetween(
            source,
            "app.MapGet(\"/__local/auth-fixture/admin\"",
            "var statusHandler");
        Assert.Contains("RequireLocalFixtureSecret", adminMapBlock, StringComparison.Ordinal);

        string proofMapBlock = ExtractBetween(
            source,
            "app.MapPost(\"/api/local/auth-fixture/admin-sensitive-proof\"",
            "private static async ValueTask<object?> RequireLocalFixtureSecret");
        Assert.Contains("RequireLocalFixtureSecret", proofMapBlock, StringComparison.Ordinal);
        Assert.Contains("RequireLoopbackCaller", proofMapBlock, StringComparison.Ordinal);
        Assert.Contains("AllowAnonymous", proofMapBlock, StringComparison.Ordinal);
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
    public void BinaryCommentAdminDelete_RequiresAdminSensitiveStepUpBeforeAdminDelete()
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

        Assert.Contains("IAdminPrincipalService adminPrincipals", deleteRoute, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync(httpContext, adminPrincipals)", deleteRoute, StringComparison.Ordinal);
        Assert.Contains("BinaryResults.FromError(stepUp.Value.Error, aeds, stepUp.Value.StatusCode)", deleteRoute, StringComparison.Ordinal);
        AssertBefore(deleteRoute, "RequireAdminSensitiveStepUpAsync(httpContext, adminPrincipals)", "commentService.DeleteCommentAsAdminAsync");
    }

    [Fact]
    public void BinarySystemPublicContentMutations_RequireAdminSensitiveStepUpBeforeMutation()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.System.cs");

        string seo = ExtractBetween(source, "group.MapPut(\"/system/seo\"", "group.MapGet(\"/system/compliance\"");
        string compliance = ExtractBetween(source, "group.MapPut(\"/system/compliance\"", "group.MapGet(\"/system/page/{slug}\"");
        string page = ExtractBetween(source, "group.MapPut(\"/system/page\"", "group.MapPost(\"/system/page/refresh/{slug}\"");
        string refresh = ExtractBetween(source, "group.MapPost(\"/system/page/refresh/{slug}\"", "    }\n}");

        AssertAdminStepUpBefore(seo, "systemService.UpdateSeoConfigAsync");
        AssertAdminStepUpBefore(compliance, "systemService.UpdateSiteComplianceConfigAsync");
        AssertAdminStepUpBefore(page, "systemService.UpdatePageContentAsync");
        AssertAdminStepUpBefore(refresh, "systemService.RefreshPageCacheAsync");
    }

    [Fact]
    public void AuthoringDangerousPublishMutations_RequireAdminSensitiveStepUpBeforeMutation()
    {
        string source = ReadRepoFile(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "AuthoringEndpoints.cs");

        string rollback = ExtractBetween(
            source,
            "group.MapPost(\"/articles/{articleId:int}/revisions/{revisionId:long}/rollback\"",
            "group.MapPost(\"/articles/{articleId:int}/assets/reindex\"");
        string import = ExtractBetween(
            source,
            "group.MapPost(\"/articles/import\"",
            "group.MapGet(\"/ops/health\"");

        Assert.Contains("IAdminPrincipalService adminPrincipals", rollback, StringComparison.Ordinal);
        Assert.Contains("IAdminPrincipalService adminPrincipals", import, StringComparison.Ordinal);
        AssertBefore(rollback, "RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds)", "service.RollbackRevisionAsync");
        AssertBefore(import, "RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds)", "service.ImportArticleAsync");
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
        Assert.Contains("RequireUserSecurityStepUpAsync(", handler, StringComparison.Ordinal);
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
        Assert.Contains("ValidateAndConsumeProofTokenAsync(", anonymousBranch, StringComparison.Ordinal);
        Assert.Contains("userId", anonymousBranch, StringComparison.Ordinal);
        Assert.Contains("ResolveAccountSubjectHash", anonymousBranch, StringComparison.Ordinal);
        Assert.Contains("proofToken)", anonymousBranch, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadBinaryRequestPayloadAsync", anonymousBranch, StringComparison.Ordinal);
        Assert.DoesNotContain("MfaPasswordProofRequest", anonymousBranch, StringComparison.Ordinal);
        Assert.DoesNotContain("IsMfaVerified()", anonymousBranch, StringComparison.Ordinal);
    }

    private static void AssertAdminStepUpBefore(string handler, string mutationCall)
    {
        Assert.Contains("IAdminPrincipalService adminPrincipals", handler, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync(httpContext, adminPrincipals)", handler, StringComparison.Ordinal);
        Assert.Contains("BinaryResults.FromError(stepUp.Value.Error, aeds, stepUp.Value.StatusCode)", handler, StringComparison.Ordinal);
        AssertBefore(handler, "RequireAdminSensitiveStepUpAsync(httpContext, adminPrincipals)", mutationCall);
    }

    private static void AssertBefore(string source, string earlier, string later)
    {
        int earlierIndex = source.IndexOf(earlier, StringComparison.Ordinal);
        int laterIndex = source.IndexOf(later, StringComparison.Ordinal);

        Assert.True(earlierIndex >= 0, $"Missing earlier marker: {earlier}");
        Assert.True(laterIndex >= 0, $"Missing later marker: {later}");
        Assert.True(earlierIndex < laterIndex, $"{earlier} must appear before {later}.");
    }
}
