using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
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
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task RotateRefreshTokenAsync_ConcurrentCasHasOneWinnerThenTombstoneReplayCompromisesOnlyFamily()
    {
        const string RawRefreshToken = "issue-1185-original-refresh-token";
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        int userId = SeedUser(setupDb, mfaEnabled: true);
        int otherUserId = SeedUser(setupDb, mfaEnabled: true);
        string sessionId = $"issue-1185-session-{Guid.NewGuid():N}";
        string otherSessionId = $"issue-1185-other-{Guid.NewGuid():N}";
        SeedSession(setupDb, userId, sessionId, RawRefreshToken);
        SeedSession(setupDb, otherUserId, otherSessionId, "issue-1185-other-refresh");

        var validationCache = Substitute.For<IUserSessionValidationCache>();
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        UserSessionCommandService firstService = CreateSessionService(firstDb, "issue-1185-first-rotated", validationCache);
        UserSessionCommandService secondService = CreateSessionService(secondDb, "issue-1185-second-rotated", validationCache);

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
        Task<RefreshTokenRotationResult> first = StartTogetherAsync(
            barrier,
            () => firstService.RotateRefreshTokenAsync(RawRefreshToken, sessionId));
        Task<RefreshTokenRotationResult> second = StartTogetherAsync(
            barrier,
            () => secondService.RotateRefreshTokenAsync(RawRefreshToken, sessionId));
        await Task.Delay(TimeSpan.FromMilliseconds(300));
        Assert.False(first.IsCompleted);
        Assert.False(second.IsCompleted);

        await transaction.CommitAsync();
        RefreshTokenRotationResult[] results = await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Single(results, result => result.Outcome == RefreshTokenRotationOutcome.Success);
        Assert.Single(results, result => result.Outcome == RefreshTokenRotationOutcome.ConcurrentConflict);
        UserSession rotated = await setupDb.Queryable<UserSession>().SingleAsync(row => row.SessionId == sessionId);
        Assert.Equal(1, rotated.RefreshGeneration);
        Assert.Null(rotated.RevokedAt);
        UserRefreshTokenTombstone tombstone = await setupDb.Queryable<UserRefreshTokenTombstone>().SingleAsync();
        Assert.Equal(HashToken(RawRefreshToken), tombstone.TokenHash);
        Assert.Equal(rotated.RefreshFamilyId, tombstone.RefreshFamilyId);
        Assert.Equal(0, tombstone.Generation);

        RefreshTokenRotationResult replay = await firstService.RotateRefreshTokenAsync(
            RawRefreshToken,
            sessionId: null);

        Assert.Equal(RefreshTokenRotationOutcome.ReplayCompromised, replay.Outcome);
        UserSession compromised = await setupDb.Queryable<UserSession>().SingleAsync(row => row.SessionId == sessionId);
        Assert.Equal("refresh_token_replay", compromised.RefreshCompromiseReason);
        Assert.NotNull(compromised.RefreshCompromisedAtUtc);
        Assert.NotNull(compromised.RevokedAt);
        Assert.Null((await setupDb.Queryable<UserSession>().SingleAsync(row => row.SessionId == otherSessionId)).RevokedAt);
        Assert.Equal(0, await setupDb.Queryable<UserRefreshTokenTombstone>().CountAsync());
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public async Task RotateRefreshTokenAsync_ContinuousGenerationsPersistBoundedHashOnlyLineage()
    {
        const string GenerationZeroToken = "issue-1185-generation-zero";
        const string GenerationOneToken = "issue-1185-generation-one";
        const string GenerationTwoToken = "issue-1185-generation-two";
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(db);
        int userId = SeedUser(db, mfaEnabled: true);
        string sessionId = $"issue-1185-generations-{Guid.NewGuid():N}";
        SeedSession(db, userId, sessionId, GenerationZeroToken);

        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns(GenerationOneToken, GenerationTwoToken);
        jwt.GenerateAccessToken(Arg.Any<User>(), sessionId, Arg.Any<UserSessionAuthenticationContext>())
            .Returns(new IssuedAccessToken("access-token", DateTimeOffset.UtcNow.AddMinutes(15)));
        var service = new UserSessionCommandService(
            db,
            NullLogger<UserSessionCommandService>.Instance,
            jwt,
            Substitute.For<IUserSessionValidationCache>());
        await db.Insertable(new UserRefreshTokenTombstone
        {
            TokenHash = HashToken("expired-generation"),
            RefreshFamilyId = (await db.Queryable<UserSession>().SingleAsync(row => row.SessionId == sessionId)).RefreshFamilyId,
            SessionId = sessionId,
            Generation = 99,
            UsedAtUtc = DateTime.UtcNow.AddDays(-31),
            ExpiresAtUtc = DateTime.UtcNow.AddDays(-1)
        }).ExecuteCommandAsync();

        RefreshTokenRotationResult first = await service.RotateRefreshTokenAsync(GenerationZeroToken, sessionId);
        RefreshTokenRotationResult second = await service.RotateRefreshTokenAsync(GenerationOneToken, sessionId);

        Assert.Equal(RefreshTokenRotationOutcome.Success, first.Outcome);
        Assert.Equal(RefreshTokenRotationOutcome.Success, second.Outcome);
        UserSession current = await db.Queryable<UserSession>().SingleAsync(row => row.SessionId == sessionId);
        Assert.Equal(2, current.RefreshGeneration);
        Assert.Equal(HashToken(GenerationTwoToken), current.RefreshTokenHash);
        List<UserRefreshTokenTombstone> tombstones = await db.Queryable<UserRefreshTokenTombstone>()
            .OrderBy(row => row.Generation)
            .ToListAsync();
        Assert.Equal([0L, 1L], tombstones.Select(row => row.Generation));
        Assert.Equal([HashToken(GenerationZeroToken), HashToken(GenerationOneToken)], tombstones.Select(row => row.TokenHash));
        Assert.DoesNotContain(tombstones, row => row.TokenHash.Contains("issue-1185", StringComparison.Ordinal));
        Assert.All(tombstones, row => Assert.InRange(
            row.ExpiresAtUtc - row.UsedAtUtc,
            TimeSpan.FromDays(29),
            TimeSpan.FromDays(31)));
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "auth-session-fail-closed")]
    public async Task RotateRefreshTokenAsync_WrongSessionIdCompromisesTokenFamilyOnly()
    {
        const string TargetToken = "issue-1185-mismatch-target";
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(db);
        int userId = SeedUser(db, mfaEnabled: true);
        string targetSessionId = $"issue-1185-target-{Guid.NewGuid():N}";
        string retainedSessionId = $"issue-1185-retained-{Guid.NewGuid():N}";
        SeedSession(db, userId, targetSessionId, TargetToken);
        SeedSession(db, userId, retainedSessionId, "issue-1185-retained-token");
        UserSessionCommandService service = CreateSessionService(
            db,
            "must-not-be-issued",
            Substitute.For<IUserSessionValidationCache>());

        RefreshTokenRotationResult result = await service.RotateRefreshTokenAsync(
            TargetToken,
            retainedSessionId);

        Assert.Equal(RefreshTokenRotationOutcome.SessionMismatchCompromised, result.Outcome);
        Assert.NotNull((await db.Queryable<UserSession>().SingleAsync(row => row.SessionId == targetSessionId)).RevokedAt);
        Assert.Null((await db.Queryable<UserSession>().SingleAsync(row => row.SessionId == retainedSessionId)).RevokedAt);
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task RefreshTokenAsync_ConcurrentTabsAllowOneRotationWithoutRevokingSessionFamily()
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
        UserSessionCommandService firstService = CreateSessionService(firstDb, "first-rotated-token", validationCache);
        UserSessionCommandService secondService = CreateSessionService(secondDb, "second-rotated-token", validationCache);

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
        Assert.Null(stored.RevokedAt);
        Assert.Null(stored.RevokeReason);

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
        Assert.Null(afterThrash.RevokedAt);
        Assert.Null(afterThrash.RevokeReason);

        DateTime staleLastSeenAt = DateTime.UtcNow.Subtract(TimeSpan.FromMinutes(1));
        await setupDb.Updateable<UserSession>()
            .SetColumns(session => session.LastSeenAt == staleLastSeenAt)
            .Where(session => session.SessionId == sessionId)
            .ExecuteCommandAsync();
        (bool staleSuccess, TokenResponseDto? staleData) = await firstService.RefreshTokenAsync(RawRefreshToken, sessionId);
        Assert.False(staleSuccess);
        Assert.Null(staleData);

        UserSession revokedAfterGrace = await setupDb.Queryable<UserSession>()
            .SingleAsync(item => item.SessionId == sessionId);
        Assert.NotNull(revokedAfterGrace.RevokedAt);
        Assert.Equal("refresh_token_reuse_family_revoke", revokedAfterGrace.RevokeReason);
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
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task VerifyMfaOrRecoveryCodeAsync_ConcurrentConsumptionPersistsExactlyOnce()
    {
        await VerifyConcurrentRecoveryCodeConsumptionAsync(participantCount: 2);
        await VerifyConcurrentRecoveryCodeConsumptionAsync(participantCount: 6);
    }

    private async Task VerifyConcurrentRecoveryCodeConsumptionAsync(int participantCount)
    {
        const string ConsumedCode = "2330-AAAA-BBBB-CCCC";
        const string RetainedCode = "2330-DDDD-EEEE-FFFF";
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        int userId = SeedUser(setupDb, mfaEnabled: true);
        var totp = new TotpService(
            new EphemeralDataProtectionProvider(),
            TimeProvider.System,
            new TotpService.RecoveryCodeHashPolicy(1024, 1, 1));
        string oldHashes = totp.HashRecoveryCodes([ConsumedCode, RetainedCode]);
        RecoveryCodeConsumeResult expectedConsumption = totp.ConsumeRecoveryCode(oldHashes, ConsumedCode);
        Assert.True(expectedConsumption.Success);
        setupDb.Insertable(new UserMfaProfile
        {
            UserId = userId,
            MfaSecretEncrypted = totp.ProtectSecret(totp.GenerateSecret()),
            MfaRecoveryCodesHash = oldHashes,
            MfaRecoveryCodesHashVersion = TotpService.CurrentRecoveryCodeHashVersion,
            UpdatedAtUtc = DateTime.UtcNow
        }).ExecuteCommand();

        var databases = Enumerable.Range(0, participantCount)
            .Select(_ => PostgresSqlSugarTestClient.Create(connectionString))
            .ToArray();
        UserService[] verificationServices = databases
            .Select(db => CreateService(db, "unused", Substitute.For<IUserSessionValidationCache>(), totp))
            .ToArray();
        UserLoginWorkflowService[] loginServices = databases
            .Select(CreateLoginWorkflowService)
            .ToArray();

        try
        {
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

            using var barrier = new Barrier(participantCount);
            Task<RecoveryCodeLoginAttempt>[] attempts = Enumerable.Range(0, participantCount)
                .Select(index => StartTogetherAsync(
                    barrier,
                    () => VerifyRecoveryCodeAndCompleteLoginAsync(
                        verificationServices[index],
                        loginServices[index],
                        userId,
                        ConsumedCode)))
                .ToArray();
            await Task.Delay(TimeSpan.FromMilliseconds(300));
            Assert.All(attempts, static attempt => Assert.False(attempt.IsCompleted));

            await transaction.CommitAsync();
            RecoveryCodeLoginAttempt[] results = await Task.WhenAll(attempts)
                .WaitAsync(TimeSpan.FromSeconds(30));

            RecoveryCodeLoginAttempt success = Assert.Single(results, static result => result.Verified);
            Assert.True(success.LoginSucceeded);
            Assert.NotNull(success.SessionTokens);
            Assert.False(string.IsNullOrWhiteSpace(success.SessionTokens.Value.AccessToken));
            Assert.False(string.IsNullOrWhiteSpace(success.SessionTokens.Value.RefreshToken));
            Assert.All(results.Where(static result => !result.Verified), static failure =>
            {
                Assert.False(failure.LoginSucceeded);
                Assert.Null(failure.SessionTokens);
            });
            Assert.Equal(1, await setupDb.Queryable<UserSession>()
                .Where(session => session.UserId == userId)
                .CountAsync());

            UserMfaProfile stored = await setupDb.Queryable<UserMfaProfile>()
                .SingleAsync(item => item.UserId == userId);
            Assert.Equal(expectedConsumption.UpdatedHashes, stored.MfaRecoveryCodesHash);
            Assert.Equal(TotpService.CurrentRecoveryCodeHashVersion, stored.MfaRecoveryCodesHashVersion);
            Assert.False(totp.ConsumeRecoveryCode(stored.MfaRecoveryCodesHash, ConsumedCode).Success);
            Assert.True(totp.ConsumeRecoveryCode(stored.MfaRecoveryCodesHash, RetainedCode).Success);

            bool retainedCodeSucceeded = await verificationServices[0].VerifyMfaOrRecoveryCodeAsync(
                userId,
                code: null,
                recoveryCode: RetainedCode,
                persistRecoveryConsumption: true);
            Assert.True(retainedCodeSucceeded);
            UserMfaProfile fullyConsumed = await setupDb.Queryable<UserMfaProfile>()
                .SingleAsync(item => item.UserId == userId);
            Assert.Equal(string.Empty, fullyConsumed.MfaRecoveryCodesHash);
        }
        finally
        {
            foreach (SqlSugarClient database in databases)
            {
                database.Dispose();
            }
        }
    }

    private static async Task<RecoveryCodeLoginAttempt> VerifyRecoveryCodeAndCompleteLoginAsync(
        UserService verificationService,
        UserLoginWorkflowService loginService,
        int userId,
        string recoveryCode)
    {
        bool verified = await verificationService.VerifyMfaOrRecoveryCodeAsync(
            userId,
            code: null,
            recoveryCode,
            persistRecoveryConsumption: true);
        if (!verified)
        {
            return new RecoveryCodeLoginAttempt(false, false, null);
        }

        var login = await loginService.CompleteLoginAsync(
            userId,
            "203.0.113.30",
            "issue-2330-device",
            "issue-2330-agent",
            mfaVerified: true,
            rememberMe: false,
            authenticationContext: new UserSessionAuthenticationContext(
                UserSessionAuthenticationMethods.RecoveryKey,
                UserSessionAuthenticationStrengths.Recovery,
                DateTime.UtcNow,
                DurationPolicy: UserSessionDurationPolicies.BrowserSession));
        return new RecoveryCodeLoginAttempt(true, login.Success, login.Data);
    }

    private static UserLoginWorkflowService CreateLoginWorkflowService(SqlSugarClient db)
    {
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns(_ => $"issue-2330-refresh-{Guid.NewGuid():N}");
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string?>(), Arg.Any<UserSessionAuthenticationContext>())
            .Returns(_ => new IssuedAccessToken(
                $"issue-2330-access-{Guid.NewGuid():N}",
                DateTimeOffset.UtcNow.AddMinutes(15)));
        return new UserLoginWorkflowService(
            db,
            NullLogger<UserLoginWorkflowService>.Instance,
            jwt,
            Substitute.For<IUserSessionValidationCache>(),
            Substitute.For<IAuthRiskService>(),
            new UserSessionMetadataProtector(
                new SecurityRiskPseudonymizer(
                    1,
                    Enumerable.Range(1, 32).Select(static value => (byte)value).ToArray())),
            new ConfigurationBuilder().Build());
    }

    private sealed record RecoveryCodeLoginAttempt(
        bool Verified,
        bool LoginSucceeded,
        SessionTokenResponseDto? SessionTokens);

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
            typeof(UserRefreshTokenTombstone),
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
            RefreshFamilyId = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),
            RefreshGeneration = 0,
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
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string?>(), Arg.Any<UserSessionAuthenticationContext>())
            .Returns(new IssuedAccessToken("access-token", DateTimeOffset.UtcNow.AddMinutes(15)));
        return new UserService(
            _db: db,
            _logger: NullLogger<UserService>.Instance,
            _cacheCounters: Substitute.For<ICacheCounterStore>(),
            _totpService: totp ?? Substitute.For<ITotpService>());
    }

    private static UserSessionCommandService CreateSessionService(
        SqlSugarClient db,
        string nextRefreshToken,
        IUserSessionValidationCache validationCache)
    {
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns(nextRefreshToken);
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string?>(), Arg.Any<bool>())
            .Returns(new IssuedAccessToken("access-token", DateTimeOffset.UtcNow.AddMinutes(15)));
        return new UserSessionCommandService(
            db,
            NullLogger<UserSessionCommandService>.Instance,
            jwt,
            validationCache);
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
