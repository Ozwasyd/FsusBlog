using System.Runtime.CompilerServices;

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

    private static string ReadRepoFile(string relativePath, [CallerFilePath] string sourceFile = "")
        => File.ReadAllText(Path.Combine(FindRepoRoot(sourceFile), relativePath));

    private static string FindRepoRoot(string sourceFile)
        => Directory.GetParent(sourceFile)?.Parent?.Parent?.Parent?.FullName
            ?? throw new InvalidOperationException("Unable to resolve repository root.");
}
