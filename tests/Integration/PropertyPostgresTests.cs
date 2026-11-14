using System.Net;
using System.Net.Http.Headers;
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
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
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
        await Change(renameAgain);
        await ExpectError(WireRoutes.PropertyWorkspace, Wire.EncodePropertyWorkspaceRequest(nextPage), author, HttpStatusCode.Conflict);

        async Task<PropertyCommandReceipt> Change(PropertyDefinitionCommand command) =>
            Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertyDefinitionCommand, Wire.EncodePropertyDefinitionCommand(command),
                author, HttpStatusCode.OK));
        async Task<PropertyCommandReceipt> Send(PropertyTextCommand command) =>
            Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertyTextCommand, Wire.EncodePropertyTextCommand(command),
                author, HttpStatusCode.OK));
        async Task ExpectError(string path, byte[] bytes, string token, HttpStatusCode status) =>
            Assert.Equal(WireLayouts.ErrorBytes, Aeds.Decode(await Post(path, bytes, token, status), FrameType.ApiError).Length);
        async Task<byte[]> Post(string path, byte[] bytes, string token, HttpStatusCode status)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = new ByteArrayContent(bytes) };
            request.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
            request.Headers.Add("Cookie", $"fsus-v2-session={token}");
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
            await using (var user = Store.Sql(connection, null,
                "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)", id, name, canAuthor))
                await user.ExecuteNonQueryAsync(ct);
            await using (var ticket = Store.Sql(connection, null,
                "insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '2 minutes')",
                SHA256.HashData(seed), id)) await ticket.ExecuteNonQueryAsync(ct);
            return (await store.SignIn(Convert.ToHexStringLower(seed), ct)).Token;
        }
    }
}
