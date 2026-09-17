using FsusBlog.Server.Infrastructure.Middlewares;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

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
    [InlineData("X-Fsus-Client-Mutation-Id")]
    [InlineData("X-Fsus-Device-Fp")]
    [InlineData("X-Fsus-Mfa-Proof")]
    [InlineData("X-Fsus-Region")]
    [InlineData("X-Fsus-Notification-Stream-Protocol")]
    [InlineData("X-Fsus-Test-Session")]
    [InlineData("X-Fsus-Local-Auth-Fixture-Secret")]
    [InlineData("X-Fsus-Local-Demo-Fixture-Secret")]
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

    [Theory]
    [InlineData("X-Fsus-Local-Public-Content-Fixture-Secret")]
    [InlineData("X-Fsus-Test-Namespace")]
    [InlineData("X-Fsus-Test-Run-Id")]
    public async Task InvokeAsync_AllowsExactEndpointDeclaredFixtureHeadersOnlyInDevelopment(
        string headerName)
    {
        bool nextCalled = false;
        var middleware = new AnonymousGatewayHeaderGuardMiddleware(
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            NullLogger<AnonymousGatewayHeaderGuardMiddleware>.Instance);
        using ServiceProvider services = new ServiceCollection()
            .AddSingleton<IWebHostEnvironment>(
                new TestWebHostEnvironment(Environments.Development))
            .BuildServiceProvider();
        var context = new DefaultHttpContext
        {
            RequestServices = services
        };
        context.Response.Body = new MemoryStream();
        context.Request.Headers[headerName] = "development-value";
        context.SetEndpoint(new Endpoint(
            static _ => Task.CompletedTask,
            new EndpointMetadataCollection(
                new DevelopmentOnlyFsusHeaderMetadata(
                    "X-Fsus-Local-Public-Content-Fixture-Secret",
                    "X-Fsus-Test-Namespace",
                    "X-Fsus-Test-Run-Id")),
            "development public content fixture"));

        await middleware.InvokeAsync(context);

        Assert.True(nextCalled);
        Assert.False(AnonymousGatewayHeaderGuardMiddleware.IsAllowedHeader(headerName));
    }

    [Fact]
    public async Task InvokeAsync_RejectsUnknownHeaderOutsideExactEndpointMetadataAllowlist()
    {
        bool nextCalled = false;
        var middleware = new AnonymousGatewayHeaderGuardMiddleware(
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            NullLogger<AnonymousGatewayHeaderGuardMiddleware>.Instance);
        using ServiceProvider services = new ServiceCollection()
            .AddSingleton<IWebHostEnvironment>(
                new TestWebHostEnvironment(Environments.Development))
            .BuildServiceProvider();
        var context = new DefaultHttpContext
        {
            RequestServices = services
        };
        context.Response.Body = new MemoryStream();
        context.Request.Headers["X-Fsus-Test-Account"] = "must-not-pass";
        context.SetEndpoint(new Endpoint(
            static _ => Task.CompletedTask,
            new EndpointMetadataCollection(
                new DevelopmentOnlyFsusHeaderMetadata(
                    "X-Fsus-Test-Namespace",
                    "X-Fsus-Test-Run-Id")),
            "development fixture exact allowlist"));

        await middleware.InvokeAsync(context);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        Assert.Equal(
            "unknown_fsus_header",
            context.Items[AnonymousGatewayHeaderGuardMiddleware.RejectionReasonItemKey]);
    }

    [Theory]
    [InlineData("Production", true)]
    [InlineData("Development", false)]
    public async Task InvokeAsync_RejectsFixtureHeaderOutsideExactDevelopmentEndpoint(
        string environmentName,
        bool attachMetadata)
    {
        const string HeaderName = "X-Fsus-Local-Temporal-Fixture-Secret";
        bool nextCalled = false;
        var middleware = new AnonymousGatewayHeaderGuardMiddleware(
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            NullLogger<AnonymousGatewayHeaderGuardMiddleware>.Instance);
        using ServiceProvider services = new ServiceCollection()
            .AddSingleton<IWebHostEnvironment>(
                new TestWebHostEnvironment(environmentName))
            .BuildServiceProvider();
        var context = new DefaultHttpContext
        {
            RequestServices = services
        };
        context.Response.Body = new MemoryStream();
        context.Request.Headers[HeaderName] = "must-not-pass";
        if (attachMetadata)
        {
            context.SetEndpoint(new Endpoint(
                static _ => Task.CompletedTask,
                new EndpointMetadataCollection(
                    new DevelopmentOnlyFsusHeaderMetadata(HeaderName)),
                "fixture metadata outside development"));
        }

        await middleware.InvokeAsync(context);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        Assert.Equal(
            "unknown_fsus_header",
            context.Items[AnonymousGatewayHeaderGuardMiddleware.RejectionReasonItemKey]);
    }

    private sealed class TestWebHostEnvironment(string environmentName) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(AnonymousGatewayHeaderGuardMiddlewareTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.GetTempPath();
        public string EnvironmentName { get; set; } = environmentName;
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
