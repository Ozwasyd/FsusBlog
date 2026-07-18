using System.Collections.Concurrent;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Trait("Category", "SecurityStateMachine")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class UserSessionRevocationIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task RevokeSession_RejectsPreviouslyIssuedPrincipalAfterCacheWasWarm()
    {
        using SqlSugarClient db = await CreateDbAsync();
        int accountId = await SeedAccountAsync(db);
        UserSession session = await SeedSessionAsync(db, accountId, "single-revoke");
        var cache = new VersionedSessionValidationCache();
        var validator = new UserSessionValidationService(db, cache);
        ClaimsPrincipal principal = CreatePrincipal(accountId, session.SessionId);

        Assert.True((await validator.ValidateAsync(principal, CancellationToken.None)).IsValid);

        UserService users = CreateUserService(db, cache);
        Assert.True(await users.RevokeSessionAsync(accountId, session.SessionId));

        UserSessionValidationResult rejected = await validator.ValidateAsync(principal, CancellationToken.None);
        Assert.False(rejected.IsValid);
        Assert.Equal("user_session_revoked", rejected.Reason);
        Assert.Equal(1, cache.DatabaseMissPublishCount);
        Assert.NotNull((await db.Queryable<UserSession>().SingleAsync(row => row.SessionId == session.SessionId)).RevokedAt);
    }

    [Fact]
    public async Task RevokeOtherSessions_InvalidatesOthersAndKeepsCurrentSessionValid()
    {
        using SqlSugarClient db = await CreateDbAsync();
        int accountId = await SeedAccountAsync(db);
        UserSession current = await SeedSessionAsync(db, accountId, "current");
        UserSession otherA = await SeedSessionAsync(db, accountId, "other-a");
        UserSession otherB = await SeedSessionAsync(db, accountId, "other-b");
        var cache = new VersionedSessionValidationCache();
        var validator = new UserSessionValidationService(db, cache);
        ClaimsPrincipal currentPrincipal = CreatePrincipal(accountId, current.SessionId);
        ClaimsPrincipal otherAPrincipal = CreatePrincipal(accountId, otherA.SessionId);
        ClaimsPrincipal otherBPrincipal = CreatePrincipal(accountId, otherB.SessionId);

        Assert.True((await validator.ValidateAsync(currentPrincipal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(otherAPrincipal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(otherBPrincipal, CancellationToken.None)).IsValid);

        UserService users = CreateUserService(db, cache);
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
    public async Task RevokeAllSessions_InvalidatesEveryWarmPrincipalWithSecurityReason()
    {
        using SqlSugarClient db = await CreateDbAsync();
        int accountId = await SeedAccountAsync(db);
        UserSession first = await SeedSessionAsync(db, accountId, "rollback-a");
        UserSession second = await SeedSessionAsync(db, accountId, "rollback-b");
        var cache = new VersionedSessionValidationCache();
        var validator = new UserSessionValidationService(db, cache);
        ClaimsPrincipal firstPrincipal = CreatePrincipal(accountId, first.SessionId);
        ClaimsPrincipal secondPrincipal = CreatePrincipal(accountId, second.SessionId);

        Assert.True((await validator.ValidateAsync(firstPrincipal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(secondPrincipal, CancellationToken.None)).IsValid);

        UserService users = CreateUserService(db, cache);
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
        ClaimsPrincipal principal = CreatePrincipal(accountId, session.SessionId);
        Assert.True((await validator.ValidateAsync(principal, CancellationToken.None)).IsValid);

        UserService users = CreateUserService(db, cache);
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
    public async Task RefreshReplay_AtomicallyRevokesSameDeviceFamilyAndKeepsOtherDevice()
    {
        using SqlSugarClient db = await CreateDbAsync();
        int accountId = await SeedAccountAsync(db);
        UserSession replayTarget = await SeedSessionAsync(
            db,
            accountId,
            "family-target",
            refreshTokenHash: HashToken("current-family-token"),
            deviceFingerprint: "device-family-a");
        UserSession sameDevice = await SeedSessionAsync(
            db,
            accountId,
            "family-sibling",
            deviceFingerprint: "device-family-a");
        UserSession otherDevice = await SeedSessionAsync(
            db,
            accountId,
            "other-device",
            deviceFingerprint: "device-family-b");
        var cache = new VersionedSessionValidationCache();
        var validator = new UserSessionValidationService(db, cache);
        ClaimsPrincipal targetPrincipal = CreatePrincipal(accountId, replayTarget.SessionId);
        ClaimsPrincipal siblingPrincipal = CreatePrincipal(accountId, sameDevice.SessionId);
        ClaimsPrincipal otherPrincipal = CreatePrincipal(accountId, otherDevice.SessionId);
        Assert.True((await validator.ValidateAsync(targetPrincipal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(siblingPrincipal, CancellationToken.None)).IsValid);
        Assert.True((await validator.ValidateAsync(otherPrincipal, CancellationToken.None)).IsValid);

        UserService users = CreateUserService(db, cache);
        var refresh = await users.RefreshTokenAsync("replayed-stale-family-token", replayTarget.SessionId);

        Assert.False(refresh.Success);
        Assert.Equal("user_session_revoked", (await validator.ValidateAsync(targetPrincipal, CancellationToken.None)).Reason);
        Assert.Equal("user_session_revoked", (await validator.ValidateAsync(siblingPrincipal, CancellationToken.None)).Reason);
        Assert.True((await validator.ValidateAsync(otherPrincipal, CancellationToken.None)).IsValid);
        List<UserSession> rows = await db.Queryable<UserSession>()
            .Where(row => row.UserId == accountId)
            .ToListAsync();
        Assert.All(
            rows.Where(row => row.DeviceFingerprint == "device-family-a"),
            row =>
            {
                Assert.NotNull(row.RevokedAt);
                Assert.Equal("refresh_token_reuse_family_revoke", row.RevokeReason);
            });
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
        ClaimsPrincipal principal = CreatePrincipal(accountId, session.SessionId);

        Task<UserSessionValidationResult> concurrentValidation = validator.ValidateAsync(principal, CancellationToken.None);
        await cache.WaitForBlockedActivePublishAsync();

        UserService users = CreateUserService(db, cache);
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
        PostgresSqlSugarTestClient.InitTables(db, typeof(User), typeof(UserSession));
        return await db.Insertable(new User
        {
            PublicHandle = $"session-{Guid.NewGuid():N}"[..20],
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            Status = 0,
            PrivacyInitializedAt = DateTime.UtcNow
        }).ExecuteReturnIdentityAsync();
    }

    private static async Task<UserSession> SeedSessionAsync(
        SqlSugarClient db,
        int accountId,
        string suffix,
        string? refreshTokenHash = null,
        string? deviceFingerprint = null)
    {
        string sessionId = $"{suffix}-{Guid.NewGuid():N}";
        var session = new UserSession
        {
            SessionId = sessionId,
            UserId = accountId,
            RefreshTokenHash = refreshTokenHash ?? HashToken($"refresh-{sessionId}"),
            DeviceFingerprint = deviceFingerprint,
            CreatedAt = DateTime.UtcNow.AddMinutes(-5),
            LastSeenAt = DateTime.UtcNow.AddMinutes(-1),
            IdleExpiresAt = DateTime.UtcNow.AddHours(1),
            AbsoluteExpiresAt = DateTime.UtcNow.AddDays(1),
            MfaVerified = true
        };
        await db.Insertable(session).ExecuteCommandAsync();
        return session;
    }

    private static UserService CreateUserService(
        ISqlSugarClient db,
        IUserSessionValidationCache validationCache)
    {
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns("rotated-refresh-token");
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string>(), Arg.Any<bool>()).Returns(
            new IssuedAccessToken("rotated-access-token", DateTimeOffset.UtcNow.AddMinutes(15)));
        return new UserService(
            _db: db,
            _logger: NullLogger<UserService>.Instance,
            _jwtHelper: jwt,
            _cache: Substitute.For<IUnifiedCache>(),
            _blacklistService: Substitute.For<IBlacklistService>(),
            _messageCommandService: Substitute.For<IMessageCommandService>(),
            _messageRealtimePublisher: Substitute.For<IMessageRealtimePublisher>(),
            _totpService: Substitute.For<ITotpService>(),
            _authRiskService: Substitute.For<IAuthRiskService>(),
            _userSessionValidationCache: validationCache);
    }

    private static ClaimsPrincipal CreatePrincipal(int accountId, string sessionId)
        => new(new ClaimsIdentity(
        [
            new Claim(ClaimTypes.NameIdentifier, accountId.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind),
            new Claim("sid", sessionId),
            new Claim("mfa", "1")
        ], "Bearer"));

    private static string HashToken(string token)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

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
