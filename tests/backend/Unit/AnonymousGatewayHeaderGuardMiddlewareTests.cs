using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;

using FsusBlog.Server.Infrastructure.Middlewares;
namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousGatewayHeaderGuardMiddlewareTests
{
    [Theory]
    [InlineData("X-Fsus-Username")]
    [InlineData("X-Fsus-Email")]
    [InlineData("X-Fsus-Role")]
    [InlineData("X-Fsus-Account-Role")]
    [InlineData("X-Fsus-User-Id")]
    [InlineData("X-Fsus-Password")]
    [InlineData("X-Fsus-Totp")]
    public async Task InvokeAsync_RejectsTraditionalGatewayAccountHeaders(string headerName)
    {
        bool nextCalled = false;
        var middleware = new AnonymousGatewayHeaderGuardMiddleware(
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            NullLogger<AnonymousGatewayHeaderGuardMiddleware>.Instance);
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        context.Request.Headers[headerName] = "legacy-value";

        await middleware.InvokeAsync(context);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        Assert.Equal(headerName, context.Items[AnonymousGatewayHeaderGuardMiddleware.RejectedHeaderItemKey]);
        Assert.Equal("traditional_account_header", context.Items[AnonymousGatewayHeaderGuardMiddleware.RejectionReasonItemKey]);
        Assert.False(context.User.Identity?.IsAuthenticated == true);
    }

    [Fact]
    public async Task InvokeAsync_RejectsUnknownFsusHeadersBeforeAuthentication()
    {
        bool nextCalled = false;
        var middleware = new AnonymousGatewayHeaderGuardMiddleware(
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            NullLogger<AnonymousGatewayHeaderGuardMiddleware>.Instance);
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        context.Request.Headers["X-Fsus-Trusted-Account"] = "external";

        await middleware.InvokeAsync(context);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        Assert.Equal("unknown_fsus_header", context.Items[AnonymousGatewayHeaderGuardMiddleware.RejectionReasonItemKey]);
    }

    [Theory]
    [InlineData("X-Fsus-Challenge-Proof")]
    [InlineData("X-Fsus-Challenge-Id")]
    [InlineData("X-Fsus-Challenge-Kind")]
    [InlineData("X-Fsus-Device-Fp")]
    [InlineData("X-Fsus-Mfa-Proof")]
    [InlineData("X-Fsus-Region")]
    [InlineData("X-Fsus-Notification-Stream-Protocol")]
    [InlineData("X-Fsus-Test-Session")]
    [InlineData("X-Fsus-Local-Auth-Fixture-Secret")]
    public async Task InvokeAsync_AllowsAnonymousProfileAndRuntimeHeaders(string headerName)
    {
        bool nextCalled = false;
        var middleware = new AnonymousGatewayHeaderGuardMiddleware(
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            NullLogger<AnonymousGatewayHeaderGuardMiddleware>.Instance);
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        context.Request.Headers[headerName] = "allowed";

        await middleware.InvokeAsync(context);

        Assert.True(nextCalled);
        Assert.NotEqual(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        Assert.True(AnonymousGatewayHeaderGuardMiddleware.IsAllowedHeader(headerName));
        Assert.False(context.User.Identity?.IsAuthenticated == true);
    }
}
