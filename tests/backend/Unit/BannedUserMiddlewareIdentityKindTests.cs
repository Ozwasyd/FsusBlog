using System.Security.Claims;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BannedUserMiddlewareIdentityKindTests
{
    [Fact]
    public async Task InvokeAsync_AdminPrincipalWithMissingSysUser_AllowsNextWithoutUserOrBanLookup()
    {
        bool nextCalled = false;
        var middleware = new BannedUserMiddleware(context =>
        {
            nextCalled = true;
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return Task.CompletedTask;
        });
        var blacklist = Substitute.For<IBlacklistService>();
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(1).Returns(Task.FromResult<UserAccountSnapshot?>(null));
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var context = CreateContext("POST", CreateAdminPrincipal(1));

        await middleware.InvokeAsync(context, blacklist, users, cache);

        Assert.True(nextCalled);
        Assert.Equal(StatusCodes.Status204NoContent, context.Response.StatusCode);
        await users.DidNotReceive().GetAccountByIdAsync(Arg.Any<int>());
        await blacklist.DidNotReceive().GetBanStateAsync(Arg.Any<int>());
    }

    [Fact]
    public async Task InvokeAsync_AdminPrincipalWithBannedSysUserId_AllowsNextWithoutBanLookup()
    {
        bool nextCalled = false;
        var middleware = new BannedUserMiddleware(context =>
        {
            nextCalled = true;
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return Task.CompletedTask;
        });
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(1).Returns(Task.FromResult(new BanStateSnapshot(true, "manual", "blocked")));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(1).Returns(Task.FromResult<UserAccountSnapshot?>(CreateActiveUser(1)));
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var context = CreateContext("POST", CreateAdminPrincipal(1));

        await middleware.InvokeAsync(context, blacklist, users, cache);

        Assert.True(nextCalled);
        Assert.Equal(StatusCodes.Status204NoContent, context.Response.StatusCode);
        await users.DidNotReceive().GetAccountByIdAsync(Arg.Any<int>());
        await blacklist.DidNotReceive().GetBanStateAsync(Arg.Any<int>());
    }

    [Fact]
    public async Task InvokeAsync_LegacyUserWithBannedState_ReturnsLocked()
    {
        bool nextCalled = false;
        var middleware = new BannedUserMiddleware(context =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42).Returns(Task.FromResult(new BanStateSnapshot(true, "manual", "blocked")));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(CreateActiveUser(42)));
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var context = CreateContext("POST", CreateLegacyUser(42));

        await middleware.InvokeAsync(context, blacklist, users, cache);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status423Locked, context.Response.StatusCode);
        await users.Received(1).GetAccountByIdAsync(42);
        await blacklist.Received(1).GetBanStateAsync(42);
    }

    [Fact]
    public async Task InvokeAsync_AnonymousAccountWithDeletedState_ReturnsUnauthorized()
    {
        bool nextCalled = false;
        var middleware = new BannedUserMiddleware(context =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });
        var blacklist = Substitute.For<IBlacklistService>();
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(CreateDeletedUser(42)));
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var context = CreateContext("POST", CreateAnonymousAccount(42));

        await middleware.InvokeAsync(context, blacklist, users, cache);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
        await users.Received(1).GetAccountByIdAsync(42);
        await blacklist.DidNotReceive().GetBanStateAsync(Arg.Any<int>());
    }

    private static DefaultHttpContext CreateContext(string method, ClaimsPrincipal user)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.RequestServices = new ServiceCollection().BuildServiceProvider();
        context.Response.Body = new MemoryStream();
        context.User = user;
        return context;
    }

    private static ClaimsPrincipal CreateAdminPrincipal(int adminId)
        => CreatePrincipal(
            adminId,
            new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new Claim("admin_id", adminId.ToString()));

    private static ClaimsPrincipal CreateAnonymousAccount(int userId)
        => CreatePrincipal(userId, new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind));

    private static ClaimsPrincipal CreateLegacyUser(int userId)
        => CreatePrincipal(userId);

    private static ClaimsPrincipal CreatePrincipal(int id, params Claim[] additionalClaims)
    {
        Claim[] claims =
        [
            new(ClaimTypes.NameIdentifier, id.ToString()),
            .. additionalClaims
        ];
        return new ClaimsPrincipal(new ClaimsIdentity(claims, "test"));
    }

    private static UserAccountSnapshot CreateActiveUser(int userId)
        => new(userId, 0, null, false, null);

    private static UserAccountSnapshot CreateDeletedUser(int userId)
        => new(userId, 2, null, false, DateTime.UtcNow);
}
