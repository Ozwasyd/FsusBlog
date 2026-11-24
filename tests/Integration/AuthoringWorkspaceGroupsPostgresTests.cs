public sealed class AuthoringWorkspaceGroupsPostgresTests
{
    [PostgresFact]
    public async Task GroupsShareLegacyRevisionAndRejectLegacyOverwriteEvenWithTheCurrentRevision()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        var author = await db.SignIn("Workspace author", ct, true, minutes: 1);
        var other = await db.SignIn("Other workspace author", ct, true, minutes: 1);
        var reader = await db.SignIn("Workspace reader", ct, false, minutes: 1);
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);
        var client = server.Client;
        var first = await SiteAedsFixture.SaveDraft(client, author.Token, author.Handle, 0, 0, "First", "Private content", ct);
        var preview = await SiteAedsFixture.SaveDraft(client, author.Token, author.Handle, 0, 0, "Primary preview", "Private content", ct);
        var second = await SiteAedsFixture.SaveDraft(client, author.Token, author.Handle, 0, 0, "Secondary preview", "Private content", ct);
        var foreign = await SiteAedsFixture.SaveDraft(client, other.Token, other.Handle, 0, 0, "Other author's article", "Private content", ct);
        var empty = await ReadGroups(client, author.Token, author.Handle, ct);
        Assert.Equal(0, empty.Revision);
        Assert.Empty(empty.Tabs);
        Assert.Empty(empty.SecondaryTabs);

        var legacy = Wire.DecodeAuthoringWorkspaceLayout(await Send(client, HttpMethod.Post, WireRoutes.AuthoringWorkspaceLayout,
            author.Token, author.Handle, Wire.EncodeAuthoringWorkspaceLayoutCommand(new(2, 0, first.Id, [first.Id, -preview.Id], true)), OK, ct));
        Assert.Equal(1, legacy.Revision);
        var migrated = await ReadGroups(client, author.Token, author.Handle, ct);
        Assert.Equal((legacy.Revision, legacy.UpdatedAtUnixMs, true), (migrated.Revision, migrated.UpdatedAtUnixMs, migrated.InspectorOpen));
        Assert.Equal(legacy.Tabs, migrated.Tabs);
        Assert.Empty(migrated.SecondaryTabs);

        var filtered = await SaveGroups(client, author.Token, author.Handle, new(3, migrated.Revision, first.Id, [first.Id, -preview.Id], true,
            foreign.Id, [foreign.Id, -second.Id], 1), ct);
        Assert.Equal((2, 0, 0, 1), (filtered.Revision, filtered.SecondaryActiveArticleId, filtered.FocusedGroup, filtered.Skipped));
        Assert.Equal([first.Id, -preview.Id], filtered.Tabs);
        Assert.Equal([-second.Id], filtered.SecondaryTabs);
        var split = await SaveGroups(client, author.Token, author.Handle, new(3, filtered.Revision, preview.Id, [first.Id, -preview.Id], true,
            second.Id, [-second.Id], 1), ct);
        Assert.Equal((3, second.Id, 1), (split.Revision, split.SecondaryActiveArticleId, split.FocusedGroup));

        foreach (var (method, route, payload) in new[]
        {
            (HttpMethod.Get, WireRoutes.AuthoringWorkspace, (byte[]?)null),
            (HttpMethod.Get, WireRoutes.AuthoringWorkspaceLayout, null),
            (HttpMethod.Post, WireRoutes.AuthoringWorkspace, Wire.EncodeAuthoringWorkspaceCommand(new(1, split.Revision, first.Id, [first.Id]))),
            (HttpMethod.Post, WireRoutes.AuthoringWorkspaceLayout, Wire.EncodeAuthoringWorkspaceLayoutCommand(new(2, split.Revision, first.Id, [first.Id], false))),
            (HttpMethod.Post, WireRoutes.AuthoringWorkspaceGroups, Wire.EncodeAuthoringWorkspaceGroupsCommand(new(3, filtered.Revision, first.Id, [first.Id], false, 0, [], 0))),
        })
            await Send(client, method, route, author.Token, author.Handle, payload, Conflict, ct);
        var unchanged = await ReadGroups(client, author.Token, author.Handle, ct);
        Assert.Equal((split.Revision, split.UpdatedAtUnixMs, true), (unchanged.Revision, unchanged.UpdatedAtUnixMs, unchanged.InspectorOpen));
        Assert.Equal(split.Tabs, unchanged.Tabs);
        Assert.Equal(split.SecondaryTabs, unchanged.SecondaryTabs);

        await Send(client, HttpMethod.Get, WireRoutes.AuthoringWorkspaceGroups, author.Token, other.Handle, null, Conflict, ct);
        await Send(client, HttpMethod.Get, WireRoutes.AuthoringWorkspaceGroups, reader.Token, reader.Handle, null, Unauthorized, ct);
        var unrelated = await ReadGroups(client, other.Token, other.Handle, ct);
        Assert.Equal(0, unrelated.Revision);
        Assert.Empty(unrelated.Tabs);
        Assert.Empty(unrelated.SecondaryTabs);

        await Send(client, HttpMethod.Post, WireRoutes.Delete, author.Token, author.Handle,
            Wire.EncodeArticleCommand(new(second.Id, second.Revision, Guid.NewGuid(), "", "")), OK, ct);
        var projected = await ReadGroups(client, author.Token, author.Handle, ct);
        Assert.Equal((split.Revision, preview.Id, 0, 0, 1),
            (projected.Revision, projected.ActiveArticleId, projected.SecondaryActiveArticleId, projected.FocusedGroup, projected.Skipped));
        Assert.Empty(projected.SecondaryTabs);
        await Send(client, HttpMethod.Get, WireRoutes.AuthoringWorkspaceLayout, author.Token, author.Handle, null, Conflict, ct);

        var collapsed = await SaveGroups(client, author.Token, author.Handle, new(3, projected.Revision, first.Id, [first.Id, preview.Id], true, 0, [], 0), ct);
        var race = await Task.WhenAll(
            WriteStatus(client, WireRoutes.AuthoringWorkspaceLayout, author.Token, author.Handle,
                Wire.EncodeAuthoringWorkspaceLayoutCommand(new(2, collapsed.Revision, first.Id, [first.Id, preview.Id], false)), ct),
            WriteStatus(client, WireRoutes.AuthoringWorkspaceGroups, author.Token, author.Handle,
                Wire.EncodeAuthoringWorkspaceGroupsCommand(new(3, collapsed.Revision, first.Id, [first.Id], true, preview.Id, [preview.Id], 1)), ct));
        Assert.Equal((1, 1), (race.Count(status => status == OK), race.Count(status => status == Conflict)));
        var remaining = await ReadGroups(client, author.Token, author.Handle, ct);
        Assert.Equal(collapsed.Revision + 1, remaining.Revision);
        if (race[1] == OK)
        {
            Assert.Equal([first.Id], remaining.Tabs);
            Assert.Equal([preview.Id], remaining.SecondaryTabs);
            Assert.True(remaining.InspectorOpen);
        }
        else
        {
            Assert.Equal([first.Id, preview.Id], remaining.Tabs);
            Assert.Empty(remaining.SecondaryTabs);
            Assert.False(remaining.InspectorOpen);
        }
    }

    [PostgresFact]
    public async Task LegacyDatabaseServesOldFormatsAndRejectsAPartialGroupUpgrade()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        var author = await db.SignIn("Workspace author", ct, true, minutes: 1);
        await db.Exec("alter table public.authoring_workspace drop column secondary_active_article_id, drop column secondary_tabs, drop column focused_group");

        await using (var legacy = await ServerProcess.Start(db.ConnectionString, ct))
        {
            await Send(legacy.Client, HttpMethod.Get, WireRoutes.AuthoringWorkspaceGroups, author.Token, author.Handle, null, NotFound, ct);
            await Send(legacy.Client, HttpMethod.Post, WireRoutes.AuthoringWorkspaceGroups, author.Token, author.Handle,
                Wire.EncodeAuthoringWorkspaceGroupsCommand(new(3, 0, 0, [], false, 0, [], 0)), NotFound, ct);
            var saved = Wire.DecodeAuthoringWorkspaceLayout(await Send(legacy.Client, HttpMethod.Post, WireRoutes.AuthoringWorkspaceLayout,
                author.Token, author.Handle, Wire.EncodeAuthoringWorkspaceLayoutCommand(new(2, 0, 0, [], true)), OK, ct));
            Assert.Equal((1, true), (saved.Revision, saved.InspectorOpen));
            await Send(legacy.Client, HttpMethod.Get, WireRoutes.AuthoringWorkspace, author.Token, author.Handle, null, OK, ct);
        }

        await db.Exec("alter table public.authoring_workspace add column focused_group integer not null default 0");
        var failure = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await using var rejected = await ServerProcess.Start(db.ConnectionString, ct);
        });
        Assert.Contains("group schema is incomplete", failure.Message, StringComparison.OrdinalIgnoreCase);
    }

    private static async Task<AuthoringWorkspaceGroups> ReadGroups(HttpClient client, string token, string handle, CancellationToken ct) =>
        Wire.DecodeAuthoringWorkspaceGroups(await Send(client, HttpMethod.Get, WireRoutes.AuthoringWorkspaceGroups, token, handle, null, OK, ct));

    private static async Task<AuthoringWorkspaceGroups> SaveGroups(HttpClient client, string token, string handle,
        AuthoringWorkspaceGroupsCommand command, CancellationToken ct) =>
        Wire.DecodeAuthoringWorkspaceGroups(await Send(client, HttpMethod.Post, WireRoutes.AuthoringWorkspaceGroups,
            token, handle, Wire.EncodeAuthoringWorkspaceGroupsCommand(command), OK, ct));

    private static async Task<HttpStatusCode> WriteStatus(HttpClient client, string route, string token, string handle, byte[] payload, CancellationToken ct)
    {
        using var response = await SiteAedsFixture.Send(client, HttpMethod.Post, route, payload, token, handle, ct);
        return response.StatusCode;
    }

    private static Task<byte[]> Send(HttpClient client, HttpMethod method, string route, string token, string handle,
        byte[]? payload, HttpStatusCode status, CancellationToken ct) =>
        SiteAedsFixture.ExpectPrivate(client, method, route, payload, token, handle, status, ct);
}
