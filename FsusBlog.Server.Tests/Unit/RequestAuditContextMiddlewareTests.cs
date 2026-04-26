using System.Net;
using System.Security.Claims;
using FsusBlog.Server.Infrastructure.Audit;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests;

public sealed class RequestAuditContextMiddlewareTests
{
    [Fact]
    public void RequestAuditContextSnapshot_FromHttpContext_ExtractsTraceUserAndProxyAwareIp()
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
        Assert.Equal("12", properties["UserId"]);
        Assert.Equal("binaryadmin", properties["Username"]);
        Assert.Equal("203.0.113.10", properties["ClientIp"]);
        Assert.Equal("FsusBrowser/1.0", properties["UserAgent"]);
    }
}
