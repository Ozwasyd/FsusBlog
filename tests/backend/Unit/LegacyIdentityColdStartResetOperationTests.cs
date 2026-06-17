using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class LegacyIdentityColdStartResetOperationTests
{
    [Fact]
    public void Operation_RemovesLegacyUserCachePoliciesAfterCommit()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Operations/LegacyIdentityColdStartResetOperation.cs");

        Assert.Contains("RemoveLegacyUserCachesAsync", source, StringComparison.Ordinal);
        Assert.Contains("CachePolicyId.SecurityBlacklistUser", source, StringComparison.Ordinal);
        Assert.Contains("CachePolicyId.SecurityBlockedUser", source, StringComparison.Ordinal);
        Assert.Contains("CachePolicyId.MessageUnread", source, StringComparison.Ordinal);
        Assert.Contains("CachePolicyId.UserCommentCursor", source, StringComparison.Ordinal);
        Assert.Contains("CachePolicyId.UserCommentCursorFrame", source, StringComparison.Ordinal);
    }

    private static string ReadRepoFile(string relativePath)
        => BackendTestPaths.ReadAllTextFromRoot(relativePath);
}
