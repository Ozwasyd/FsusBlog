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
            Run(ctx, store, null, extended: false, ct)).RequireRateLimiting("command");
        app.MapPost(WireRoutes.AuthoringWorkspace, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var input = Wire.DecodeAuthoringWorkspaceCommand(await readFrame(ctx, WireLimits.MaxAuthoringWorkspaceFrameBytes, ct));
            return await Run(ctx, store, input, extended: false, ct);
        }).RequireRateLimiting("command");

        app.MapGet(WireRoutes.AuthoringWorkspaceLayout, (HttpContext ctx, Store store, CancellationToken ct) =>
            Run(ctx, store, null, extended: true, ct)).RequireRateLimiting("command");
        app.MapPost(WireRoutes.AuthoringWorkspaceLayout, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var input = Wire.DecodeAuthoringWorkspaceLayoutCommand(await readFrame(ctx, WireLimits.MaxAuthoringWorkspaceLayoutCommandFrameBytes, ct));
            return await Run(ctx, store, new(1, input.ExpectedRevision, input.ActiveArticleId, input.Tabs), extended: true, ct, input.InspectorOpen);
        }).RequireRateLimiting("command");

        Task<IResult> Run(HttpContext ctx, Store store, AuthoringWorkspaceCommand? input, bool extended, CancellationToken ct, bool? inspector = null)
        {
            var token = ctx.Request.Cookies[cookie];
            var expectedSession = ctx.Request.Headers[WireHeaders.CurrentSession] is { Count: 1 } header ? header[0] : null;
            return store.WithSession<IResult>(token, true, async (db, tx, actor) =>
            {
                SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expectedSession);
                await using var schema = Store.Sql(db, tx, "select pg_catalog.to_regclass($1) is not null", CurrentSchema.AuthoringWorkspaceRelation);
                if (await schema.ExecuteScalarAsync(ct) is not true)
                    throw new BusinessException(Rejection.NotFound, "Workspace layout storage is unavailable.");
                if (extended && !await CurrentSchema.HasAuthoringWorkspaceLayoutAsync(db, tx, ct))
                    throw new BusinessException(Rejection.NotFound, "Workspace layout upgrade is unavailable.");
                var snapshot = input is null ? await Read(db, tx, actor.Id, ct, extended) : await Write(db, tx, actor.Id, input, inspector, ct);
                if (!extended) return Results.Bytes(Wire.EncodeAuthoringWorkspaceSnapshot(snapshot.Legacy), Aeds.ContentType);
                return Results.Bytes(Wire.EncodeAuthoringWorkspaceLayout(new(2, snapshot.Revision, snapshot.UpdatedAtUnixMs,
                    snapshot.ActiveArticleId, snapshot.Tabs, snapshot.Skipped, snapshot.InspectorOpen)), Aeds.ContentType);
            }, ct);
        }
    }

    private sealed record Snapshot(int SchemaVersion, long Revision, long UpdatedAtUnixMs, int ActiveArticleId,
        IReadOnlyList<int> Tabs, int Skipped, bool InspectorOpen)
    {
        internal AuthoringWorkspaceSnapshot Legacy => new(SchemaVersion, Revision, UpdatedAtUnixMs, ActiveArticleId, Tabs, Skipped);
    }

    private static async Task<Snapshot> Read(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, CancellationToken ct, bool extended)
    {
        int schema;
        long revision;
        long updated;
        int active;
        int[] tabs;
        bool inspector;
        await using (var cmd = Store.Sql(db, tx, """
            select schema_version,revision,updated_at,active_article_id,tabs,
            """ + (extended ? "inspector_open" : "false") + " from public.authoring_workspace where user_id=$1", owner))
        await using (var row = await cmd.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) return new(1, 0, 0, 0, [], 0, false);
            schema = row.GetInt32(0);
            revision = row.GetInt64(1);
            updated = row.GetFieldValue<DateTimeOffset>(2).ToUnixTimeMilliseconds();
            active = row.GetInt32(3);
            tabs = row.GetFieldValue<int[]>(4);
            inspector = row.GetBoolean(5);
        }

        // Fail closed on malformed persisted records without resetting their revision or touching any drafts.
        try { Wire.Validate(new AuthoringWorkspaceSnapshot(schema, revision, updated, active, tabs, 0)); }
        catch (ProtocolException)
        {
            throw new BusinessException(Rejection.Conflict, "The saved workspace layout cannot be restored.");
        }
        var allowed = await OwnedTabs(db, tx, owner, tabs, ct);
        return new(schema, revision, updated, allowed.Any(tab => Math.Abs(tab) == active) ? active : 0, allowed,
            tabs.Length - allowed.Length, inspector);
    }

    private static async Task<Snapshot> Write(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        AuthoringWorkspaceCommand input, bool? inspector, CancellationToken ct)
    {
        // The article query never acquires article row locks. Workspace CAS owns only the layout row.
        var tabs = await OwnedTabs(db, tx, owner, input.Tabs, ct);
        var active = tabs.Any(tab => Math.Abs(tab) == input.ActiveArticleId) ? input.ActiveArticleId : 0;
        var expected = input.ExpectedRevision;
        var sql = expected == 0
            ? "insert into public.authoring_workspace(user_id,schema_version,revision,updated_at,active_article_id,tabs" +
                (inspector.HasValue ? ",inspector_open) values ($1,1,1,clock_timestamp(),$2,$3,$4)" : ") values ($1,1,1,clock_timestamp(),$2,$3)") +
                " on conflict (user_id) do nothing returning revision,updated_at"
            : "update public.authoring_workspace set revision=revision+1,updated_at=clock_timestamp(),active_article_id=$2,tabs=$3" +
                (inspector.HasValue ? ",inspector_open=$5" : "") + " where user_id=$1 and revision=$4 returning revision,updated_at";
        var parameters = new List<object> { owner, active, tabs };
        if (expected != 0) parameters.Add(expected);
        if (inspector.HasValue) parameters.Add(inspector.Value);
        await using var cmd = Store.Sql(db, tx, sql, parameters.ToArray());
        await using var row = await cmd.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct))
            throw new BusinessException(Rejection.Conflict, "The workspace layout changed in another session.");
        return new(1, row.GetInt64(0), row.GetFieldValue<DateTimeOffset>(1).ToUnixTimeMilliseconds(), active, tabs,
            input.Tabs.Count - tabs.Length, inspector ?? false);
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
