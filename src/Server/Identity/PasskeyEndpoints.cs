using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Sessions;
using Microsoft.AspNetCore.Http.Features;

namespace FsusBlog.V2.Server.Passkeys;

internal static class PasskeyEndpoints
{
    private const string ProvisionCookie = "fsus-v2-passkey-ceremony";
    private const string ProvisionCookiePath = "/api/v2/identity/passkey/register";

    internal static void Map(WebApplication app, string sessionCookie,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, RecoveryKeySecret? recoveryKey, bool persistentEnabled)
    {
        var configuration = PasskeyConfiguration.Read(app.Configuration);
        var secrets = TotpSecret.Read(app.Configuration);
        if (configuration is null)
        {
            if (secrets is not null)
                throw new InvalidOperationException("A Passkey relying party is required to enable TOTP.");
            if (recoveryKey is not null)
                throw new InvalidOperationException("A Passkey relying party is required to enable Recovery Keys.");
            if (persistentEnabled)
                throw new InvalidOperationException("A Passkey relying party is required to enable persistent site sessions.");
            return;
        }
        var database = app.Services.GetRequiredService<NpgsqlDataSource>();
        var lease = app.Services.GetRequiredService<InstanceLease>();
        var passkeys = new PasskeyStore(database, configuration, lease);
        var expectedOrigin = configuration.Origin.GetLeftPart(UriPartial.Authority);
        var secure = configuration.Origin.Scheme == "https";
        var refresh = persistentEnabled
            ? new SiteRefreshEndpoints(new SiteRefreshStore(database, lease), sessionCookie, secure, RequireHost, Cookie) : null;
        refresh?.Map(app);

        app.MapGet(WireRoutes.PasskeyAvailability, (HttpContext ctx) =>
        {
            RequireHost(ctx);
            return Results.Bytes(Wire.EncodeEmptySuccess(), Aeds.ContentType);
        });
        app.MapGet(WireRoutes.SitePasskeys, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            RequireHost(ctx);
            var rows = await SitePasskeys.List(store, ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), ct);
            return Results.Bytes(Wire.EncodeSitePasskeys(rows), Aeds.ContentType);
        }).RequireRateLimiting("command");
        app.MapGet(WireRoutes.SitePasskeyManagement, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            RequireHost(ctx);
            ctx.Response.Headers.CacheControl = "private, no-store";
            var rows = await SitePasskeys.Manage(store, ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), ct);
            return Results.Bytes(Wire.EncodeSitePasskeyManagement(rows), Aeds.ContentType);
        }).RequireRateLimiting("command");
        var management = new SiteMfaPostRoutes(app, RequireManagementOrigin);
        management.Post(WireRoutes.SitePasskeyRenameBegin, async (ctx, ct) =>
        {
            var input = Wire.DecodeSitePasskeyRename(await readFrame(ctx, WireLimits.MaxSitePasskeyRenameFrameBytes, ct));
            return Results.Bytes(await passkeys.BeginSitePasskeyRename(ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), input, ct), Aeds.ContentType);
        });
        management.Post(WireRoutes.SitePasskeyRenameComplete, async (ctx, ct) =>
        {
            var input = PasskeyWire.ReadLogin(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false);
            await passkeys.CompleteSitePasskeyRename(ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), input, ct);
            return Results.Bytes(Wire.EncodeEmptySuccess(), Aeds.ContentType);
        });
        management.Post(WireRoutes.SitePasskeyRemoveBegin, async (ctx, ct) =>
        {
            var input = Wire.DecodeSitePasskeyRemove(await readFrame(ctx, WireLimits.MaxSitePasskeyRemoveFrameBytes, ct));
            return Results.Bytes(await passkeys.BeginSitePasskeyRemove(ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), input, ct), Aeds.ContentType);
        });
        management.Post(WireRoutes.SitePasskeyRemoveComplete, async (ctx, ct) =>
        {
            var input = PasskeyWire.ReadLogin(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false);
            if (await passkeys.CompleteSitePasskeyRemove(ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), input, ct))
            {
                ctx.Response.Cookies.Delete(sessionCookie, Cookie("/"));
                SiteRefreshEndpoints.ClearRefreshCookie(ctx);
            }
            return Results.Bytes(Wire.EncodeEmptySuccess(), Aeds.ContentType);
        });
        management.Post(WireRoutes.SitePasskeyEnrollBegin, async (ctx, ct) =>
        {
            if (ctx.Features.Get<IHttpRequestBodyDetectionFeature>()?.CanHaveBody != false)
                throw new BusinessException(Rejection.Invalid, "Passkey enrollment begins without a body.");
            return Results.Bytes(await passkeys.BeginSitePasskeyEnrollment(ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), ct), Aeds.ContentType);
        });
        management.Post(WireRoutes.SitePasskeyEnrollApprove, async (ctx, ct) =>
        {
            var input = PasskeyWire.ReadLogin(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false);
            return Results.Bytes(await passkeys.ApproveSitePasskeyEnrollment(ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), input, ct), Aeds.ContentType);
        });
        management.Post(WireRoutes.SitePasskeyEnrollComplete, async (ctx, ct) =>
        {
            var input = PasskeyWire.ReadProvision(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct));
            await passkeys.CompleteSitePasskeyEnrollment(ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), input, ct);
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
            var (session, number, pending, binding) = await passkeys.CompleteLogin(request, secrets is not null, persistentEnabled, ct);
            if (session is not null) IssueSession(ctx, session);
            if (binding is not null)
            {
                var options = Cookie(WireRoutes.MfaChallengeVerify);
                options.MaxAge = TimeSpan.FromMinutes(5);
                ctx.Response.Cookies.Append(MfaEndpoints.LoginCookie, binding, options);
            }
            return Results.Bytes(PasskeyWire.Authenticated(number, pending), Aeds.ContentType);
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

        if (secrets is not null)
            MfaEndpoints.Map(app, new MfaStore(database, secrets, lease), passkeys, sessionCookie, readFrame, RequireHost,
                IssueSession, Cookie, persistentEnabled);
        if (recoveryKey is not null)
            RecoveryKeyEndpoints.Map(app, passkeys, recoveryKey, sessionCookie, readFrame, RequireHost, Cookie);

        void IssueSession(HttpContext ctx, SiteRefreshStore.Issued session)
        {
            if (refresh is not null) refresh.Issue(ctx, session);
            else
            {
                ctx.Response.Cookies.Append(sessionCookie, session.Access, Cookie("/"));
                SiteRefreshEndpoints.SetAccessExpiry(ctx, session.AccessExpires);
            }
        }

        CookieOptions Cookie(string path) => new() { HttpOnly = true, Secure = secure, SameSite = SameSiteMode.Strict, Path = path };

        void RequireManagementOrigin(HttpContext ctx)
        {
            RequireHost(ctx);
            ctx.Response.Headers.CacheControl = "private, no-store";
            if (ctx.Request.Headers.Origin is not { Count: 1 } origin ||
                !string.Equals(origin[0], expectedOrigin, StringComparison.OrdinalIgnoreCase))
                throw new BusinessException(Rejection.Forbidden, "A same-origin Passkey request is required.");
        }

        void RequireHost(HttpContext ctx)
        {
            var requestOrigin = $"{ctx.Request.Scheme}://{ctx.Request.Host}";
            if (!string.Equals(expectedOrigin, requestOrigin, StringComparison.OrdinalIgnoreCase))
                throw new BusinessException(Rejection.Forbidden, "Passkey request origin is not configured.");
        }
    }
}
