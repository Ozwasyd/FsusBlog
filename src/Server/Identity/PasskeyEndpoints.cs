using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;

namespace FsusBlog.V2.Server.Passkeys;

internal static class PasskeyEndpoints
{
    private const string ProvisionCookie = "fsus-v2-passkey-ceremony";
    private const string ProvisionCookiePath = "/api/v2/identity/passkey/register";

    internal static void Map(WebApplication app, string sessionCookie,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var configuration = PasskeyConfiguration.Read(app.Configuration);
        if (configuration is null) return;
        var passkeys = new PasskeyStore(app.Services.GetRequiredService<NpgsqlDataSource>(), configuration);
        var expectedOrigin = configuration.Origin.GetLeftPart(UriPartial.Authority);
        var secure = configuration.Origin.Scheme == "https";

        app.MapGet(WireRoutes.PasskeyAvailability, (HttpContext ctx) =>
        {
            RequireHost(ctx);
            return Results.Bytes(Wire.EncodeEmptySuccess(), Aeds.ContentType);
        });
        app.MapPost(WireRoutes.PasskeyLoginBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequireHost(ctx);
            return Results.Bytes(await passkeys.BeginLogin(ct), Aeds.ContentType);
        }).RequireRateLimiting("sign-in");
        app.MapPost(WireRoutes.PasskeyLoginComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequireHost(ctx);
            var request = PasskeyWire.ReadLogin(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct));
            var (token, number, expires) = await passkeys.CompleteLogin(request, ct);
            ctx.Response.Cookies.Append(sessionCookie, token, Cookie("/"));
            ctx.Response.Headers[WireHeaders.AccessExpiresAtUtc] = expires.UtcDateTime.ToString("O", CultureInfo.InvariantCulture);
            return Results.Bytes(PasskeyWire.Authenticated(number), Aeds.ContentType);
        }).RequireRateLimiting("sign-in");

        app.MapPost(WireRoutes.PasskeyProvisionBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequireHost(ctx);
            var request = Wire.DecodeSignIn(await readFrame(ctx, WireLimits.MaxSignInFrameBytes, ct));
            var (frame, binding) = await passkeys.BeginProvision(request.Ticket, ct);
            var options = Cookie(ProvisionCookiePath);
            options.MaxAge = TimeSpan.FromMinutes(5);
            ctx.Response.Cookies.Append(ProvisionCookie, binding, options);
            return Results.Bytes(frame, Aeds.ContentType);
        }).RequireRateLimiting("sign-in");
        app.MapPost(WireRoutes.PasskeyProvisionComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequireHost(ctx);
            var request = PasskeyWire.ReadProvision(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct));
            var binding = ctx.Request.Cookies[ProvisionCookie];
            ctx.Response.Cookies.Delete(ProvisionCookie, Cookie(ProvisionCookiePath));
            await passkeys.CompleteProvision(request, binding, ct);
            ctx.Response.Cookies.Delete(sessionCookie, Cookie("/"));
            return Results.Bytes(Wire.EncodeEmptySuccess(), Aeds.ContentType);
        }).RequireRateLimiting("sign-in");

        CookieOptions Cookie(string path) => new() { HttpOnly = true, Secure = secure, SameSite = SameSiteMode.Strict, Path = path };

        void RequireHost(HttpContext ctx)
        {
            var requestOrigin = $"{ctx.Request.Scheme}://{ctx.Request.Host}";
            if (!string.Equals(expectedOrigin, requestOrigin, StringComparison.OrdinalIgnoreCase))
                throw new BusinessException(Rejection.Forbidden, "Passkey request origin is not configured.");
        }
    }
}
