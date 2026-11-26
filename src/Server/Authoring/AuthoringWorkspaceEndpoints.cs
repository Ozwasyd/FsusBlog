namespace FsusBlog.V2.Server.Authoring;

internal static class AuthoringWorkspaceEndpoints
{
    private const int Legacy = 1;
    private const int Inspector = 2;
    private const int Groups = 3;

    internal static void Map(WebApplication app, string cookie)
    {
        MapLayout(WireRoutes.AuthoringWorkspace, Legacy, WireLimits.MaxAuthoringWorkspaceFrameBytes, frame =>
        {
            var input = Wire.DecodeAuthoringWorkspaceCommand(frame);
            return new(Groups, input.ExpectedRevision, input.ActiveArticleId, input.Tabs, false, 0, [], 0);
        });
        MapLayout(WireRoutes.AuthoringWorkspaceLayout, Inspector, WireLimits.MaxAuthoringWorkspaceLayoutCommandFrameBytes, frame =>
        {
            var input = Wire.DecodeAuthoringWorkspaceLayoutCommand(frame);
            return new(Groups, input.ExpectedRevision, input.ActiveArticleId, input.Tabs, input.InspectorOpen, 0, [], 0);
        });
        MapLayout(WireRoutes.AuthoringWorkspaceGroups, Groups, WireLimits.MaxAuthoringWorkspaceGroupsCommandFrameBytes,
            frame => Wire.DecodeAuthoringWorkspaceGroupsCommand(frame));

        void MapLayout(string route, int format, int limit, Func<byte[], AuthoringWorkspaceGroupsCommand> decode)
        {
            app.MapCommandGet(route, (HttpContext ctx, Store store, CancellationToken ct) => Run(ctx, store, format, ct));
            app.MapCommandPost(route, async (HttpContext ctx, Store store, CancellationToken ct) =>
                await Run(ctx, store, format, ct, decode(await ServerHttp.ReadFrame(ctx, limit, ct))));
        }

        Task<IResult> Run(HttpContext ctx, Store store, int format, CancellationToken ct, AuthoringWorkspaceGroupsCommand? input = null)
        {
            var token = ctx.Request.Cookies[cookie];
            return SiteSessions.WithCurrentAuthor<IResult>(store, token, SiteSessions.Requested(ctx), async (db, tx, actor, _) =>
            {
                if (await SqlCommands.Scalar(db, tx, ct,
                    "select pg_catalog.to_regclass($1) is not null", CurrentSchema.AuthoringWorkspaceRelation) is not true)
                    throw new BusinessException(Rejection.NotFound, "Workspace layout storage is unavailable.");
                var hasGroups = await CurrentSchema.HasAuthoringWorkspaceGroupsAsync(db, tx, ct);
                if (format == Groups && !hasGroups)
                    throw new BusinessException(Rejection.NotFound, "Workspace group layout upgrade is unavailable.");
                if (format == Inspector && !hasGroups && !await CurrentSchema.HasAuthoringWorkspaceLayoutAsync(db, tx, ct))
                    throw new BusinessException(Rejection.NotFound, "Workspace layout upgrade is unavailable.");

                var snapshot = input is null ? await Read(db, tx, actor.Id, format, hasGroups, ct)
                    : await Write(db, tx, actor.Id, input, format, hasGroups, ct);
                var frame = format switch
                {
                    Legacy => Wire.EncodeAuthoringWorkspaceSnapshot(new(Legacy, snapshot.Revision, snapshot.UpdatedAtUnixMs,
                        snapshot.ActiveArticleId, snapshot.Tabs, snapshot.Skipped)),
                    Inspector => Wire.EncodeAuthoringWorkspaceLayout(new(Inspector, snapshot.Revision, snapshot.UpdatedAtUnixMs,
                        snapshot.ActiveArticleId, snapshot.Tabs, snapshot.Skipped, snapshot.InspectorOpen)),
                    _ => Wire.EncodeAuthoringWorkspaceGroups(snapshot)
                };
                return ServerHttp.Frame(frame);
            }, ct);
        }
    }

    private sealed record Positions(int ActiveArticleId, IReadOnlyList<int> Tabs, int SecondaryActiveArticleId,
        IReadOnlyList<int> SecondaryTabs, int FocusedGroup);

    private static async Task<AuthoringWorkspaceGroups> Read(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        int format, bool hasGroups, CancellationToken ct)
    {
        var saved = await SqlCommands.QueryOne(db, tx, ct, "select schema_version,revision,updated_at,active_article_id,tabs," +
            (format >= Inspector ? "inspector_open" : "false") + "," +
            (hasGroups ? "secondary_active_article_id,secondary_tabs,focused_group" : "0,'{}'::integer[],0") +
            " from public.authoring_workspace where user_id=$1", row =>
            row.GetInt32(0) == Legacy
                ? new AuthoringWorkspaceGroups(Groups, row.GetInt64(1), row.GetUnixMilliseconds(2),
                    row.GetInt32(3), row.GetFieldValue<int[]>(4), 0, row.GetBoolean(5), row.GetInt32(6),
                    row.GetFieldValue<int[]>(7), row.GetInt32(8))
                : throw InvalidLayout(), owner);
        if (saved is null) return new(Groups, 0, 0, 0, [], 0, false, 0, [], 0);

        // A legacy reader must not flatten a stored split, including when every secondary article is no longer visible.
        if (format < Groups && saved.SecondaryTabs.Count != 0)
            throw new BusinessException(Rejection.Conflict, "The saved workspace has two article groups. Use the current layout route.");

        // Validate the stored shape before filtering so malformed coordinates are never repaired silently.
        try { Wire.Validate(saved); }
        catch (ProtocolException) { throw InvalidLayout(); }

        var (owned, skipped) = await OwnedPositions(db, tx, owner,
            new(saved.ActiveArticleId, saved.Tabs, saved.SecondaryActiveArticleId, saved.SecondaryTabs, saved.FocusedGroup), ct);
        return saved with
        {
            ActiveArticleId = owned.ActiveArticleId, Tabs = owned.Tabs, Skipped = skipped,
            SecondaryActiveArticleId = owned.SecondaryActiveArticleId, SecondaryTabs = owned.SecondaryTabs,
            FocusedGroup = owned.FocusedGroup
        };
    }

    private static async Task<AuthoringWorkspaceGroups> Write(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        AuthoringWorkspaceGroupsCommand input, int format, bool hasGroups, CancellationToken ct)
    {
        if (input.ExpectedRevision == long.MaxValue)
            throw new BusinessException(Rejection.Conflict, "The workspace revision cannot be advanced.");

        // Ownership of both panes is decided from one article statement. The CAS only takes a workspace row lock.
        var (owned, skipped) = await OwnedPositions(db, tx, owner,
            new(input.ActiveArticleId, input.Tabs, input.SecondaryActiveArticleId, input.SecondaryTabs, input.FocusedGroup), ct);
        await using var cmd = StoreLayout(db, tx, owner, owned, input, format, hasGroups);
        await using var row = await cmd.ExecuteReaderAsync(ct);
        await row.ReadRequired(ct, () => new BusinessException(Rejection.Conflict, "The workspace layout changed in another session or uses a newer format."));
        return new(Groups, row.GetInt64(0), row.GetUnixMilliseconds(1), owned.ActiveArticleId,
            owned.Tabs, skipped, input.InspectorOpen, owned.SecondaryActiveArticleId, owned.SecondaryTabs, owned.FocusedGroup);
    }

    private static NpgsqlCommand StoreLayout(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, Positions owned,
        AuthoringWorkspaceGroupsCommand input, int format, bool hasGroups)
    {
        (string Columns, string Values, string Assignments, object[] Parameters) layout = format switch
        {
            Groups => (",inspector_open,secondary_active_article_id,secondary_tabs,focused_group", ",$4,$5,$6,$7",
                ",inspector_open=$4,secondary_active_article_id=$5,secondary_tabs=$6,focused_group=$7",
                [owner, owned.ActiveArticleId, owned.Tabs, input.InspectorOpen, owned.SecondaryActiveArticleId, owned.SecondaryTabs, owned.FocusedGroup]),
            Inspector => (",inspector_open", ",$4", ",inspector_open=$4", [owner, owned.ActiveArticleId, owned.Tabs, input.InspectorOpen]),
            _ => ("", "", "", [owner, owned.ActiveArticleId, owned.Tabs])
        };
        if (input.ExpectedRevision == 0)
            return Store.Sql(db, tx, $"""
                insert into public.authoring_workspace(user_id,schema_version,revision,updated_at,active_article_id,tabs{layout.Columns})
                values ($1,1,1,clock_timestamp(),$2,$3{layout.Values})
                on conflict (user_id) do nothing returning revision,updated_at
                """, layout.Parameters);

        var revision = (layout.Parameters.Length + 1).ToString(CultureInfo.InvariantCulture);
        var unsplit = hasGroups && format != Groups ? " and cardinality(secondary_tabs)=0" : "";
        return Store.Sql(db, tx, $"""
            update public.authoring_workspace set revision=revision+1,updated_at=clock_timestamp(),active_article_id=$2,tabs=$3{layout.Assignments}
            where user_id=$1 and revision=${revision}{unsplit} returning revision,updated_at
            """, [.. layout.Parameters, input.ExpectedRevision]);
    }

    private static async Task<(Positions Positions, int Skipped)> OwnedPositions(NpgsqlConnection db, NpgsqlTransaction tx,
        Guid owner, Positions input, CancellationToken ct)
    {
        var requested = input.Tabs.Concat(input.SecondaryTabs).Select(Math.Abs).ToArray();
        if (requested.Length == 0) return (new(0, Array.Empty<int>(), 0, Array.Empty<int>(), 0), 0);
        var allowed = (await SqlCommands.QueryList(db, tx, ct, $"""
            select a.id from public.article a
            where a.owner_id=$1 and not a.deleted and a.id=any($2) and {ArchivedArticleAuthority.Available}
            """, r => r.GetInt32(0), owner, requested)).ToHashSet();
        var primary = input.Tabs.Where(tab => allowed.Contains(Math.Abs(tab))).ToArray();
        var secondary = input.SecondaryTabs.Where(tab => allowed.Contains(Math.Abs(tab))).ToArray();
        var active = allowed.Contains(input.ActiveArticleId) ? input.ActiveArticleId : 0;
        var secondaryActive = allowed.Contains(input.SecondaryActiveArticleId) ? input.SecondaryActiveArticleId : 0;
        var focused = secondaryActive > 0 && (input.FocusedGroup == 1 || active == 0) ? 1 : 0;
        return (new(active, primary, secondaryActive, secondary, focused), requested.Length - allowed.Count);
    }

    private static BusinessException InvalidLayout() => new(Rejection.Conflict, "The saved workspace layout cannot be restored.");
}
