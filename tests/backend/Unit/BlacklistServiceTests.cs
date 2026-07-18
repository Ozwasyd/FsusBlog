using System.Linq.Expressions;
using System.Security.Cryptography;
using System.Text;

using NSubstitute;
using SqlSugar;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Security;
namespace FsusBlog.Server.Tests.Unit;

public class BlacklistServiceTests
{
    [Fact]
    public async Task BanUserAsync_PersistsBannedStatusAndCachesNormalizedReason()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var db = Substitute.For<ISqlSugarClient>();
        var userUpdate = Substitute.For<IUpdateable<User>>();
        userUpdate.SetColumns(Arg.Any<Expression<Func<User, bool>>>()).Returns(userUpdate);
        userUpdate.Where(Arg.Any<Expression<Func<User, bool>>>()).Returns(userUpdate);
        userUpdate.ExecuteCommandAsync().Returns(Task.FromResult(1));
        db.Updateable<User>().Returns(userUpdate);
        var queryable = Substitute.For<ISugarQueryable<User>>();
        queryable.InSingleAsync(42).Returns(Task.FromResult(new User
        {
            Id = 42,
            PublicHandle = "SameSubject",
            AccountSubjectHash = ExpectedAccountSubjectHash("SameSubject"),
            Status = 1,
            BanReason = "spam",
            RowVersion = "7"
        }));
        db.Queryable<User>().Returns(queryable);
        var service = new BlacklistService(cache, db);
        string accountSubjectKey = ExpectedAccountSubjectKey("SameSubject");

        await service.BanUserAsync(42, "  spam  ");

        userUpdate.Received(1)
            .SetColumns(Arg.Is<Expression<Func<User, bool>>>(expr => MatchesStatusBanned(expr)));
        userUpdate.Received(1)
            .SetColumns(Arg.Is<Expression<Func<User, bool>>>(expr => MatchesBanReason(expr, "spam")));
        userUpdate.Received(1)
            .Where(Arg.Is<Expression<Func<User, bool>>>(expr => MatchesUserId(expr, 42)));
        await userUpdate.Received(1).ExecuteCommandAsync();
        await cache.Received(1).TrySetVersionedStringAsync(
            CachePolicyId.SecurityBlacklistUser,
            accountSubjectKey,
            Arg.Is<string>(value => IsCacheSnapshot(value, true, "manual_ban", "spam", "7")),
            "7",
            true,
            Arg.Is<TimeSpan?>(ttl => !ttl.HasValue),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task GetBanStateAsync_CacheMissLoadsBannedUserFromDbAndWarmsCache()
    {
        var cache = Substitute.For<IUnifiedCache>();
        string accountSubjectHash = ExpectedAccountSubjectHash("SameSubject");
        string accountSubjectKey = string.Concat("account:", accountSubjectHash);
        cache.GetStringAsync(CachePolicyId.SecurityBlacklistUser, accountSubjectKey, Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>(null));
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<User>>();
        queryable.InSingleAsync(42).Returns(Task.FromResult(new User
        {
            Id = 42,
            PublicHandle = "SameSubject",
            AccountSubjectHash = accountSubjectHash,
            Status = 1,
            BanReason = "persisted spam",
            RowVersion = "8"
        }));
        db.Queryable<User>().Returns(queryable);
        var service = new BlacklistService(cache, db);

        var snapshot = await service.GetBanStateAsync(42, accountSubjectHash);

        Assert.True(snapshot.IsBanned);
        Assert.Equal("manual_ban", snapshot.ReasonCode);
        Assert.Equal("persisted spam", snapshot.Message);
        await cache.Received(1).TrySetVersionedStringAsync(
            CachePolicyId.SecurityBlacklistUser,
            accountSubjectKey,
            Arg.Is<string>(value => IsCacheSnapshot(value, true, "manual_ban", "persisted spam", "8")),
            "8",
            false,
            Arg.Is<TimeSpan?>(ttl => !ttl.HasValue),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task GetBanStateAsync_SameAccountSubjectHashUsesSameCacheEntryAcrossAccountIds()
    {
        string accountSubjectHash = ExpectedAccountSubjectHash("SameSubject");
        string accountSubjectKey = string.Concat("account:", accountSubjectHash);
        var cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.SecurityBlacklistUser, accountSubjectKey, Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>(BlacklistService.EncodeCacheValueForTests(1, "cached ban", "9")));
        var db = Substitute.For<ISqlSugarClient>();
        var service = new BlacklistService(cache, db);

        var first = await service.GetBanStateAsync(42, accountSubjectHash);
        var rebuilt = await service.GetBanStateAsync(84, accountSubjectHash);

        Assert.True(first.IsBanned);
        Assert.True(rebuilt.IsBanned);
        await cache.Received(2).GetStringAsync(
            CachePolicyId.SecurityBlacklistUser,
            accountSubjectKey,
            Arg.Any<CancellationToken>());
        db.DidNotReceive().Queryable<User>();
    }

    [Fact]
    public async Task GetBanStateAsync_CacheMissReturnsNotBannedWhenDbUserIsNormal()
    {
        var cache = Substitute.For<IUnifiedCache>();
        string accountSubjectHash = ExpectedAccountSubjectHash("SameSubject");
        string accountSubjectKey = string.Concat("account:", accountSubjectHash);
        cache.GetStringAsync(CachePolicyId.SecurityBlacklistUser, accountSubjectKey, Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>(null));
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<User>>();
        queryable.InSingleAsync(42).Returns(Task.FromResult(new User
        {
            Id = 42,
            PublicHandle = "SameSubject",
            AccountSubjectHash = accountSubjectHash,
            Status = 0,
            BanReason = "stale reason",
            RowVersion = "10"
        }));
        db.Queryable<User>().Returns(queryable);
        var service = new BlacklistService(cache, db);

        var snapshot = await service.GetBanStateAsync(42, accountSubjectHash);

        Assert.False(snapshot.IsBanned);
        Assert.Null(snapshot.ReasonCode);
        Assert.Null(snapshot.Message);
        await cache.Received(1).TrySetVersionedStringAsync(
            CachePolicyId.SecurityBlacklistUser,
            accountSubjectKey,
            Arg.Is<string>(value => IsCacheSnapshot(value, false, null, null, "10")),
            "10",
            false,
            Arg.Any<TimeSpan?>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task GetBanStateAsync_ClaimSubjectMismatchWithPhysicalProjectionFailsClosed()
    {
        const string PhysicalSubjectHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const string ClaimSubjectHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        var cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(
                CachePolicyId.SecurityBlacklistUser,
                "account:" + ClaimSubjectHash,
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>(null));
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<User>>();
        queryable.InSingleAsync(42).Returns(Task.FromResult(new User
        {
            Id = 42,
            AccountSubjectHash = PhysicalSubjectHash,
            Status = 0,
            RowVersion = "10"
        }));
        db.Queryable<User>().Returns(queryable);
        var service = new BlacklistService(cache, db);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.GetBanStateAsync(42, ClaimSubjectHash));

        await cache.DidNotReceive().TrySetVersionedStringAsync(
            CachePolicyId.SecurityBlacklistUser,
            Arg.Any<string>(),
            Arg.Any<string>(),
            Arg.Any<string>(),
            Arg.Any<bool>(),
            Arg.Any<TimeSpan?>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task GetBanStateAsync_StaleMissWarmRejectedUsesCurrentCacheState()
    {
        string accountSubjectHash = ExpectedAccountSubjectHash("SameSubject");
        string accountSubjectKey = string.Concat("account:", accountSubjectHash);
        string currentNormal = BlacklistService.EncodeCacheValueForTests(0, null, "12");
        var cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.SecurityBlacklistUser, accountSubjectKey, Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>(null), Task.FromResult<string?>(currentNormal));
        cache.TrySetVersionedStringAsync(
                CachePolicyId.SecurityBlacklistUser,
                accountSubjectKey,
                Arg.Any<string>(),
                "11",
                false,
                null,
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(false));
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<User>>();
        queryable.InSingleAsync(42).Returns(Task.FromResult(new User
        {
            Id = 42,
            PublicHandle = "SameSubject",
            AccountSubjectHash = accountSubjectHash,
            Status = 1,
            BanReason = "old ban",
            RowVersion = "11"
        }));
        db.Queryable<User>().Returns(queryable);
        var service = new BlacklistService(cache, db);

        var snapshot = await service.GetBanStateAsync(42, accountSubjectHash);

        Assert.False(snapshot.IsBanned);
        Assert.Null(snapshot.ReasonCode);
        Assert.Null(snapshot.Message);
        await cache.Received(1).TrySetVersionedStringAsync(
            CachePolicyId.SecurityBlacklistUser,
            accountSubjectKey,
            Arg.Is<string>(value => IsCacheSnapshot(value, true, "manual_ban", "old ban", "11")),
            "11",
            false,
            null,
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task UnbanUserAsync_PublishesVersionedNormalStateInsteadOfRemovingKey()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var db = Substitute.For<ISqlSugarClient>();
        var userUpdate = Substitute.For<IUpdateable<User>>();
        userUpdate.SetColumns(Arg.Any<Expression<Func<User, bool>>>()).Returns(userUpdate);
        userUpdate.Where(Arg.Any<Expression<Func<User, bool>>>()).Returns(userUpdate);
        userUpdate.ExecuteCommandAsync().Returns(Task.FromResult(1));
        db.Updateable<User>().Returns(userUpdate);
        var queryable = Substitute.For<ISugarQueryable<User>>();
        queryable.InSingleAsync(42).Returns(Task.FromResult(new User
        {
            Id = 42,
            PublicHandle = "SameSubject",
            AccountSubjectHash = ExpectedAccountSubjectHash("SameSubject"),
            Status = 0,
            BanReason = null,
            RowVersion = "13"
        }));
        db.Queryable<User>().Returns(queryable);
        var service = new BlacklistService(cache, db);
        string accountSubjectKey = ExpectedAccountSubjectKey("SameSubject");

        await service.UnbanUserAsync(42);

        await cache.Received(1).TrySetVersionedStringAsync(
            CachePolicyId.SecurityBlacklistUser,
            accountSubjectKey,
            Arg.Is<string>(value => IsCacheSnapshot(value, false, null, null, "13")),
            "13",
            true,
            null,
            Arg.Any<CancellationToken>());
        await cache.DidNotReceive().RemoveAsync(
            CachePolicyId.SecurityBlacklistUser,
            accountSubjectKey,
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public void BlacklistCacheValue_RejectsLegacyReasonOnlyValue()
    {
        Assert.False(BlacklistService.TryDecodeCacheValueForTests("plain reason", out _, out _));
    }

    [Fact]
    public async Task GetBanStateAsync_LegacyReasonOnlyCacheValueIsRemovedAndReloaded()
    {
        string accountSubjectHash = ExpectedAccountSubjectHash("SameSubject");
        string accountSubjectKey = string.Concat("account:", accountSubjectHash);
        var cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.SecurityBlacklistUser, accountSubjectKey, Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>("legacy reason"));
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<User>>();
        queryable.InSingleAsync(42).Returns(Task.FromResult(new User
        {
            Id = 42,
            PublicHandle = "SameSubject",
            AccountSubjectHash = accountSubjectHash,
            Status = 1,
            BanReason = "current reason",
            RowVersion = "14"
        }));
        db.Queryable<User>().Returns(queryable);
        var service = new BlacklistService(cache, db);

        var snapshot = await service.GetBanStateAsync(42, accountSubjectHash);

        Assert.True(snapshot.IsBanned);
        Assert.Equal("current reason", snapshot.Message);
        await cache.Received(1).RemoveAsync(
            CachePolicyId.SecurityBlacklistUser,
            accountSubjectKey,
            Arg.Any<CancellationToken>());
        await cache.Received(1).TrySetVersionedStringAsync(
            CachePolicyId.SecurityBlacklistUser,
            accountSubjectKey,
            Arg.Is<string>(value => IsCacheSnapshot(value, true, "manual_ban", "current reason", "14")),
            "14",
            false,
            null,
            Arg.Any<CancellationToken>());
    }

    private static bool MatchesStatusBanned(Expression<Func<User, bool>> expression)
    {
        try
        {
            var predicate = expression.Compile();
            return predicate(new User { Status = 1 }) && !predicate(new User { Status = 0 });
        }
        catch
        {
            return false;
        }
    }

    private static bool MatchesBanReason(Expression<Func<User, bool>> expression, string reason)
    {
        try
        {
            var predicate = expression.Compile();
            return predicate(new User { BanReason = reason }) && !predicate(new User { BanReason = "other" });
        }
        catch
        {
            return false;
        }
    }

    private static bool MatchesUserId(Expression<Func<User, bool>> expression, int userId)
    {
        try
        {
            var predicate = expression.Compile();
            return predicate(new User { Id = userId }) && !predicate(new User { Id = userId + 1 });
        }
        catch
        {
            return false;
        }
    }

    private static string ExpectedAccountSubjectKey(string subject)
        => string.Concat("account:", ExpectedAccountSubjectHash(subject));

    private static string ExpectedAccountSubjectHash(string subject)
    {
        byte[] bytes = SHA256.HashData(Encoding.UTF8.GetBytes(
            string.Concat("fsus:account-subject:v1:", AnonymousIdentityRuntime.AnonymousAccountKind, ':', subject.Trim().ToLowerInvariant())));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private static bool IsCacheSnapshot(string value, bool banned, string? reasonCode, string? message, string rowVersion)
    {
        bool decoded = BlacklistService.TryDecodeCacheValueForTests(value, out BanStateSnapshot snapshot, out string decodedVersion);
        return decoded &&
            decodedVersion == rowVersion &&
            snapshot.IsBanned == banned &&
            snapshot.ReasonCode == reasonCode &&
            snapshot.Message == message;
    }
}
