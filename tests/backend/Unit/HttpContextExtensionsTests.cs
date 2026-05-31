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
}
