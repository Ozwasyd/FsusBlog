using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class UserSessionLoginConcurrencyTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task CompleteLoginAsync_TwoDeviceLoginsLeavesOnlyLatestActiveSession()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(UserSession));
        UserService service = CreateService(db);
        var user = new User { Id = 42, Status = 0 };

        var first = await service.CompleteLoginAsync(
            user,
            "203.0.113.10",
            deviceFingerprint: "device-a",
            userAgent: "agent-a",
            mfaVerified: true,
            rememberMe: false);
        var second = await service.CompleteLoginAsync(
            user,
            "203.0.113.11",
            deviceFingerprint: "device-b",
            userAgent: "agent-b",
            mfaVerified: true,
            rememberMe: false);

        Assert.True(first.Success, first.Message);
        Assert.True(second.Success, second.Message);

        List<UserSession> sessions = await db.Queryable<UserSession>()
            .Where(session => session.UserId == user.Id)
            .OrderBy(session => session.CreatedAt)
            .ToListAsync();

        Assert.Equal(2, sessions.Count);
        UserSession active = Assert.Single(sessions, static session => session.RevokedAt is null);
        UserSession revoked = Assert.Single(sessions, static session => session.RevokedAt is not null);
        Assert.Equal("device-b", active.DeviceFingerprint);
        Assert.Equal("login_replaced", revoked.RevokeReason);
    }

    private static UserService CreateService(ISqlSugarClient db)
    {
        var jwt = Substitute.For<IJwtHelper>();
        int refreshCounter = 0;
        jwt.GenerateRefreshToken().Returns(_ => $"refresh-token-{Interlocked.Increment(ref refreshCounter)}");
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string>(), Arg.Any<bool>()).Returns("access-token");

        return new UserService(
            _db: db,
            _logger: NullLogger<UserService>.Instance,
            _jwtHelper: jwt,
            _cache: Substitute.For<IUnifiedCache>(),
            _blacklistService: Substitute.For<IBlacklistService>(),
            _messageCommandService: Substitute.For<IMessageCommandService>(),
            _messageRealtimePublisher: Substitute.For<IMessageRealtimePublisher>(),
            _totpService: Substitute.For<ITotpService>(),
            _authRiskService: Substitute.For<IAuthRiskService>());
    }
}
