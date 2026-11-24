namespace FsusBlog.V2.Integration.Tests;

public sealed class PropertyBatchPostgresTests
{
    [PostgresFact]
    public async Task OneAuthorizedBatchAppliesAllFieldsAtOneRevisionAndRetriesExactly()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(db.DataSource);
        var (author, session, _) = await db.SignIn("Property batch author", ct);
        var original = await Save(0, 0, "Original body");
        var draft = await Save(original.Id, original.Revision, "Updated body");
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);

        var text = Guid.Parse("742d4400-0701-452c-aa94-9e9964cae701");
        var number = Guid.Parse("742d4400-0701-452c-aa94-9e9964cae702");
        Assert.Equal(1, (await Define(new(1, text, Guid.NewGuid(), 0, 0, "a-text", "Text"), PropertyFieldKind.Text)).Revision);
        Assert.Equal(1, (await Define(new(1, number, Guid.NewGuid(), 1, 0, "b-number", "Number"), PropertyFieldKind.Number)).Revision);
        const long Schema = 3;
        const long TextRevision = 2;
        var renamed = await Define(new(2, text, Guid.NewGuid(), 2, 1, "", "Renamed text"), PropertyFieldKind.Text);
        Assert.Equal((Schema, TextRevision), (renamed.SchemaRevision, renamed.Revision));

        var single = new PropertyValueInput(draft.Id, draft.Revision, Schema, 0, text, TextRevision, Guid.NewGuid(),
            new PropertyFieldValue.Text("Old value"));
        Assert.Equal(1, Wire.DecodePropertyCommandReceipt(await Expect(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueInput(single), OK)).Revision);

        const decimal ExactValue = 9007199254740993.1234567m;
        var initial = new PropertyValueBatchInput(draft.Id, draft.Revision, Schema, 1, Guid.NewGuid(),
            [new(text, TextRevision, new PropertyFieldValue.Missing()), new(number, 1, new PropertyFieldValue.Number(ExactValue))]);
        var initialFrame = Wire.EncodePropertyValueBatch(initial);
        var receipt = await Expect(WireRoutes.PropertyValueCommand, initialFrame, OK);
        Assert.Equal(new PropertyValueBatchReceipt(draft.Id, Schema, 2, initial.RequestId), Wire.DecodePropertyValueBatchReceipt(receipt));
        Assert.Equal(receipt, await Expect(WireRoutes.PropertyValueCommand, initialFrame, OK));

        var afterInitial = await Read();
        Assert.Equal((draft.Revision, Schema, 2L), (afterInitial.ArticleRevision, afterInitial.SchemaRevision, afterInitial.ValueRevision));
        Assert.IsType<PropertyFieldValue.Missing>(Field(afterInitial, text));
        Assert.Equal(ExactValue, Assert.IsType<PropertyFieldValue.Number>(Field(afterInitial, number)).Value);

        var next = initial with
        {
            RequestId = Guid.NewGuid(),
            ValueRevision = afterInitial.ValueRevision,
            Changes = [new(text, TextRevision, new PropertyFieldValue.Text("This must roll back")), new(number, 1, new PropertyFieldValue.Number(0))]
        };
        await Expect(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueInput(single with
        {
            RequestId = initial.RequestId, ValueRevision = afterInitial.ValueRevision,
            Value = new PropertyFieldValue.Text("An existing batch key cannot authorize a single write")
        }), Conflict);
        foreach (var (bad, status) in new[]
        {
            (next with { RequestId = initial.RequestId }, Conflict),
            (next with { RequestId = single.RequestId }, Conflict),
            (next with { ArticleRevision = original.Revision }, Conflict),
            (next with { SchemaRevision = Schema - 1 }, Conflict),
            (next with { ValueRevision = 1 }, Conflict),
            (next with { Changes = [next.Changes[0] with { DefinitionRevision = 1 }, next.Changes[1]] }, Conflict),
            (next with { Changes = [next.Changes[0], next.Changes[1] with { Value = new PropertyFieldValue.Boolean(false) }] }, BadRequest),
        })
            await Reject(bad, status);
        var afterRejection = await Read();
        Assert.Equal(afterInitial.ValueRevision, afterRejection.ValueRevision);
        Assert.Equal(afterInitial.Fields.Select(field => field.Value), afterRejection.Fields.Select(field => field.Value));

        var first = next with { Changes = [new(text, TextRevision, new PropertyFieldValue.Text("First writer")), next.Changes[1]] };
        var second = next with
        {
            RequestId = Guid.NewGuid(),
            Changes = [new(text, TextRevision, new PropertyFieldValue.Text("Second writer")), new(number, 1, new PropertyFieldValue.Null())]
        };
        var outcomes = await Task.WhenAll(
            Post(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueBatch(first), session),
            Post(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueBatch(second), session));
        var winner = Assert.Single(outcomes, outcome => outcome.Status == OK);
        var loser = Assert.Single(outcomes, outcome => outcome.Status == Conflict);
        Assert.Equal(WireLayouts.ErrorBytes, Aeds.Decode(loser.Bytes, FrameType.ApiError).Length);
        var applied = outcomes[0].Status == OK ? first : second;
        Assert.Equal(new PropertyValueBatchReceipt(draft.Id, Schema, 3, applied.RequestId), Wire.DecodePropertyValueBatchReceipt(winner.Bytes));

        var final = await Read();
        Assert.Equal((3L, applied.Changes[0].Value, applied.Changes[1].Value), (final.ValueRevision, Field(final, text), Field(final, number)));
        Assert.Equal(receipt, await Expect(WireRoutes.PropertyValueCommand, initialFrame, OK));
        Assert.Equal(3, (await Read()).ValueRevision);

        var untouched = Guid.Parse("742d4400-0701-452c-aa94-9e9964cae703");
        var added = await Define(new(1, untouched, Guid.NewGuid(), Schema, 0, "c-untouched", "Untouched"), PropertyFieldKind.Text);
        var searchable = await OptIn(text, added.SchemaRevision, TextRevision);
        var retained = await OptIn(untouched, searchable.SchemaRevision, added.Revision);
        var setup = new PropertyValueInput(draft.Id, draft.Revision, retained.SchemaRevision, final.ValueRevision, untouched,
            retained.Revision, Guid.NewGuid(), new PropertyFieldValue.Text("Unchanged source"));
        await Expect(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueInput(setup), OK);
        var beforeLateFailure = await Read();
        var publicEvents = await db.ScalarAsync<long>(ct, $"select count(*) from public.blog_outbox where article_id={draft.Id}");
        var late = new PropertyValueBatchInput(draft.Id, draft.Revision, retained.SchemaRevision, beforeLateFailure.ValueRevision, Guid.NewGuid(),
            [new(text, searchable.Revision, new PropertyFieldValue.Text("Late text")), new(number, 1, new PropertyFieldValue.Number(314.125m))]);

        // A sequence witnesses that both new values and their shared revision reached PostgreSQL before the rejected enqueue.
        // Its nextval remains observable after the production transaction rolls back.
        await db.ExecAsync(ct, $"""
            create sequence public.fixture_property_batch_late_attempt;
            create function public.fixture_property_batch_refuse_rebuild() returns trigger language plpgsql as $$
            begin
                if new.owner_id = '{author}'::uuid and new.profile = 4 and new.definition_id = '{text}'::uuid then
                    if exists (select from public.property_article where article_id = {draft.Id} and revision = {late.ValueRevision + 1})
                        and exists (select from public.property_value where article_id = {draft.Id}
                            and definition_id = '{text}'::uuid and data->>'Value' = 'Late text')
                        and exists (select from public.property_value where article_id = {draft.Id}
                            and definition_id = '{number}'::uuid and (data->>'Value')::numeric = 314.125) then
                        perform nextval('public.fixture_property_batch_late_attempt');
                    end if;
                    raise check_violation using message = 'Fixture rejects the private rebuild enqueue';
                end if;
                return new;
            end
            $$;
            create trigger fixture_property_batch_refuse_rebuild before insert on public.author_text_rebuild_job
                for each row execute function public.fixture_property_batch_refuse_rebuild();
            """);
        await Reject(late, ServiceUnavailable);
        Assert.True(await db.ScalarAsync<bool>(ct, "select is_called from public.fixture_property_batch_late_attempt"));
        var afterLateFailure = await Read();
        Assert.Equal(beforeLateFailure.ValueRevision, afterLateFailure.ValueRevision);
        Assert.Equal(beforeLateFailure.Fields.Select(field => field.Value), afterLateFailure.Fields.Select(field => field.Value));
        Assert.Equal((0L, 0L), (await db.ScalarAsync<long>(ct, $"select count(*) from public.property_value_command where article_id={draft.Id} and request_id='{late.RequestId}'::uuid"),
            await db.ScalarAsync<long>(ct, $"select count(*) from public.author_text_rebuild_job where owner_id='{author}'::uuid and profile=4")));

        await db.ExecAsync(ct, "drop trigger fixture_property_batch_refuse_rebuild on public.author_text_rebuild_job");
        var lateReceipt = await Expect(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueBatch(late), OK);
        Assert.Equal(new PropertyValueBatchReceipt(draft.Id, late.SchemaRevision, late.ValueRevision + 1, late.RequestId),
            Wire.DecodePropertyValueBatchReceipt(lateReceipt));
        var afterRetry = await Read();
        Assert.Equal((late.ValueRevision + 1, late.Changes[0].Value, late.Changes[1].Value),
            (afterRetry.ValueRevision, Field(afterRetry, text), Field(afterRetry, number)));
        // No search request has been sent. The committed mutation alone queues both the changed and retained sources.
        await WaitForProjection(afterRetry.ValueRevision, lateText: true);
        var clear = late with
        {
            RequestId = Guid.NewGuid(), ValueRevision = afterRetry.ValueRevision,
            Changes = [new(text, searchable.Revision, new PropertyFieldValue.Missing())]
        };
        await Expect(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueBatch(clear), OK);
        await WaitForProjection(clear.ValueRevision + 1, lateText: false);
        Assert.Equal(publicEvents, await db.ScalarAsync<long>(ct, $"select count(*) from public.blog_outbox where article_id={draft.Id}"));

        async Task<PropertyCommandReceipt> OptIn(Guid definition, long schemaRevision, long definitionRevision) =>
            Wire.DecodePropertyCommandReceipt(await Expect(WireRoutes.PropertySchemaCommand,
                Wire.EncodePropertyDefinitionProjectionCommand(new(definition, Guid.NewGuid(), schemaRevision,
                    definitionRevision, SearchEligible: true, Sortable: false)), OK));

        async Task WaitForProjection(long revision, bool lateText)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            var witness = $"""
                select not exists (select from public.author_text_rebuild_job where owner_id='{author}'::uuid)
                    and exists (select from public.author_text_property_document
                        where article_id={draft.Id} and definition_id='{untouched}'::uuid and value_revision={revision}
                            and source_digest=sha256(convert_to('Unchanged source','UTF8')))
                    and {(lateText ? "" : "not ")}exists (select from public.author_text_property_document
                        where article_id={draft.Id} and definition_id='{text}'::uuid
                        {(lateText ? $"and value_revision={revision} and source_digest=sha256(convert_to('Late text','UTF8'))" : "")})
                """;
            while (!await db.ScalarAsync<bool>(ct, witness))
                await Task.Delay(TimeSpan.FromMilliseconds(50), timeout.Token);
        }

        async Task<ArticleState> Save(int article, long revision, string body) =>
            (await store.WithSession(session, true, (connection, tx, actor) => Store.Execute(connection, tx, actor,
                ArticleAction.Save, new(article, revision, Guid.NewGuid(), "Property batch", body), ct), ct)).Article;

        async Task<PropertyCommandReceipt> Define(PropertyDefinitionCommand command, PropertyFieldKind kind) =>
            Wire.DecodePropertyCommandReceipt(await Expect(WireRoutes.PropertySchemaCommand, Wire.EncodePropertySchemaInput(new(command, kind, [])), OK));

        async Task<PropertyEditorWorkspace> Read() =>
            Wire.DecodePropertyEditor(await Expect(WireRoutes.PropertyEditor, Wire.EncodePropertyWorkspaceRequest(new(draft.Id, draft.Revision, 0, 0, "")), OK));

        static PropertyFieldValue Field(PropertyEditorWorkspace workspace, Guid definition) =>
            Assert.Single(workspace.Fields, field => field.DefinitionId == definition).Value;

        async Task Reject(PropertyValueBatchInput input, HttpStatusCode status) =>
            Assert.Equal(WireLayouts.ErrorBytes,
                Aeds.Decode(await Expect(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueBatch(input), status), FrameType.ApiError).Length);

        Task<byte[]> Expect(string path, byte[] body, HttpStatusCode status) =>
            SiteAedsFixture.ExpectStatus(server.Client, HttpMethod.Post, path, body, session, null, status, ct);

        async Task<(HttpStatusCode Status, byte[] Bytes)> Post(string path, byte[] body, string token)
        {
            using var response = await SiteAedsFixture.Send(server.Client, HttpMethod.Post, path, body, token, null, ct);
            return (response.StatusCode, await response.Content.ReadAsByteArrayAsync(ct));
        }
    }
}
