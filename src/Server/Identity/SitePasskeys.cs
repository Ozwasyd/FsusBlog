namespace FsusBlog.V2.Server.Passkeys;

internal static class SitePasskeys
{
    internal static Task<IReadOnlyList<SitePasskeyRow>> List(Store store, string? token, string? expected, CancellationToken ct) =>
        store.WithSession<IReadOnlyList<SitePasskeyRow>>(token, false, async (db, tx, actor) =>
        {
            var digest = Store.TokenDigest(token)!;
            SiteSessions.RequireCurrent(actor.Id, digest, expected);
            var rows = await SqlCommands.QueryList(db, tx, ct, """
                select c.created_at,c.last_used_at,c.backup_eligible,c.backed_up,(c.credential_id=s.passkey_credential_id) as is_current
                from public.passkey_credential c join public.user_session s on s.user_id=c.user_id
                where c.user_id=$1 and s.digest=$2 and s.passkey_credential_id is not null
                order by is_current desc,c.created_at,c.credential_id limit $3
                """, reader => new SitePasskeyRow(reader.GetUnixMilliseconds(0),
                    reader.IsDBNull(1) ? null : reader.GetUnixMilliseconds(1),
                    reader.GetBoolean(2), reader.GetBoolean(3), reader.GetBoolean(4)),
                actor.Id, digest, WireLimits.SitePasskeyListSize + 1);
            if (rows.Count > WireLimits.SitePasskeyListSize) throw new PublicUnavailableException();
            if (rows.Count == 0)
                throw new BusinessException(Rejection.Unauthorized, "Session or sign-in ticket is invalid or expired.");
            return rows;
        }, ct);

    internal static Task<IReadOnlyList<SitePasskeyManagedRow>> Manage(Store store, string? token, string? expected, CancellationToken ct) =>
        store.WithSession<IReadOnlyList<SitePasskeyManagedRow>>(token, false, async (db, tx, actor) =>
        {
            var digest = Store.TokenDigest(token)!;
            SiteSessions.RequireCurrent(actor.Id, digest, expected);
            return (await Manage(db, tx, actor.Id, digest, ct)).Select(row => row.Value).ToArray();
        }, ct);

    internal static async Task<List<ManagementEntry>> Manage(NpgsqlConnection db, NpgsqlTransaction tx, Guid user,
        byte[] sessionDigest, CancellationToken ct)
    {
        if (!await CurrentSchema.HasSitePasskeyNamesAsync(db, tx, ct))
            throw new BusinessException(Rejection.NotFound, "Passkey names are unavailable.");
        var rows = await SqlCommands.QueryList(db, tx, ct, """
            select c.credential_id,c.created_at,c.last_used_at,c.backup_eligible,c.backed_up,
                   (c.credential_id=s.passkey_credential_id) as is_current,coalesce(n.revision,0),coalesce(n.name,'')
            from public.passkey_credential c join public.user_session s on s.user_id=c.user_id
            left join public.site_passkey_name n on n.credential_id=c.credential_id and n.user_id=c.user_id
            where c.user_id=$1 and s.digest=$2 and s.passkey_credential_id is not null
            order by is_current desc,c.created_at,c.credential_id limit $3
            """, reader =>
        {
            var id = reader.GetFieldValue<byte[]>(0);
            var reference = Convert.ToHexStringLower(HMACSHA256.HashData(sessionDigest.AsSpan(), [.. "FsusBlog v2 site passkey management v1"u8, .. id]));
            var createdAt = reader.GetFieldValue<DateTimeOffset>(1);
            var flags = new SitePasskeyRow(createdAt.ToUnixTimeMilliseconds(),
                reader.IsDBNull(2) ? null : reader.GetUnixMilliseconds(2),
                reader.GetBoolean(3), reader.GetBoolean(4), reader.GetBoolean(5));
            return new ManagementEntry(id, createdAt.UtcTicks, new(reference, reader.GetInt64(6), reader.GetString(7), flags));
        }, user, sessionDigest, WireLimits.SitePasskeyListSize + 1);
        if (rows.Count > WireLimits.SitePasskeyListSize) throw new PublicUnavailableException();
        if (rows.Count == 0 || !rows[0].Value.Metadata.Current)
            throw new BusinessException(Rejection.Unauthorized, "Session or sign-in ticket is invalid or expired.");
        return rows;
    }

    internal sealed record ManagementEntry(byte[] CredentialId, long CreatedAtTicks, SitePasskeyManagedRow Value);
}
