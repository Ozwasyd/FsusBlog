using System.Globalization;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollection))]
public sealed class RecoveryKeyServiceBehaviorTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task VerifyAsync_WithOnlyRecoveryKey_SucceedsAndRevokesRequestedCredentials()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        int userId = SeedUser(db);
        SeedSession(db, userId, "session-current");
        SeedPasskey(db, userId, "old-credential", DateTime.UtcNow.AddMinutes(-5));
        RecoveryKeyService service = CreateService(db);

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

        Result<RecoveryKeySession> recoverySession = await service.GetRecoverySessionAsync(
            verified.Value.RecoverySessionToken,
            CancellationToken.None);
        Assert.True(recoverySession.IsSuccess);
        Assert.NotNull(recoverySession.Value);
        SeedPasskey(db, userId, "new-credential", recoverySession.Value.IssuedAtUtc.AddSeconds(1));

        await service.ApplyPostPasskeyBindAsync(recoverySession.Value, CancellationToken.None);

        string[] remainingCredentialIds = await db.Queryable<PasskeyCredential>()
            .Where(c => c.AccountId == userId)
            .Select(c => c.CredentialId)
            .ToArrayAsync();
        Assert.Equal(["new-credential"], remainingCredentialIds);
        user = await db.Queryable<User>().SingleAsync(u => u.Id == userId);
        Assert.True(user.PasskeyEnabled);
    }

    [Fact]
    public async Task VerifyAsync_InvalidOrLegacyKey_ReturnsGenericFailureAndRateLimits()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
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

    private Task<SqlSugarClient> CreateDbAsync()
        => PostgresSqlSugarTestClient.CreateAsync(fixture);

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

    private static RecoveryKeyService CreateService(SqlSugarClient db)
        => new(
            db,
            CreateCache(),
            new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Security:RecoveryKeyPepper"] = "unit-test-recovery-key-pepper-with-enough-entropy"
                })
                .Build());

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
