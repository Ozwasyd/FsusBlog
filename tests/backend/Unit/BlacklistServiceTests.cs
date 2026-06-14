using System.Linq.Expressions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;
using NSubstitute;
using SqlSugar;

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
        var service = new BlacklistService(cache, db);

        await service.BanUserAsync(42, "  spam  ");

        userUpdate.Received(1)
            .SetColumns(Arg.Is<Expression<Func<User, bool>>>(expr => MatchesStatusBanned(expr)));
        userUpdate.Received(1)
            .SetColumns(Arg.Is<Expression<Func<User, bool>>>(expr => MatchesBanReason(expr, "spam")));
        userUpdate.Received(1)
            .Where(Arg.Is<Expression<Func<User, bool>>>(expr => MatchesUserId(expr, 42)));
        await userUpdate.Received(1).ExecuteCommandAsync();
        await cache.Received(1).SetStringAsync(
            CachePolicyId.SecurityBlacklistUser,
            "42",
            "spam",
            Arg.Is<TimeSpan?>(ttl => !ttl.HasValue),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task GetBanStateAsync_CacheMissLoadsBannedUserFromDbAndWarmsCache()
    {
        var cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.SecurityBlacklistUser, "42", Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>(null));
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<User>>();
        queryable.InSingleAsync(42).Returns(Task.FromResult(new User
        {
            Id = 42,
            Status = 1,
            BanReason = "persisted spam"
        }));
        db.Queryable<User>().Returns(queryable);
        var service = new BlacklistService(cache, db);

        var snapshot = await service.GetBanStateAsync(42);

        Assert.True(snapshot.IsBanned);
        Assert.Equal("manual_ban", snapshot.ReasonCode);
        Assert.Equal("persisted spam", snapshot.Message);
        await cache.Received(1).SetStringAsync(
            CachePolicyId.SecurityBlacklistUser,
            "42",
            "persisted spam",
            Arg.Is<TimeSpan?>(ttl => !ttl.HasValue),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task GetBanStateAsync_CacheMissReturnsNotBannedWhenDbUserIsNormal()
    {
        var cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.SecurityBlacklistUser, "42", Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>(null));
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<User>>();
        queryable.InSingleAsync(42).Returns(Task.FromResult(new User
        {
            Id = 42,
            Status = 0,
            BanReason = "stale reason"
        }));
        db.Queryable<User>().Returns(queryable);
        var service = new BlacklistService(cache, db);

        var snapshot = await service.GetBanStateAsync(42);

        Assert.False(snapshot.IsBanned);
        Assert.Null(snapshot.ReasonCode);
        Assert.Null(snapshot.Message);
        await cache.DidNotReceive().SetStringAsync(
            CachePolicyId.SecurityBlacklistUser,
            Arg.Any<string>(),
            Arg.Any<string>(),
            Arg.Any<TimeSpan?>(),
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
}
