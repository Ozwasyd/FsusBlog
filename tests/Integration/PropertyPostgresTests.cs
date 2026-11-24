namespace FsusBlog.V2.Integration.Tests;

public sealed class PropertyPostgresTests
{
    [PostgresFact]
    public async Task TextPropertyCommandsUseOneAuthorizedCasAndKeepExistingValuesDuringDeprecation()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(db.DataSource);
        var author = (await db.SignIn("property author", ct)).Token;
        var visitor = (await db.SignIn("other author", ct)).Token;
        var guest = (await db.SignIn("guest", ct, canAuthor: false)).Token;
        var draft = (await store.WithSession(author, true, (connection, tx, actor) => Store.Execute(connection, tx, actor,
            ArticleAction.Save, new(0, 0, Guid.NewGuid(), "Host", "Markdown"), ct), ct)).Article;
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);

        var input = new PropertyWorkspaceRequest(draft.Id, draft.Revision, 0, 0, "");
        var authorPanel = await Workspace(input);
        Assert.Equal(0, authorPanel.SchemaRevision);
        Assert.Empty(authorPanel.Fields);
        await ExpectError(WireRoutes.PropertyWorkspace, Wire.EncodePropertyWorkspaceRequest(input), visitor, NotFound);
        await ExpectError(WireRoutes.PropertyWorkspace, Wire.EncodePropertyWorkspaceRequest(input), guest, Unauthorized);

        var create = new PropertyDefinitionCommand(1, Guid.NewGuid(), Guid.NewGuid(), 0, 0, "subtitle", "副标题");
        var definition = await Change(create);
        Assert.Equal(definition, await Change(create));
        await ExpectError(WireRoutes.PropertyDefinitionCommand, Wire.EncodePropertyDefinitionCommand(create with { Label = "Mismatch" }), author, Conflict);
        Assert.Equal(new(create.DefinitionId, 1, "subtitle", "副标题", false, null), Assert.Single((await Workspace(input)).Fields));

        var write = new PropertyTextCommand(draft.Id, draft.Revision, 1, 0, create.DefinitionId, 1, Guid.NewGuid(), false, "草稿属性 🐝");
        var settled = await Task.WhenAll(Send(write), Send(write));
        Assert.Equal(settled[0], settled[1]);
        Assert.Equal(1, settled[0].Revision);
        foreach (var bad in new[] { write with { RequestId = Guid.NewGuid() }, write with { Value = "Changed retry" } })
            await ExpectError(WireRoutes.PropertyTextCommand, Wire.EncodePropertyTextCommand(bad), author, Conflict);
        var afterWrite = await Workspace(input);
        Assert.Equal(("草稿属性 🐝", 1L), (Assert.Single(afterWrite.Fields).Value, afterWrite.ValueRevision));

        var rename = create with { Operation = 2, RequestId = Guid.NewGuid(), SchemaRevision = 1, DefinitionRevision = 1, MachineKey = "", Label = "Article subtitle" };
        Assert.Equal(2, (await Change(rename)).Revision);
        var deprecate = rename with { Operation = 3, RequestId = Guid.NewGuid(), SchemaRevision = 2, DefinitionRevision = 2, Label = "" };
        Assert.Equal(3, (await Change(deprecate)).Revision);
        var delete = deprecate with { Operation = 4, RequestId = Guid.NewGuid(), SchemaRevision = 3, DefinitionRevision = 3 };
        await ExpectError(WireRoutes.PropertyDefinitionCommand, Wire.EncodePropertyDefinitionCommand(delete), author, Conflict);
        Assert.Equal(new(create.DefinitionId, 3, "subtitle", "Article subtitle", true, "草稿属性 🐝"), Assert.Single((await Workspace(input)).Fields));

        var remove = write with { RequestId = Guid.NewGuid(), SchemaRevision = 3, ValueRevision = 1, DefinitionRevision = 3, Remove = true, Value = "" };
        Assert.Equal((2L, 4L), ((await Send(remove)).Revision, (await Change(delete)).Revision));
        Assert.Empty((await Workspace(input)).Fields);
        Assert.Equal(draft, await store.WithSession(author, true, (connection, tx, actor) =>
            Store.Find(connection, tx, actor, draft.Id, false, ct), ct));

        for (var index = 0; index < WireLimits.PropertyPageSize + 1; index++)
            await Change(create with { DefinitionId = Guid.NewGuid(), RequestId = Guid.NewGuid(), SchemaRevision = 4 + index,
                MachineKey = $"field-{index:D2}", Label = $"Field {index:D2}" });
        var firstPage = await Workspace(input);
        Assert.Equal(WireLimits.PropertyPageSize, firstPage.Fields.Count);
        var nextPage = input with { SchemaRevision = firstPage.SchemaRevision, ValueRevision = firstPage.ValueRevision, AfterKey = firstPage.NextKey };
        var last = await Workspace(nextPage);
        Assert.Equal(("field-25", ""), (Assert.Single(last.Fields).MachineKey, last.NextKey));
        var renameAgain = new PropertyDefinitionCommand(2, last.Fields[0].DefinitionId, Guid.NewGuid(),
            firstPage.SchemaRevision, last.Fields[0].DefinitionRevision, "", "New name");
        var renamed = Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertySchemaCommand,
            Wire.EncodePropertySchemaInput(new(renameAgain, PropertyFieldKind.Text, [])), author, OK));
        await ExpectError(WireRoutes.PropertyWorkspace, Wire.EncodePropertyWorkspaceRequest(nextPage), author, Conflict);

        var initialFlags = Wire.DecodePropertyDefinitionProjection(await ReadProjection(author, OK));
        Assert.Equal(new(renamed.DefinitionId, renamed.SchemaRevision, renamed.Revision, false, false, false, false, initialFlags.Digest), initialFlags);
        Assert.Equal(WireLayouts.ErrorBytes, Aeds.Decode(await ReadProjection(visitor, NotFound), FrameType.ApiError).Length);

        var keptValue = await Send(write with { DefinitionId = renamed.DefinitionId, DefinitionRevision = renamed.Revision,
            SchemaRevision = renamed.SchemaRevision, ValueRevision = 2, RequestId = Guid.NewGuid(), Value = "Preserved value" });
        var filtered = Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertyFilterability,
            Wire.EncodePropertyFilterabilityCommand(new(renamed.DefinitionId, Guid.NewGuid(), renamed.SchemaRevision, renamed.Revision, true)), author, OK));
        var beforeFlags = Wire.DecodePropertyDefinitionProjection(await ReadProjection(author, OK));
        Assert.True(beforeFlags.Filterable && !beforeFlags.SearchEligible && !beforeFlags.Sortable);

        var flags = new PropertyDefinitionProjectionCommand(filtered.DefinitionId, Guid.NewGuid(), filtered.SchemaRevision, filtered.Revision, true, true);
        var savedFlags = await SetFlags(flags);
        Assert.Equal(savedFlags, await SetFlags(flags));
        foreach (var (cmd, token, status) in new[]
        {
            (flags with { Sortable = false }, author, Conflict),
            (flags with { RequestId = Guid.NewGuid() }, author, Conflict),
            (flags, visitor, NotFound),
        })
            await ExpectError(WireRoutes.PropertySchemaCommand, Wire.EncodePropertyDefinitionProjectionCommand(cmd), token, status);

        var afterFlags = Wire.DecodePropertyDefinitionProjection(await ReadProjection(author, OK));
        Assert.Equal(new(savedFlags.DefinitionId, savedFlags.SchemaRevision, savedFlags.Revision, false, true, true, true, afterFlags.Digest), afterFlags);
        Assert.Equal((beforeFlags.SchemaRevision + 1, beforeFlags.DefinitionRevision + 1), (afterFlags.SchemaRevision, afterFlags.DefinitionRevision));
        Assert.NotEqual(beforeFlags.Digest, afterFlags.Digest);
        Assert.Equal((afterFlags.Digest, beforeFlags.Digest, afterFlags.Digest, 1L),
            Assert.Single(await db.QueryRowsAsync(ct, """
                select d.digest,c.receipt->>'BeforeDigest',c.receipt->>'AfterDigest',(c.receipt->>'AffectedCount')::bigint
                from public.property_definition d join public.property_schema_command c on c.owner_id=d.owner_id
                where d.id=$1 and c.request_id=$2
                """, r => (r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt64(3)), flags.DefinitionId, flags.RequestId)));
        Assert.Equal("Preserved value", Assert.Single((await Workspace(input with
        {
            AfterKey = "field-24", SchemaRevision = afterFlags.SchemaRevision, ValueRevision = keptValue.Revision
        })).Fields).Value);

        var changedSort = await SetFlags(flags with { RequestId = Guid.NewGuid(), SchemaRevision = afterFlags.SchemaRevision,
            DefinitionRevision = afterFlags.DefinitionRevision, Sortable = false });
        var finalFlags = Wire.DecodePropertyDefinitionProjection(await ReadProjection(author, OK));
        Assert.Equal(new(changedSort.DefinitionId, changedSort.SchemaRevision, changedSort.Revision, false, true, true, false, finalFlags.Digest), finalFlags);
        Assert.NotEqual(afterFlags.Digest, finalFlags.Digest);

        async Task<PropertyWorkspace> Workspace(PropertyWorkspaceRequest req) =>
            Wire.DecodePropertyWorkspace(await Post(WireRoutes.PropertyWorkspace, Wire.EncodePropertyWorkspaceRequest(req), author, OK));
        async Task<PropertyCommandReceipt> Change(PropertyDefinitionCommand command) =>
            Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertyDefinitionCommand, Wire.EncodePropertyDefinitionCommand(command), author, OK));
        async Task<PropertyCommandReceipt> SetFlags(PropertyDefinitionProjectionCommand command) =>
            Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertySchemaCommand, Wire.EncodePropertyDefinitionProjectionCommand(command), author, OK));
        Task<byte[]> ReadProjection(string token, HttpStatusCode status) =>
            SiteAedsFixture.ExpectPrivate(server.Client, HttpMethod.Get, $"{WireRoutes.PropertySchemaCommand}?definition={renameAgain.DefinitionId:D}", null, token, null, status, ct);
        async Task<PropertyCommandReceipt> Send(PropertyTextCommand command) =>
            Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertyTextCommand, Wire.EncodePropertyTextCommand(command), author, OK));
        async Task ExpectError(string path, byte[] bytes, string token, HttpStatusCode status) =>
            Assert.Equal(WireLayouts.ErrorBytes, Aeds.Decode(await Post(path, bytes, token, status), FrameType.ApiError).Length);
        Task<byte[]> Post(string path, byte[] bytes, string token, HttpStatusCode status) =>
            SiteAedsFixture.ExpectPrivate(server.Client, HttpMethod.Post, path, bytes, token, null, status, ct);
    }
}
