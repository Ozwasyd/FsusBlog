using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class StatsRecentCommentPrivacyTests
{
    [Fact]
    public void RecentCommentStats_ContractDoesNotExposeUserIdentity()
    {
        string outputs = BackendTestPaths.ReadAllTextFromRoot("src/shared/Contracts/Outputs/ServerResponseContracts.cs");
        string statsPods = BackendTestPaths.ReadAllTextFromRoot("src/shared/Contracts/Models/StatsPods.cs");
        string coreModels = BackendTestPaths.ReadAllTextFromRoot("src/core/Mapping/Models/ReadModels.cs");
        string frontendStats = BackendTestPaths.ReadAllTextFromRoot("src/frontend/src/api/stats.ts");
        string frontendView = BackendTestPaths.ReadAllTextFromRoot("src/frontend/src/view-contracts/adminStats.ts");

        string dtoBlock = ExtractBlock(outputs, "public readonly record struct RecentCommentStatItemDto", "public readonly record struct RegionStatItemDto");
        string podBlock = ExtractBlock(statsPods, "public readonly struct RecentCommentPod", "[StructLayout(LayoutKind.Sequential, Pack = 1)]\npublic readonly struct RegionDistributionPod");
        string coreBlock = ExtractBlock(coreModels, "public readonly record struct RecentCommentCoreModel", "public readonly record struct RegionDistributionCoreModel");

        Assert.DoesNotContain("UserId", dtoBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("UserName", dtoBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", podBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("HasUserId", podBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("UserName", podBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", coreBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("UserName", coreBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("userId", frontendStats, StringComparison.Ordinal);
        Assert.DoesNotContain("userName", frontendStats, StringComparison.Ordinal);
        Assert.DoesNotContain("comment.userName", frontendView, StringComparison.Ordinal);

        Assert.Contains("AuthorDisplayName", dtoBlock, StringComparison.Ordinal);
        Assert.Contains("AuthorMode", dtoBlock, StringComparison.Ordinal);
        Assert.Contains("AuthorBadge", dtoBlock, StringComparison.Ordinal);
        Assert.Contains("authorDisplayName", frontendStats, StringComparison.Ordinal);
        Assert.Contains("comment.authorDisplayName", frontendView, StringComparison.Ordinal);
    }

    [Fact]
    public void StatsServiceRecentComments_UsesCommentAuthorSnapshotWithoutSysUserJoin()
    {
        string stats = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/StatsService.cs");
        string method = ExtractBlock(stats, "private async Task<List<RecentCommentStatItemDto>> LoadRecentCommentsAsync", "private async Task<List<RegionStatItemDto>> LoadRegionStatsAsync");

        Assert.DoesNotContain("LeftJoin<User>", method, StringComparison.Ordinal);
        Assert.DoesNotContain("u.Username", method, StringComparison.Ordinal);
        Assert.DoesNotContain("u.Id", method, StringComparison.Ordinal);
        Assert.DoesNotContain("GetOrdinal(\"Username\")", method, StringComparison.Ordinal);
        Assert.DoesNotContain("GetOrdinal(\"Id\")", method, StringComparison.Ordinal);

        Assert.Contains("AnonymousDisplayName", method, StringComparison.Ordinal);
        Assert.Contains("PublicHandle", method, StringComparison.Ordinal);
        Assert.Contains("AuthorMode", method, StringComparison.Ordinal);
        Assert.Contains("CredentialLevel", method, StringComparison.Ordinal);
    }

    private static string ExtractBlock(string source, string startToken, string endToken)
    {
        int start = source.IndexOf(startToken, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start token: {startToken}");
        int end = source.IndexOf(endToken, start + startToken.Length, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing end token: {endToken}");
        return source[start..end];
    }
}
