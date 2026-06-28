using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ConcurrencyRaceHardeningContractTests
{
    [Fact]
    public void AnonymousNullifierConsume_IsSingleAtomicSpendInsideCommentTransaction()
    {
        string nullifier = ReadSource("src/backend/Services/Security/CommentAnonymousNullifierService.cs");
        string comments = ReadSource("src/backend/Services/CommentService.cs");

        Assert.Contains("UPDATE comment_anonymous_nullifier", nullifier, StringComparison.Ordinal);
        Assert.Contains("WITH consumed AS", nullifier, StringComparison.Ordinal);
        Assert.Contains("ON CONFLICT (nullifier_hash, scope) DO UPDATE", nullifier, StringComparison.Ordinal);
        Assert.Contains("SET use_count = comment_anonymous_nullifier.use_count + 1", nullifier, StringComparison.Ordinal);
        Assert.Contains("first_comment_id = COALESCE(comment_anonymous_nullifier.first_comment_id, @CommentId)", nullifier, StringComparison.Ordinal);
        Assert.Contains("RETURNING true AS allowed, 'reserved'::text AS status, use_count", nullifier, StringComparison.Ordinal);
        Assert.DoesNotContain("SetColumns(n => n.UseCount", ExtractBetween(nullifier, "public async Task<bool> IncrementUsageAsync", "public async Task<bool> BlockAsync"), StringComparison.Ordinal);

        string create = ExtractBetween(comments, "private async Task<bool> CreateResolvedCommentAsync", "private async Task<bool> LockVisibleCommentTargetAsync");
        string transaction = ExtractBetween(create, "db.Ado.UseTranAsync(async () =>", "});");
        Assert.Contains("TryConsumeAsync", transaction, StringComparison.Ordinal);
        Assert.DoesNotContain("CheckAndReserveAsync", create, StringComparison.Ordinal);
        Assert.DoesNotContain("IncrementUsageAsync", create, StringComparison.Ordinal);
        Assert.True(
            transaction.IndexOf("ExecuteReturnSnowflakeIdAsync", StringComparison.Ordinal) <
            transaction.IndexOf("TryConsumeAsync", StringComparison.Ordinal),
            "anonymous nullifier consume needs the generated comment id and must remain inside the write transaction.");
        Assert.True(
            create.IndexOf("LockVisibleCommentTargetAsync", StringComparison.Ordinal) <
            create.IndexOf("ExecuteReturnSnowflakeIdAsync", StringComparison.Ordinal),
            "comment target locks must be held until the insert commits.");

        string lockTarget = ExtractBetween(comments, "private async Task<bool> LockVisibleCommentTargetAsync", "private static bool RequiresAnonymousNullifierEnforcement");
        Assert.Equal(2, CountOccurrences(lockTarget, "GetDataReaderAsync"));
        Assert.Contains("FROM article a, comment pc, comment rc", lockTarget, StringComparison.Ordinal);
        Assert.Contains("COALESCE(pc.root_id, pc.id) = @RootId", lockTarget, StringComparison.Ordinal);
        Assert.Contains("rc.parent_id IS NULL", lockTarget, StringComparison.Ordinal);
        Assert.DoesNotContain("HasLockedVisibleArticleAsync", comments, StringComparison.Ordinal);
        Assert.DoesNotContain("HasLockedVisibleCommentAsync", comments, StringComparison.Ordinal);
    }

    [Fact]
    public void ChallengeAndPowReplayWindows_DoNotUseBoundaryQuantizedKeys()
    {
        string limiter = ReadSource("src/backend/Services/Security/SecurityChallengeVerifyRateLimiter.cs");
        string pow = ReadSource("src/backend/Services/Security/RedisPowService.cs");
        string cache = ReadSource("src/backend/Infrastructure/Cache/IUnifiedCache.cs");

        Assert.Contains("IncrementWithExpiryAsync", limiter, StringComparison.Ordinal);
        Assert.DoesNotContain("windowStartTicks", limiter, StringComparison.Ordinal);
        Assert.DoesNotContain("Window.Ticks", limiter, StringComparison.Ordinal);
        Assert.Contains("redis.call('INCRBY'", cache, StringComparison.Ordinal);
        Assert.Contains("redis.call('PEXPIRE'", cache, StringComparison.Ordinal);
        Assert.Contains("return ProofReplayTtl", ExtractBetween(pow, "private static TimeSpan ResolveReplayTtl", "private static bool IsTimestampWithinWindow"), StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleDestructiveMutations_AreVersionGuardedAndTrashScoped()
    {
        string source = ReadSource("src/backend/Services/ArticleService.cs");
        string delete = ExtractBetween(source, "public async Task<bool> DeleteAsync", "public async Task<bool> RestoreAsync");
        string restore = ExtractBetween(source, "public async Task<bool> RestoreAsync", "public async Task<bool> PermanentlyDeleteArticleAsync");
        string permanent = ExtractBetween(source, "public async Task<bool> PermanentlyDeleteArticleAsync", "public async Task<int> ClearTrashAsync");

        Assert.Contains("LoadArticleMutationStateAsync", delete, StringComparison.Ordinal);
        Assert.Contains("xmin::text = @RowVersion", delete, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("LoadArticleMutationStateAsync", restore, StringComparison.Ordinal);
        Assert.Contains("xmin::text = @RowVersion", restore, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("LoadArticleMutationStateAsync", permanent, StringComparison.Ordinal);
        Assert.Contains("AND isdeleted = true", permanent, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("xmin::text = @RowVersion", permanent, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("result.Data > 0", permanent, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousCredentialRevoke_WritesRevocationHandleWhenMetadataProvidesIt()
    {
        string credential = ReadSource("src/backend/Services/Security/AnonymousCredentialService.cs");

        Assert.Contains("anonymous_credential_revocation", credential, StringComparison.Ordinal);
        Assert.Contains("TryParseRevocationMetadata", credential, StringComparison.Ordinal);
        Assert.Contains("ON CONFLICT (epoch, revocation_handle_hash) DO NOTHING", credential, StringComparison.Ordinal);
        Assert.True(
            credential.IndexOf("Updateable<AnonymousCredential>", StringComparison.Ordinal) <
            credential.IndexOf("anonymous_credential_revocation", StringComparison.Ordinal),
            "credential status update and revocation insert must be ordered in one transaction.");
    }

    [Fact]
    public void UserSessionAndMfaPaths_KeepExistingConcurrencyGuards()
    {
        string users = ReadSource("src/backend/Services/UserService.cs");

        Assert.Contains("RefreshTokenHash == hash", ExtractBetween(users, "public async Task<(bool Success, TokenResponseDto? Data)> RefreshTokenAsync(string refreshToken, string? sessionId)", "private async Task RevokeLikelyRefreshReplayAsync"), StringComparison.Ordinal);
        Assert.Contains("RevokeLikelyRefreshReplayAsync", users, StringComparison.Ordinal);
        Assert.Contains("LockUserMfaStateForUpdateAsync", users, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", ExtractBetween(users, "private async Task<bool?> LockUserMfaStateForUpdateAsync", "public async Task<bool> VerifyMfaOrRecoveryCodeAsync"), StringComparison.Ordinal);
        Assert.Contains("AND mfa_recovery_codes_hash = @OldHashes", users, StringComparison.Ordinal);
    }

    private static string ReadSource(string relativePath, [CallerFilePath] string sourceFilePath = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex, StringComparison.Ordinal);
        Assert.True(endIndex >= 0, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }

    private static int CountOccurrences(string source, string value)
    {
        int count = 0;
        int index = 0;
        while ((index = source.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }

        return count;
    }
}
