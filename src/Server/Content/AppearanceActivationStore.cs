namespace FsusBlog.V2.Server.Content;

internal sealed record AppearanceActivation(long Revision, AppearanceSelection Selected);

internal static class AppearanceActivationStore
{
    internal static async Task<AppearanceActivation> Read(NpgsqlConnection db, NpgsqlTransaction tx,
        AppearanceRegistry registry, CancellationToken ct, bool locked = false)
    {
        var sql = "select revision, theme_digest, font_digest from public.appearance_activation where singleton";
        if (locked) sql += " for update";
        await using var cmd = Store.Sql(db, tx, sql);
        await using var row = await cmd.ExecuteReaderAsync(ct);
        await row.ReadRequired(ct, () => new PublicUnavailableException());
        var revision = row.GetInt64(0);
        return new(revision, revision == 0 ? registry.Default : new(row.GetString(1), row.GetString(2)));
    }

    internal static async Task<AppearanceSelection?> Previous(NpgsqlConnection db, NpgsqlTransaction tx, long revision, CancellationToken ct)
    {
        if (revision == 0) return null;
        await using var cmd = Store.Sql(db, tx, """
            select previous_theme_digest,previous_font_digest from public.appearance_activation_audit where revision=$1
            """, revision);
        await using var row = await cmd.ExecuteReaderAsync(ct);
        await row.ReadRequired(ct, () => new PublicUnavailableException());
        return new(row.GetString(0), row.GetString(1));
    }

    internal static async Task<bool> StillActive(NpgsqlConnection db, NpgsqlTransaction tx, long revision, CancellationToken ct)
    {
        return await SqlCommands.Scalar(db, tx, ct,
            "select revision from public.appearance_activation where singleton for share") is long current && current == revision;
    }

    internal static async Task<AdminAppearanceHistoryPage> History(NpgsqlConnection db, NpgsqlTransaction tx,
        long? before, int limit, CancellationToken ct)
    {
        await using var cmd = Store.Sql(db, tx, """
            select a.revision,a.happened_at,p.handle,a.rollback,a.previous_theme_digest,a.previous_font_digest,a.theme_digest,a.font_digest
            from public.appearance_activation_audit a join public.admin_principal p on p.id=a.principal_id
            where a.revision<=$1 order by a.revision desc limit $2
            """, before is { } coordinate ? coordinate - 1 : long.MaxValue, limit + 1);
        await using var rows = await cmd.ExecuteReaderAsync(ct);
        var items = new List<AdminAppearanceChange>(limit);
        while (await rows.ReadAsync(ct))
        {
            if (items.Count == limit) return new(items[^1].Revision, items);
            items.Add(new(rows.GetInt64(0), new DateTimeOffset(rows.GetDateTime(1)).ToUnixTimeMilliseconds(), rows.GetString(2),
                rows.GetBoolean(3), rows.GetString(4), rows.GetString(5), rows.GetString(6), rows.GetString(7)));
        }
        return new(0, items);
    }

    internal static async Task Change(NpgsqlConnection db, NpgsqlTransaction tx, AppearanceActivation current,
        AppearanceSelection next, Guid principal, bool rollback, CancellationToken ct)
    {
        if (await SqlCommands.Execute(db, tx, ct, """
            with changed as (
                update public.appearance_activation set revision=revision+1, theme_digest=$2, font_digest=$3
                where singleton and revision=$1 returning revision
            )
            insert into public.appearance_activation_audit
                (revision,principal_id,rollback,previous_theme_digest,previous_font_digest,theme_digest,font_digest,happened_at)
            select revision,$4,$5,$6,$7,$2,$3,clock_timestamp() from changed
            """, current.Revision, next.ThemeDigest, next.FontDigest, principal, rollback, current.Selected.ThemeDigest,
            current.Selected.FontDigest) != 1)
            throw new BusinessException(Rejection.Conflict, "The active appearance changed. Reload before applying.");
    }
}
