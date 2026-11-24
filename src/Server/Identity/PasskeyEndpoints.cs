namespace FsusBlog.V2.Server.Passkeys;

internal static class PasskeyEndpoints
{
    private const string ProvisionCookie = "fsus-v2-passkey-ceremony";
    private const string ProvisionCookiePath = "/api/v2/identity/passkey/register";

    internal static void Map(WebApplication app, string sessionCookie, SiteCapabilities capabilities)
    {
        var configuration = capabilities.SitePasskey;
        var secrets = TotpSecret.Read(app.Configuration);
        var recoveryKey = capabilities.RecoveryKey;
        var persistentEnabled = capabilities.SitePersistentRefresh;
        var readerRegistration = capabilities.ReaderRegistration;
        if (configuration is null)
        {
            if (readerRegistration)
                throw new InvalidOperationException("A Passkey relying party is required to enable reader registration.");
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
        var adminIdentity = capabilities.AdminIdentity;
        var adminStore = adminIdentity is not null ? new AdminPasskeyStore(database, lease, adminIdentity) : null;
        var adminCookie = adminIdentity is not null ? AdminIdentityEndpoints.SessionCookieName(adminIdentity) : null;
        var expectedOrigin = configuration.Origin.GetLeftPart(UriPartial.Authority);
        var secure = configuration.Origin.Scheme == "https";
        var refresh = persistentEnabled
            ? new SiteRefreshEndpoints(new SiteRefreshStore(database, lease), sessionCookie, secure, RequireHost, Cookie) : null;
        refresh?.Map(app);
        if (readerRegistration)
            ReaderRegistrationEndpoints.Map(app, passkeys, RequireHost, RequireManagementOrigin, Cookie);

        app.MapGet(WireRoutes.PasskeyAvailability, (HttpContext ctx) =>
        {
            RequireHost(ctx);
            return ServerHttp.EmptyFrame();
        });
        app.MapCommandGet(WireRoutes.SitePasskeys, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            RequireHost(ctx);
            var rows = await SitePasskeys.List(store, ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), ct);
            return ServerHttp.Frame(Wire.EncodeSitePasskeys(rows));
        });
        app.MapCommandGet(WireRoutes.SitePasskeyManagement, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            RequireHost(ctx);
            ctx.Response.Headers.CacheControl = "private, no-store";
            var rows = await SitePasskeys.Manage(store, ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), ct);
            return ServerHttp.Frame(Wire.EncodeSitePasskeyManagement(rows));
        });
        var management = new SiteMfaPostRoutes(app, RequireManagementOrigin);
        management.Post(WireRoutes.SitePasskeyRenameBegin, async (ctx, ct) =>
        {
            var input = Wire.DecodeSitePasskeyRename(await ServerHttp.ReadFrame(ctx, WireLimits.MaxSitePasskeyRenameFrameBytes, ct));
            return ServerHttp.Frame(await passkeys.BeginSitePasskeyRename(ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), input, ct));
        });
        management.Post(WireRoutes.SitePasskeyRenameComplete, async (ctx, ct) =>
        {
            var input = PasskeyWire.ReadLogin(await ServerHttp.ReadFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false);
            await passkeys.CompleteSitePasskeyRename(ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), input, ct);
            return ServerHttp.EmptyFrame();
        });
        management.Post(WireRoutes.SitePasskeyRemoveBegin, async (ctx, ct) =>
        {
            var input = Wire.DecodeSitePasskeyRemove(await ServerHttp.ReadFrame(ctx, WireLimits.MaxSitePasskeyRemoveFrameBytes, ct));
            return ServerHttp.Frame(await passkeys.BeginSitePasskeyRemove(ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), input, ct));
        });
        management.Post(WireRoutes.SitePasskeyRemoveComplete, async (ctx, ct) =>
        {
            var input = PasskeyWire.ReadLogin(await ServerHttp.ReadFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false);
            if (await passkeys.CompleteSitePasskeyRemove(ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), input, ct))
            {
                ctx.Response.Cookies.Delete(sessionCookie, Cookie("/"));
                SiteRefreshEndpoints.ClearRefreshCookie(ctx);
            }
            return ServerHttp.EmptyFrame();
        });
        management.Post(WireRoutes.SitePasskeyEnrollBegin, async (ctx, ct) =>
        {
            if (ctx.Features.Get<IHttpRequestBodyDetectionFeature>()?.CanHaveBody != false)
                throw new BusinessException(Rejection.Invalid, "Passkey enrollment begins without a body.");
            return ServerHttp.Frame(await passkeys.BeginSitePasskeyEnrollment(ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), ct));
        });
        management.Post(WireRoutes.SitePasskeyEnrollApprove, async (ctx, ct) =>
        {
            var input = PasskeyWire.ReadLogin(await ServerHttp.ReadFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false);
            return ServerHttp.Frame(await passkeys.ApproveSitePasskeyEnrollment(ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), input, ct));
        });
        management.Post(WireRoutes.SitePasskeyEnrollComplete, async (ctx, ct) =>
        {
            var input = PasskeyWire.ReadProvision(await ServerHttp.ReadFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct));
            await passkeys.CompleteSitePasskeyEnrollment(ctx.Request.Cookies[sessionCookie], SiteSessions.Requested(ctx), input, ct);
            return ServerHttp.EmptyFrame();
        });
        app.MapPost(WireRoutes.PasskeyLoginBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequireHost(ctx);
            return ServerHttp.Frame(await passkeys.BeginLogin(ct));
        }).RequireRateLimiting("sign-in");
        app.MapPost(WireRoutes.PasskeyLoginComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequireHost(ctx);
            var request = PasskeyWire.ReadLogin(await ServerHttp.ReadFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct));
            var allowAdmin = adminStore is not null && AdminIdentityEndpoints.IsAdminOrigin(ctx, adminIdentity);
            var result = await passkeys.CompleteLogin(request, secrets is not null, persistentEnabled, allowAdmin ? adminStore : null, ct);
            if (result.AdminToken is not null)
            {
                ctx.Response.Cookies.Append(adminCookie!, result.AdminToken, Cookie("/"));
                return ServerHttp.Frame(PasskeyWire.AuthenticatedAdministrator());
            }
            if (result.ReaderSession is not null) IssueSession(ctx, result.ReaderSession);
            if (result.MfaBinding is not null)
            {
                var options = Cookie(WireRoutes.MfaChallengeVerify);
                options.MaxAge = TimeSpan.FromMinutes(5);
                ctx.Response.Cookies.Append(MfaEndpoints.LoginCookie, result.MfaBinding, options);
            }
            return ServerHttp.Frame(PasskeyWire.Authenticated(result.AccountNumber, result.MfaToken));
        }).RequireRateLimiting("sign-in");

        app.MapPost(WireRoutes.PasskeyProvisionBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequireHost(ctx);
            var request = Wire.DecodeSignIn(await ServerHttp.ReadFrame(ctx, WireLimits.MaxSignInFrameBytes, ct));
            var (frame, binding) = await passkeys.BeginProvision(request.Ticket, ct);
            var options = Cookie(ProvisionCookiePath);
            options.MaxAge = TimeSpan.FromMinutes(5);
            ctx.Response.Cookies.Append(ProvisionCookie, binding, options);
            return ServerHttp.Frame(frame);
        }).RequireRateLimiting("sign-in");
        app.MapPost(WireRoutes.PasskeyProvisionComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequireHost(ctx);
            var request = PasskeyWire.ReadProvision(await ServerHttp.ReadFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct));
            var binding = ctx.Request.Cookies[ProvisionCookie];
            ctx.Response.Cookies.Delete(ProvisionCookie, Cookie(ProvisionCookiePath));
            await passkeys.CompleteProvision(request, binding, ct);
            ctx.Response.Cookies.Delete(sessionCookie, Cookie("/"));
            return ServerHttp.EmptyFrame();
        }).RequireRateLimiting("sign-in");

        if (secrets is not null)
            MfaEndpoints.Map(app, new MfaStore(database, secrets, lease), passkeys, sessionCookie, RequireHost,
                IssueSession, Cookie, persistentEnabled);
        if (recoveryKey is not null)
            RecoveryKeyEndpoints.Map(app, passkeys, recoveryKey, sessionCookie, RequireHost, Cookie);

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
