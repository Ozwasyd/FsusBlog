using System.Globalization;
using System.Reflection;

using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class RecoveryKeyServiceBehaviorTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly SemaphoreSlim s_databaseResetLock = new(1, 1);
    private static string? s_sharedConnectionString;

    [Fact]
    public async Task VerifyAsync_WithOnlyRecoveryKey_CreatesPendingSessionWithoutPrematurePasskeyRevocation()
    {
        using SqlSugarClient db = await CreateDbAsync();
        int userId = SeedUser(db);
        SeedSession(db, userId, "session-current");
        SeedPasskey(db, userId, "old-credential", DateTime.UtcNow.AddMinutes(-5));
        var validationCache = Substitute.For<IUserSessionValidationCache>();
        IReadOnlyList<UserSessionValidationCacheState>? publishedSessions = null;
        validationCache.PublishManyAsync(
                Arg.Do<IReadOnlyList<UserSessionValidationCacheState>>(states => publishedSessions = states),
                true,
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        RecoveryKeyService service = CreateService(db, validationCache);

        Result<RecoveryKeyCreateResponseCoreModel> created = await service.CreateAsync(userId, CancellationToken.None);
        Assert.True(created.IsSuccess);
        Assert.StartsWith("frk_", created.Value.RecoveryKey, StringComparison.Ordinal);
        string recoveryKeyBody = created.Value.RecoveryKey["frk_".Length..];
        int separator = recoveryKeyBody.IndexOf('_');
        Assert.Equal(32, separator);
        Assert.Matches("^[0-9a-f]{32}$", recoveryKeyBody[..separator]);
        Assert.True(recoveryKeyBody[(separator + 1)..].Length >= 32);

        RecoveryKeyCredential storedKey = await db.Queryable<RecoveryKeyCredential>().SingleAsync(k => k.AccountId == userId);
        Assert.False(string.IsNullOrWhiteSpace(storedKey.LookupIdHash));
        Assert.NotEqual(created.Value.RecoveryKey, storedKey.KeyHash);
        Assert.DoesNotContain(created.Value.RecoveryKey, storedKey.KeyHash, StringComparison.Ordinal);

        Result<RecoveryKeyVerifyResponseCoreModel> verified = await service.VerifyAsync(
            new RecoveryKeyVerifyRequestCoreModel(
                created.Value.RecoveryKey,
                RevokeSessions: true,
                RevokePasskeys: true),
            "203.0.113.10",
            "unit-test",
            CancellationToken.None);

        Assert.True(verified.IsSuccess);
        Assert.False(string.IsNullOrWhiteSpace(verified.Value.RecoverySessionToken));

        RecoveryKeyCredential consumedKey = await db.Queryable<RecoveryKeyCredential>().SingleAsync(k => k.AccountId == userId);
        Assert.NotNull(consumedKey.UsedAt);
        User user = await db.Queryable<User>().SingleAsync(u => u.Id == userId);
        Assert.False(user.RecoveryEnabled);
        UserSession session = await db.Queryable<UserSession>().SingleAsync(s => s.SessionId == "session-current");
        Assert.NotNull(session.RevokedAt);
        Assert.Equal("recovery_key_verified", session.RevokeReason);
        UserSessionValidationCacheState publishedSession = Assert.Single(publishedSessions!);
        Assert.Equal("session-current", publishedSession.SessionId);
        Assert.True(publishedSession.RevokedAtUtc.HasValue);
        Assert.False(string.IsNullOrWhiteSpace(publishedSession.RowVersion));

        Result<RecoveryKeySession> recoverySession = await service.GetRecoverySessionAsync(
            verified.Value.RecoverySessionToken,
            CancellationToken.None);
        Assert.True(recoverySession.IsSuccess);
        Assert.NotNull(recoverySession.Value);
        Assert.True(recoverySession.Value.RevokePasskeys);
        string[] credentialIdsBeforeCompletion = await db.Queryable<PasskeyCredential>()
            .Where(c => c.AccountId == userId)
            .Select(c => c.CredentialId)
            .ToArrayAsync();
        Assert.Equal(["old-credential"], credentialIdsBeforeCompletion);
    }

    [Fact]
    public async Task VerifyAsync_RevocationPublicationFailureRollsBackDatabaseAndCleansPossiblePartialFence()
    {
        using SqlSugarClient db = await CreateDbAsync();
        int userId = SeedUser(db);
        SeedSession(db, userId, "session-publication-failure");
        var validationCache = Substitute.For<IUserSessionValidationCache>();
        validationCache.PublishManyAsync(
                Arg.Any<IReadOnlyList<UserSessionValidationCacheState>>(),
                true,
                Arg.Any<CancellationToken>())
            .Returns(_ => Task.FromException(new InvalidOperationException("forced recovery publication failure")));
        validationCache.InvalidateManyAsync(
                Arg.Any<IReadOnlyList<UserSessionValidationCacheState>>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        RecoveryKeyService service = CreateService(db, validationCache);
        Result<RecoveryKeyCreateResponseCoreModel> created = await service.CreateAsync(userId, CancellationToken.None);
        Assert.True(created.IsSuccess);

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            service.VerifyAsync(
                new RecoveryKeyVerifyRequestCoreModel(created.Value.RecoveryKey, true, false),
                "203.0.113.21",
                "unit-test",
                CancellationToken.None));

        Assert.Equal("forced recovery publication failure", error.Message);
        RecoveryKeyCredential key = await db.Queryable<RecoveryKeyCredential>()
            .SingleAsync(item => item.AccountId == userId);
        Assert.Null(key.UsedAt);
        UserSession session = await db.Queryable<UserSession>()
            .SingleAsync(item => item.SessionId == "session-publication-failure");
        Assert.Null(session.RevokedAt);
        await validationCache.Received(1).InvalidateManyAsync(
            Arg.Is<IReadOnlyList<UserSessionValidationCacheState>>(states =>
                states.Count == 1 && states[0].SessionId == "session-publication-failure"),
            CancellationToken.None);
    }

    [Fact]
    public async Task VerifyAsync_InvalidOrLegacyKey_ReturnsGenericFailureAndRateLimits()
    {
        using SqlSugarClient db = await CreateDbAsync();
        RecoveryKeyService service = CreateService(db);
        var legacyFormat = new RecoveryKeyVerifyRequestCoreModel(
            "frk_legacy_without_lookup",
            RevokeSessions: false,
            RevokePasskeys: false);

        Result<RecoveryKeyVerifyResponseCoreModel> legacyResult = await service.VerifyAsync(
            legacyFormat,
            "203.0.113.11",
            "unit-test",
            CancellationToken.None);

        Assert.False(legacyResult.IsSuccess);
        Assert.Equal(ErrorCode.Unauthorized, legacyResult.Error.Code);
        Assert.Equal("RECOVERY_KEY_INVALID", legacyResult.Error.Message);

        var wrongKey = new RecoveryKeyVerifyRequestCoreModel(
            "frk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_wrongSecret",
            RevokeSessions: false,
            RevokePasskeys: false);
        Result<RecoveryKeyVerifyResponseCoreModel> result = default;
        for (int i = 0; i < 8; i++)
        {
            result = await service.VerifyAsync(
                wrongKey,
                "203.0.113.12",
                "unit-test",
                CancellationToken.None);
        }

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.Forbidden, result.Error.Code);
        Assert.Equal("RECOVERY_KEY_RATE_LIMITED", result.Error.Message);

        Result<RecoveryKeyVerifyResponseCoreModel> locked = await service.VerifyAsync(
            wrongKey,
            "203.0.113.12",
            "unit-test",
            CancellationToken.None);
        Assert.False(locked.IsSuccess);
        Assert.Equal(ErrorCode.Forbidden, locked.Error.Code);
        Assert.Equal("RECOVERY_KEY_RATE_LIMITED", locked.Error.Message);
    }

    [Fact]
    public async Task VerifyAsync_OverlongRecoveryKeyRejectsBeforeAttemptCounterOrCredentialLookup()
    {
        using SqlSugarClient db = await CreateDbAsync();
        RecoveryKeyService service = CreateService(db);
        string overlong = "frk_" + new string('a', 4096);

        Result<RecoveryKeyVerifyResponseCoreModel> result = await service.VerifyAsync(
            new RecoveryKeyVerifyRequestCoreModel(
                overlong,
                RevokeSessions: false,
                RevokePasskeys: false),
            "203.0.113.13",
            "unit-test",
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
        Assert.Equal("RECOVERY_KEY_INVALID", result.Error.Message);
        Assert.Equal(0, db.Queryable<RecoveryKeyCredential>().Count());
    }

    [Fact]
    public void RecoveryKeyService_BoundsInputAndDerivesAttemptIdentityOnlyFromLookup()
    {
        FieldInfo maxCharsField = typeof(RecoveryKeyService).GetField(
            "MaxRecoveryKeyChars",
            BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException("Recovery key input limit was not found.");
        Assert.Equal(256, Assert.IsType<int>(maxCharsField.GetRawConstantValue()));

        MethodInfo normalize = typeof(RecoveryKeyService).GetMethod(
            "NormalizeRecoveryKey",
            BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException("Recovery key normalizer was not found.");
        string overlong = "  frk_" + new string('a', 4096) + "  ";
        string normalized = Assert.IsType<string>(normalize.Invoke(null, [overlong]));
        Assert.Equal(overlong.Trim(), normalized);
        Assert.True(normalized.Length > 256);

        MethodInfo buildAttemptIdentity = typeof(RecoveryKeyService).GetMethod(
            "BuildAttemptIdentity",
            BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException("Recovery attempt identity builder was not found.");
        ParameterInfo parameter = Assert.Single(buildAttemptIdentity.GetParameters());
        Assert.Equal(typeof(string), parameter.ParameterType);
        string first = Assert.IsType<string>(buildAttemptIdentity.Invoke(null, ["lookup-a"]));
        string repeated = Assert.IsType<string>(buildAttemptIdentity.Invoke(null, ["lookup-a"]));
        string second = Assert.IsType<string>(buildAttemptIdentity.Invoke(null, ["lookup-b"]));
        Assert.Equal(first, repeated);
        Assert.NotEqual(first, second);
        Assert.Matches("^[0-9A-F]{32}$", first);
    }

    [Fact]
    public async Task VerifyAsync_LocksCandidateRowBeforeConsumingValidSecret()
    {
        using SqlSugarClient db = await CreateDbAsync();
        int accountId = SeedUser(db);
        RecoveryKeyService service = CreateService(db);
        Result<RecoveryKeyCreateResponseCoreModel> created = await service.CreateAsync(accountId, CancellationToken.None);
        Assert.True(created.IsSuccess);
        var executedSql = new List<string>();
        db.Aop.OnLogExecuting = (sql, _) => executedSql.Add(sql);

        Result<RecoveryKeyVerifyResponseCoreModel> verified = await service.VerifyAsync(
            new RecoveryKeyVerifyRequestCoreModel(created.Value.RecoveryKey, false, false),
            "203.0.113.20",
            "unit-test",
            CancellationToken.None);

        string lockedLookup = Assert.Single(executedSql, static sql =>
            sql.Contains("account_recovery_key", StringComparison.OrdinalIgnoreCase)
            && sql.Contains("FOR UPDATE", StringComparison.OrdinalIgnoreCase));
        Assert.Contains("lookup_id_hash", lockedLookup, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("key_hash =", lockedLookup, StringComparison.OrdinalIgnoreCase);
        Assert.True(verified.IsSuccess);
        RecoveryKeyCredential consumed = await db.Queryable<RecoveryKeyCredential>()
            .SingleAsync(item => item.AccountId == accountId);
        Assert.NotNull(consumed.UsedAt);
    }

    private async Task<SqlSugarClient> CreateDbAsync()
    {
        await s_databaseResetLock.WaitAsync();
        try
        {
            string connectionString;
            if (s_sharedConnectionString is null)
            {
                connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
                using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
                CreateTables(setupDb);
                s_sharedConnectionString = connectionString;
            }
            else
            {
                connectionString = s_sharedConnectionString;
            }

            await fixture.ExecuteAsync(
                connectionString,
                "TRUNCATE TABLE account_recovery_key, passkey_credential, sys_user_session, sys_user RESTART IDENTITY CASCADE;");
            return PostgresSqlSugarTestClient.Create(connectionString);
        }
        finally
        {
            s_databaseResetLock.Release();
        }
    }

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(UserSession),
            typeof(PasskeyCredential),
            typeof(RecoveryKeyCredential));

    private static int SeedUser(SqlSugarClient db)
        => db.Insertable(new User
        {
            PublicHandle = $"account-{Guid.NewGuid():N}"[..20],
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            Status = 0,
            RecoveryEnabled = false,
            PasskeyEnabled = true,
            PrivacyInitializedAt = DateTime.UtcNow
        }).ExecuteReturnIdentity();

    private static void SeedSession(SqlSugarClient db, int userId, string sessionId)
    {
        db.Insertable(new UserSession
        {
            SessionId = sessionId,
            UserId = userId,
            RefreshTokenHash = $"refresh-{sessionId}",
            CreatedAt = DateTime.UtcNow.AddMinutes(-10),
            IdleExpiresAt = DateTime.UtcNow.AddHours(1),
            AbsoluteExpiresAt = DateTime.UtcNow.AddDays(1)
        }).ExecuteCommand();
    }

    private static void SeedPasskey(SqlSugarClient db, int userId, string credentialId, DateTime createdAt)
    {
        db.Insertable(new PasskeyCredential
        {
            AccountId = userId,
            CredentialId = credentialId,
            PublicKey = $"public-key-{credentialId}",
            AaGuid = Guid.Empty.ToString(),
            CreatedAt = createdAt
        }).ExecuteCommand();
    }

    private static RecoveryKeyService CreateService(
        SqlSugarClient db,
        IUserSessionValidationCache? validationCache = null)
        => new(
            db,
            CreateCache(),
            new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Security:RecoveryKeyPepper"] = "unit-test-recovery-key-pepper-with-enough-entropy"
                })
                .Build(),
            Substitute.For<IPasskeyService>(),
            NullLogger<RecoveryKeyService>.Instance,
            validationCache ?? Substitute.For<IUserSessionValidationCache>());

    private static IUnifiedCache CreateCache()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var strings = new Dictionary<string, string>(StringComparer.Ordinal);

        string Key(CachePolicyId policyId, string identity)
            => $"{policyId}:{identity}";

        cache.GetStringAsync(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                string key = Key(call.ArgAt<CachePolicyId>(0), call.ArgAt<string>(1));
                return Task.FromResult(strings.TryGetValue(key, out string? value) ? value : null);
            });

        cache.SetStringAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                string key = Key(call.ArgAt<CachePolicyId>(0), call.ArgAt<string>(1));
                strings[key] = call.ArgAt<string>(2);
                return Task.CompletedTask;
            });

        cache.IncrementWithExpiryAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<TimeSpan>(),
                Arg.Any<long>(),
                Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                string key = Key(call.ArgAt<CachePolicyId>(0), call.ArgAt<string>(1));
                long current = strings.TryGetValue(key, out string? value) && long.TryParse(value, out long parsed)
                    ? parsed
                    : 0;
                current += call.ArgAt<long>(3);
                strings[key] = current.ToString(CultureInfo.InvariantCulture);
                return Task.FromResult(current);
            });

        cache.ConsumeOnceAsync(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                string key = Key(call.ArgAt<CachePolicyId>(0), call.ArgAt<string>(1));
                return Task.FromResult(strings.Remove(key));
            });

        cache.RemoveAsync(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                string key = Key(call.ArgAt<CachePolicyId>(0), call.ArgAt<string>(1));
                strings.Remove(key);
                return Task.CompletedTask;
            });

        return cache;
    }
}
