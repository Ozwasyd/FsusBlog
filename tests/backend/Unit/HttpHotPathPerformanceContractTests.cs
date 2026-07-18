using System.Net;
using System.Security.Claims;

using FsusBlog.Server.Infrastructure;
using FsusBlog.Server.Infrastructure.Audit;
using Microsoft.AspNetCore.Http;
namespace FsusBlog.Server.Tests.Unit;

public sealed class HttpHotPathPerformanceContractTests
{
    [Fact]
    public void RequestAuditSnapshot_ProducesStableLowerHexHashesAndCachesParsedIdentity()
    {
        var context = new DefaultHttpContext();
        context.TraceIdentifier = "trace-hot-path";
        context.Request.Method = HttpMethods.Post;
        context.Request.Path = "/api/binary/comment";
        context.Request.Headers.UserAgent = "FsusBlog/benchmark";
        context.Request.Headers["X-Fsus-Device-Fp"] = "device-fingerprint";
        context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.10");
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, "42")],
            "benchmark"));

        RequestAuditContextSnapshot first = RequestAuditContextSnapshot.FromHttpContext(context);
        RequestAuditContextSnapshot second = RequestAuditContextSnapshot.FromHttpContext(context);

        Assert.Equal("user", first.ActorType);
        Assert.Equal("42", first.AccountId);
        Assert.Equal(first.IpHash, second.IpHash);
        Assert.Equal(first.UserAgentHash, second.UserAgentHash);
        Assert.Equal(64, first.IpHash?.Length);
        Assert.Equal(first.IpHash, first.IpHash?.ToLowerInvariant());
        Assert.Equal(42L, FastUserIdProvider.GetOrParseUserId(context));
        Assert.True(context.Items.ContainsKey(FastUserIdProvider.ParsedUserIdItemKey));
    }

    [Theory]
    [InlineData("GET", "/", false)]
    [InlineData("HEAD", "/articles", false)]
    [InlineData("POST", "/api/binary/comment", true)]
    [InlineData("GET", "/api/binary/auth/profile", true)]
    [InlineData("GET", "/api/admin/stats", true)]
    public void RequestAuditGate_AttachesOnlyToStatefulOrSensitiveRequests(string method, string path, bool expected)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = path;

        Assert.Equal(expected, RequestAuditContextMiddleware.ShouldAttachAuditContext(context));
    }
}
