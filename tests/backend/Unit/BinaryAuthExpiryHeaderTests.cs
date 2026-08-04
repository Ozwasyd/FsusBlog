using System.Globalization;
using System.Reflection;
using System.Security.Claims;

using FsusBlog.Server.Modules.Endpoints.Binary;

using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BinaryAuthExpiryHeaderTests
{
    private const string HeaderName = "X-Fsus-Access-Expires-At-Utc";
    private static readonly DateTimeOffset s_businessNow =
        new(2024, 2, 29, 23, 59, 59, TimeSpan.Zero);
    private static readonly MethodInfo s_tryWriteAccessExpiryHeader = typeof(BinaryEndpoints).GetMethod(
        "TryWriteAccessExpiryHeader",
        BindingFlags.NonPublic | BindingFlags.Static)
        ?? throw new InvalidOperationException("Binary auth access-expiry helper was not found.");

    [Fact]
    public void TryWriteAccessExpiryHeader_UsesValidatedPrincipalExpiry()
    {
        DateTimeOffset expiresAtUtc = s_businessNow.AddMinutes(10);
        var context = CreateContext(expiresAtUtc.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture));

        bool written = Invoke(context, new FixedTimeProvider(s_businessNow));

        Assert.True(written);
        Assert.True(DateTimeOffset.TryParseExact(
            context.Response.Headers[HeaderName],
            "O",
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal,
            out DateTimeOffset actual));
        Assert.Equal(expiresAtUtc.ToUnixTimeSeconds(), actual.ToUnixTimeSeconds());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("not-a-unix-time")]
    [InlineData("0")]
    public void TryWriteAccessExpiryHeader_RejectsMissingInvalidOrExpiredPrincipalExpiry(string? rawExpiry)
    {
        var context = CreateContext(rawExpiry);

        bool written = Invoke(context, new FixedTimeProvider(s_businessNow));

        Assert.False(written);
        Assert.False(context.Response.Headers.ContainsKey(HeaderName));
    }

    private static DefaultHttpContext CreateContext(string? rawExpiry)
    {
        var context = new DefaultHttpContext();
        context.User = rawExpiry is null
            ? new ClaimsPrincipal(new ClaimsIdentity())
            : new ClaimsPrincipal(new ClaimsIdentity([new Claim("exp", rawExpiry)], "test"));
        return context;
    }

    private static bool Invoke(HttpContext context, TimeProvider timeProvider)
        => Assert.IsType<bool>(s_tryWriteAccessExpiryHeader.Invoke(null, [context, timeProvider]));

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
