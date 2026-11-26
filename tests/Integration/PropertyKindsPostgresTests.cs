namespace FsusBlog.V2.Integration.Tests;

public sealed class PropertyKindsPostgresTests
{
    [PostgresFact]
    public async Task AllEightKindsRoundTripInOneAuthorizedEditor()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(db.DataSource);
        var (_, session, _) = await db.SignIn("author", ct);
        var source = await Edit(ArticleAction.Save, new(0, 0, Guid.NewGuid(), "Source", "Text"));
        var target = await Edit(ArticleAction.Save, new(0, 0, Guid.NewGuid(), "Target", "Text"));
        var privateTarget = await Edit(ArticleAction.Save, new(0, 0, Guid.NewGuid(), "Private", "Text"));
        source = await Edit(ArticleAction.Publish, new(source.Id, source.Revision, Guid.NewGuid(), "", ""));
        target = await Edit(ArticleAction.Publish, new(target.Id, target.Revision, Guid.NewGuid(), "", ""));
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);
        var red = Guid.NewGuid();
        var blue = Guid.NewGuid();
        PropertyFieldOption[] options = [new(red, "Red"), new(blue, "Blue")];
        var values = TypedPropertyFixture.Samples(target.Id, red, new[] { blue, red }.Order().ToArray(), "准确 🐈",
            number: decimal.Parse("9007199254740993.1234567", System.Globalization.CultureInfo.InvariantCulture));
        string[] names = ["a-text", "b-number", "c-boolean", "d-date", "e-single", "f-multi", "g-reference", "h-url"];
        var definitions = await TypedPropertyFixture.CreateDefinitions(values, options, index => (names[index], names[index]),
            frame => Send(WireRoutes.PropertySchemaCommand, frame), TypedPropertyFixture.AssertCreated);
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
        Task<byte[]> Send(string path, byte[] bytes, HttpStatusCode expected = HttpStatusCode.OK) =>
            SiteAedsFixture.ExpectStatus(server.Client, HttpMethod.Post, path, bytes, session, null, expected, ct);
        async Task<ArticleState> Edit(ArticleAction action, Edit edit) => (await store.WithSession(session, true,
            (connection, tx, actor) => Store.Execute(connection, tx, actor, action, Publishing.Validate(action, edit), ct), ct)).Article;
    }
}
