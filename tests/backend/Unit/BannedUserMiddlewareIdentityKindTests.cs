using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Interfaces;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BannedUserMiddlewareIdentityKindTests
{
    private const string StableAccountSubjectHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
        await blacklist.DidNotReceive().GetBanStateAsync(Arg.Any<int>(), Arg.Any<string>());
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
        blacklist.GetBanStateAsync(1, Arg.Any<string>()).Returns(Task.FromResult(new BanStateSnapshot(true, "manual", "blocked")));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(1).Returns(Task.FromResult<UserAccountSnapshot?>(CreateActiveUser(1)));
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var context = CreateContext("POST", CreateAdminPrincipal(1));

        await middleware.InvokeAsync(context, blacklist, users, cache);

        Assert.True(nextCalled);
        Assert.Equal(StatusCodes.Status204NoContent, context.Response.StatusCode);
        await users.DidNotReceive().GetAccountByIdAsync(Arg.Any<int>());
        await blacklist.DidNotReceive().GetBanStateAsync(Arg.Any<int>(), Arg.Any<string>());
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
        blacklist.GetBanStateAsync(42, Arg.Any<string>()).Returns(Task.FromResult(new BanStateSnapshot(true, "manual", "blocked")));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(CreateActiveUser(42)));
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var context = CreateContext("POST", CreateLegacyUser(42));

        await middleware.InvokeAsync(context, blacklist, users, cache);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status423Locked, context.Response.StatusCode);
        await users.Received(1).GetAccountByIdAsync(42);
        await blacklist.Received(1).GetBanStateAsync(42, Arg.Any<string>());
    }

    [Fact]
    public async Task InvokeAsync_OrdinaryWriteRequestUsesCachedAccountStateButStillChecksBanState()
    {
        int nextCalls = 0;
        var middleware = new BannedUserMiddleware(context =>
        {
            nextCalls++;
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return Task.CompletedTask;
        });
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42, Arg.Any<string>())
            .Returns(Task.FromResult(new BanStateSnapshot(false, null, null)));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(CreateActiveUser(42)));
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var first = CreateContext("POST", CreateLegacyUser(42));
        var second = CreateContext("POST", CreateLegacyUser(42));

        await middleware.InvokeAsync(first, blacklist, users, cache);
        await middleware.InvokeAsync(second, blacklist, users, cache);

        Assert.Equal(2, nextCalls);
        Assert.Equal(StatusCodes.Status204NoContent, first.Response.StatusCode);
        Assert.Equal(StatusCodes.Status204NoContent, second.Response.StatusCode);
        await users.Received(1).GetAccountByIdAsync(42);
        await blacklist.Received(2).GetBanStateAsync(42, Arg.Any<string>());
    }

    [Fact]
    public async Task InvokeAsync_ForceAccountStateRefreshMetadataBypassesAccountStateCache()
    {
        int nextCalls = 0;
        var middleware = new BannedUserMiddleware(context =>
        {
            nextCalls++;
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return Task.CompletedTask;
        });
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42, Arg.Any<string>())
            .Returns(Task.FromResult(new BanStateSnapshot(false, null, null)));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(CreateActiveUser(42)));
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var first = CreateContext("POST", CreateLegacyUser(42));
        var second = CreateContext("POST", CreateLegacyUser(42));
        SetForceAccountStateRefreshEndpoint(first);
        SetForceAccountStateRefreshEndpoint(second);

        await middleware.InvokeAsync(first, blacklist, users, cache);
        await middleware.InvokeAsync(second, blacklist, users, cache);

        Assert.Equal(2, nextCalls);
        await users.Received(2).GetAccountByIdAsync(42);
        await blacklist.Received(2).GetBanStateAsync(42, Arg.Any<string>());
    }

    [Fact]
    public async Task InvokeAsync_AnonymousAccountUsesAccountSubjectHashForAccountStateCache()
    {
        const string accountSubjectHash = StableAccountSubjectHash;
        bool nextCalled = false;
        var middleware = new BannedUserMiddleware(context =>
        {
            nextCalled = true;
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return Task.CompletedTask;
        });
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(Arg.Any<int>(), Arg.Any<string>())
            .Returns(Task.FromResult(new BanStateSnapshot(false, null, null)));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(CreateActiveUser(42)));
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var first = CreateContext("GET", CreateAnonymousAccount(42, accountSubjectHash));
        var second = CreateContext("GET", CreateAnonymousAccount(84, accountSubjectHash));

        await middleware.InvokeAsync(first, blacklist, users, cache);
        await middleware.InvokeAsync(second, blacklist, users, cache);

        Assert.True(nextCalled);
        Assert.Equal(StatusCodes.Status204NoContent, first.Response.StatusCode);
        Assert.Equal(StatusCodes.Status204NoContent, second.Response.StatusCode);
        await users.Received(1).GetAccountByIdAsync(42);
        await users.DidNotReceive().GetAccountByIdAsync(84);
        Assert.True(cache.TryGetValue("account:state:" + StableAccountSubjectHash, out UserAccountSnapshot _));
        await blacklist.DidNotReceive().GetBanStateAsync(Arg.Any<int>(), Arg.Any<string>());
    }

    [Fact]
    public async Task InvokeAsync_AnonymousAccountUsesAccountSubjectHashForBanLookup()
    {
        const string accountSubjectHash = StableAccountSubjectHash;
        bool nextCalled = false;
        var middleware = new BannedUserMiddleware(context =>
        {
            nextCalled = true;
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return Task.CompletedTask;
        });
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42, accountSubjectHash)
            .Returns(Task.FromResult(new BanStateSnapshot(false, null, null)));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(CreateActiveUser(42)));
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var context = CreateContext("POST", CreateAnonymousAccount(42, accountSubjectHash));

        await middleware.InvokeAsync(context, blacklist, users, cache);

        Assert.True(nextCalled);
        Assert.Equal(StatusCodes.Status204NoContent, context.Response.StatusCode);
        await blacklist.Received(1).GetBanStateAsync(42, accountSubjectHash);
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
        await blacklist.DidNotReceive().GetBanStateAsync(Arg.Any<int>(), Arg.Any<string>());
    }

    [Fact]
    public async Task InvokeAsync_AccountWithoutPhysicalSubjectClaimFailsClosedBeforeLookup()
    {
        bool nextCalled = false;
        var middleware = new BannedUserMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });
        var blacklist = Substitute.For<IBlacklistService>();
        var users = Substitute.For<IUserAccountReader>();
        using var cache = new MemoryCache(new MemoryCacheOptions());
        ClaimsPrincipal principal = CreatePrincipal(
            42,
            new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind));
        var context = CreateContext("POST", principal);

        await middleware.InvokeAsync(context, blacklist, users, cache);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
        await users.DidNotReceive().GetAccountByIdAsync(Arg.Any<int>());
        await blacklist.DidNotReceive().GetBanStateAsync(Arg.Any<int>(), Arg.Any<string>());
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

    private static void SetForceAccountStateRefreshEndpoint(DefaultHttpContext context)
        => context.SetEndpoint(new Endpoint(
            _ => Task.CompletedTask,
            new EndpointMetadataCollection(ForceAccountStateRefreshMetadata.Instance),
            "force-account-state-refresh"));

    private static ClaimsPrincipal CreateAdminPrincipal(int adminId)
        => CreatePrincipal(
            adminId,
            new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new Claim("admin_id", adminId.ToString()));

    private static ClaimsPrincipal CreateAnonymousAccount(
        int userId,
        string accountSubjectHash = StableAccountSubjectHash)
        => CreatePrincipal(
            userId,
            new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind),
            new Claim("account_subject_hash", accountSubjectHash));

    private static ClaimsPrincipal CreateLegacyUser(int userId)
        => CreatePrincipal(userId, new Claim("account_subject_hash", StableAccountSubjectHash));

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
        => new(userId, 0, null, false, null, AccountSubjectHash: StableAccountSubjectHash);

    private static UserAccountSnapshot CreateDeletedUser(int userId)
        => new(userId, 2, null, false, DateTime.UtcNow, AccountSubjectHash: StableAccountSubjectHash);
}
