using System.Net;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PropertyKindsPostgresTests
{
    [PostgresFact]
    public async Task AllEightKindsRoundTripInOneAuthorizedEditor()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(db.DataSource);
        var id = Guid.NewGuid();
        var key = RandomNumberGenerator.GetBytes(32);
        await using (var connection = await db.DataSource.OpenConnectionAsync(ct))
        {
            await FixtureSql.ExecuteAsync(connection, null, ct, "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,'author',true,true,1)", id);
            await FixtureSql.ExecuteAsync(connection, null, ct, "insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '2 minute')", SHA256.HashData(key), id);
        }
        var session = (await store.SignIn(Convert.ToHexStringLower(key), ct)).Token;
        var source = await Edit(ArticleAction.Save, new(0, 0, Guid.NewGuid(), "Source", "Text"));
        var target = await Edit(ArticleAction.Save, new(0, 0, Guid.NewGuid(), "Target", "Text"));
        var privateTarget = await Edit(ArticleAction.Save, new(0, 0, Guid.NewGuid(), "Private", "Text"));
        source = await Edit(ArticleAction.Publish, new(source.Id, source.Revision, Guid.NewGuid(), "", ""));
        target = await Edit(ArticleAction.Publish, new(target.Id, target.Revision, Guid.NewGuid(), "", ""));
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);
        var red = Guid.NewGuid();
        var blue = Guid.NewGuid();
        PropertyFieldOption[] options = [new(red, "Red"), new(blue, "Blue")];
        var values = new (string Key, PropertyFieldKind Kind, PropertyFieldValue Value)[]
        {
            ("a-text", PropertyFieldKind.Text, new PropertyFieldValue.Text("准确 🐈")),
            ("b-number", PropertyFieldKind.Number, new PropertyFieldValue.Number(decimal.Parse("9007199254740993.1234567", System.Globalization.CultureInfo.InvariantCulture))),
            ("c-boolean", PropertyFieldKind.Boolean, new PropertyFieldValue.Boolean(false)),
            ("d-date", PropertyFieldKind.Date, new PropertyFieldValue.Date(DateTimeOffset.FromUnixTimeMilliseconds(1794669740123))),
            ("e-single", PropertyFieldKind.SingleSelect, new PropertyFieldValue.SingleSelect(red)),
            ("f-multi", PropertyFieldKind.MultiSelect, new PropertyFieldValue.MultiSelect(new[] { blue, red }.Order().ToArray())),
            ("g-reference", PropertyFieldKind.ArticleReference, new PropertyFieldValue.ArticleReference([target.Id])),
            ("h-url", PropertyFieldKind.Url, new PropertyFieldValue.Url("https://example.net/guide")),
        };

        var definitions = new List<Guid>();
        for (var index = 0; index < values.Length; index++)
        {
            var (name, kind, _) = values[index];
            var definition = Guid.NewGuid();
            definitions.Add(definition);
            var input = new PropertySchemaInput(new(1, definition, Guid.NewGuid(), index, 0, name, name), kind,
                kind is PropertyFieldKind.SingleSelect or PropertyFieldKind.MultiSelect ? options : []);
            var receipt = Wire.DecodePropertyCommandReceipt(await Send(WireRoutes.PropertySchemaCommand, Wire.EncodePropertySchemaInput(input)));
            Assert.Equal(new(definition, index + 1, 1), receipt);
        }
        for (var index = 0; index < values.Length; index++)
        {
            var input = Value(source, index, index, values[index].Value);
            var frame = Wire.EncodePropertyValueInput(input);
            var receipt = Wire.DecodePropertyCommandReceipt(await Send(WireRoutes.PropertyValueCommand, frame));
            Assert.Equal(new(definitions[index], values.Length, index + 1), receipt);
        }

        var workspace = await Read();
        Assert.Equal(8, workspace.Fields.Count);
        for (var index = 0; index < values.Length; index++)
        {
            var expected = values[index];
            var field = workspace.Fields[index];
            Assert.Equal(definitions[index], field.DefinitionId);
            Assert.Equal(expected.Kind, field.Kind);
            Assert.Equal(Wire.EncodePropertyValueInput(Value(source, index, 8, expected.Value)),
                Wire.EncodePropertyValueInput(Value(source, index, 8, field.Value)));
        }
        await Rejected(Value(source, 2, 8, new PropertyFieldValue.Text("false")));
        await Rejected(Value(source, 4, 8, new PropertyFieldValue.SingleSelect(Guid.NewGuid())));
        await Rejected(Value(source, 6, 8, new PropertyFieldValue.ArticleReference([privateTarget.Id])));
        await Rejected(Value(source, 6, 8, new PropertyFieldValue.ArticleReference([source.Id])));
        await Rejected(Value(target, 6, 0, new PropertyFieldValue.ArticleReference([source.Id])));
        await Rejected(Value(source, 7, 8, new PropertyFieldValue.Url("http://example.net/unsupported")));

        var setNull = Wire.EncodePropertyValueInput(Value(source, 0, 8, new PropertyFieldValue.Null()));
        Assert.Equal(9, Wire.DecodePropertyCommandReceipt(await Send(WireRoutes.PropertyValueCommand, setNull)).Revision);
        Assert.IsType<PropertyFieldValue.Null>((await Read()).Fields[0].Value);
        var remove = Wire.EncodePropertyValueInput(Value(source, 0, 9, new PropertyFieldValue.Missing()));
        Assert.Equal(10, Wire.DecodePropertyCommandReceipt(await Send(WireRoutes.PropertyValueCommand, remove)).Revision);
        Assert.IsType<PropertyFieldValue.Missing>((await Read()).Fields[0].Value);

        await Edit(ArticleAction.Retract, new(target.Id, target.Revision, Guid.NewGuid(), "", ""));
        Assert.IsType<PropertyFieldValue.Unavailable>((await Read()).Fields[6].Value);
        Assert.Equal(10, (await Read()).ValueRevision);

        PropertyValueInput Value(ArticleState article, int index, long valueRevision, PropertyFieldValue value) =>
            new(article.Id, article.Revision, values.Length, valueRevision, definitions[index], 1,
                Guid.Parse($"32783000-0000-0000-0000-{index + 1 + valueRevision * 100:D12}"), value);
        async Task<PropertyEditorWorkspace> Read() => Wire.DecodePropertyEditor(await Send(WireRoutes.PropertyEditor,
            Wire.EncodePropertyWorkspaceRequest(new(source.Id, source.Revision, 0, 0, ""))));
        async Task Rejected(PropertyValueInput input)
        {
            var error = await Send(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueInput(input), HttpStatusCode.BadRequest);
            Assert.Equal(WireLayouts.ErrorBytes, Aeds.Decode(error, FrameType.ApiError).Length);
        }
        async Task<byte[]> Send(string path, byte[] bytes, HttpStatusCode expected = HttpStatusCode.OK)
        {
            using var request = SiteAedsFixture.Request(HttpMethod.Post, path, bytes, session, handle: null);
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(expected, response.StatusCode);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }
        async Task<ArticleState> Edit(ArticleAction action, Edit edit) => (await store.WithSession(session, true,
            (connection, tx, actor) => Store.Execute(connection, tx, actor, action, Publishing.Validate(action, edit), ct), ct)).Article;
    }
}
