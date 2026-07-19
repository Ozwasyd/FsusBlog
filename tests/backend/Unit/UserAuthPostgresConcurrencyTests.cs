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
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Trait("Category", "Concurrency")]
[Trait("Category", "SecurityStateMachine")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class UserAuthPostgresConcurrencyTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task RefreshTokenAsync_ConcurrentReplayAllowsOneRotationThenRevokesSession()
    {
        const string RawRefreshToken = "issue-1040-original-refresh-token";
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        int userId = SeedUser(setupDb, mfaEnabled: true);
        string sessionId = $"issue-1040-session-{Guid.NewGuid():N}";
        SeedSession(setupDb, userId, sessionId, RawRefreshToken);

        var validationCache = Substitute.For<IUserSessionValidationCache>();
        validationCache.PublishAsync(
                Arg.Any<UserSessionValidationCacheState>(),
                Arg.Any<bool>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(true));
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        UserService firstService = CreateService(firstDb, "first-rotated-token", validationCache);
        UserService secondService = CreateService(secondDb, "second-rotated-token", validationCache);

        await using var holder = new NpgsqlConnection(connectionString);
        await holder.OpenAsync();
        await using NpgsqlTransaction transaction = await holder.BeginTransactionAsync();
        await using (var lockCommand = new NpgsqlCommand(
            "UPDATE sys_user_session SET lastseenat = lastseenat WHERE sessionid = @session_id;",
            holder,
            transaction))
        {
            lockCommand.Parameters.AddWithValue("session_id", sessionId);
            Assert.Equal(1, await lockCommand.ExecuteNonQueryAsync());
        }

        using var barrier = new Barrier(2);
        Task<(bool Success, TokenResponseDto? Data)> first = StartTogetherAsync(
            barrier,
            () => firstService.RefreshTokenAsync(RawRefreshToken, sessionId));
        Task<(bool Success, TokenResponseDto? Data)> second = StartTogetherAsync(
            barrier,
            () => secondService.RefreshTokenAsync(RawRefreshToken, sessionId));
        await Task.Delay(TimeSpan.FromMilliseconds(300));
        Assert.False(first.IsCompleted);
        Assert.False(second.IsCompleted);

        await transaction.CommitAsync();
        var results = await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Single(results, static result => result.Success);
        Assert.Single(results, static result => !result.Success && result.Data is null);
        UserSession stored = await setupDb.Queryable<UserSession>()
            .SingleAsync(item => item.SessionId == sessionId);
        Assert.NotNull(stored.RevokedAt);
        Assert.Equal("refresh_token_reuse_family_revoke", stored.RevokeReason);
        DateTime revokedAt = stored.RevokedAt.Value;

        var replayResults = new List<(bool Success, TokenResponseDto? Data)>();
        for (int round = 0; round < 4; round++)
        {
            (bool Success, TokenResponseDto? Data)[] roundResults = await Task.WhenAll(
                firstService.RefreshTokenAsync(RawRefreshToken, sessionId),
                secondService.RefreshTokenAsync(RawRefreshToken, sessionId)).WaitAsync(TimeSpan.FromSeconds(30));
            replayResults.AddRange(roundResults);
        }

        Assert.All(replayResults, static result =>
        {
            Assert.False(result.Success);
            Assert.Null(result.Data);
        });
        UserSession afterThrash = await setupDb.Queryable<UserSession>()
            .SingleAsync(item => item.SessionId == sessionId);
        Assert.Equal(revokedAt, afterThrash.RevokedAt);
        Assert.Equal("refresh_token_reuse_family_revoke", afterThrash.RevokeReason);
        await validationCache.Received(1).PublishManyAsync(
            Arg.Is<IReadOnlyList<UserSessionValidationCacheState>>(states =>
                states.Count == 1
                && states[0].SessionId == sessionId
                && states[0].AccountId == userId
                && states[0].RevokedAtUtc.HasValue),
            true,
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task VerifyMfaOrRecoveryCodeAsync_ConcurrentConsumptionPersistsExactlyOnce()
    {
        const string OldHashes = "issue-1040-old-recovery-hashes";
        const string NewHashes = "issue-1040-new-recovery-hashes";
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        int userId = SeedUser(setupDb, mfaEnabled: true);
        setupDb.Insertable(new UserMfaProfile
        {
            UserId = userId,
            MfaSecretEncrypted = "protected-secret",
            MfaRecoveryCodesHash = OldHashes,
            MfaRecoveryCodesHashVersion = 1,
            UpdatedAtUtc = DateTime.UtcNow
        }).ExecuteCommand();

        var totp = Substitute.For<ITotpService>();
        totp.ConsumeRecoveryCode(OldHashes, "RECOVERY")
            .Returns(new RecoveryCodeConsumeResult(
                Success: true,
                UpdatedHashes: NewHashes,
                ConsumedLegacyHash: false,
                LegacyHashExpired: false,
                RequiresRecoveryCodeRegeneration: false));
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        UserService firstService = CreateService(firstDb, "unused-first", Substitute.For<IUserSessionValidationCache>(), totp);
        UserService secondService = CreateService(secondDb, "unused-second", Substitute.For<IUserSessionValidationCache>(), totp);
        var user = new User { Id = userId, MfaEnabled = true };

        await using var holder = new NpgsqlConnection(connectionString);
        await holder.OpenAsync();
        await using NpgsqlTransaction transaction = await holder.BeginTransactionAsync();
        await using (var lockCommand = new NpgsqlCommand(
            "UPDATE user_mfa_profile SET updated_at_utc = updated_at_utc WHERE user_id = @user_id;",
            holder,
            transaction))
        {
            lockCommand.Parameters.AddWithValue("user_id", userId);
            Assert.Equal(1, await lockCommand.ExecuteNonQueryAsync());
        }

        using var barrier = new Barrier(2);
        Task<bool> first = StartTogetherAsync(
            barrier,
            () => firstService.VerifyMfaOrRecoveryCodeAsync(user, code: null, recoveryCode: "RECOVERY", persistRecoveryConsumption: true));
        Task<bool> second = StartTogetherAsync(
            barrier,
            () => secondService.VerifyMfaOrRecoveryCodeAsync(user, code: null, recoveryCode: "RECOVERY", persistRecoveryConsumption: true));
        await Task.Delay(TimeSpan.FromMilliseconds(300));
        Assert.False(first.IsCompleted);
        Assert.False(second.IsCompleted);

        await transaction.CommitAsync();
        bool[] results = await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Single(results, static success => success);
        UserMfaProfile stored = await setupDb.Queryable<UserMfaProfile>()
            .SingleAsync(item => item.UserId == userId);
        Assert.Equal(NewHashes, stored.MfaRecoveryCodesHash);
        Assert.Equal(TotpService.CurrentRecoveryCodeHashVersion, stored.MfaRecoveryCodesHashVersion);
        totp.Received(2).ConsumeRecoveryCode(OldHashes, "RECOVERY");
    }

    [Fact]
    public async Task BlacklistService_BanAndUnbanCannotResurrectDeletedAccount()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(db);
        int userId = SeedUser(db, mfaEnabled: false);
        DateTime deletedAt = DateTime.UtcNow.AddMinutes(-1);
        Assert.Equal(1, db.Ado.ExecuteCommand(
            "UPDATE sys_user SET status = 2, deleted_at = @DeletedAt, deleted_reason = 'account-deleted' WHERE id = @UserId;",
            new SugarParameter("@DeletedAt", deletedAt),
            new SugarParameter("@UserId", userId)));
        var cache = Substitute.For<IUnifiedCache>();
        var service = new BlacklistService(cache, cache, cache, cache, db);

        await service.BanUserAsync(userId, "must-not-ban");
        await service.UnbanUserAsync(userId);

        User stored = await db.Queryable<User>().InSingleAsync(userId);
        Assert.Equal(2, stored.Status);
        Assert.NotNull(stored.DeletedAt);
        Assert.Equal("account-deleted", stored.DeletedReason);
        Assert.Null(stored.BanReason);
        await cache.DidNotReceiveWithAnyArgs().TrySetVersionedStringAsync(
            default,
            default!,
            default!,
            default!,
            default,
            default,
            default);
    }

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(UserSession),
            typeof(UserMfaProfile));

    private static int SeedUser(SqlSugarClient db, bool mfaEnabled)
        => db.Insertable(new User
        {
            PublicHandle = $"auth-race-{Guid.NewGuid():N}"[..20],
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            PasskeyUserHandle = $"auth-race-handle-{Guid.NewGuid():N}",
            PrivacyInitializedAt = DateTime.UtcNow,
            Status = 0,
            MfaEnabled = mfaEnabled
        }).ExecuteReturnIdentity();

    private static void SeedSession(
        SqlSugarClient db,
        int userId,
        string sessionId,
        string rawRefreshToken)
        => db.Insertable(new UserSession
        {
            SessionId = sessionId,
            UserId = userId,
            RefreshTokenHash = HashToken(rawRefreshToken),
            CreatedAt = DateTime.UtcNow.AddMinutes(-5),
            LastSeenAt = DateTime.UtcNow.AddMinutes(-1),
            IdleExpiresAt = DateTime.UtcNow.AddDays(7),
            AbsoluteExpiresAt = DateTime.UtcNow.AddDays(30),
            MfaVerified = true,
            RememberMe = false
        }).ExecuteCommand();

    private static UserService CreateService(
        SqlSugarClient db,
        string nextRefreshToken,
        IUserSessionValidationCache validationCache,
        ITotpService? totp = null)
    {
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns(nextRefreshToken);
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string?>(), Arg.Any<bool>())
            .Returns(new IssuedAccessToken("access-token", DateTimeOffset.UtcNow.AddMinutes(15)));
        return new UserService(
            _db: db,
            _logger: NullLogger<UserService>.Instance,
            _jwtHelper: jwt,
            _cacheCounters: Substitute.For<ICacheCounterStore>(),
            _blacklistService: Substitute.For<IBlacklistService>(),
            _messageCommandService: Substitute.For<IMessageCommandService>(),
            _messageRealtimePublisher: Substitute.For<IMessageRealtimePublisher>(),
            _totpService: totp ?? Substitute.For<ITotpService>(),
            _authRiskService: Substitute.For<IAuthRiskService>(),
            _userSessionValidationCache: validationCache);
    }

    private static string HashToken(string token)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    private static Task<T> StartTogetherAsync<T>(Barrier barrier, Func<Task<T>> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(30)),
                    "Timed out waiting for concurrent authentication operations.");
                return await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();
}
