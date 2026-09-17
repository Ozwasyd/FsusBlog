using System.Security.Claims;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BannedUserMiddlewareIdentityKindTests
{
    private const string SubjectHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task AdminPrincipal_AllowsNextWithoutProjectionOrBanLookup()
    {
        bool nextCalled = false;
        var middleware = Middleware(() => nextCalled = true);
        var blacklist = Substitute.For<IBlacklistService>();
        var accounts = Substitute.For<IAccountStateProjection>();

        await middleware.InvokeAsync(CreateContext("POST", CreateAdmin(1)), blacklist, accounts);

        Assert.True(nextCalled);
        await accounts.DidNotReceive().ReadAsync(Arg.Any<int>(), Arg.Any<string>(), Arg.Any<CancellationToken>());
        await blacklist.DidNotReceive().GetBanStateAsync(Arg.Any<int>(), Arg.Any<string>());
    }

    [Fact]
    public async Task OrdinaryWrite_UsesProjectionAndBanState()
    {
        int nextCalls = 0;
        var middleware = Middleware(() => nextCalls++);
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42, SubjectHash)
            .Returns(Task.FromResult(new BanStateSnapshot(false, null, null, true, false, 1)));
        var accounts = PresentProjection();

        await middleware.InvokeAsync(CreateContext("POST", CreateAccount(42)), blacklist, accounts);
        await middleware.InvokeAsync(CreateContext("POST", CreateAccount(42)), blacklist, accounts);

        Assert.Equal(2, nextCalls);
        await accounts.Received(2).ReadAsync(42, SubjectHash, Arg.Any<CancellationToken>());
        await accounts.DidNotReceive().RefreshAsync(Arg.Any<int>(), Arg.Any<string?>(), Arg.Any<CancellationToken>());
        await blacklist.Received(2).GetBanStateAsync(42, SubjectHash);
    }

    [Fact]
    public async Task ForceMetadata_UsesAuthoritativeRefresh()
    {
        int nextCalls = 0;
        var middleware = Middleware(() => nextCalls++);
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42, SubjectHash)
            .Returns(Task.FromResult(new BanStateSnapshot(false, null, null, true, false, 1)));
        var accounts = Substitute.For<IAccountStateProjection>();
        accounts.RefreshAsync(42, SubjectHash, Arg.Any<CancellationToken>())
            .Returns(ValueTask.FromResult(PresentResult()));
        var context = CreateContext("POST", CreateAccount(42));
        context.SetEndpoint(new Endpoint(
            _ => Task.CompletedTask,
            new EndpointMetadataCollection(ForceAccountStateRefreshMetadata.Instance),
            "force-account-state-refresh"));

        await middleware.InvokeAsync(context, blacklist, accounts);

        Assert.Equal(1, nextCalls);
        await accounts.Received(1).RefreshAsync(42, SubjectHash, Arg.Any<CancellationToken>());
        await accounts.DidNotReceive().ReadAsync(Arg.Any<int>(), Arg.Any<string>(), Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData(AccountStateReadOutcome.Missing, StatusCodes.Status401Unauthorized)]
    [InlineData(AccountStateReadOutcome.Deleted, StatusCodes.Status401Unauthorized)]
    [InlineData(AccountStateReadOutcome.SubjectMismatch, StatusCodes.Status401Unauthorized)]
    [InlineData(AccountStateReadOutcome.Unknown, StatusCodes.Status503ServiceUnavailable)]
    [InlineData(AccountStateReadOutcome.Conflict, StatusCodes.Status503ServiceUnavailable)]
    public async Task NonPresentProjection_FailsClosed(AccountStateReadOutcome outcome, int expectedStatus)
    {
        bool nextCalled = false;
        var middleware = Middleware(() => nextCalled = true);
        var blacklist = Substitute.For<IBlacklistService>();
        var accounts = Substitute.For<IAccountStateProjection>();
        accounts.ReadAsync(42, SubjectHash, Arg.Any<CancellationToken>())
            .Returns(ValueTask.FromResult(new AccountStateReadResult(outcome, null, LocalHit: true)));
        var context = CreateContext("POST", CreateAccount(42));

        await middleware.InvokeAsync(context, blacklist, accounts);

        Assert.False(nextCalled);
        Assert.Equal(expectedStatus, context.Response.StatusCode);
        await blacklist.DidNotReceive().GetBanStateAsync(Arg.Any<int>(), Arg.Any<string>());
    }

    [Fact]
    public async Task BannedWrite_ReturnsLocked()
    {
        bool nextCalled = false;
        var middleware = Middleware(() => nextCalled = true);
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42, SubjectHash)
            .Returns(Task.FromResult(new BanStateSnapshot(true, "manual", "blocked", true, false, 2)));
        var context = CreateContext("POST", CreateAccount(42));

        await middleware.InvokeAsync(context, blacklist, PresentProjection());

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status423Locked, context.Response.StatusCode);
    }

    [Fact]
    public async Task MissingSubjectClaim_FailsBeforeProjection()
    {
        bool nextCalled = false;
        var middleware = Middleware(() => nextCalled = true);
        var blacklist = Substitute.For<IBlacklistService>();
        var accounts = Substitute.For<IAccountStateProjection>();
        var context = CreateContext("POST", CreatePrincipal(42));

        await middleware.InvokeAsync(context, blacklist, accounts);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
        await accounts.DidNotReceive().ReadAsync(Arg.Any<int>(), Arg.Any<string>(), Arg.Any<CancellationToken>());
    }

    private static IAccountStateProjection PresentProjection()
    {
        var accounts = Substitute.For<IAccountStateProjection>();
        accounts.ReadAsync(42, SubjectHash, Arg.Any<CancellationToken>())
            .Returns(ValueTask.FromResult(PresentResult()));
        return accounts;
    }

    private static AccountStateReadResult PresentResult()
        => new(
            AccountStateReadOutcome.Present,
            new AccountStateSnapshot
            {
                AccountId = 42,
                Generation = 1,
                Knowledge = AccountStateKnowledge.Present,
                AccountSubjectHash = SubjectHash,
                IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
                RegistrationState = AccountRegistrationStates.Active
            },
            LocalHit: true);

    private static BannedUserMiddleware Middleware(Action next)
        => new(context =>
        {
            next();
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return Task.CompletedTask;
        });

    private static DefaultHttpContext CreateContext(string method, ClaimsPrincipal user)
    {
        var context = new DefaultHttpContext { User = user };
        context.Request.Method = method;
        context.RequestServices = new ServiceCollection().BuildServiceProvider();
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static ClaimsPrincipal CreateAdmin(int id)
        => CreatePrincipal(
            id,
            new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new Claim("admin_id", id.ToString()));

    private static ClaimsPrincipal CreateAccount(int id)
        => CreatePrincipal(
            id,
            new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind),
            new Claim(AccountSubjectHasher.ClaimType, SubjectHash));

    private static ClaimsPrincipal CreatePrincipal(int id, params Claim[] additionalClaims)
        => new(new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, id.ToString()), .. additionalClaims],
            "test"));
}
