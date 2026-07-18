using System.Net;
using System.Security.Claims;

using Microsoft.AspNetCore.Http;
using Serilog;
using Serilog.Core;
using Serilog.Events;

using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Security;
namespace FsusBlog.Server.Tests;

public sealed class RequestAuditContextMiddlewareTests
{
    [Fact]
    public void RequestAuditContextSnapshot_FromHttpContext_ExtractsTraceAndAccountWithoutIpOrUserAgent()
    {
        var context = new DefaultHttpContext();
        context.TraceIdentifier = "trace-42";
        context.Request.Path = "/api/Article/1";
        context.Request.Method = HttpMethods.Get;
        context.Request.Headers["X-Forwarded-For"] = "203.0.113.10, 10.0.0.5";
        context.Request.Headers.UserAgent = "FsusBrowser/1.0";
        context.Connection.RemoteIpAddress = IPAddress.Loopback;
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
        [
            new Claim(ClaimTypes.NameIdentifier, "12"),
            new Claim(ClaimTypes.Name, "binaryadmin")
        ], "test"));

        RequestAuditContextSnapshot snapshot = RequestAuditContextSnapshot.FromHttpContext(context);
        IReadOnlyDictionary<string, object?> properties = snapshot.ToProperties();

        Assert.Equal("trace-42", properties["TraceId"]);
        Assert.Equal("/api/Article/1", properties["RequestPath"]);
        Assert.Equal("GET", properties["RequestMethod"]);
        Assert.Equal("12", snapshot.AccountId);
        Assert.Null(snapshot.AdminPrincipalId);
        Assert.Equal("12", properties[AuditPropertyNames.ActorId]);
        Assert.Equal("12", properties["AccountId"]);
        Assert.Null(properties["AdminPrincipalId"]);
        Assert.DoesNotContain("UserId", properties.Keys);
        Assert.DoesNotContain("Username", properties.Keys);
        Assert.DoesNotContain("ClientIp", properties.Keys);
        Assert.DoesNotContain("UserAgent", properties.Keys);
    }

    [Fact]
    public void RequestAuditContextSnapshot_RecordShape_UsesAccountAndActorRoleNames()
    {
        Assert.Null(typeof(RequestAuditContextSnapshot).GetProperty("UserId"));
        Assert.Null(typeof(RequestAuditContextSnapshot).GetProperty("UserRole"));
        Assert.NotNull(typeof(RequestAuditContextSnapshot).GetProperty(nameof(RequestAuditContextSnapshot.AccountId)));
        Assert.NotNull(typeof(RequestAuditContextSnapshot).GetProperty(nameof(RequestAuditContextSnapshot.AdminPrincipalId)));
        Assert.NotNull(typeof(RequestAuditContextSnapshot).GetProperty(nameof(RequestAuditContextSnapshot.ActorId)));
        Assert.NotNull(typeof(RequestAuditContextSnapshot).GetProperty(nameof(RequestAuditContextSnapshot.ActorRole)));
    }

    [Fact]
    public async Task InvokeAsync_PublicAnonymousGet_SkipsAuditLogContext()
    {
        var sink = new CollectingSink();
        ILogger previous = Log.Logger;
        Log.Logger = new LoggerConfiguration()
            .Enrich.FromLogContext()
            .WriteTo.Sink(sink)
            .CreateLogger();

        try
        {
            var middleware = new RequestAuditContextMiddleware(_ =>
            {
                Log.Information("public read");
                return Task.CompletedTask;
            });
            var context = new DefaultHttpContext();
            context.Request.Method = HttpMethods.Get;
            context.Request.Path = "/article/42";
            context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
            context.Request.Headers.UserAgent = "FsusBrowser/1.0";

            await middleware.InvokeAsync(context);

            LogEvent logEvent = Assert.Single(sink.Events);
            Assert.DoesNotContain(AuditPropertyNames.ActorType, logEvent.Properties.Keys);
            Assert.DoesNotContain("IpHash", logEvent.Properties.Keys);
        }
        finally
        {
            Log.Logger = previous;
        }
    }

    [Fact]
    public async Task InvokeAsync_PublicReadEndpointMetadata_PushesAuditLogContextForAnonymousGet()
    {
        var sink = new CollectingSink();
        ILogger previous = Log.Logger;
        Log.Logger = new LoggerConfiguration()
            .Enrich.FromLogContext()
            .WriteTo.Sink(sink)
            .CreateLogger();

        try
        {
            var middleware = new RequestAuditContextMiddleware(_ =>
            {
                Log.Information("public hot read");
                return Task.CompletedTask;
            });
            var context = new DefaultHttpContext();
            context.TraceIdentifier = "trace-public-read";
            context.Request.Method = HttpMethods.Get;
            context.Request.Path = "/";
            context.SetEndpoint(new Endpoint(
                _ => Task.CompletedTask,
                new EndpointMetadataCollection(RiskActionRegistry.Default.CreateMetadata(RiskActionNames.PublicRead, "public.html.home")),
                "public.html.home"));

            await middleware.InvokeAsync(context);

            LogEvent logEvent = Assert.Single(sink.Events);
            Assert.Equal("\"trace-public-read\"", logEvent.Properties["TraceId"].ToString());
            Assert.Equal("\"/\"", logEvent.Properties["RequestPath"].ToString());
            Assert.Contains(AuditPropertyNames.ActorType, logEvent.Properties.Keys);
            Assert.DoesNotContain("ClientIp", logEvent.Properties.Keys);
            Assert.DoesNotContain("UserAgent", logEvent.Properties.Keys);
        }
        finally
        {
            Log.Logger = previous;
        }
    }

    [Fact]
    public async Task InvokeAsync_RoleOnlyUserMutation_DoesNotBecomeAdminActor()
    {
        var sink = new CollectingSink();
        ILogger previous = Log.Logger;
        Log.Logger = new LoggerConfiguration()
            .Enrich.FromLogContext()
            .WriteTo.Sink(sink)
            .CreateLogger();

        try
        {
            var middleware = new RequestAuditContextMiddleware(_ =>
            {
                Log.Information("user mutation");
                return Task.CompletedTask;
            });
            var context = new DefaultHttpContext();
            context.TraceIdentifier = "trace-user";
            context.Request.Method = HttpMethods.Post;
            context.Request.Path = "/api/binary/admin/users/12";
            context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
            context.Request.Headers.UserAgent = "FsusBrowser/1.0";
            context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, "12"),
                new Claim(ClaimTypes.Role, "admin"),
                new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind)
            ], "test"));

            await middleware.InvokeAsync(context);

            LogEvent logEvent = Assert.Single(sink.Events);
            Assert.Equal("\"user\"", logEvent.Properties[AuditPropertyNames.ActorType].ToString());
            Assert.Equal("\"12\"", logEvent.Properties[AuditPropertyNames.ActorId].ToString());
        }
        finally
        {
            Log.Logger = previous;
        }
    }

    [Fact]
    public async Task InvokeAsync_AdminPrincipalMutation_PushesAuditLogContext()
    {
        var sink = new CollectingSink();
        ILogger previous = Log.Logger;
        Log.Logger = new LoggerConfiguration()
            .Enrich.FromLogContext()
            .WriteTo.Sink(sink)
            .CreateLogger();

        try
        {
            var middleware = new RequestAuditContextMiddleware(_ =>
            {
                Log.Information("admin mutation");
                return Task.CompletedTask;
            });
            var context = new DefaultHttpContext();
            context.TraceIdentifier = "trace-admin";
            context.Request.Method = HttpMethods.Post;
            context.Request.Path = "/api/binary/admin/users/12";
            context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
            context.Request.Headers.UserAgent = "FsusBrowser/1.0";
            context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, "12"),
                new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                new Claim("admin_id", "12")
            ], "test"));

            await middleware.InvokeAsync(context);

            LogEvent logEvent = Assert.Single(sink.Events);
            Assert.Equal("\"admin\"", logEvent.Properties[AuditPropertyNames.ActorType].ToString());
            Assert.Equal("\"12\"", logEvent.Properties[AuditPropertyNames.ActorId].ToString());
            Assert.Equal("\"12\"", logEvent.Properties["AdminPrincipalId"].ToString());
            Assert.DoesNotContain("UserId", logEvent.Properties.Keys);
            Assert.Equal("\"trace-admin\"", logEvent.Properties["TraceId"].ToString());
            Assert.Contains("IpHash", logEvent.Properties.Keys);
        }
        finally
        {
            Log.Logger = previous;
        }
    }

    private sealed class CollectingSink : ILogEventSink
    {
        public List<LogEvent> Events { get; } = [];

        public void Emit(LogEvent logEvent) => Events.Add(logEvent);
    }
}
