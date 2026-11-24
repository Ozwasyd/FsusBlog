namespace FsusBlog.V2.Server.Content;

internal static class SubscriptionEndpoints
{
    internal const string PagePath = "/subscribe";
    private const string RatePolicy = "subscription-preference";

    internal static void AddRateLimits(RateLimiterOptions options) =>
        options.AddPolicy(RatePolicy, ctx => RateLimitPartition.GetFixedWindowLimiter(
            ctx.Connection.RemoteIpAddress, _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 8, Window = TimeSpan.FromMinutes(1), QueueLimit = 0
            }));

    internal static void Map(WebApplication app, SubscriptionIdentity identity, string origin)
    {
        app.MapGet(PagePath, (HttpContext ctx) =>
        {
            CheckOrigin(ctx, origin);
            ctx.Response.Headers.CacheControl = "no-store";
            ctx.Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
            ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
            return Results.Bytes(app.Services.GetRequiredService<WebPages>().Page(), "text/html; charset=utf-8");
        });

        Map(WireRoutes.SubscriptionEnroll, cancel: false);
        Map(WireRoutes.SubscriptionCancel, cancel: true);

        void Map(string path, bool cancel) => app.MapPost(path, async (HttpContext ctx, NpgsqlDataSource source, InstanceLease lease,
            CancellationToken ct) =>
        {
            CheckOrigin(ctx, origin);
            if (ctx.Request.QueryString.HasValue) throw Invalid();
            var input = Wire.DecodeSubscriptionPreferenceRequest(await ServerHttp.ReadFrame(ctx, WireLimits.MaxSubscriptionPreferenceFrameBytes, ct));
            if (input.Channel is not (SubscriptionIdentity.RssChannel or SubscriptionIdentity.EmailChannel) ||
                identity.EmailKey(input.Email) is not { } emailKey) throw Invalid();
            var channel = (short)input.Channel;
            var header = ctx.Request.Headers[WireHeaders.SubscriptionProof];
            byte[]? proof = null;
            if (cancel)
            {
                if (header.Count != 1 || (proof = SubscriptionIdentity.ProofDigest(header[0])) is null) throw Invalid();
            }
            else if (header.Count != 0) throw Invalid();

            await InstanceLease.RunProtected(source, lease, async (db, tx) =>
            {
                if (proof is not null)
                {
                    // Check expiry after admission to the matching row, including time spent waiting for its lock.
                    await SqlCommands.Scalar(db, tx, ct, """
                        select 1 from public.site_subscription
                        where email_key=$1 and channel=$2 and enabled and proof_digest=$3 for update
                        """, emailKey, channel, proof);
                    await SqlCommands.Execute(db, tx, ct, """
                        update public.site_subscription set enabled=false,unsubscribed_at=clock_timestamp(),proof_digest=null,proof_expires_at=null
                        where email_key=$1 and channel=$2 and enabled and proof_digest=$3 and proof_expires_at>clock_timestamp()
                        """, emailKey, channel, proof);
                }
                else
                {
                    await SqlCommands.Execute(db, tx, ct, """
                        insert into public.site_subscription(email_key,channel,enabled,created_at)
                        values($1,$2,true,clock_timestamp()) on conflict(email_key) do nothing
                        """, emailKey, channel);
                }
            }, ct);
            return ServerHttp.EmptyFrame();
        }).RequireRateLimiting(RatePolicy);
    }

    private static void CheckOrigin(HttpContext ctx, string origin)
    {
        var authority = ctx.Request.Host;
        if (authority.Port == 443) authority = new HostString(authority.Host);
        if (!ctx.Request.IsHttps || !string.Equals($"https://{authority}", origin, StringComparison.OrdinalIgnoreCase))
            throw new BusinessException(Rejection.NotFound, "This route is unavailable on the current origin.");
    }

    private static BusinessException Invalid() => new(Rejection.Invalid, "Invalid subscription preference request.");
}
