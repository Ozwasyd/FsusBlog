using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using NSubstitute;

using FsusBlog.Server.Infrastructure.Testing;
namespace FsusBlog.Tests.Unit;

public sealed class TestSessionContextTests
{
    [Fact]
    public async Task NotificationPreflight_BridgesHeaderToHttpOnlyPathCookie()
    {
        var environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns("Development");
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/notifications/stream/preflight";
        context.Request.Headers[HttpTestSessionKeyScope.HeaderName] = "Console-Fix-0";
        string? observedSession = null;
        var middleware = new TestSessionValidationMiddleware(next: request =>
        {
            observedSession = request.Request.Headers[HttpTestSessionKeyScope.HeaderName].ToString();
            return Task.CompletedTask;
        }, environment);

        await middleware.InvokeAsync(context);

        Assert.Equal("console-fix-0", observedSession);
        Assert.Equal(HttpTestSessionKeyScope.HeaderName, context.Response.Headers.Vary.ToString());
        string setCookie = context.Response.Headers["Set-Cookie"].ToString();
        Assert.NotEmpty(setCookie);
        Assert.Contains("FsusTestSession=console-fix-0", setCookie, StringComparison.Ordinal);
        Assert.Contains("path=/api/notifications/stream", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("httponly", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=strict", setCookie, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task NotificationWebSocket_PromotesBridgeCookieBeforeAuthentication()
    {
        var environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns("Development");
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/notifications/stream";
        context.Request.Headers.Cookie = "FsusTestSession=console-fix-0";
        string? observedSession = null;
        var middleware = new TestSessionValidationMiddleware(next: request =>
        {
            observedSession = request.Request.Headers[HttpTestSessionKeyScope.HeaderName].ToString();
            return Task.CompletedTask;
        }, environment);

        await middleware.InvokeAsync(context);

        Assert.Equal("console-fix-0", observedSession);
        Assert.Equal(HttpTestSessionKeyScope.HeaderName, context.Response.Headers.Vary.ToString());
        Assert.False(context.Response.Headers.ContainsKey("Set-Cookie"));
    }

    [Fact]
    public async Task NotificationWebSocket_RejectsInvalidBridgeCookie()
    {
        var environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns("Development");
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/notifications/stream";
        context.Request.Headers.Cookie = "FsusTestSession=invalid/session";
        bool nextCalled = false;
        var middleware = new TestSessionValidationMiddleware(next: _ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        }, environment);

        await middleware.InvokeAsync(context);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
    }
}
