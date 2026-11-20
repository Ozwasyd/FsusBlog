using System.Net;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;

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
        Assert.Equal(Schema, renamed.SchemaRevision);
        Assert.Equal(TextRevision, renamed.Revision);

        var single = new PropertyValueInput(draft.Id, draft.Revision, Schema, 0, text, TextRevision, Guid.NewGuid(),
            new PropertyFieldValue.Text("Old value"));
        var seeded = await Expect(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueInput(single), HttpStatusCode.OK);
        Assert.Equal(1, Wire.DecodePropertyCommandReceipt(seeded).Revision);

        const decimal ExactValue = 9007199254740993.1234567m;
        var initial = new PropertyValueBatchInput(draft.Id, draft.Revision, Schema, 1, Guid.NewGuid(),
            [new(text, TextRevision, new PropertyFieldValue.Missing()), new(number, 1, new PropertyFieldValue.Number(ExactValue))]);
        var initialFrame = Wire.EncodePropertyValueBatch(initial);
        var receipt = await Expect(WireRoutes.PropertyValueCommand, initialFrame, HttpStatusCode.OK);
        Assert.Equal(new PropertyValueBatchReceipt(draft.Id, Schema, 2, initial.RequestId),
            Wire.DecodePropertyValueBatchReceipt(receipt));
        Assert.Equal(receipt, await Expect(WireRoutes.PropertyValueCommand, initialFrame, HttpStatusCode.OK));

        var afterInitial = await Read();
        Assert.Equal(draft.Revision, afterInitial.ArticleRevision);
        Assert.Equal(Schema, afterInitial.SchemaRevision);
        Assert.Equal(2, afterInitial.ValueRevision);
        Assert.IsType<PropertyFieldValue.Missing>(Field(afterInitial, text));
        Assert.Equal(ExactValue, Assert.IsType<PropertyFieldValue.Number>(Field(afterInitial, number)).Value);

        var next = initial with
        {
            RequestId = Guid.NewGuid(),
            ValueRevision = afterInitial.ValueRevision,
            Changes = [new(text, TextRevision, new PropertyFieldValue.Text("This must roll back")), new(number, 1, new PropertyFieldValue.Number(0))]
        };
        await Reject(next with { RequestId = initial.RequestId }, HttpStatusCode.Conflict);
        await Reject(next with { RequestId = single.RequestId }, HttpStatusCode.Conflict);
        await Expect(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueInput(single with
        {
            RequestId = initial.RequestId,
            ValueRevision = afterInitial.ValueRevision,
            Value = new PropertyFieldValue.Text("An existing batch key cannot authorize a single write")
        }), HttpStatusCode.Conflict);
        await Reject(next with { ArticleRevision = original.Revision }, HttpStatusCode.Conflict);
        await Reject(next with { SchemaRevision = Schema - 1 }, HttpStatusCode.Conflict);
        await Reject(next with { ValueRevision = 1 }, HttpStatusCode.Conflict);
        await Reject(next with { Changes = [next.Changes[0] with { DefinitionRevision = 1 }, next.Changes[1]] }, HttpStatusCode.Conflict);

        var invalidMember = next with { Changes = [next.Changes[0], next.Changes[1] with { Value = new PropertyFieldValue.Boolean(false) }] };
        await Reject(invalidMember, HttpStatusCode.BadRequest);
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
        var winner = Assert.Single(outcomes, outcome => outcome.Status == HttpStatusCode.OK);
        var loser = Assert.Single(outcomes, outcome => outcome.Status == HttpStatusCode.Conflict);
        Assert.Equal(WireLayouts.ErrorBytes, Aeds.Decode(loser.Bytes, FrameType.ApiError).Length);
        var applied = outcomes[0].Status == HttpStatusCode.OK ? first : second;
        Assert.Equal(new PropertyValueBatchReceipt(draft.Id, Schema, 3, applied.RequestId),
            Wire.DecodePropertyValueBatchReceipt(winner.Bytes));

        var final = await Read();
        Assert.Equal(3, final.ValueRevision);
        Assert.Equal(applied.Changes[0].Value, Field(final, text));
        Assert.Equal(applied.Changes[1].Value, Field(final, number));
        Assert.Equal(receipt, await Expect(WireRoutes.PropertyValueCommand, initialFrame, HttpStatusCode.OK));
        Assert.Equal(3, (await Read()).ValueRevision);

        var untouched = Guid.Parse("742d4400-0701-452c-aa94-9e9964cae703");
        var added = await Define(new(1, untouched, Guid.NewGuid(), Schema, 0, "c-untouched", "Untouched"), PropertyFieldKind.Text);
        var searchable = await OptIn(text, added.SchemaRevision, TextRevision);
        var retained = await OptIn(untouched, searchable.SchemaRevision, added.Revision);
        var setup = new PropertyValueInput(draft.Id, draft.Revision, retained.SchemaRevision, final.ValueRevision, untouched,
            retained.Revision, Guid.NewGuid(), new PropertyFieldValue.Text("Unchanged source"));
        await Expect(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueInput(setup), HttpStatusCode.OK);
        var beforeLateFailure = await Read();
        var publicEvents = await Scalar<long>($"select count(*) from public.blog_outbox where article_id={draft.Id}");
        var late = new PropertyValueBatchInput(draft.Id, draft.Revision, retained.SchemaRevision, beforeLateFailure.ValueRevision, Guid.NewGuid(),
            [new(text, searchable.Revision, new PropertyFieldValue.Text("Late text")), new(number, 1, new PropertyFieldValue.Number(314.125m))]);

        // A sequence witnesses that both new values and their shared revision reached PostgreSQL before the rejected enqueue.
        // Its nextval remains observable after the production transaction rolls back.
        await Execute($"""
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
        await Reject(late, HttpStatusCode.ServiceUnavailable);
        Assert.True(await Scalar<bool>("select is_called from public.fixture_property_batch_late_attempt"));
        var afterLateFailure = await Read();
        Assert.Equal(beforeLateFailure.ValueRevision, afterLateFailure.ValueRevision);
        Assert.Equal(beforeLateFailure.Fields.Select(field => field.Value), afterLateFailure.Fields.Select(field => field.Value));
        Assert.Equal(0, await Scalar<long>($"""
            select count(*) from public.property_value_command where article_id={draft.Id} and request_id='{late.RequestId}'::uuid
            """));
        Assert.Equal(0, await Scalar<long>($"""
            select count(*) from public.author_text_rebuild_job where owner_id='{author}'::uuid and profile=4
            """));

        await Execute("drop trigger fixture_property_batch_refuse_rebuild on public.author_text_rebuild_job");
        var lateReceipt = await Expect(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueBatch(late), HttpStatusCode.OK);
        Assert.Equal(new PropertyValueBatchReceipt(draft.Id, late.SchemaRevision, late.ValueRevision + 1, late.RequestId),
            Wire.DecodePropertyValueBatchReceipt(lateReceipt));
        var afterRetry = await Read();
        Assert.Equal(late.ValueRevision + 1, afterRetry.ValueRevision);
        Assert.Equal(late.Changes[0].Value, Field(afterRetry, text));
        Assert.Equal(late.Changes[1].Value, Field(afterRetry, number));
        // No search request has been sent. The committed mutation alone queues both the changed and retained sources.
        await WaitForProjection(afterRetry.ValueRevision, lateText: true);
        var clear = late with
        {
            RequestId = Guid.NewGuid(), ValueRevision = afterRetry.ValueRevision,
            Changes = [new(text, searchable.Revision, new PropertyFieldValue.Missing())]
        };
        await Expect(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueBatch(clear), HttpStatusCode.OK);
        await WaitForProjection(clear.ValueRevision + 1, lateText: false);
        Assert.Equal(publicEvents, await Scalar<long>($"select count(*) from public.blog_outbox where article_id={draft.Id}"));

        async Task<PropertyCommandReceipt> OptIn(Guid definition, long schemaRevision, long definitionRevision) =>
            Wire.DecodePropertyCommandReceipt(await Expect(WireRoutes.PropertySchemaCommand,
                Wire.EncodePropertyDefinitionProjectionCommand(new(definition, Guid.NewGuid(), schemaRevision,
                    definitionRevision, SearchEligible: true, Sortable: false)), HttpStatusCode.OK));

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
            while (!await Scalar<bool>(witness))
                await Task.Delay(TimeSpan.FromMilliseconds(50), timeout.Token);
        }

        async Task Execute(string sql)
        {
            await using var connection = await db.DataSource.OpenConnectionAsync(ct);
            await using var command = Store.Sql(connection, null, sql);
            await command.ExecuteNonQueryAsync(ct);
        }

        async Task<T> Scalar<T>(string sql)
        {
            await using var connection = await db.DataSource.OpenConnectionAsync(ct);
            return Assert.IsType<T>(await FixtureSql.ScalarAsync(connection, null, ct, sql));
        }

        async Task<ArticleState> Save(int article, long revision, string body) =>
            (await store.WithSession(session, true, (connection, tx, actor) => Store.Execute(connection, tx, actor,
                ArticleAction.Save, new(article, revision, Guid.NewGuid(), "Property batch", body), ct), ct)).Article;

        async Task<PropertyCommandReceipt> Define(PropertyDefinitionCommand command, PropertyFieldKind kind) =>
            Wire.DecodePropertyCommandReceipt(await Expect(WireRoutes.PropertySchemaCommand,
                Wire.EncodePropertySchemaInput(new(command, kind, [])), HttpStatusCode.OK));

        async Task<PropertyEditorWorkspace> Read() =>
            Wire.DecodePropertyEditor(await Expect(WireRoutes.PropertyEditor,
                Wire.EncodePropertyWorkspaceRequest(new(draft.Id, draft.Revision, 0, 0, "")), HttpStatusCode.OK));

        static PropertyFieldValue Field(PropertyEditorWorkspace workspace, Guid definition) =>
            Assert.Single(workspace.Fields, field => field.DefinitionId == definition).Value;

        async Task Reject(PropertyValueBatchInput input, HttpStatusCode status)
        {
            var body = await Expect(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueBatch(input), status);
            Assert.Equal(WireLayouts.ErrorBytes, Aeds.Decode(body, FrameType.ApiError).Length);
        }

        async Task<byte[]> Expect(string path, byte[] body, HttpStatusCode status)
        {
            var result = await Post(path, body, session);
            Assert.Equal(status, result.Status);
            return result.Bytes;
        }

        async Task<(HttpStatusCode Status, byte[] Bytes)> Post(string path, byte[] body, string token)
        {
            using var request = SiteAedsFixture.Request(HttpMethod.Post, path, body, token, null);
            using var response = await server.Client.SendAsync(request, ct);
            return (response.StatusCode, await response.Content.ReadAsByteArrayAsync(ct));
        }
    }
}
