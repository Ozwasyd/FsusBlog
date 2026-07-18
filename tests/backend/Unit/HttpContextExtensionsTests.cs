using System.Net;

using FsusBlog.Server.Infrastructure.Helpers;

using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests;

public sealed class HttpContextExtensionsTests
{
    [Fact]
    public void GetClientIp_IgnoresSpoofedForwardedHeaders()
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
        context.Request.Headers["X-Forwarded-For"] = "127.0.0.1";
        context.Request.Headers["X-Real-IP"] = "127.0.0.1";

        string clientIp = context.GetClientIp();

        Assert.Equal("198.51.100.17", clientIp);
    }

    [Fact]
    public void GetClientIp_NormalizesIpv6Loopback()
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.IPv6Loopback;

        string clientIp = context.GetClientIp();

        Assert.Equal("127.0.0.1", clientIp);
    }

    [Fact]
    public void GetUserAgent_UsesFirstHeaderValueAndTruncates()
    {
        var context = new DefaultHttpContext();
        context.Request.Headers.UserAgent = new Microsoft.Extensions.Primitives.StringValues([new string('a', 700), "second-agent"]);

        string userAgent = context.GetUserAgent();

        Assert.Equal(512, userAgent.Length);
        Assert.All(userAgent, static ch => Assert.Equal('a', ch));
    }
}
