using System.Text.RegularExpressions;

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

    private static string ReadRepoFile(params string[] segments)
        => File.ReadAllText(Path.Combine([FindRepoRoot(), .. segments]));

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex, StringComparison.Ordinal);
        Assert.True(endIndex >= 0, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }
}
