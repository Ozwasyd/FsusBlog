using System.Text.RegularExpressions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class EndpointPolicyContractTests
{
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
            "BannedUserFilter.cs");

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
}
