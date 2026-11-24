namespace FsusBlog.V2.Server.Sessions;

internal static class SiteSessions
{
    private static readonly byte[] IdDomain = "FsusBlog v2 site session v1"u8.ToArray();
    private static readonly byte[] ContinuityDomain = "FsusBlog v2 site session continuity v1"u8.ToArray();

    internal static Task<SiteSessionList> List(Store store, string? token, string? expectedCurrent, CancellationToken ct,
        bool persistent = false) =>
        store.WithSession(token, false, async (db, tx, actor) =>
        {
            var digest = Store.TokenDigest(token)!;
            RequireCurrent(actor.Id, digest, expectedCurrent);
            var expiry = Lifetime(persistent);
            var rows = await SqlCommands.QueryList(db, tx, ct, $"""
                select s.digest,{expiry} as expires,s.passkey_credential_id is not null,s.totp_verified_at is not null
                from public.user_session s
                where s.user_id=$1 and s.generation=$2 and (s.digest=$3 or {expiry}>statement_timestamp())
                order by (s.digest=$3) desc,expires desc,s.digest limit $4
                """, reader =>
            {
                var row = reader.GetFieldValue<byte[]>(0);
                return new SiteSessionRow(Id(actor.Id, row), reader.GetUnixMilliseconds(1),
                    row.AsSpan().SequenceEqual(digest), reader.GetBoolean(2) ? 2 : 1, reader.GetBoolean(3));
            }, actor.Id, actor.Generation, digest, WireLimits.SiteSessionListSize + 1);
            var hasMore = rows.Count > WireLimits.SiteSessionListSize;
            if (hasMore) rows.RemoveAt(WireLimits.SiteSessionListSize);
            return new SiteSessionList(rows, hasMore);
        }, ct);

    internal static Task Revoke(Store store, string? token, string? expectedCurrent, string? target, CancellationToken ct,
        bool persistent = false) =>
        store.WithSessionForAccountUpdate(token, async (db, tx, actor) =>
        {
            var digest = Store.TokenDigest(token)!;
            RequireCurrent(actor.Id, digest, expectedCurrent);
            if (target is null)
                return await SqlCommands.Execute(db, tx, ct, "delete from public.user_session where user_id=$1 and digest<>$2", actor.Id, digest);
            if (!Wire.ValidSiteSessionId(target)) throw NotFound();
            if (target == expectedCurrent) throw new BusinessException(Rejection.Conflict, "Use log out to end this browser session.");
            var removed = await SqlCommands.Execute(db, tx, ct, $"""
                delete from public.user_session s where s.user_id=$1 and s.generation=$2 and {Lifetime(persistent)}>clock_timestamp()
                and pg_catalog.sha256($3 || pg_catalog.uuid_send(s.user_id) || s.digest)=$4
                """, actor.Id, actor.Generation, IdDomain, Convert.FromHexString(target));
            return removed == 1 ? removed : throw NotFound();
        }, ct);

    private static string Lifetime(bool persistent) => persistent
        ? "coalesce((select idle_expires_at from public.site_session_refresh where access_digest=s.digest),s.expires_at)"
        : "s.expires_at";

    internal static string Id(Guid account, byte[] digest)
    {
        Span<byte> input = stackalloc byte[IdDomain.Length + 16 + 32];
        IdDomain.AsSpan().CopyTo(input);
        account.TryWriteBytes(input[IdDomain.Length..], bigEndian: true, out _);
        digest.AsSpan().CopyTo(input[(IdDomain.Length + 16)..]);
        return Convert.ToHexStringLower(SHA256.HashData(input));
    }

    internal static string Continuity(Guid account, Guid family)
    {
        Span<byte> input = stackalloc byte[ContinuityDomain.Length + 32];
        ContinuityDomain.CopyTo(input);
        account.TryWriteBytes(input[ContinuityDomain.Length..], bigEndian: true, out _);
        family.TryWriteBytes(input[(ContinuityDomain.Length + 16)..], bigEndian: true, out _);
        return Convert.ToHexStringLower(SHA256.HashData(input));
    }

    internal static void IfCurrent(Guid account, string? token, string? expected)
    {
        if (expected is not null) RequireCurrent(account, Store.TokenDigest(token)!, expected);
    }

    internal static string? Requested(HttpContext ctx) => ctx.Request.Headers.TryGetValue(WireHeaders.CurrentSession, out var header)
        ? header.Count == 1 ? header[0] ?? "" : "" : null;

    internal static Task<T> WithCurrentAuthor<T>(Store store, string? token, string? expected,
        Func<NpgsqlConnection, NpgsqlTransaction, Identity, byte[], Task<T>> execute, CancellationToken ct) =>
        store.WithSession(token, true, (db, tx, actor) =>
        {
            var digest = Store.TokenDigest(token)!;
            RequireCurrent(actor.Id, digest, expected);
            return execute(db, tx, actor, digest);
        }, ct);

    internal static void RequireCurrent(Guid account, byte[] digest, string? expected)
    {
        if (!Wire.ValidSiteSessionId(expected) || expected != Id(account, digest))
            throw new BusinessException(Rejection.Conflict, "The current browser session changed. Reload before making changes.");
    }

    private static BusinessException NotFound() => new(Rejection.NotFound, "Site session not found.");
}

internal static class SiteSessionEndpoints
{
    internal static void Map(WebApplication app, string sessionName, bool persistent = false)
    {
        app.MapCommandGet(WireRoutes.SiteSessions, async (HttpContext ctx, Store store, CancellationToken ct) =>
            ServerHttp.Frame(Wire.EncodeSiteSessions(await SiteSessions.List(store, ctx.Request.Cookies[sessionName], Current(ctx), ct, persistent))));
        app.MapCommandPost(WireRoutes.SiteSessionRevoke, (HttpContext ctx, Store store, string id, CancellationToken ct) => Revoke(ctx, store, id, ct));
        app.MapCommandPost(WireRoutes.SiteSessionsRevokeOthers, (HttpContext ctx, Store store, CancellationToken ct) => Revoke(ctx, store, null, ct));

        async Task<IResult> Revoke(HttpContext ctx, Store store, string? target, CancellationToken ct)
        {
            await SiteSessions.Revoke(store, ctx.Request.Cookies[sessionName], Current(ctx), target, ct, persistent);
            return ServerHttp.EmptyFrame();
        }
    }

    private static string? Current(HttpContext ctx) => ctx.Request.Headers[WireHeaders.CurrentSession] is { Count: 1 } value ? value[0] : null;
}

internal static class SiteDisplayNames
{
    internal static Task<SiteDisplayNameState> Read(Store store, string? token, string? expectedCurrent, CancellationToken ct) =>
        store.WithSession(token, false, async (db, tx, actor) =>
        {
            SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expectedCurrent);
            return new SiteDisplayNameState(await SqlCommands.Scalar(db, tx, ct,
                "select display_name from public.comment_public_handle where user_id = $1", actor.Id) as string ?? "");
        }, ct);

    internal static Task<SiteDisplayNameState> Update(Store store, string? token, string? expectedCurrent,
        SiteDisplayNameCommand command, CancellationToken ct)
    {
        var normalized = Normalize(command.DisplayName);
        return store.WithSessionForAccountUpdate(token, async (db, tx, actor) =>
        {
            SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expectedCurrent);
            await SqlCommands.Execute(db, tx, ct, """
                insert into public.comment_public_handle(user_id, display_name) values ($1, $2)
                on conflict (user_id) do update set display_name = excluded.display_name
                """, actor.Id, normalized);
            return new SiteDisplayNameState(normalized);
        }, ct);
    }

    internal static string Normalize(string? value)
    {
        var trimmed = (value ?? "").Trim();
        if (trimmed.Length == 0) throw new BusinessException(Rejection.Invalid, "Display name must not be empty.");
        var runes = 0;
        foreach (var rune in trimmed.EnumerateRunes())
        {
            if (Rune.IsControl(rune)) throw new BusinessException(Rejection.Invalid, "Display name must not contain control characters.");
            if (++runes > WireLimits.SiteDisplayNameChars) throw new BusinessException(Rejection.Invalid, "Display name is too long.");
        }
        if (Encoding.UTF8.GetByteCount(trimmed) > WireLimits.PublicCommentHandleBytes)
            throw new BusinessException(Rejection.Invalid, "Display name exceeds byte limit.");
        return trimmed;
    }
}

internal static class SiteDisplayNameEndpoints
{
    internal static void Map(WebApplication app, string sessionName)
    {
        app.MapCommandGet(WireRoutes.SiteDisplayName, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "private, no-store";
            return ServerHttp.Frame(Wire.EncodeSiteDisplayNameState(
                await SiteDisplayNames.Read(store, ctx.Request.Cookies[sessionName], SiteSessions.Requested(ctx), ct)));
        });
        app.MapCommandPost(WireRoutes.SiteDisplayName, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "private, no-store";
            var command = Wire.DecodeSiteDisplayNameCommand(await ServerHttp.ReadFrame(ctx, WireLimits.SiteDisplayNameFrameBytes, ct));
            return ServerHttp.Frame(Wire.EncodeSiteDisplayNameState(
                await SiteDisplayNames.Update(store, ctx.Request.Cookies[sessionName], SiteSessions.Requested(ctx), command, ct)));
        });
    }
}
