using System.Net;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;

public sealed class AuthoringWorkspaceGroupsPostgresTests
{
    [PostgresFact]
    public async Task GroupsShareLegacyRevisionAndRejectLegacyOverwriteEvenWithTheCurrentRevision()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        var author = await Login(db, "Workspace author", true, ct);
        var other = await Login(db, "Other workspace author", true, ct);
        var reader = await Login(db, "Workspace reader", false, ct);
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);
        var client = server.Client;
        var first = await Draft(client, author, "First", ct);
        var preview = await Draft(client, author, "Primary preview", ct);
        var second = await Draft(client, author, "Secondary preview", ct);
        var foreign = await Draft(client, other, "Other author's article", ct);
        var empty = await ReadGroups(client, author, ct);
        Assert.Equal(0, empty.Revision);
        Assert.Empty(empty.Tabs);
        Assert.Empty(empty.SecondaryTabs);

        var legacy = Wire.DecodeAuthoringWorkspaceLayout(await Send(client, HttpMethod.Post, WireRoutes.AuthoringWorkspaceLayout,
            author, Wire.EncodeAuthoringWorkspaceLayoutCommand(new(2, 0, first.Id, [first.Id, -preview.Id], true)), HttpStatusCode.OK, ct));
        Assert.Equal(1, legacy.Revision);
        var migrated = await ReadGroups(client, author, ct);
        Assert.Equal(legacy.Revision, migrated.Revision);
        Assert.Equal(legacy.UpdatedAtUnixMs, migrated.UpdatedAtUnixMs);
        Assert.Equal(legacy.Tabs, migrated.Tabs);
        Assert.True(migrated.InspectorOpen);
        Assert.Empty(migrated.SecondaryTabs);

        var filtered = await SaveGroups(client, author, new(3, migrated.Revision, first.Id, [first.Id, -preview.Id], true,
            foreign.Id, [foreign.Id, -second.Id], 1), ct);
        Assert.Equal(2, filtered.Revision);
        Assert.Equal([first.Id, -preview.Id], filtered.Tabs);
        Assert.Equal([-second.Id], filtered.SecondaryTabs);
        Assert.Equal(0, filtered.SecondaryActiveArticleId);
        Assert.Equal(0, filtered.FocusedGroup);
        Assert.Equal(1, filtered.Skipped);
        var split = await SaveGroups(client, author, new(3, filtered.Revision, preview.Id, [first.Id, -preview.Id], true,
            second.Id, [-second.Id], 1), ct);
        Assert.Equal(3, split.Revision);
        Assert.Equal(second.Id, split.SecondaryActiveArticleId);
        Assert.Equal(1, split.FocusedGroup);

        await Send(client, HttpMethod.Get, WireRoutes.AuthoringWorkspace, author, null, HttpStatusCode.Conflict, ct);
        await Send(client, HttpMethod.Get, WireRoutes.AuthoringWorkspaceLayout, author, null, HttpStatusCode.Conflict, ct);
        await Send(client, HttpMethod.Post, WireRoutes.AuthoringWorkspace, author,
            Wire.EncodeAuthoringWorkspaceCommand(new(1, split.Revision, first.Id, [first.Id])), HttpStatusCode.Conflict, ct);
        await Send(client, HttpMethod.Post, WireRoutes.AuthoringWorkspaceLayout, author,
            Wire.EncodeAuthoringWorkspaceLayoutCommand(new(2, split.Revision, first.Id, [first.Id], false)), HttpStatusCode.Conflict, ct);
        await Send(client, HttpMethod.Post, WireRoutes.AuthoringWorkspaceGroups, author,
            Wire.EncodeAuthoringWorkspaceGroupsCommand(new(3, filtered.Revision, first.Id, [first.Id], false, 0, [], 0)), HttpStatusCode.Conflict, ct);
        var unchanged = await ReadGroups(client, author, ct);
        Assert.Equal(split.Revision, unchanged.Revision);
        Assert.Equal(split.UpdatedAtUnixMs, unchanged.UpdatedAtUnixMs);
        Assert.Equal(split.Tabs, unchanged.Tabs);
        Assert.Equal(split.SecondaryTabs, unchanged.SecondaryTabs);
        Assert.True(unchanged.InspectorOpen);

        await Send(client, HttpMethod.Get, WireRoutes.AuthoringWorkspaceGroups, author with { Handle = other.Handle }, null, HttpStatusCode.Conflict, ct);
        await Send(client, HttpMethod.Get, WireRoutes.AuthoringWorkspaceGroups, reader, null, HttpStatusCode.Unauthorized, ct);
        var unrelated = await ReadGroups(client, other, ct);
        Assert.Equal(0, unrelated.Revision);
        Assert.Empty(unrelated.Tabs);
        Assert.Empty(unrelated.SecondaryTabs);

        await Send(client, HttpMethod.Post, WireRoutes.Delete, author,
            Wire.EncodeArticleCommand(new(second.Id, second.Revision, Guid.NewGuid(), "", "")), HttpStatusCode.OK, ct);
        var projected = await ReadGroups(client, author, ct);
        Assert.Equal(split.Revision, projected.Revision);
        Assert.Equal(preview.Id, projected.ActiveArticleId);
        Assert.Empty(projected.SecondaryTabs);
        Assert.Equal(0, projected.SecondaryActiveArticleId);
        Assert.Equal(0, projected.FocusedGroup);
        Assert.Equal(1, projected.Skipped);
        await Send(client, HttpMethod.Get, WireRoutes.AuthoringWorkspaceLayout, author, null, HttpStatusCode.Conflict, ct);

        var collapsed = await SaveGroups(client, author, new(3, projected.Revision, first.Id, [first.Id, preview.Id], true, 0, [], 0), ct);
        var race = await Task.WhenAll(
            WriteStatus(client, WireRoutes.AuthoringWorkspaceLayout, author,
                Wire.EncodeAuthoringWorkspaceLayoutCommand(new(2, collapsed.Revision, first.Id, [first.Id, preview.Id], false)), ct),
            WriteStatus(client, WireRoutes.AuthoringWorkspaceGroups, author,
                Wire.EncodeAuthoringWorkspaceGroupsCommand(new(3, collapsed.Revision, first.Id, [first.Id], true, preview.Id, [preview.Id], 1)), ct));
        Assert.Equal(1, race.Count(status => status == HttpStatusCode.OK));
        Assert.Equal(1, race.Count(status => status == HttpStatusCode.Conflict));
        var remaining = await ReadGroups(client, author, ct);
        Assert.Equal(collapsed.Revision + 1, remaining.Revision);
        if (race[1] == HttpStatusCode.OK)
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
        var author = await Login(db, "Workspace author", true, ct);
        await using var connection = await db.DataSource.OpenConnectionAsync(ct);
        await FixtureSql.ExecuteAsync(connection, null, ct, """
            alter table public.authoring_workspace drop column secondary_active_article_id,
                drop column secondary_tabs, drop column focused_group
            """);

        await using (var legacy = await ServerProcess.Start(db.ConnectionString, ct))
        {
            await Send(legacy.Client, HttpMethod.Get, WireRoutes.AuthoringWorkspaceGroups, author, null, HttpStatusCode.NotFound, ct);
            await Send(legacy.Client, HttpMethod.Post, WireRoutes.AuthoringWorkspaceGroups, author,
                Wire.EncodeAuthoringWorkspaceGroupsCommand(new(3, 0, 0, [], false, 0, [], 0)), HttpStatusCode.NotFound, ct);
            var saved = Wire.DecodeAuthoringWorkspaceLayout(await Send(legacy.Client, HttpMethod.Post, WireRoutes.AuthoringWorkspaceLayout,
                author, Wire.EncodeAuthoringWorkspaceLayoutCommand(new(2, 0, 0, [], true)), HttpStatusCode.OK, ct));
            Assert.Equal(1, saved.Revision);
            Assert.True(saved.InspectorOpen);
            await Send(legacy.Client, HttpMethod.Get, WireRoutes.AuthoringWorkspace, author, null, HttpStatusCode.OK, ct);
        }

        await FixtureSql.ExecuteAsync(connection, null, ct, "alter table public.authoring_workspace add column focused_group integer not null default 0");
        var failure = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await using var rejected = await ServerProcess.Start(db.ConnectionString, ct);
        });
        Assert.Contains("group schema is incomplete", failure.Message, StringComparison.OrdinalIgnoreCase);
    }

    private static async Task<Credential> Login(ScratchDatabase db, string name, bool canAuthor, CancellationToken ct)
    {
        var (_, token, handle) = await db.SignIn(name, ct, canAuthor, minutes: 1);
        return new(token, handle);
    }

    private static async Task<Draft> Draft(HttpClient client, Credential credentials, string title, CancellationToken ct) =>
        Wire.DecodeDraft(await Send(client, HttpMethod.Post, WireRoutes.Save, credentials,
            Wire.EncodeArticleCommand(new(0, 0, Guid.NewGuid(), title, "Private content")), HttpStatusCode.OK, ct));

    private static async Task<AuthoringWorkspaceGroups> ReadGroups(HttpClient client, Credential credentials, CancellationToken ct) =>
        Wire.DecodeAuthoringWorkspaceGroups(await Send(client, HttpMethod.Get, WireRoutes.AuthoringWorkspaceGroups, credentials, null, HttpStatusCode.OK, ct));

    private static async Task<AuthoringWorkspaceGroups> SaveGroups(HttpClient client, Credential credentials, AuthoringWorkspaceGroupsCommand command,
        CancellationToken ct) => Wire.DecodeAuthoringWorkspaceGroups(await Send(client, HttpMethod.Post, WireRoutes.AuthoringWorkspaceGroups,
            credentials, Wire.EncodeAuthoringWorkspaceGroupsCommand(command), HttpStatusCode.OK, ct));

    private static async Task<HttpStatusCode> WriteStatus(HttpClient client, string route, Credential credentials, byte[] payload, CancellationToken ct)
    {
        using var request = SiteAedsFixture.Request(HttpMethod.Post, route, payload, credentials.Token, credentials.Handle);
        using var response = await client.SendAsync(request, ct);
        return response.StatusCode;
    }

    private static Task<byte[]> Send(HttpClient client, HttpMethod method, string route, Credential credentials, byte[]? payload,
        HttpStatusCode status, CancellationToken ct) =>
        SiteAedsFixture.ExpectPrivate(client, method, route, payload, credentials.Token, credentials.Handle, status, ct);

    private sealed record Credential(string Token, string Handle);
}
