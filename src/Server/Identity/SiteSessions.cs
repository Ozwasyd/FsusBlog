using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Sessions;

internal static class SiteSessions
{
    private static readonly byte[] IdDomain = "FsusBlog v2 site session v1"u8.ToArray();
    internal static Task<SiteSessionList> List(Store store, string? token, string? expectedCurrent, CancellationToken ct) =>
        store.WithSession(token, false, async (db, tx, actor) =>
        {
            var digest = Store.TokenDigest(token)!;
            RequireCurrent(actor.Id, digest, expectedCurrent);
            await using var query = Store.Sql(db, tx, """
                select digest,expires_at,passkey_credential_id is not null,totp_verified_at is not null
                from public.user_session
                where user_id=$1 and generation=$2 and (digest=$3 or expires_at>statement_timestamp())
                order by (digest=$3) desc,expires_at desc,digest
                limit $4
                """, actor.Id, actor.Generation, digest, WireLimits.SiteSessionListSize + 1);
            var rows = new List<SiteSessionRow>();
            await using var reader = await query.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                if (rows.Count == WireLimits.SiteSessionListSize) return new SiteSessionList(rows, true);
                var row = reader.GetFieldValue<byte[]>(0);
                rows.Add(new(Id(actor.Id, row), reader.GetFieldValue<DateTimeOffset>(1).ToUnixTimeMilliseconds(),
                    row.AsSpan().SequenceEqual(digest), reader.GetBoolean(2) ? 2 : 1, reader.GetBoolean(3)));
            }
            return new SiteSessionList(rows, false);
        }, ct);

    internal static Task Revoke(Store store, string? token, string? expectedCurrent, string? target, CancellationToken ct) =>
        store.WithSessionForAccountUpdate(token, async (db, tx, actor) =>
        {
            var digest = Store.TokenDigest(token)!;
            RequireCurrent(actor.Id, digest, expectedCurrent);
            if (target is null)
            {
                await using var others = Store.Sql(db, tx, """
                    delete from public.user_session where user_id=$1 and digest<>$2
                    """, actor.Id, digest);
                return await others.ExecuteNonQueryAsync(ct);
            }

            if (!Wire.ValidSiteSessionId(target)) throw NotFound();
            if (target == expectedCurrent) throw new BusinessException(Rejection.Conflict, "Use log out to end this browser session.");
            await using var revoke = Store.Sql(db, tx, """
                delete from public.user_session where user_id=$1 and generation=$2 and expires_at>clock_timestamp()
                and pg_catalog.sha256($3 || pg_catalog.uuid_send(user_id) || digest)=$4
                """, actor.Id, actor.Generation, IdDomain, Convert.FromHexString(target));
            var removed = await revoke.ExecuteNonQueryAsync(ct);
            if (removed != 1) throw NotFound();
            return removed;
        }, ct);

    internal static string Id(Guid account, byte[] digest)
    {
        Span<byte> input = stackalloc byte[IdDomain.Length + 16 + 32];
        IdDomain.AsSpan().CopyTo(input);
        account.TryWriteBytes(input[IdDomain.Length..], bigEndian: true, out _);
        digest.AsSpan().CopyTo(input[(IdDomain.Length + 16)..]);
        return Convert.ToHexStringLower(SHA256.HashData(input));
    }

    internal static void RequireCurrent(Guid account, byte[] digest, string? expected)
    {
        if (!Wire.ValidSiteSessionId(expected) || expected != Id(account, digest))
            throw new BusinessException(Rejection.Conflict, "The current browser session changed. Reload before making changes.");
    }

    private static BusinessException NotFound() => new(Rejection.NotFound, "Site session not found.");
}
