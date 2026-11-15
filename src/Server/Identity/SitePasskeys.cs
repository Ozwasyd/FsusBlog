using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;

namespace FsusBlog.V2.Server.Passkeys;

internal static class SitePasskeys
{
    internal static Task<IReadOnlyList<SitePasskeyRow>> List(Store store, string? token, string? expected, CancellationToken ct) =>
        store.WithSession<IReadOnlyList<SitePasskeyRow>>(token, false, async (db, tx, actor) =>
        {
            var digest = Store.TokenDigest(token)!;
            SiteSessions.RequireCurrent(actor.Id, digest, expected);

            await using var query = Store.Sql(db, tx, """
                select c.created_at,c.last_used_at,c.backup_eligible,c.backed_up,
                       (c.credential_id=s.passkey_credential_id) as is_current
                from public.passkey_credential c
                join public.user_session s on s.user_id=c.user_id
                where c.user_id=$1 and s.digest=$2 and s.passkey_credential_id is not null
                order by is_current desc,c.created_at,c.credential_id
                limit $3
                """, actor.Id, digest, WireLimits.SitePasskeyListSize + 1);
            var rows = new List<SitePasskeyRow>();
            await using var reader = await query.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                if (rows.Count == WireLimits.SitePasskeyListSize) throw new PublicUnavailableException();
                rows.Add(new(reader.GetFieldValue<DateTimeOffset>(0).ToUnixTimeMilliseconds(),
                    reader.IsDBNull(1) ? null : reader.GetFieldValue<DateTimeOffset>(1).ToUnixTimeMilliseconds(),
                    reader.GetBoolean(2), reader.GetBoolean(3), reader.GetBoolean(4)));
            }

            if (rows.Count == 0)
                throw new BusinessException(Rejection.Unauthorized, "Session or sign-in ticket is invalid or expired.");
            return rows;
        }, ct);
}
