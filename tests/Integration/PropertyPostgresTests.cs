using System.Net;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PropertyPostgresTests
{
    [PostgresFact]
    public async Task TextPropertyCommandsUseOneAuthorizedCasAndKeepExistingValuesDuringDeprecation()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(db.DataSource);
        var author = await Account("property author");
        var visitor = await Account("other author");
        var guest = await Account("guest", false);
        var draft = (await store.WithSession(author, true, (connection, tx, actor) => Store.Execute(connection, tx, actor,
            ArticleAction.Save, new(0, 0, Guid.NewGuid(), "Host", "Markdown"), ct), ct)).Article;
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);

        var input = new PropertyWorkspaceRequest(draft.Id, draft.Revision, 0, 0, "");
        var authorPanel = Wire.DecodePropertyWorkspace(await Post(WireRoutes.PropertyWorkspace,
            Wire.EncodePropertyWorkspaceRequest(input), author, HttpStatusCode.OK));
        Assert.Equal(0, authorPanel.SchemaRevision);
        Assert.Empty(authorPanel.Fields);
        await ExpectError(WireRoutes.PropertyWorkspace, Wire.EncodePropertyWorkspaceRequest(input), visitor, HttpStatusCode.NotFound);
        await ExpectError(WireRoutes.PropertyWorkspace, Wire.EncodePropertyWorkspaceRequest(input), guest, HttpStatusCode.Forbidden);

        var create = new PropertyDefinitionCommand(1, Guid.NewGuid(), Guid.NewGuid(), 0, 0, "subtitle", "副标题");
        var definition = await Change(create);
        Assert.Equal(definition, await Change(create));
        await ExpectError(WireRoutes.PropertyDefinitionCommand, Wire.EncodePropertyDefinitionCommand(create with { Label = "Mismatch" }),
            author, HttpStatusCode.Conflict);
        var afterCreate = Wire.DecodePropertyWorkspace(await Post(WireRoutes.PropertyWorkspace,
            Wire.EncodePropertyWorkspaceRequest(input), author, HttpStatusCode.OK));
        Assert.Equal(new(create.DefinitionId, 1, "subtitle", "副标题", false, null), Assert.Single(afterCreate.Fields));

        var write = new PropertyTextCommand(draft.Id, draft.Revision, 1, 0, create.DefinitionId, 1, Guid.NewGuid(), false, "草稿属性 🐝");
        var first = Send(write);
        var replay = Send(write);
        var settled = await Task.WhenAll(first, replay);
        Assert.Equal(settled[0], settled[1]);
        Assert.Equal(1, settled[0].Revision);
        await ExpectError(WireRoutes.PropertyTextCommand, Wire.EncodePropertyTextCommand(write with { RequestId = Guid.NewGuid() }),
            author, HttpStatusCode.Conflict);
        await ExpectError(WireRoutes.PropertyTextCommand, Wire.EncodePropertyTextCommand(write with { Value = "Changed retry" }),
            author, HttpStatusCode.Conflict);
        var afterWrite = Wire.DecodePropertyWorkspace(await Post(WireRoutes.PropertyWorkspace,
            Wire.EncodePropertyWorkspaceRequest(input), author, HttpStatusCode.OK));
        Assert.Equal("草稿属性 🐝", Assert.Single(afterWrite.Fields).Value);
        Assert.Equal(1, afterWrite.ValueRevision);

        var rename = create with { Operation = 2, RequestId = Guid.NewGuid(), SchemaRevision = 1,
            DefinitionRevision = 1, MachineKey = "", Label = "Article subtitle" };
        Assert.Equal(2, (await Change(rename)).Revision);
        var deprecate = rename with { Operation = 3, RequestId = Guid.NewGuid(), SchemaRevision = 2, DefinitionRevision = 2, Label = "" };
        Assert.Equal(3, (await Change(deprecate)).Revision);
        var delete = deprecate with { Operation = 4, RequestId = Guid.NewGuid(), SchemaRevision = 3, DefinitionRevision = 3 };
        await ExpectError(WireRoutes.PropertyDefinitionCommand, Wire.EncodePropertyDefinitionCommand(delete), author, HttpStatusCode.Conflict);
        var deprecated = Wire.DecodePropertyWorkspace(await Post(WireRoutes.PropertyWorkspace,
            Wire.EncodePropertyWorkspaceRequest(input), author, HttpStatusCode.OK));
        Assert.Equal(new(create.DefinitionId, 3, "subtitle", "Article subtitle", true, "草稿属性 🐝"), Assert.Single(deprecated.Fields));

        var remove = write with { RequestId = Guid.NewGuid(), SchemaRevision = 3, ValueRevision = 1,
            DefinitionRevision = 3, Remove = true, Value = "" };
        Assert.Equal(2, (await Send(remove)).Revision);
        Assert.Equal(4, (await Change(delete)).Revision);
        Assert.Empty(Wire.DecodePropertyWorkspace(await Post(WireRoutes.PropertyWorkspace,
            Wire.EncodePropertyWorkspaceRequest(input), author, HttpStatusCode.OK)).Fields);
        Assert.Equal(draft, await store.WithSession(author, true, (connection, tx, actor) =>
            Store.Find(connection, tx, actor, draft.Id, false, ct), ct));

        for (var index = 0; index < WireLimits.PropertyPageSize + 1; index++)
            await Change(create with { DefinitionId = Guid.NewGuid(), RequestId = Guid.NewGuid(), SchemaRevision = 4 + index,
                MachineKey = $"field-{index:D2}", Label = $"Field {index:D2}" });
        var firstPage = Wire.DecodePropertyWorkspace(await Post(WireRoutes.PropertyWorkspace,
            Wire.EncodePropertyWorkspaceRequest(input), author, HttpStatusCode.OK));
        Assert.Equal(WireLimits.PropertyPageSize, firstPage.Fields.Count);
        var nextPage = input with { SchemaRevision = firstPage.SchemaRevision, ValueRevision = firstPage.ValueRevision,
            AfterKey = firstPage.NextKey };
        var last = Wire.DecodePropertyWorkspace(await Post(WireRoutes.PropertyWorkspace,
            Wire.EncodePropertyWorkspaceRequest(nextPage), author, HttpStatusCode.OK));
        Assert.Equal("field-25", Assert.Single(last.Fields).MachineKey);
        Assert.Empty(last.NextKey);
        var renameAgain = new PropertyDefinitionCommand(2, last.Fields[0].DefinitionId, Guid.NewGuid(),
            firstPage.SchemaRevision, last.Fields[0].DefinitionRevision, "", "New name");
        var renamed = Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertySchemaCommand,
            Wire.EncodePropertySchemaInput(new(renameAgain, PropertyFieldKind.Text, [])), author, HttpStatusCode.OK));
        await ExpectError(WireRoutes.PropertyWorkspace, Wire.EncodePropertyWorkspaceRequest(nextPage), author, HttpStatusCode.Conflict);

        var initialFlags = Wire.DecodePropertyDefinitionProjection(await ReadProjection(author, HttpStatusCode.OK));
        Assert.Equal(new(renamed.DefinitionId, renamed.SchemaRevision, renamed.Revision, false,
            false, false, false, initialFlags.Digest), initialFlags);
        Assert.Equal(WireLayouts.ErrorBytes, Aeds.Decode(await ReadProjection(visitor, HttpStatusCode.NotFound), FrameType.ApiError).Length);

        var keptValue = await Send(write with { DefinitionId = renamed.DefinitionId, DefinitionRevision = renamed.Revision,
            SchemaRevision = renamed.SchemaRevision, ValueRevision = 2, RequestId = Guid.NewGuid(), Value = "Preserved value" });
        var filter = new PropertyFilterabilityCommand(renamed.DefinitionId, Guid.NewGuid(), renamed.SchemaRevision, renamed.Revision, true);
        var filtered = Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertyFilterability,
            Wire.EncodePropertyFilterabilityCommand(filter), author, HttpStatusCode.OK));
        var beforeFlags = Wire.DecodePropertyDefinitionProjection(await ReadProjection(author, HttpStatusCode.OK));
        Assert.True(beforeFlags.Filterable);
        Assert.False(beforeFlags.SearchEligible || beforeFlags.Sortable);

        var flags = new PropertyDefinitionProjectionCommand(filtered.DefinitionId, Guid.NewGuid(), filtered.SchemaRevision,
            filtered.Revision, true, true);
        var savedFlags = await SetFlags(flags);
        Assert.Equal(savedFlags, await SetFlags(flags));
        await ExpectError(WireRoutes.PropertySchemaCommand, Wire.EncodePropertyDefinitionProjectionCommand(flags with { Sortable = false }),
            author, HttpStatusCode.Conflict);
        await ExpectError(WireRoutes.PropertySchemaCommand, Wire.EncodePropertyDefinitionProjectionCommand(flags with { RequestId = Guid.NewGuid() }),
            author, HttpStatusCode.Conflict);
        await ExpectError(WireRoutes.PropertySchemaCommand, Wire.EncodePropertyDefinitionProjectionCommand(flags),
            visitor, HttpStatusCode.NotFound);

        var afterFlags = Wire.DecodePropertyDefinitionProjection(await ReadProjection(author, HttpStatusCode.OK));
        Assert.Equal(new(savedFlags.DefinitionId, savedFlags.SchemaRevision, savedFlags.Revision, false,
            true, true, true, afterFlags.Digest), afterFlags);
        Assert.Equal(beforeFlags.SchemaRevision + 1, afterFlags.SchemaRevision);
        Assert.Equal(beforeFlags.DefinitionRevision + 1, afterFlags.DefinitionRevision);
        Assert.NotEqual(beforeFlags.Digest, afterFlags.Digest);
        await using (var connection = await db.DataSource.OpenConnectionAsync(ct))
        await using (var stored = Store.Sql(connection, null, """
            select d.digest,c.receipt->>'BeforeDigest',c.receipt->>'AfterDigest',(c.receipt->>'AffectedCount')::bigint
            from public.property_definition d join public.property_schema_command c on c.owner_id=d.owner_id
            where d.id=$1 and c.request_id=$2
            """, flags.DefinitionId, flags.RequestId))
        await using (var row = await stored.ExecuteReaderAsync(ct))
        {
            Assert.True(await row.ReadAsync(ct));
            Assert.Equal(afterFlags.Digest, row.GetString(0));
            Assert.Equal(beforeFlags.Digest, row.GetString(1));
            Assert.Equal(afterFlags.Digest, row.GetString(2));
            Assert.Equal(1L, row.GetInt64(3));
            Assert.False(await row.ReadAsync(ct));
        }
        var articleAfterFlags = Wire.DecodePropertyWorkspace(await Post(WireRoutes.PropertyWorkspace,
            Wire.EncodePropertyWorkspaceRequest(input with { AfterKey = "field-24", SchemaRevision = afterFlags.SchemaRevision,
                ValueRevision = keptValue.Revision }), author, HttpStatusCode.OK));
        Assert.Equal("Preserved value", Assert.Single(articleAfterFlags.Fields).Value);

        var changedSort = await SetFlags(flags with { RequestId = Guid.NewGuid(), SchemaRevision = afterFlags.SchemaRevision,
            DefinitionRevision = afterFlags.DefinitionRevision, Sortable = false });
        var finalFlags = Wire.DecodePropertyDefinitionProjection(await ReadProjection(author, HttpStatusCode.OK));
        Assert.Equal(new(changedSort.DefinitionId, changedSort.SchemaRevision, changedSort.Revision, false,
            true, true, false, finalFlags.Digest), finalFlags);
        Assert.NotEqual(afterFlags.Digest, finalFlags.Digest);

        async Task<PropertyCommandReceipt> Change(PropertyDefinitionCommand command) =>
            Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertyDefinitionCommand, Wire.EncodePropertyDefinitionCommand(command),
                author, HttpStatusCode.OK));
        async Task<PropertyCommandReceipt> SetFlags(PropertyDefinitionProjectionCommand command) =>
            Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertySchemaCommand,
                Wire.EncodePropertyDefinitionProjectionCommand(command), author, HttpStatusCode.OK));
        async Task<byte[]> ReadProjection(string token, HttpStatusCode status)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get,
                $"{WireRoutes.PropertySchemaCommand}?definition={renameAgain.DefinitionId:D}");
            request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }
        async Task<PropertyCommandReceipt> Send(PropertyTextCommand command) =>
            Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertyTextCommand, Wire.EncodePropertyTextCommand(command),
                author, HttpStatusCode.OK));
        async Task ExpectError(string path, byte[] bytes, string token, HttpStatusCode status) =>
            Assert.Equal(WireLayouts.ErrorBytes, Aeds.Decode(await Post(path, bytes, token, status), FrameType.ApiError).Length);
        async Task<byte[]> Post(string path, byte[] bytes, string token, HttpStatusCode status)
        {
            using var request = SiteAedsFixture.Request(HttpMethod.Post, path, bytes, token, handle: null);
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }
        async Task<string> Account(string name, bool canAuthor = true)
        {
            var id = Guid.NewGuid();
            var seed = RandomNumberGenerator.GetBytes(32);
            await using var connection = await db.DataSource.OpenConnectionAsync(ct);
            await FixtureSql.ExecuteAsync(connection, null, ct, "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)", id, name, canAuthor);
            await using (var ticket = Store.Sql(connection, null,
                "insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '2 minutes')",
                SHA256.HashData(seed), id)) await ticket.ExecuteNonQueryAsync(ct);
            return (await store.SignIn(Convert.ToHexStringLower(seed), ct)).Token;
        }
    }
}
