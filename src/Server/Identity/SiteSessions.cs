using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;

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
            await using var query = Store.Sql(db, tx, $"""
                select s.digest,{expiry} as expires,s.passkey_credential_id is not null,s.totp_verified_at is not null
                from public.user_session s
                where s.user_id=$1 and s.generation=$2 and (s.digest=$3 or {expiry}>statement_timestamp())
                order by (s.digest=$3) desc,expires desc,s.digest
                limit $4
                """, actor.Id, actor.Generation, digest, WireLimits.SiteSessionListSize + 1);
            var rows = new List<SiteSessionRow>();
            await using var reader = await query.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                if (rows.Count == WireLimits.SiteSessionListSize) return new SiteSessionList(rows, true);
                var row = reader.GetFieldValue<byte[]>(0);
                rows.Add(new(Id(actor.Id, row), reader.GetUnixMilliseconds(1),
                    row.AsSpan().SequenceEqual(digest), reader.GetBoolean(2) ? 2 : 1, reader.GetBoolean(3)));
            }
            return new SiteSessionList(rows, false);
        }, ct);

    internal static Task Revoke(Store store, string? token, string? expectedCurrent, string? target, CancellationToken ct,
        bool persistent = false) =>
        store.WithSessionForAccountUpdate(token, async (db, tx, actor) =>
        {
            var digest = Store.TokenDigest(token)!;
            RequireCurrent(actor.Id, digest, expectedCurrent);
            if (target is null)
            {
                return await SqlCommands.Execute(db, tx, ct, """
                    delete from public.user_session where user_id=$1 and digest<>$2
                    """, actor.Id, digest);
            }

            if (!Wire.ValidSiteSessionId(target)) throw NotFound();
            if (target == expectedCurrent) throw new BusinessException(Rejection.Conflict, "Use log out to end this browser session.");
            var removed = await SqlCommands.Execute(db, tx, ct, $"""
                delete from public.user_session s where s.user_id=$1 and s.generation=$2 and {Lifetime(persistent)}>clock_timestamp()
                and pg_catalog.sha256($3 || pg_catalog.uuid_send(s.user_id) || s.digest)=$4
                """, actor.Id, actor.Generation, IdDomain, Convert.FromHexString(target));
            if (removed != 1) throw NotFound();
            return removed;
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
