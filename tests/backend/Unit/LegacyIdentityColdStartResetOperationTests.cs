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

    [Fact]
    public void Operation_DeletesAnonymousIdentityDerivedTablesAndReportsCounts()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Operations/LegacyIdentityColdStartResetOperation.cs");

        foreach (string table in new[]
        {
            "account_recovery_key",
            "anonymous_credential",
            "anonymous_credential_issuance_audit",
            "comment_anonymous_nullifier"
        })
        {
            Assert.Contains($"DELETE FROM {table}", source, StringComparison.Ordinal);
        }

        foreach (string resultProperty in new[]
        {
            "AccountRecoveryKeysDeleted",
            "AnonymousCredentialsDeleted",
            "AnonymousCredentialIssuanceAuditsDeleted",
            "CommentAnonymousNullifiersDeleted"
        })
        {
            Assert.Contains(resultProperty, source, StringComparison.Ordinal);
        }

        foreach (string publicMetadataTable in new[]
        {
            "anonymous_credential_root",
            "anonymous_credential_epoch",
            "anonymous_credential_revocation"
        })
        {
            Assert.DoesNotContain($"DELETE FROM {publicMetadataTable}", source, StringComparison.Ordinal);
        }
    }

    private static string ReadRepoFile(string relativePath)
        => BackendTestPaths.ReadAllTextFromRoot(relativePath);
}
