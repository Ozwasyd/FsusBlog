using System.Security.Claims;
using System.Data;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "SecurityStateMachine")]
public sealed class UserSessionValidationServiceTests
{
    private static readonly DateTime s_authenticatedAtUtc = new(2026, 7, 20, 1, 2, 3, DateTimeKind.Utc);

    [Fact]
    public void CachePayload_RoundTripsVersionedSessionSnapshot()
    {
        var state = new UserSessionValidationCacheState(
            "session-42",
            42,
            new DateTime(638900000000000000, DateTimeKind.Utc),
            new DateTime(638900010000000000, DateTimeKind.Utc),
            new DateTime(638900020000000000, DateTimeKind.Utc),
            "2147483651",
            1,
            null,
            AnonymousIdentityRuntime.AnonymousAccountKind,
            UserSessionAuthenticationMethods.Passkey,
            UserSessionAuthenticationStrengths.WebAuthnUv,
            s_authenticatedAtUtc,
            UserSessionMode.Restricted,
            "2147483652");

        string payload = UserSessionValidationCache.Encode(state);
        UserSessionValidationCacheState? decoded = UserSessionValidationCache.Decode(payload, state.SessionId);

        Assert.Equal(state, decoded);
        Assert.StartsWith("v3|2147483651|42|", payload, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("")]
    [InlineData("v2|7|42|-1|638900010000000000|638900020000000000|0|-1|anonymous_account")]
    [InlineData("v1|7|0|-1|638900010000000000|638900020000000000|0|-1|anonymous_account")]
    [InlineData("v1|7|42|-1|bad|638900020000000000|0|-1|anonymous_account")]
    public void CachePayload_RejectsMalformedOrUnsupportedSnapshots(string payload)
    {
        Assert.Null(UserSessionValidationCache.Decode(payload, "session-42"));
    }

    [Fact]
    public async Task CachedActiveSession_AllowsRequestWithoutDatabaseRead()
    {
        const int AccountId = 42;
        const string SessionId = "active-session";
        var cache = new StubSessionValidationCache(CreateState(SessionId, AccountId));
        var db = Substitute.For<ISqlSugarClient>();
        var service = new UserSessionValidationService(db, cache);

        UserSessionValidationResult result = await service.ValidateAsync(
            CreatePrincipal(AccountId, SessionId),
            CancellationToken.None);

        Assert.True(result.IsValid, result.Reason);
        Assert.Equal(1, cache.ReadCount);
        _ = db.DidNotReceive().Ado;
    }

    [Fact]
    public async Task CachedRevokedSession_RejectsRequestWithoutDatabaseRead()
    {
        const int AccountId = 42;
        const string SessionId = "revoked-session";
        UserSessionValidationCacheState revoked = CreateState(SessionId, AccountId) with
        {
            RevokedAtUtc = DateTime.UtcNow.AddSeconds(-1)
        };
        var cache = new StubSessionValidationCache(revoked);
        var db = Substitute.For<ISqlSugarClient>();
        var service = new UserSessionValidationService(db, cache);

        UserSessionValidationResult result = await service.ValidateAsync(
            CreatePrincipal(AccountId, SessionId),
            CancellationToken.None);

        Assert.False(result.IsValid);
        Assert.Equal("user_session_revoked", result.Reason);
        _ = db.DidNotReceive().Ado;
    }

    [Fact]
    public async Task CachedUnknownSessionMode_FailsClosedWithoutDatabaseRead()
    {
        UserSessionValidationCacheState invalid = CreateState("invalid-mode", 42) with
        {
            SessionMode = (UserSessionMode)99
        };
        var db = Substitute.For<ISqlSugarClient>();
        var service = new UserSessionValidationService(db, new StubSessionValidationCache(invalid));

        UserSessionValidationResult result = await service.ValidateAsync(
            CreatePrincipal(42, invalid.SessionId),
            CancellationToken.None);

        Assert.False(result.IsValid);
        Assert.Equal("user_session_mode_invalid", result.Reason);
        _ = db.DidNotReceive().Ado;
    }

    [Fact]
    public async Task CacheError_FallsBackToPostgresAndRepairsCache()
    {
        const int AccountId = 42;
        const string SessionId = "redis-error-fallback";
        var cache = Substitute.For<IUserSessionValidationCache>();
        cache.ReadAsync(SessionId, Arg.Any<CancellationToken>())
            .Returns<Task<UserSessionValidationCacheState?>>(_ => throw new RedisConnectionException(ConnectionFailureType.UnableToConnect, "offline"));
        cache.PublishAsync(Arg.Any<UserSessionValidationCacheState>(), true, Arg.Any<CancellationToken>())
            .Returns(true);
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(_ => Task.FromResult((IDataReader)CreateDatabaseStateReader(SessionId, AccountId, UserSessionMode.Normal, 0)));
        var service = new UserSessionValidationService(db, cache);

        UserSessionValidationResult result = await service.ValidateAsync(CreatePrincipal(AccountId, SessionId), CancellationToken.None);

        Assert.True(result.IsValid, result.Reason);
        Assert.Equal(UserSessionMode.Normal, result.SessionMode);
        await cache.Received(1).PublishAsync(
            Arg.Is<UserSessionValidationCacheState>(state => state.RowVersion == "19" && state.AccountRowVersion == "23"),
            true,
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task CacheError_PostgresFailureFailsClosed()
    {
        var cache = Substitute.For<IUserSessionValidationCache>();
        cache.ReadAsync("db-failure", Arg.Any<CancellationToken>())
            .Returns<Task<UserSessionValidationCacheState?>>(_ => throw new InvalidDataException("corrupt"));
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns<Task<IDataReader>>(_ => throw new InvalidOperationException("postgres offline"));
        var service = new UserSessionValidationService(db, cache);

        UserSessionValidationResult result = await service.ValidateAsync(CreatePrincipal(42, "db-failure"), CancellationToken.None);

        Assert.False(result.IsValid);
        Assert.Equal("user_session_database_unavailable", result.Reason);
        await cache.DidNotReceive().PublishAsync(Arg.Any<UserSessionValidationCacheState>(), Arg.Any<bool>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task CacheRepairConflict_CannotOverrideAuthoritativeDatabaseRevocation()
    {
        const string SessionId = "repair-conflict-revoked";
        var cache = Substitute.For<IUserSessionValidationCache>();
        cache.ReadAsync(SessionId, Arg.Any<CancellationToken>())
            .Returns<Task<UserSessionValidationCacheState?>>(_ => throw new InvalidDataException("corrupt"));
        cache.PublishAsync(Arg.Any<UserSessionValidationCacheState>(), true, Arg.Any<CancellationToken>())
            .Returns(false);
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(_ => Task.FromResult((IDataReader)CreateDatabaseStateReader(
                SessionId,
                42,
                UserSessionMode.Revoked,
                0,
                DateTime.UtcNow.AddSeconds(-1))));
        var service = new UserSessionValidationService(db, cache);

        UserSessionValidationResult result = await service.ValidateAsync(
            CreatePrincipal(42, SessionId),
            CancellationToken.None);

        Assert.False(result.IsValid);
        Assert.Equal("user_session_revoked", result.Reason);
        await cache.Received(1).PublishAsync(
            Arg.Is<UserSessionValidationCacheState>(state =>
                state.SessionMode == UserSessionMode.Revoked && state.RevokedAtUtc.HasValue),
            true,
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task CacheRepairConflict_FailsClosedInsteadOfAllowingStaleActiveDatabaseRead()
    {
        const string SessionId = "repair-conflict-active";
        var cache = Substitute.For<IUserSessionValidationCache>();
        cache.ReadAsync(SessionId, Arg.Any<CancellationToken>()).Returns((UserSessionValidationCacheState?)null);
        cache.PublishAsync(Arg.Any<UserSessionValidationCacheState>(), false, Arg.Any<CancellationToken>()).Returns(false);
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(_ => Task.FromResult((IDataReader)CreateDatabaseStateReader(
                SessionId,
                42,
                UserSessionMode.Normal,
                0)));
        var service = new UserSessionValidationService(db, cache);

        UserSessionValidationResult result = await service.ValidateAsync(
            CreatePrincipal(42, SessionId),
            CancellationToken.None);

        Assert.False(result.IsValid);
        Assert.Equal("user_session_cache_conflict", result.Reason);
    }

    [Fact]
    public async Task CacheMiss_FallbackBudgetRejectionFailsClosedWithoutDatabaseRead()
    {
        var cache = new StubSessionValidationCache(null);
        var gate = Substitute.For<IUserSessionDbFallbackGate>();
        gate.TryEnterAsync(Arg.Any<CancellationToken>())
            .Returns(ValueTask.FromResult<IUserSessionDbFallbackLease?>(null));
        var db = Substitute.For<ISqlSugarClient>();
        var service = new UserSessionValidationService(db, cache, fallbackGate: gate);

        UserSessionValidationResult result = await service.ValidateAsync(
            CreatePrincipal(42, "budget-rejected"),
            CancellationToken.None);

        Assert.False(result.IsValid);
        Assert.Equal("user_session_fallback_budget_exhausted", result.Reason);
        _ = db.DidNotReceive().Ado;
    }

    [Theory]
    [InlineData(UserSessionMode.Restricted, "normal")]
    [InlineData(UserSessionMode.Normal, "restricted")]
    public async Task SessionModeMismatch_UsesTheStricterServerEffectiveMode(UserSessionMode databaseMode, string tokenMode)
    {
        UserSessionValidationCacheState state = CreateState("mode-mismatch", 42) with
        {
            SessionMode = databaseMode,
            AccountStatus = databaseMode == UserSessionMode.Restricted ? 1 : 0
        };
        var service = new UserSessionValidationService(Substitute.For<ISqlSugarClient>(), new StubSessionValidationCache(state));
        ClaimsPrincipal principal = CreatePrincipal(42, state.SessionId, tokenMode);

        UserSessionValidationResult result = await service.ValidateAsync(principal, CancellationToken.None);

        Assert.True(result.IsValid, result.Reason);
        Assert.Equal(UserSessionMode.Restricted, result.SessionMode);
        Assert.Equal("restricted", principal.FindFirst(UserSessionModes.ClaimType)?.Value);
    }

    [Fact]
    public async Task DbFallbackGate_RejectsExcessConcurrencyAndOpensCircuit()
    {
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            [$"{UserSessionDbFallbackGate.SectionName}:MaxConcurrent"] = "1",
            [$"{UserSessionDbFallbackGate.SectionName}:FailureThreshold"] = "1",
            [$"{UserSessionDbFallbackGate.SectionName}:BreakSeconds"] = "5"
        }).Build();
        var gate = new UserSessionDbFallbackGate(configuration);
        IUserSessionDbFallbackLease lease = Assert.IsAssignableFrom<IUserSessionDbFallbackLease>(
            await gate.TryEnterAsync(CancellationToken.None));
        Assert.Null(await gate.TryEnterAsync(CancellationToken.None));
        lease.RecordFailure();
        lease.Dispose();
        Assert.Null(await gate.TryEnterAsync(CancellationToken.None));
    }

    [Theory]
    [InlineData("auth_method", "recovery_key")]
    [InlineData("auth_strength", "recovery")]
    [InlineData("auth_time", "1")]
    [InlineData("auth_method", null)]
    [InlineData("auth_strength", null)]
    [InlineData("auth_time", null)]
    [InlineData("auth_time", "not-a-unix-time")]
    public async Task CachedSession_RejectsMissingMalformedOrMismatchedJwtAuthenticationContext(
        string claimType,
        string? replacement)
    {
        const int AccountId = 42;
        const string SessionId = "context-mismatch";
        var cache = new StubSessionValidationCache(CreateState(SessionId, AccountId));
        var db = Substitute.For<ISqlSugarClient>();
        var service = new UserSessionValidationService(db, cache);
        ClaimsPrincipal principal = CreatePrincipal(AccountId, SessionId);
        var identity = (ClaimsIdentity)principal.Identity!;
        identity.RemoveClaim(principal.FindFirst(claimType)!);
        if (replacement is not null)
        {
            identity.AddClaim(new Claim(claimType, replacement));
        }

        UserSessionValidationResult result = await service.ValidateAsync(principal, CancellationToken.None);

        Assert.False(result.IsValid);
        Assert.Equal("user_session_authentication_context_mismatch", result.Reason);
        _ = db.DidNotReceive().Ado;
    }

    [Theory]
    [InlineData("owner", "user_session_account_mismatch")]
    [InlineData("idle", "user_session_idle_expired")]
    [InlineData("absolute", "user_session_absolute_expired")]
    [InlineData("status", "account_deleted")]
    [InlineData("deleted-at", "account_deleted")]
    [InlineData("identity-kind", "user_session_identity_kind_mismatch")]
    public async Task CachedSession_RejectsOwnershipExpiryDeletionAndIdentityViolations(
        string mutation,
        string expectedReason)
    {
        const int AccountId = 42;
        const string SessionId = "invalid-session-state";
        UserSessionValidationCacheState state = CreateState(SessionId, AccountId);
        state = mutation switch
        {
            "owner" => state with { AccountId = AccountId + 1 },
            "idle" => state with { IdleExpiresAtUtc = DateTime.UtcNow.AddSeconds(-1) },
            "absolute" => state with { AbsoluteExpiresAtUtc = DateTime.UtcNow.AddSeconds(-1) },
            "status" => state with { AccountStatus = 2 },
            "deleted-at" => state with { AccountDeletedAtUtc = DateTime.UtcNow.AddSeconds(-1) },
            "identity-kind" => state with { IdentityKind = AnonymousIdentityRuntime.AdminPrincipalKind },
            _ => throw new ArgumentOutOfRangeException(nameof(mutation), mutation, null)
        };
        var cache = new StubSessionValidationCache(state);
        var db = Substitute.For<ISqlSugarClient>();
        var service = new UserSessionValidationService(db, cache);

        UserSessionValidationResult result = await service.ValidateAsync(
            CreatePrincipal(AccountId, SessionId),
            CancellationToken.None);

        Assert.False(result.IsValid);
        Assert.Equal(expectedReason, result.Reason);
        _ = db.DidNotReceive().Ado;
    }

    [Fact]
    public async Task DistributedCacheToggle_CanEnterDbOnlyModeWithoutRestartOrRedisWrites()
    {
        var values = new Dictionary<string, string?>
        {
            [UserSessionValidationCache.DistributedCacheEnabledKey] = "true"
        };
        IConfigurationRoot configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();
        var unified = Substitute.For<IUnifiedCache>();
        var database = Substitute.For<IDatabase>();
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        var cache = new UserSessionValidationCache(unified, unified, unified, redis, configuration);
        UserSessionValidationCacheState state = CreateState("db-only-session", 42);

        configuration[UserSessionValidationCache.DistributedCacheEnabledKey] = "false";

        Assert.Null(await cache.ReadAsync(state.SessionId));
        Assert.True(await cache.PublishAsync(state, allowOverwrite: true));

        unified.DidNotReceive().BuildKey(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<string?>());
        await database.DidNotReceive().StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
        await unified.DidNotReceive().TrySetVersionedStringAsync(
            Arg.Any<CachePolicyId>(),
            Arg.Any<string>(),
            Arg.Any<string>(),
            Arg.Any<string>(),
            Arg.Any<bool>(),
            Arg.Any<TimeSpan?>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task DistributedCacheRead_UsesDirectL2AndDecodesSnapshot()
    {
        UserSessionValidationCacheState state = CreateState("direct-l2-session", 42);
        string payload = UserSessionValidationCache.Encode(state);
        var unified = Substitute.For<IUnifiedCache>();
        unified.BuildKey(CachePolicyId.SecurityUserSessionValidation, state.SessionId, null)
            .Returns("runtime:sec:user-session-validation:direct-l2-session");
        var database = Substitute.For<IDatabase>();
        database.StringGetAsync(
                "runtime:sec:user-session-validation:direct-l2-session",
                Arg.Any<CommandFlags>())
            .Returns(Task.FromResult((RedisValue)payload));
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        var cache = new UserSessionValidationCache(
            unified,
            unified,
            unified,
            redis,
            new ConfigurationBuilder().Build());

        UserSessionValidationCacheState? actual = await cache.ReadAsync(state.SessionId);

        Assert.Equal(state, actual);
        await database.Received(1).StringGetAsync(
            "runtime:sec:user-session-validation:direct-l2-session",
            Arg.Any<CommandFlags>());
        await unified.DidNotReceive().GetStringAsync(
            Arg.Any<CachePolicyId>(),
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task RevocationPublish_UsesPostgresRowVersionAndOverwrite()
    {
        UserSessionValidationCacheState state = CreateState("revocation-publish", 42) with
        {
            RevokedAtUtc = DateTime.UtcNow,
            RowVersion = "19"
        };
        var unified = Substitute.For<IUnifiedCache>();
        unified.TrySetVersionedStringAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<bool>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(true));
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());
        var cache = new UserSessionValidationCache(
            unified,
            unified,
            unified,
            redis,
            new ConfigurationBuilder().Build());

        Assert.True(await cache.PublishAsync(state, allowOverwrite: true));

        await unified.Received(1).TrySetVersionedStringAsync(
            CachePolicyId.SecurityUserSessionValidation,
            state.SessionId,
            Arg.Is<string>(payload => payload.StartsWith("v3|19|42|", StringComparison.Ordinal)),
            "19",
            true,
            TimeSpan.FromMinutes(2),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task RevocationRollbackCleanup_RemovesDistinctDistributedSessionKeys()
    {
        UserSessionValidationCacheState first = CreateState("rollback-session-a", 42) with
        {
            RevokedAtUtc = DateTime.UtcNow,
            RowVersion = "20"
        };
        UserSessionValidationCacheState second = CreateState("rollback-session-b", 42) with
        {
            RevokedAtUtc = DateTime.UtcNow,
            RowVersion = "21"
        };
        var unified = Substitute.For<IUnifiedCache>();
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());
        var cache = new UserSessionValidationCache(
            unified,
            unified,
            unified,
            redis,
            new ConfigurationBuilder().Build());

        await cache.InvalidateManyAsync([first, first, second]);

        await unified.Received(1).RemoveManyAsync(
            Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
                keys.Count == 2 &&
                keys.Contains(new CacheKeyIdentity(CachePolicyId.SecurityUserSessionValidation, first.SessionId)) &&
                keys.Contains(new CacheKeyIdentity(CachePolicyId.SecurityUserSessionValidation, second.SessionId))),
            Arg.Any<CancellationToken>());
    }

    private static UserSessionValidationCacheState CreateState(string sessionId, int accountId)
        => new(
            sessionId,
            accountId,
            null,
            DateTime.UtcNow.AddHours(1),
            DateTime.UtcNow.AddDays(1),
            "7",
            0,
            null,
            AnonymousIdentityRuntime.AnonymousAccountKind,
            UserSessionAuthenticationMethods.Passkey,
            UserSessionAuthenticationStrengths.WebAuthnUv,
            s_authenticatedAtUtc,
            UserSessionMode.Normal,
            "8");

    private static ClaimsPrincipal CreatePrincipal(int accountId, string sessionId, string? sessionMode = null)
        => new(new ClaimsIdentity(
        [
            new Claim(ClaimTypes.NameIdentifier, accountId.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind),
            new Claim("sid", sessionId),
            new Claim("auth_method", UserSessionAuthenticationMethods.Passkey),
            new Claim("auth_strength", UserSessionAuthenticationStrengths.WebAuthnUv),
            new Claim("auth_time", new DateTimeOffset(s_authenticatedAtUtc).ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture)),
            .. sessionMode is null ? [] : new[] { new Claim(UserSessionModes.ClaimType, sessionMode) }
        ], "Bearer"));

    private static IDataReader CreateDatabaseStateReader(
        string sessionId,
        int accountId,
        UserSessionMode mode,
        int accountStatus,
        DateTime? revokedAtUtc = null)
    {
        var table = new DataTable();
        table.Columns.Add("sessionid", typeof(string));
        table.Columns.Add("userid", typeof(int));
        table.Columns.Add("revokedat", typeof(DateTime));
        table.Columns.Add("idleexpiresat", typeof(DateTime));
        table.Columns.Add("absoluteexpiresat", typeof(DateTime));
        table.Columns.Add("row_version", typeof(string));
        table.Columns.Add("status", typeof(int));
        table.Columns.Add("deleted_at", typeof(DateTime));
        table.Columns.Add("identity_kind", typeof(string));
        table.Columns.Add("session_mode", typeof(int));
        table.Columns.Add("account_row_version", typeof(string));
        table.Columns.Add("authentication_method", typeof(string));
        table.Columns.Add("authentication_strength", typeof(string));
        table.Columns.Add("authenticated_at_utc", typeof(DateTime));
        table.Rows.Add(
            sessionId,
            accountId,
            revokedAtUtc.HasValue ? revokedAtUtc.Value : DBNull.Value,
            DateTime.UtcNow.AddHours(1),
            DateTime.UtcNow.AddDays(1),
            "19",
            accountStatus,
            DBNull.Value,
            AnonymousIdentityRuntime.AnonymousAccountKind,
            (int)mode,
            "23",
            UserSessionAuthenticationMethods.Passkey,
            UserSessionAuthenticationStrengths.WebAuthnUv,
            s_authenticatedAtUtc);
        return table.CreateDataReader();
    }

    private sealed class StubSessionValidationCache(UserSessionValidationCacheState? state)
        : IUserSessionValidationCache
    {
        public int ReadCount
        {
            get; private set;
        }

        public Task<UserSessionValidationCacheState?> ReadAsync(
            string sessionId,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ReadCount++;
            return Task.FromResult(state);
        }

        public Task<bool> PublishAsync(
            UserSessionValidationCacheState value,
            bool allowOverwrite,
            CancellationToken cancellationToken = default)
            => Task.FromResult(true);

        public Task PublishManyAsync(
            IReadOnlyList<UserSessionValidationCacheState> states,
            bool allowOverwrite,
            CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task InvalidateManyAsync(
            IReadOnlyList<UserSessionValidationCacheState> states,
            CancellationToken cancellationToken = default)
            => Task.CompletedTask;
    }
}
