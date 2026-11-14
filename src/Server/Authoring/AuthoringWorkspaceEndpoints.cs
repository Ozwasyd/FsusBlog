using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal static class AuthoringWorkspaceEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapGet(WireRoutes.AuthoringWorkspace, (HttpContext ctx, Store store, CancellationToken ct) =>
            Run(ctx, store, null, ct)).RequireRateLimiting("command");
        app.MapPost(WireRoutes.AuthoringWorkspace, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var input = Wire.DecodeAuthoringWorkspaceCommand(await readFrame(ctx, WireLimits.MaxAuthoringWorkspaceFrameBytes, ct));
            return await Run(ctx, store, input, ct);
        }).RequireRateLimiting("command");

        Task<IResult> Run(HttpContext ctx, Store store, AuthoringWorkspaceCommand? input, CancellationToken ct)
        {
            var token = ctx.Request.Cookies[cookie];
            var expectedSession = ctx.Request.Headers[WireHeaders.CurrentSession] is { Count: 1 } header ? header[0] : null;
            return store.WithSession<IResult>(token, true, async (db, tx, actor) =>
            {
                SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expectedSession);
                await using var schema = Store.Sql(db, tx, "select pg_catalog.to_regclass($1) is not null", CurrentSchema.AuthoringWorkspaceRelation);
                if (await schema.ExecuteScalarAsync(ct) is not true)
                    throw new BusinessException(Rejection.NotFound, "Workspace layout storage is unavailable.");
                var snapshot = input is null ? await Read(db, tx, actor.Id, ct) : await Write(db, tx, actor.Id, input, ct);
                return Results.Bytes(Wire.EncodeAuthoringWorkspaceSnapshot(snapshot), Aeds.ContentType);
            }, ct);
        }
    }

    private static async Task<AuthoringWorkspaceSnapshot> Read(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, CancellationToken ct)
    {
        int schema;
        long revision;
        long updated;
        int active;
        int[] tabs;
        await using (var cmd = Store.Sql(db, tx, """
            select schema_version,revision,updated_at,active_article_id,tabs from public.authoring_workspace where user_id=$1
            """, owner))
        await using (var row = await cmd.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) return new(1, 0, 0, 0, [], 0);
            schema = row.GetInt32(0);
            revision = row.GetInt64(1);
            updated = row.GetFieldValue<DateTimeOffset>(2).ToUnixTimeMilliseconds();
            active = row.GetInt32(3);
            tabs = row.GetFieldValue<int[]>(4);
        }

        // Fail closed on malformed persisted records without resetting their revision or touching any drafts.
        try { Wire.Validate(new AuthoringWorkspaceSnapshot(schema, revision, updated, active, tabs, 0)); }
        catch (ProtocolException)
        {
            throw new BusinessException(Rejection.Conflict, "The saved workspace layout cannot be restored.");
        }
        var allowed = await OwnedTabs(db, tx, owner, tabs, ct);
        return new(schema, revision, updated, allowed.Any(tab => Math.Abs(tab) == active) ? active : 0, allowed,
            tabs.Length - allowed.Length);
    }

    private static async Task<AuthoringWorkspaceSnapshot> Write(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        AuthoringWorkspaceCommand input, CancellationToken ct)
    {
        // The article query never acquires article row locks. Workspace CAS owns only the layout row.
        var tabs = await OwnedTabs(db, tx, owner, input.Tabs, ct);
        var active = tabs.Any(tab => Math.Abs(tab) == input.ActiveArticleId) ? input.ActiveArticleId : 0;
        var expected = input.ExpectedRevision;
        await using var cmd = expected == 0
            ? Store.Sql(db, tx, """
                insert into public.authoring_workspace(user_id,schema_version,revision,updated_at,active_article_id,tabs)
                values ($1,1,1,clock_timestamp(),$2,$3) on conflict (user_id) do nothing returning revision,updated_at
                """, owner, active, tabs)
            : Store.Sql(db, tx, """
                update public.authoring_workspace set revision=revision+1,updated_at=clock_timestamp(),active_article_id=$2,tabs=$3
                where user_id=$1 and revision=$4 returning revision,updated_at
                """, owner, active, tabs, expected);
        await using var row = await cmd.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct))
            throw new BusinessException(Rejection.Conflict, "The workspace layout changed in another session.");
        return new(1, row.GetInt64(0), row.GetFieldValue<DateTimeOffset>(1).ToUnixTimeMilliseconds(), active, tabs,
            input.Tabs.Count - tabs.Length);
    }

    private static async Task<int[]> OwnedTabs(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        IReadOnlyList<int> tabs, CancellationToken ct)
    {
        if (tabs.Count == 0) return [];
        await using var query = Store.Sql(db, tx, "select id from public.article where owner_id=$1 and not deleted and id=any($2)",
            owner, tabs.Select(Math.Abs).ToArray());
        await using var rows = await query.ExecuteReaderAsync(ct);
        var allowed = new HashSet<int>();
        while (await rows.ReadAsync(ct)) allowed.Add(rows.GetInt32(0));
        return tabs.Where(tab => allowed.Contains(Math.Abs(tab))).ToArray();
    }
}
