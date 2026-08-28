using System.Collections.Concurrent;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

using Npgsql;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;
namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Trait("Category", "SecurityStateMachine")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class UserSessionRevocationIntegrationTests(
    PostgresSchemaMigrationFixture fixture,
    PublicHotDeliveryRedisFixture redisFixture) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "session-revocation-enforcement")]
    public async Task RevokeSession_RejectsPreviouslyIssuedPrincipalAfterCacheWasWarm()
    {
        using SqlSugarClient db = await CreateDbAsync();
        int accountId = await SeedAccountAsync(db);
        UserSession session = await SeedSessionAsync(db, accountId, "single-revoke");
        var cache = new VersionedSessionValidationCache();
        var validator = new UserSessionValidationService(db, cache);
        ClaimsPrincipal principal = CreatePrincipal(accountId, session);

        Assert.True((await validator.ValidateAsync(principal, CancellationToken.None)).IsValid);

        UserSessionCommandService users = CreateSessionService(db, cache);
        Assert.True(await users.RevokeSessionAsync(accountId, session.SessionId));

        UserSessionValidationResult rejected = await validator.ValidateAsync(principal, CancellationToken.None);
        Assert.False(rejected.IsValid);
        Assert.Equal("user_session_revoked", rejected.Reason);
        Assert.Equal(1, cache.DatabaseMissPublishCount);
        Assert.NotNull((await db.Queryable<UserSession>().SingleAsync(row => row.SessionId == session.SessionId)).RevokedAt);
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "session-revocation-enforcement")]
    public async Task RevokeOtherSessions_InvalidatesOthersAndKeepsCurrentSessionValid()
    {
        using SqlSugarClient db = await CreateDbAsync();
        int accountId = await SeedAccountAsync(db);
        UserSession current = await SeedSessionAsync(db, accountId, "current");
        UserSession otherA = await SeedSessionAsync(db, accountId, "other-a");
        UserSession otherB = await SeedSessionAsync(db, accountId, "other-b");
        var cache = new VersionedSessionValidationCache();
        var validator = new UserSessionValidationService(db, cache);
        ClaimsPrincipal currentPrincipal = CreatePrincipal(accountId, current);
        ClaimsPrincipal otherAPrincipal = CreatePrincipal(accountId, otherA);
        ClaimsPrincipal otherBPrincipal = CreatePrincipal(accountId, otherB);

        Assert.True((await validator.ValidateAsync(currentPrincipal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(otherAPrincipal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(otherBPrincipal, CancellationToken.None)).IsValid);

        UserSessionCommandService users = CreateSessionService(db, cache);
        int revoked = await users.RevokeOtherSessionsAsync(accountId, current.SessionId);

        Assert.Equal(2, revoked);
        Assert.True((await validator.ValidateAsync(currentPrincipal, CancellationToken.None)).IsValid);
        Assert.Equal(
            "user_session_revoked",
            (await validator.ValidateAsync(otherAPrincipal, CancellationToken.None)).Reason);
        Assert.Equal(
            "user_session_revoked",
            (await validator.ValidateAsync(otherBPrincipal, CancellationToken.None)).Reason);
        UserSession currentRow = await db.Queryable<UserSession>().SingleAsync(row => row.SessionId == current.SessionId);
        Assert.Null(currentRow.RevokedAt);
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "session-revocation-enforcement")]
    public async Task RevokeAllSessions_InvalidatesEveryWarmPrincipalWithSecurityReason()
    {
        using SqlSugarClient db = await CreateDbAsync();
        int accountId = await SeedAccountAsync(db);
        UserSession first = await SeedSessionAsync(db, accountId, "rollback-a");
        UserSession second = await SeedSessionAsync(db, accountId, "rollback-b");
        var cache = new VersionedSessionValidationCache();
        var validator = new UserSessionValidationService(db, cache);
        ClaimsPrincipal firstPrincipal = CreatePrincipal(accountId, first);
        ClaimsPrincipal secondPrincipal = CreatePrincipal(accountId, second);

        Assert.True((await validator.ValidateAsync(firstPrincipal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(secondPrincipal, CancellationToken.None)).IsValid);

        UserSessionCommandService users = CreateSessionService(db, cache);
        int revoked = await users.RevokeAllSessionsAsync(
            accountId,
            "passkey_counter_rollback",
            CancellationToken.None);

        Assert.Equal(2, revoked);
        Assert.Equal("user_session_revoked", (await validator.ValidateAsync(firstPrincipal, CancellationToken.None)).Reason);
        Assert.Equal("user_session_revoked", (await validator.ValidateAsync(secondPrincipal, CancellationToken.None)).Reason);
        List<UserSession> stored = await db.Queryable<UserSession>()
            .Where(row => row.UserId == accountId)
            .ToListAsync();
        Assert.All(stored, row =>
        {
            Assert.NotNull(row.RevokedAt);
            Assert.Equal("passkey_counter_rollback", row.RevokeReason);
        });
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "session-revocation-enforcement")]
    public async Task RevokeSessionsByCredential_RevokesOnlyExactAccountCredentialBinding()
    {
        using SqlSugarClient db = await CreateDbAsync();
        int accountId = await SeedAccountAsync(db);
        int otherAccountId = await SeedAccountAsync(db);
        UserSession targetA = await SeedSessionAsync(db, accountId, "credential-a", credentialRowId: 701);
        UserSession targetB = await SeedSessionAsync(db, accountId, "credential-b", credentialRowId: 701);
        UserSession otherCredential = await SeedSessionAsync(db, accountId, "credential-other", credentialRowId: 702);
        UserSession otherAccount = await SeedSessionAsync(db, otherAccountId, "credential-other-account", credentialRowId: 701);
        var cache = new VersionedSessionValidationCache();
        var validator = new UserSessionValidationService(db, cache);
        ClaimsPrincipal targetPrincipal = CreatePrincipal(accountId, targetA);
        ClaimsPrincipal retainedPrincipal = CreatePrincipal(accountId, otherCredential);
        Assert.True((await validator.ValidateAsync(targetPrincipal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(retainedPrincipal, CancellationToken.None)).IsValid);

        UserSessionCommandService users = CreateSessionService(db, cache);
        int revoked = await users.RevokeSessionsByCredentialAsync(accountId, 701, CancellationToken.None);

        Assert.Equal(2, revoked);
        Assert.Equal("user_session_revoked", (await validator.ValidateAsync(targetPrincipal, CancellationToken.None)).Reason);
        Assert.True((await validator.ValidateAsync(retainedPrincipal, CancellationToken.None)).IsValid);
        List<UserSession> rows = await db.Queryable<UserSession>()
            .Where(row => row.UserId == accountId || row.UserId == otherAccountId)
            .ToListAsync();
        Assert.All(
            rows.Where(row => row.UserId == accountId && row.AuthenticatedCredentialRowId == 701),
            row =>
            {
                Assert.NotNull(row.RevokedAt);
                Assert.Equal("credential_deleted", row.RevokeReason);
            });
        Assert.Null(Assert.Single(rows, row => row.SessionId == otherCredential.SessionId).RevokedAt);
        Assert.Null(Assert.Single(rows, row => row.SessionId == otherAccount.SessionId).RevokedAt);
        Assert.NotNull(Assert.Single(rows, row => row.SessionId == targetB.SessionId).RevokedAt);
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "auth-session-fail-closed")]
    public async Task RefreshReplay_RevokesSessionAndImmediatelyRejectsOldPrincipal()
    {
        using SqlSugarClient db = await CreateDbAsync();
        int accountId = await SeedAccountAsync(db);
        UserSession session = await SeedSessionAsync(
            db,
            accountId,
            "refresh-replay",
            refreshTokenHash: HashToken("current-refresh-token"));
        var cache = new VersionedSessionValidationCache();
        var validator = new UserSessionValidationService(db, cache);
        ClaimsPrincipal principal = CreatePrincipal(accountId, session);
        Assert.True((await validator.ValidateAsync(principal, CancellationToken.None)).IsValid);

        UserSessionCommandService users = CreateSessionService(db, cache);
        var refresh = await users.RefreshTokenAsync("replayed-stale-token", session.SessionId);

        Assert.False(refresh.Success);
        Assert.Null(refresh.Data);
        UserSessionValidationResult rejected = await validator.ValidateAsync(principal, CancellationToken.None);
        Assert.False(rejected.IsValid);
        Assert.Equal("user_session_revoked", rejected.Reason);
        UserSession row = await db.Queryable<UserSession>().SingleAsync(item => item.SessionId == session.SessionId);
        Assert.Equal("refresh_token_reuse_family_revoke", row.RevokeReason);
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "auth-session-fail-closed")]
    public async Task RefreshReplay_RevokesOnlyTargetSessionAndDoesNotTreatDeviceSignalAsAuthority()
    {
        using SqlSugarClient db = await CreateDbAsync();
        int accountId = await SeedAccountAsync(db);
        UserSession replayTarget = await SeedSessionAsync(
            db,
            accountId,
            "family-target",
            refreshTokenHash: HashToken("current-family-token"),
            deviceSignalHash: HashToken("device-family-a"));
        UserSession sameDevice = await SeedSessionAsync(
            db,
            accountId,
            "family-sibling",
            deviceSignalHash: HashToken("device-family-a"));
        UserSession otherDevice = await SeedSessionAsync(
            db,
            accountId,
            "other-device",
            deviceSignalHash: HashToken("device-family-b"));
        var cache = new VersionedSessionValidationCache();
        var validator = new UserSessionValidationService(db, cache);
        ClaimsPrincipal targetPrincipal = CreatePrincipal(accountId, replayTarget);
        ClaimsPrincipal siblingPrincipal = CreatePrincipal(accountId, sameDevice);
        ClaimsPrincipal otherPrincipal = CreatePrincipal(accountId, otherDevice);
        Assert.True((await validator.ValidateAsync(targetPrincipal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(siblingPrincipal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(otherPrincipal, CancellationToken.None)).IsValid);

        UserSessionCommandService users = CreateSessionService(db, cache);
        var refresh = await users.RefreshTokenAsync("replayed-stale-family-token", replayTarget.SessionId);

        Assert.False(refresh.Success);
        Assert.Equal("user_session_revoked", (await validator.ValidateAsync(targetPrincipal, CancellationToken.None)).Reason);
        Assert.True((await validator.ValidateAsync(siblingPrincipal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(otherPrincipal, CancellationToken.None)).IsValid);
        List<UserSession> rows = await db.Queryable<UserSession>()
            .Where(row => row.UserId == accountId)
            .ToListAsync();
        UserSession revokedTarget = Assert.Single(rows, row => row.SessionId == replayTarget.SessionId);
        Assert.NotNull(revokedTarget.RevokedAt);
        Assert.Equal("refresh_token_reuse_family_revoke", revokedTarget.RevokeReason);
        Assert.Null(Assert.Single(rows, row => row.SessionId == sameDevice.SessionId).RevokedAt);
        Assert.Null(Assert.Single(rows, row => row.SessionId == otherDevice.SessionId).RevokedAt);
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task ConcurrentCacheMissAndRevoke_DoesNotResurrectStaleActiveSnapshot()
    {
        using SqlSugarClient db = await CreateDbAsync();
        int accountId = await SeedAccountAsync(db);
        UserSession session = await SeedSessionAsync(db, accountId, "cache-race");
        var cache = new VersionedSessionValidationCache();
        cache.BlockNextActivePublish();
        var validator = new UserSessionValidationService(db, cache);
        ClaimsPrincipal principal = CreatePrincipal(accountId, session);

        Task<UserSessionValidationResult> concurrentValidation = validator.ValidateAsync(principal, CancellationToken.None);
        await cache.WaitForBlockedActivePublishAsync();

        UserSessionCommandService users = CreateSessionService(db, cache);
        Assert.True(await users.RevokeSessionAsync(accountId, session.SessionId));
        cache.ReleaseBlockedActivePublish();

        UserSessionValidationResult racedResult = await concurrentValidation;
        Assert.False(racedResult.IsValid);
        Assert.Equal("user_session_revoked", racedResult.Reason);
        Assert.Equal(
            "user_session_revoked",
            (await validator.ValidateAsync(principal, CancellationToken.None)).Reason);
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task RevokeAllCommittedBeforeRefreshRejectsWarmPrincipalAndLeavesOtherAccountActive()
    {
        const string RefreshToken = "issue-2334-revoke-first-refresh";
        string cachePrefix = $"test:issue-2334-revoke-first:{Guid.CreateVersion7():N}:";
        await using RealValidationCacheHarness cache = await CreateRealValidationCacheAsync(cachePrefix);
        using SqlSugarClient db = await CreateDbAsync();
        int accountId = await SeedAccountAsync(db);
        int otherAccountId = await SeedAccountAsync(db);
        UserSession session = await SeedSessionAsync(
            db,
            accountId,
            "issue-2334-revoke-first",
            refreshTokenHash: HashToken(RefreshToken));
        UserSession otherSession = await SeedSessionAsync(
            db,
            otherAccountId,
            "issue-2334-other",
            refreshTokenHash: HashToken("issue-2334-other-refresh"));
        var validator = new UserSessionValidationService(db, cache.Recording);
        ClaimsPrincipal principal = CreatePrincipal(accountId, session);
        ClaimsPrincipal otherPrincipal = CreatePrincipal(otherAccountId, otherSession);
        Assert.True((await validator.ValidateAsync(principal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(otherPrincipal, CancellationToken.None)).IsValid);
        UserSessionValidationCacheState warm =
            Assert.IsType<UserSessionValidationCacheState>(await cache.Production.ReadAsync(session.SessionId));
        UserSessionValidationCacheState otherWarm =
            Assert.IsType<UserSessionValidationCacheState>(await cache.Production.ReadAsync(otherSession.SessionId));

        UserSessionCommandService sessions = CreateRealSessionService(db, cache.Recording);
        int revoked = await sessions.RevokeAllSessionsAsync(
            accountId,
            "issue_2334_revoke_all",
            CancellationToken.None);
        RefreshTokenRotationResult refresh = await sessions.RotateRefreshTokenAsync(
            RefreshToken,
            session.SessionId,
            CancellationToken.None);
        RefreshTokenRotationResult replay = await sessions.RotateRefreshTokenAsync(
            RefreshToken,
            session.SessionId,
            CancellationToken.None);

        Assert.Equal(1, revoked);
        Assert.Equal(RefreshTokenRotationOutcome.ExpiredOrUnknown, refresh.Outcome);
        Assert.Null(refresh.Tokens);
        Assert.Equal(RefreshTokenRotationOutcome.ExpiredOrUnknown, replay.Outcome);
        Assert.Null(replay.Tokens);
        Assert.False(await sessions.VerifyRefreshRotationAsync(RefreshToken, session.SessionId));
        Assert.Equal("user_session_revoked", (await validator.ValidateAsync(principal, CancellationToken.None)).Reason);
        Assert.True((await validator.ValidateAsync(otherPrincipal, CancellationToken.None)).IsValid);

        UserSession stored = await db.Queryable<UserSession>().SingleAsync(row => row.SessionId == session.SessionId);
        Assert.NotNull(stored.RevokedAt);
        Assert.Equal("issue_2334_revoke_all", stored.RevokeReason);
        Assert.Equal(0, stored.RefreshGeneration);
        Assert.Equal(HashToken(RefreshToken), stored.RefreshTokenHash);
        Assert.Null((await db.Queryable<UserSession>().SingleAsync(
            row => row.SessionId == otherSession.SessionId)).RevokedAt);
        Assert.True(await sessions.VerifyRefreshRotationAsync("issue-2334-other-refresh", otherSession.SessionId));

        UserSessionValidationCacheState revokedState =
            Assert.IsType<UserSessionValidationCacheState>(await cache.Production.ReadAsync(session.SessionId));
        UserSessionValidationCacheState otherAfter =
            Assert.IsType<UserSessionValidationCacheState>(await cache.Production.ReadAsync(otherSession.SessionId));
        Assert.NotEqual(warm.RowVersion, revokedState.RowVersion);
        Assert.Equal(stored.RevokedAt, revokedState.RevokedAtUtc);
        Assert.Equal(UserSessionMode.Revoked, revokedState.SessionMode);
        Assert.Equal(otherWarm, otherAfter);
        Assert.Equal(1, cache.Recording.PublishManyCallCount);
        Assert.Equal([session.SessionId], cache.Recording.LastPublishedSessionIds);
        Assert.Equal(0, cache.Recording.InvalidateManyCallCount);
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task RefreshReadOldRowThenRevokeCommitRejectsRotationAndEveryIssuedToken()
    {
        const string OriginalRefreshToken = "issue-2334-generation-zero";
        string cachePrefix = $"test:issue-2334-read-old:{Guid.CreateVersion7():N}:";
        await using RealValidationCacheHarness cache = await CreateRealValidationCacheAsync(cachePrefix);
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        int accountId = await SeedAccountAsync(setupDb);
        int otherAccountId = await SeedAccountAsync(setupDb);
        UserSession session = await SeedSessionAsync(
            setupDb,
            accountId,
            "issue-2334-read-old",
            refreshTokenHash: HashToken(OriginalRefreshToken));
        UserSession otherSession = await SeedSessionAsync(
            setupDb,
            otherAccountId,
            "issue-2334-read-old-other",
            refreshTokenHash: HashToken("issue-2334-other-current"));
        UserSessionCommandService setupSessions = CreateRealSessionService(setupDb, cache.Recording);
        RefreshTokenRotationResult firstRotation = await setupSessions.RotateRefreshTokenAsync(
            OriginalRefreshToken,
            session.SessionId,
            CancellationToken.None);
        Assert.Equal(RefreshTokenRotationOutcome.Success, firstRotation.Outcome);
        Assert.True(firstRotation.Tokens.HasValue);
        TokenResponseDto issued = firstRotation.Tokens.Value;
        UserSession rotated = await setupDb.Queryable<UserSession>().SingleAsync(
            row => row.SessionId == session.SessionId);
        Assert.Equal(1, rotated.RefreshGeneration);
        Assert.Equal(HashToken(issued.RefreshToken), rotated.RefreshTokenHash);
        Assert.Equal(
            HashToken(OriginalRefreshToken),
            (await setupDb.Queryable<UserRefreshTokenTombstone>().SingleAsync()).TokenHash);

        var validator = new UserSessionValidationService(setupDb, cache.Recording);
        ClaimsPrincipal oldPrincipal = CreatePrincipal(accountId, session);
        ClaimsPrincipal issuedPrincipal = ValidateAccessToken(issued.AccessToken);
        ClaimsPrincipal otherPrincipal = CreatePrincipal(otherAccountId, otherSession);
        Assert.True((await validator.ValidateAsync(oldPrincipal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(issuedPrincipal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(otherPrincipal, CancellationToken.None)).IsValid);
        UserSessionValidationCacheState warm =
            Assert.IsType<UserSessionValidationCacheState>(await cache.Production.ReadAsync(session.SessionId));

        string revokeApplication = $"issue2334-revoke-{Guid.NewGuid():N}"[..48];
        string refreshApplication = $"issue2334-refresh-{Guid.NewGuid():N}"[..49];
        using SqlSugarClient revokeDb =
            PostgresSqlSugarTestClient.Create(WithApplicationName(connectionString, revokeApplication));
        using SqlSugarClient refreshDb =
            PostgresSqlSugarTestClient.Create(WithApplicationName(connectionString, refreshApplication));
        UserSessionCommandService revokeSessions = CreateRealSessionService(revokeDb, cache.Recording);
        UserSessionCommandService refreshSessions = CreateRealSessionService(refreshDb, cache.Recording);

        await using var holder = new NpgsqlConnection(connectionString);
        await holder.OpenAsync();
        await using NpgsqlTransaction holderTransaction = await holder.BeginTransactionAsync();
        await AcquireSessionConcurrencyGateAsync(holder, holderTransaction, accountId);
        Task<int> revoke = revokeSessions.RevokeAllSessionsAsync(
            accountId,
            "issue_2334_revoke_all",
            CancellationToken.None);
        _ = await WaitForLockWaitersAsync(connectionString, [revokeApplication], expectedCount: 1);
        Task<RefreshTokenRotationResult> refresh = refreshSessions.RotateRefreshTokenAsync(
            issued.RefreshToken,
            session.SessionId,
            CancellationToken.None);
        bool refreshReachedGate = await WaitForLockWaitersAsync(
            connectionString,
            [revokeApplication, refreshApplication],
            expectedCount: 2,
            mustRemainIncomplete: refresh);
        Assert.False(revoke.IsCompleted);
        bool refreshWasIncompleteWhileHeld = !refresh.IsCompleted;

        await holderTransaction.CommitAsync();
        int revoked = await revoke.WaitAsync(TimeSpan.FromSeconds(30));
        RefreshTokenRotationResult racedRefresh = await refresh.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.True(
            refreshReachedGate,
            "Refresh completed before reaching the shared session concurrency gate.");
        Assert.True(
            refreshWasIncompleteWhileHeld,
            "Refresh completed while the shared session concurrency gate remained held.");

        Assert.Equal(1, revoked);
        Assert.Equal(RefreshTokenRotationOutcome.ConcurrentConflict, racedRefresh.Outcome);
        Assert.Null(racedRefresh.Tokens);
        UserSession final = await setupDb.Queryable<UserSession>().SingleAsync(
            row => row.SessionId == session.SessionId);
        Assert.NotNull(final.RevokedAt);
        Assert.Equal("issue_2334_revoke_all", final.RevokeReason);
        Assert.Equal(1, final.RefreshGeneration);
        Assert.Equal(HashToken(issued.RefreshToken), final.RefreshTokenHash);
        Assert.Equal(
            HashToken(OriginalRefreshToken),
            (await setupDb.Queryable<UserRefreshTokenTombstone>().SingleAsync()).TokenHash);

        Assert.Equal("user_session_revoked", (await validator.ValidateAsync(oldPrincipal, CancellationToken.None)).Reason);
        Assert.Equal("user_session_revoked", (await validator.ValidateAsync(issuedPrincipal, CancellationToken.None)).Reason);
        Assert.True((await validator.ValidateAsync(otherPrincipal, CancellationToken.None)).IsValid);
        Assert.False(await setupSessions.VerifyRefreshRotationAsync(issued.RefreshToken, session.SessionId));
        Assert.True(await setupSessions.VerifyRefreshRotationAsync("issue-2334-other-current", otherSession.SessionId));
        Assert.Equal(RefreshTokenRotationOutcome.ExpiredOrUnknown, (
            await setupSessions.RotateRefreshTokenAsync(
                OriginalRefreshToken,
                session.SessionId,
                CancellationToken.None)).Outcome);
        Assert.Equal(RefreshTokenRotationOutcome.ExpiredOrUnknown, (
            await setupSessions.RotateRefreshTokenAsync(
                issued.RefreshToken,
                session.SessionId,
                CancellationToken.None)).Outcome);

        UserSessionValidationCacheState revokedState =
            Assert.IsType<UserSessionValidationCacheState>(await cache.Production.ReadAsync(session.SessionId));
        Assert.NotEqual(warm.RowVersion, revokedState.RowVersion);
        Assert.Equal(final.RevokedAt, revokedState.RevokedAtUtc);
        Assert.Equal(UserSessionMode.Revoked, revokedState.SessionMode);
        Assert.Equal(1, cache.Recording.PublishManyCallCount);
        Assert.Equal([session.SessionId], cache.Recording.LastPublishedSessionIds);
        Assert.Equal(0, cache.Recording.InvalidateManyCallCount);
        Assert.Null((await setupDb.Queryable<UserSession>().SingleAsync(
            row => row.SessionId == otherSession.SessionId)).RevokedAt);
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task RefreshCommitThenRevokeCommitInvalidatesOldAndNewTokenAuthority()
    {
        const string OriginalRefreshToken = "issue-2334-refresh-first";
        const string OtherRefreshToken = "issue-2334-refresh-first-other";
        string cachePrefix = $"test:issue-2334-refresh-first:{Guid.CreateVersion7():N}:";
        await using RealValidationCacheHarness cache = await CreateRealValidationCacheAsync(cachePrefix);
        using SqlSugarClient db = await CreateDbAsync();
        int accountId = await SeedAccountAsync(db);
        int otherAccountId = await SeedAccountAsync(db);
        UserSession session = await SeedSessionAsync(
            db,
            accountId,
            "issue-2334-refresh-first",
            refreshTokenHash: HashToken(OriginalRefreshToken));
        UserSession otherSession = await SeedSessionAsync(
            db,
            otherAccountId,
            "issue-2334-refresh-first-other",
            refreshTokenHash: HashToken(OtherRefreshToken));
        var validator = new UserSessionValidationService(db, cache.Recording);
        ClaimsPrincipal oldPrincipal = CreatePrincipal(accountId, session);
        ClaimsPrincipal otherPrincipal = CreatePrincipal(otherAccountId, otherSession);
        Assert.True((await validator.ValidateAsync(oldPrincipal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(otherPrincipal, CancellationToken.None)).IsValid);
        UserSessionValidationCacheState warm =
            Assert.IsType<UserSessionValidationCacheState>(await cache.Production.ReadAsync(session.SessionId));

        UserSessionCommandService sessions = CreateRealSessionService(db, cache.Recording);
        RefreshTokenRotationResult refresh = await sessions.RotateRefreshTokenAsync(
            OriginalRefreshToken,
            session.SessionId,
            CancellationToken.None);
        Assert.Equal(RefreshTokenRotationOutcome.Success, refresh.Outcome);
        Assert.True(refresh.Tokens.HasValue);
        TokenResponseDto issued = refresh.Tokens.Value;
        ClaimsPrincipal issuedPrincipal = ValidateAccessToken(issued.AccessToken);
        Assert.True((await validator.ValidateAsync(issuedPrincipal, CancellationToken.None)).IsValid);

        int revoked = await sessions.RevokeAllSessionsAsync(
            accountId,
            "issue_2334_revoke_all",
            CancellationToken.None);

        Assert.Equal(1, revoked);
        Assert.Equal("user_session_revoked", (await validator.ValidateAsync(oldPrincipal, CancellationToken.None)).Reason);
        Assert.Equal("user_session_revoked", (await validator.ValidateAsync(issuedPrincipal, CancellationToken.None)).Reason);
        Assert.True((await validator.ValidateAsync(otherPrincipal, CancellationToken.None)).IsValid);
        Assert.False(await sessions.VerifyRefreshRotationAsync(OriginalRefreshToken, session.SessionId));
        Assert.False(await sessions.VerifyRefreshRotationAsync(issued.RefreshToken, session.SessionId));

        UserSession stored = await db.Queryable<UserSession>().SingleAsync(row => row.SessionId == session.SessionId);
        Assert.NotNull(stored.RevokedAt);
        Assert.Equal("issue_2334_revoke_all", stored.RevokeReason);
        Assert.Equal(1, stored.RefreshGeneration);
        Assert.Equal(HashToken(issued.RefreshToken), stored.RefreshTokenHash);
        UserRefreshTokenTombstone tombstone =
            await db.Queryable<UserRefreshTokenTombstone>().SingleAsync();
        Assert.Equal(HashToken(OriginalRefreshToken), tombstone.TokenHash);
        Assert.Equal(stored.RefreshFamilyId, tombstone.RefreshFamilyId);
        Assert.Equal(0, tombstone.Generation);

        RefreshTokenRotationResult oldReplay = await sessions.RotateRefreshTokenAsync(
            OriginalRefreshToken,
            session.SessionId,
            CancellationToken.None);
        RefreshTokenRotationResult newReplay = await sessions.RotateRefreshTokenAsync(
            issued.RefreshToken,
            session.SessionId,
            CancellationToken.None);
        Assert.Equal(RefreshTokenRotationOutcome.ExpiredOrUnknown, oldReplay.Outcome);
        Assert.Null(oldReplay.Tokens);
        Assert.Equal(RefreshTokenRotationOutcome.ExpiredOrUnknown, newReplay.Outcome);
        Assert.Null(newReplay.Tokens);

        UserSessionValidationCacheState revokedState =
            Assert.IsType<UserSessionValidationCacheState>(await cache.Production.ReadAsync(session.SessionId));
        Assert.NotEqual(warm.RowVersion, revokedState.RowVersion);
        Assert.Equal(stored.RevokedAt, revokedState.RevokedAtUtc);
        Assert.Equal(UserSessionMode.Revoked, revokedState.SessionMode);
        Assert.Equal(1, cache.Recording.PublishManyCallCount);
        Assert.Equal([session.SessionId], cache.Recording.LastPublishedSessionIds);
        Assert.Equal(0, cache.Recording.InvalidateManyCallCount);
        Assert.Null((await db.Queryable<UserSession>().SingleAsync(
            row => row.SessionId == otherSession.SessionId)).RevokedAt);
        Assert.True(await sessions.VerifyRefreshRotationAsync(OtherRefreshToken, otherSession.SessionId));
    }

    [Fact]
    public async Task UnauthenticatedPrincipal_DoesNotReadSessionCacheOrDatabase()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var cache = new VersionedSessionValidationCache();
        var validator = new UserSessionValidationService(db, cache);

        UserSessionValidationResult result = await validator.ValidateAsync(
            new ClaimsPrincipal(new ClaimsIdentity()),
            CancellationToken.None);

        Assert.False(result.IsValid);
        Assert.Equal(0, cache.ReadCount);
        _ = db.DidNotReceive().Ado;
    }

    private Task<SqlSugarClient> CreateDbAsync()
        => PostgresSqlSugarTestClient.CreateAsync(fixture);

    private static async Task<int> SeedAccountAsync(SqlSugarClient db)
    {
        PostgresSqlSugarTestClient.InitTables(db, typeof(User), typeof(UserSession), typeof(UserRefreshTokenTombstone));
        return await db.Insertable(new User
        {
            PublicHandle = $"session-{Guid.NewGuid():N}"[..20],
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            RegistrationState = AccountRegistrationStates.Active,
            AccountSubjectHash = Convert.ToHexStringLower(
                SHA256.HashData(Encoding.UTF8.GetBytes(Guid.NewGuid().ToString("N")))),
            Status = 0,
            PrivacyInitializedAt = DateTime.UtcNow
        }).ExecuteReturnIdentityAsync();
    }

    private static async Task<UserSession> SeedSessionAsync(
        SqlSugarClient db,
        int accountId,
        string suffix,
        string? refreshTokenHash = null,
        string? deviceSignalHash = null,
        int? credentialRowId = null)
    {
        string sessionId = $"{suffix}-{Guid.NewGuid():N}";
        var session = new UserSession
        {
            SessionId = sessionId,
            UserId = accountId,
            RefreshTokenHash = refreshTokenHash ?? HashToken($"refresh-{sessionId}"),
            RefreshFamilyId = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),
            RefreshGeneration = 0,
            DeviceSignalHash = deviceSignalHash,
            DeviceSignalEpoch = deviceSignalHash is null ? null : 1,
            CreatedAt = DateTime.UtcNow.AddMinutes(-5),
            LastSeenAt = DateTime.UtcNow.AddMinutes(-1),
            IdleExpiresAt = DateTime.UtcNow.AddHours(1),
            AbsoluteExpiresAt = DateTime.UtcNow.AddDays(31),
            MfaVerified = true,
            AuthenticationMethod = UserSessionAuthenticationMethods.Passkey,
            AuthenticationStrength = UserSessionAuthenticationStrengths.WebAuthnUv,
            AuthenticatedAtUtc = DateTime.UtcNow.AddMinutes(-5),
            AuthenticatedCredentialRowId = credentialRowId,
            DurationPolicy = UserSessionDurationPolicies.BrowserSession
        };
        await db.Insertable(session).ExecuteCommandAsync();
        return session;
    }

    private static UserSessionCommandService CreateSessionService(
        ISqlSugarClient db,
        IUserSessionValidationCache validationCache)
    {
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns("rotated-refresh-token");
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string>(), Arg.Any<bool>()).Returns(
            new IssuedAccessToken("rotated-access-token", DateTimeOffset.UtcNow.AddMinutes(15)));
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string>(), Arg.Any<UserSessionAuthenticationContext>()).Returns(
            new IssuedAccessToken("rotated-access-token", DateTimeOffset.UtcNow.AddMinutes(15)));
        return new UserSessionCommandService(
            db,
            NullLogger<UserSessionCommandService>.Instance,
            jwt,
            validationCache);
    }

    private static UserSessionCommandService CreateRealSessionService(
        ISqlSugarClient db,
        IUserSessionValidationCache validationCache)
        => new(
            db,
            NullLogger<UserSessionCommandService>.Instance,
            CreateJwtHelper(),
            validationCache);

    private async Task<RealValidationCacheHarness> CreateRealValidationCacheAsync(string prefix)
    {
        ConnectionMultiplexer connection = await redisFixture.ConnectAsync();
        var memory = new MemoryCache(new MemoryCacheOptions());
        var registry = new CachePolicyRegistry();
        var scope = new PrefixRuntimeKeyScope(prefix);
        var unified = new UnifiedCache(
            memory,
            connection,
            registry,
            scope,
            NullLogger<UnifiedCache>.Instance);
        var resolver = new CacheKeyResolver(
            registry,
            scope,
            NullLogger<CacheKeyResolver>.Instance);
        var production = new UserSessionValidationCache(
            resolver,
            unified,
            unified,
            connection,
            new ConfigurationBuilder().Build());
        return new RealValidationCacheHarness(
            redisFixture,
            prefix,
            connection,
            memory,
            unified,
            production);
    }

    private static JwtHelper CreateJwtHelper()
        => new(Options.Create(new JwtSettings
        {
            KeyVersion = "issue-2334",
            SecretKey = TestSecrets.IntegrationJwtSigningKey,
            Issuer = "FsusBlog.Tests",
            Audience = "FsusBlog.Tests",
            AccessTokenExpiresMinutes = 15
        }));

    private static ClaimsPrincipal ValidateAccessToken(string accessToken)
    {
        var handler = new JwtSecurityTokenHandler();
        ClaimsPrincipal principal = handler.ValidateToken(
            accessToken,
            new TokenValidationParameters
            {
                ValidateIssuerSigningKey = true,
                IssuerSigningKey = new SymmetricSecurityKey(
                    Encoding.UTF8.GetBytes(TestSecrets.IntegrationJwtSigningKey)),
                ValidateIssuer = true,
                ValidIssuer = "FsusBlog.Tests",
                ValidateAudience = true,
                ValidAudience = "FsusBlog.Tests",
                ValidateLifetime = true,
                ClockSkew = TimeSpan.Zero
            },
            out _);
        Assert.True(principal.Identity?.IsAuthenticated);
        return principal;
    }

    private static string WithApplicationName(string connectionString, string applicationName)
    {
        var builder = new NpgsqlConnectionStringBuilder(connectionString)
        {
            ApplicationName = applicationName
        };
        return builder.ConnectionString;
    }

    private static async Task AcquireSessionConcurrencyGateAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        int accountId)
    {
        await using var command = new NpgsqlCommand(
            "SELECT pg_advisory_xact_lock(@lock_namespace, @account_id);",
            connection,
            transaction);
        command.Parameters.AddWithValue("lock_namespace", UserSessionConcurrencyGate.LockNamespace);
        command.Parameters.AddWithValue("account_id", accountId);
        _ = await command.ExecuteScalarAsync();
    }

    private static async Task<bool> WaitForLockWaitersAsync(
        string connectionString,
        IReadOnlyList<string> applicationNames,
        int expectedCount,
        Task? mustRemainIncomplete = null)
    {
        await using var observer = new NpgsqlConnection(connectionString);
        await observer.OpenAsync();
        DateTime deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            if (mustRemainIncomplete?.IsCompleted == true)
            {
                return false;
            }
            await using var command = new NpgsqlCommand(
                """
                SELECT COUNT(DISTINCT application_name)
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND application_name = ANY(@application_names)
                  AND wait_event_type = 'Lock';
                """,
                observer);
            command.Parameters.AddWithValue("application_names", applicationNames.ToArray());
            if (Convert.ToInt32(
                await command.ExecuteScalarAsync(),
                System.Globalization.CultureInfo.InvariantCulture) >= expectedCount)
            {
                return true;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(25));
        }

        throw new TimeoutException(
            $"Expected {expectedCount} user-session refresh/revoke lock waiters.");
    }

    private static ClaimsPrincipal CreatePrincipal(int accountId, UserSession session)
        => new(new ClaimsIdentity(
        [
            new Claim(ClaimTypes.NameIdentifier, accountId.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind),
            new Claim("sid", session.SessionId),
            new Claim("mfa", "1"),
            new Claim("auth_method", session.AuthenticationMethod),
            new Claim("auth_strength", session.AuthenticationStrength),
            new Claim(
                "auth_time",
                new DateTimeOffset(session.AuthenticatedAtUtc)
                    .ToUnixTimeSeconds()
                    .ToString(System.Globalization.CultureInfo.InvariantCulture))
        ], "Bearer"));

    private static string HashToken(string token)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;
        public string PrefixKey(string key) => string.Concat(prefix, key);
    }

    private sealed class RealValidationCacheHarness(
        PublicHotDeliveryRedisFixture fixture,
        string prefix,
        ConnectionMultiplexer connection,
        MemoryCache memory,
        UnifiedCache unified,
        UserSessionValidationCache production) : IAsyncDisposable
    {
        public UserSessionValidationCache Production { get; } = production;
        public RecordingSessionValidationCache Recording { get; } = new(production);

        public async ValueTask DisposeAsync()
        {
            await fixture.DeleteNamespaceAsync(prefix);
            unified.Dispose();
            memory.Dispose();
            await connection.DisposeAsync();
        }
    }

    private sealed class RecordingSessionValidationCache(IUserSessionValidationCache inner)
        : IUserSessionValidationCache
    {
        private int _publishManyCallCount;
        private int _invalidateManyCallCount;

        public int PublishManyCallCount => Volatile.Read(ref _publishManyCallCount);
        public int InvalidateManyCallCount => Volatile.Read(ref _invalidateManyCallCount);
        public string[] LastPublishedSessionIds { get; private set; } = [];

        public Task<UserSessionValidationCacheState?> ReadAsync(
            string sessionId,
            CancellationToken cancellationToken = default)
            => inner.ReadAsync(sessionId, cancellationToken);

        public Task<bool> PublishAsync(
            UserSessionValidationCacheState state,
            bool allowOverwrite,
            CancellationToken cancellationToken = default)
            => inner.PublishAsync(state, allowOverwrite, cancellationToken);

        public Task PublishManyAsync(
            IReadOnlyList<UserSessionValidationCacheState> states,
            bool allowOverwrite,
            CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _publishManyCallCount);
            LastPublishedSessionIds = [.. states.Select(static state => state.SessionId)];
            return inner.PublishManyAsync(states, allowOverwrite, cancellationToken);
        }

        public Task InvalidateManyAsync(
            IReadOnlyList<UserSessionValidationCacheState> states,
            CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _invalidateManyCallCount);
            return inner.InvalidateManyAsync(states, cancellationToken);
        }
    }

    private sealed class VersionedSessionValidationCache : IUserSessionValidationCache
    {
        private readonly ConcurrentDictionary<string, UserSessionValidationCacheState> _states = new(StringComparer.Ordinal);
        private readonly TaskCompletionSource _activePublishBlocked = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _releaseActivePublish = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _blockNextActivePublish;

        public int ReadCount
        {
            get; private set;
        }

        public int DatabaseMissPublishCount
        {
            get; private set;
        }

        public Task<UserSessionValidationCacheState?> ReadAsync(
            string sessionId,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ReadCount++;
            _states.TryGetValue(sessionId, out UserSessionValidationCacheState? state);
            return Task.FromResult(state);
        }

        public async Task<bool> PublishAsync(
            UserSessionValidationCacheState state,
            bool allowOverwrite,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!allowOverwrite &&
                !state.RevokedAtUtc.HasValue &&
                Interlocked.Exchange(ref _blockNextActivePublish, 0) == 1)
            {
                _activePublishBlocked.TrySetResult();
                await _releaseActivePublish.Task.WaitAsync(cancellationToken);
            }

            if (allowOverwrite)
            {
                _states[state.SessionId] = state;
                return true;
            }

            DatabaseMissPublishCount++;
            while (true)
            {
                if (!_states.TryGetValue(state.SessionId, out UserSessionValidationCacheState? current))
                {
                    if (_states.TryAdd(state.SessionId, state))
                    {
                        return true;
                    }
                    continue;
                }

                if (!string.Equals(current.RowVersion, state.RowVersion, StringComparison.Ordinal))
                {
                    return false;
                }

                if (_states.TryUpdate(state.SessionId, state, current))
                {
                    return true;
                }
            }
        }

        public async Task PublishManyAsync(
            IReadOnlyList<UserSessionValidationCacheState> values,
            bool allowOverwrite,
            CancellationToken cancellationToken = default)
        {
            foreach (UserSessionValidationCacheState state in values)
            {
                if (!await PublishAsync(state, allowOverwrite, cancellationToken))
                {
                    throw new InvalidOperationException("validation cache conflict");
                }
            }
        }

        public Task InvalidateManyAsync(
            IReadOnlyList<UserSessionValidationCacheState> values,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            foreach (UserSessionValidationCacheState state in values)
            {
                _states.TryRemove(state.SessionId, out _);
            }

            return Task.CompletedTask;
        }

        public void BlockNextActivePublish()
            => Interlocked.Exchange(ref _blockNextActivePublish, 1);

        public Task WaitForBlockedActivePublishAsync()
            => _activePublishBlocked.Task;

        public void ReleaseBlockedActivePublish()
            => _releaseActivePublish.TrySetResult();
    }
}
