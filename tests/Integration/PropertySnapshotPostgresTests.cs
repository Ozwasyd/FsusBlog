namespace FsusBlog.V2.Integration.Tests;

public sealed class PropertySnapshotPostgresTests
{
    [PostgresFact]
    public async Task SavedPropertiesRemainPrivateAndImmutableAcrossPublishRetractAndRestart()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await db.SignIn("Property snapshot owner", ct);
        var outsider = await db.SignIn("Property snapshot outsider", ct);

        const string OriginalText = "snapshot-private-original-raw";
        const string PublishedText = "snapshot-private-published-raw";
        const string UnsavedText = "snapshot-private-unsaved-raw";
        var service = await ServerProcess.Start(db.ConnectionString, ct);
        var client = service.Client;
        Draft target, saved, published, retracted;
        byte[] savedBytes, publishedBytes;
        await using (service)
        {
            var empty = await Article(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Article", "Empty property revision"));
            var capturedEmpty = Wire.DecodePropertyEditor(await Snapshot(empty.Id, empty.Revision, empty.Revision, owner));
            Assert.Equal((empty.Id, empty.Revision, 0L, 0L), Coordinates(capturedEmpty));
            Assert.Empty(capturedEmpty.Fields);

            var targetDraft = await Article(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Target", "Referenced article"));
            target = await Article(WireRoutes.Publish, new(targetDraft.Id, targetDraft.Revision, Guid.NewGuid(), "", ""));

            var red = Guid.Parse("07b84434-3061-44e5-af9a-05db78ae1f01");
            var blue = Guid.Parse("07b84434-3061-44e5-af9a-05db78ae1f02");
            PropertyFieldOption[] options = [new(red, "Red"), new(blue, "Blue")];
            (PropertyFieldKind Kind, PropertyFieldValue Value)[] fixture =
            [
                (PropertyFieldKind.Text, new PropertyFieldValue.Text(OriginalText)),
                (PropertyFieldKind.Number, new PropertyFieldValue.Number(9007199254740993.1234567m)),
                (PropertyFieldKind.Boolean, new PropertyFieldValue.Boolean(false)),
                (PropertyFieldKind.Date, new PropertyFieldValue.Date(DateTimeOffset.FromUnixTimeMilliseconds(1794669740123))),
                (PropertyFieldKind.SingleSelect, new PropertyFieldValue.SingleSelect(red)),
                (PropertyFieldKind.MultiSelect, new PropertyFieldValue.MultiSelect([red, blue])),
                (PropertyFieldKind.ArticleReference, new PropertyFieldValue.ArticleReference([target.Id])),
                (PropertyFieldKind.Url, new PropertyFieldValue.Url("https://example.net/snapshot")),
            ];
            var definitions = new Guid[fixture.Length];
            for (var index = 0; index < fixture.Length; index++)
            {
                var kind = fixture[index].Kind;
                definitions[index] = Guid.NewGuid();
                var receipt = await Define(new(1, definitions[index], Guid.NewGuid(), index, 0, $"prop-{index}", $"Field {index}"),
                    kind, kind is PropertyFieldKind.SingleSelect or PropertyFieldKind.MultiSelect ? options : []);
                Assert.Equal(new PropertyCommandReceipt(definitions[index], index + 1, 1), receipt);
            }

            var initial = new PropertyValueBatchInput(empty.Id, empty.Revision, fixture.Length, 0, Guid.NewGuid(),
                definitions.Select((id, index) => new PropertyValueChange(id, 1, fixture[index].Value)).ToArray());
            Assert.Equal(1, (await Batch(initial)).ValueRevision);
            Assert.Empty(Wire.DecodePropertyEditor(await Snapshot(empty.Id, empty.Revision, empty.Revision, owner)).Fields);
            saved = await Article(WireRoutes.Save, new(empty.Id, empty.Revision, Guid.NewGuid(), empty.Title, "Saved property revision"));
            savedBytes = await Snapshot(saved.Id, saved.Revision, saved.Revision, owner);
            var capture = Wire.DecodePropertyEditor(savedBytes);
            Assert.Equal((saved.Id, saved.Revision, (long)fixture.Length, 1L), Coordinates(capture));
            Assert.Equal(definitions, capture.Fields.Select(field => field.DefinitionId));
            for (var index = 0; index < fixture.Length; index++)
            {
                var field = capture.Fields[index];
                Assert.Equal((fixture[index].Kind, $"Field {index}", 1L), (field.Kind, field.Label, field.DefinitionRevision));
                var check = new PropertyValueInput(saved.Id, saved.Revision, fixture.Length, 1, definitions[index], 1,
                    Guid.NewGuid(), fixture[index].Value);
                Assert.Equal(Wire.EncodePropertyValueInput(check), Wire.EncodePropertyValueInput(check with { Value = field.Value }));
            }
            var suffix = Wire.DecodePropertyEditor(await Snapshot(saved.Id, saved.Revision, saved.Revision, owner, offset: 4));
            Assert.Equal(definitions.Skip(4), suffix.Fields.Select(field => field.DefinitionId));

            var rename = await Define(new(2, definitions[0], Guid.NewGuid(), fixture.Length, 1, "", "Renamed field"),
                PropertyFieldKind.Text, []);
            var revisedValues = new PropertyValueBatchInput(saved.Id, saved.Revision, rename.SchemaRevision, 1, Guid.NewGuid(),
                [new(definitions[0], rename.Revision, new PropertyFieldValue.Text(PublishedText)),
                 new(definitions[^1], 1, new PropertyFieldValue.Missing())]);
            Assert.Equal(2, (await Batch(revisedValues)).ValueRevision);
            Assert.Equal(savedBytes, await Snapshot(saved.Id, saved.Revision, saved.Revision, owner));

            published = await Article(WireRoutes.Publish, new(saved.Id, saved.Revision, Guid.NewGuid(), "", ""));
            publishedBytes = await Snapshot(published.Id, published.Revision, published.Revision, owner);
            var publishedSnapshot = Wire.DecodePropertyEditor(publishedBytes);
            Assert.Equal((published.Id, published.Revision, rename.SchemaRevision, 2L), Coordinates(publishedSnapshot));
            Assert.Equal(("Renamed field", rename.Revision, PublishedText), (publishedSnapshot.Fields[0].Label,
                publishedSnapshot.Fields[0].DefinitionRevision, Assert.IsType<PropertyFieldValue.Text>(publishedSnapshot.Fields[0].Value).Value));
            Assert.Equal(definitions.Take(definitions.Length - 1), publishedSnapshot.Fields.Select(field => field.DefinitionId));
            Assert.Equal(savedBytes, await Snapshot(saved.Id, published.Revision, saved.Revision, owner));

            var update = new PropertyValueInput(published.Id, published.Revision, rename.SchemaRevision, 2, definitions[0],
                rename.Revision, Guid.NewGuid(), new PropertyFieldValue.Text(UnsavedText));
            var live = Wire.DecodePropertyCommandReceipt(await Request(HttpMethod.Post, WireRoutes.PropertyValueCommand, owner,
                Wire.EncodePropertyValueInput(update)));
            Assert.Equal(3, live.Revision);
            Assert.Equal(publishedBytes, await Snapshot(published.Id, published.Revision, published.Revision, owner));

            var publicPath = WireRoutes.PublicArticle.Replace("{id}", published.Id.ToString(CultureInfo.InvariantCulture));
            var html = await client.GetStringAsync($"/article/{published.Id}", ct);
            var publicArticle = Encoding.UTF8.GetString(Aeds.Decode(await client.GetByteArrayAsync(publicPath, ct), FrameType.ArticleDetail));
            Assert.Contains("Saved property revision", html);
            Assert.Contains("Saved property revision", publicArticle);
            foreach (var privateText in new[] { OriginalText, PublishedText, UnsavedText, "Renamed field", "https://example.net/snapshot" })
            {
                Assert.DoesNotContain(privateText, html);
                Assert.DoesNotContain(privateText, publicArticle);
            }

            await Snapshot(saved.Id, saved.Revision, saved.Revision, owner, HttpStatusCode.Conflict);
            await Snapshot(saved.Id, published.Revision, saved.Revision, null, HttpStatusCode.Unauthorized);
            await Snapshot(saved.Id, published.Revision, saved.Revision, outsider, HttpStatusCode.NotFound);
            var priorHandle = owner.Handle;
            var secondSession = await db.SignIn(owner.Id, ct);
            await Snapshot(saved.Id, published.Revision, saved.Revision,
                (secondSession.Id, secondSession.Token, priorHandle), HttpStatusCode.Conflict);
            await db.SignOutAdmin(secondSession.Token, ct);
            await Snapshot(saved.Id, published.Revision, saved.Revision, secondSession, HttpStatusCode.Unauthorized);
            owner = await db.SignIn(owner.Id, ct);

            var legacyId = await db.ScalarAsync<int>(ct, """
                with legacy as (
                    insert into public.article(owner_id,revision,title,body,deleted)
                    values($1,1,'Old article','Old body',false) returning id,title,body
                )
                insert into public.article_revision(article_id,revision,title,body,happened_at)
                select id,1,title,body,now() from legacy returning article_id
                """, owner.Id);
            await Batch(initial with { ArticleId = legacyId, ArticleRevision = 1, SchemaRevision = rename.SchemaRevision,
                RequestId = Guid.NewGuid(), Changes = [new(definitions[0], rename.Revision, new PropertyFieldValue.Text("Current legacy value"))] });
            await Snapshot(legacyId, 1, 1, owner, HttpStatusCode.NotFound);

            retracted = await Article(WireRoutes.Retract, new(published.Id, published.Revision, Guid.NewGuid(), "", ""));
            Assert.Equal(savedBytes, await Snapshot(saved.Id, retracted.Revision, saved.Revision, owner));
            Assert.Equal(publishedBytes, await Snapshot(published.Id, retracted.Revision, published.Revision, owner));
            await CheckStatusAsync(HttpStatusCode.NotFound, client.GetAsync(publicPath, ct));
        }

        await using var restarted = await ServerProcess.Start(db.ConnectionString, ct);
        client = restarted.Client;
        Assert.Equal(savedBytes, await Snapshot(saved.Id, retracted.Revision, saved.Revision, owner));
        Assert.Equal(publishedBytes, await Snapshot(published.Id, retracted.Revision, published.Revision, owner));

        var restored = Wire.DecodeDraft(await Request(HttpMethod.Post, WireRoutes.DraftRollback, owner,
            Wire.EncodeDraftRollback(new(saved.Id, retracted.Revision, saved.Revision, Guid.NewGuid(), "Restore saved metadata"))));
        Assert.Equal(saved.Body, restored.Body);
        var restoredSnapshot = Wire.DecodePropertyEditor(await Snapshot(restored.Id, restored.Revision, restored.Revision, owner));
        Assert.Equal(savedBytes, Wire.EncodePropertyEditor(restoredSnapshot with { ArticleRevision = saved.Revision }));
        Assert.Equal(1L, await db.ScalarAsync<long>(ct, """
            select count(*) from public.article_revision_property_snapshot original
            join public.article_revision_property_snapshot restored using(article_id,schema_revision,value_revision)
            where original.article_id=$1 and original.revision=$2 and restored.revision=$3
            """, saved.Id, saved.Revision, restored.Revision));

        var dbNow = await db.ScalarAsync<DateTime>(ct, "select clock_timestamp()");
        var due = new DateTimeOffset(dbNow).AddHours(1);
        var scheduleCommand = new ArticleScheduleCommand(restored.Id, restored.Revision, Guid.NewGuid(), due.ToUnixTimeMilliseconds());
        var pending = Wire.DecodeArticleSchedule(await Request(HttpMethod.Post, WireRoutes.DraftScheduleCommand, owner,
            Wire.EncodeArticleScheduleCommand(scheduleCommand)));
        var pendingBytes = await Snapshot(pending.Id, pending.Revision, pending.Revision, owner);
        var pendingSnapshot = Wire.DecodePropertyEditor(pendingBytes);
        var pendingText = pendingSnapshot.Fields[0];
        Assert.Equal(UnsavedText, Assert.IsType<PropertyFieldValue.Text>(pendingText.Value).Value);
        var pendingDigest = await db.ScalarAsync<string>(ct, """
            select s.digest from public.article_revision_property_snapshot r
            join public.article_property_snapshot s using(article_id,schema_revision,value_revision)
            where r.article_id=$1 and r.revision=$2
            """, pending.Id, pending.Revision);

        var afterSchedule = new PropertyValueInput(pending.Id, pending.Revision, pendingSnapshot.SchemaRevision,
            pendingSnapshot.ValueRevision, pendingText.DefinitionId, pendingText.DefinitionRevision, Guid.NewGuid(),
            new PropertyFieldValue.Text("A later live value must not replace the scheduled snapshot"));
        var newer = Wire.DecodePropertyCommandReceipt(await Request(HttpMethod.Post, WireRoutes.PropertyValueCommand, owner,
            Wire.EncodePropertyValueInput(afterSchedule)));
        Assert.Equal(pendingSnapshot.ValueRevision + 1, newer.Revision);
        Assert.Equal(1, await db.InTx((c, tx) => ArticleScheduleStore.PublishDue(c, tx, ct,
            DateTimeOffset.FromUnixTimeMilliseconds(scheduleCommand.DueUnixMs).UtcDateTime), ct));
        Assert.Equal(pendingBytes, await Snapshot(pending.Id, pending.Revision, pending.Revision, owner));
        Assert.Equal(pendingDigest, await db.ScalarAsync<string>(ct, """
            select s.digest from public.article_publication p
            join public.article_publication_history h using(article_id,publication_id,revision)
            join public.article_revision_property_snapshot r using(article_id,revision)
            join public.article_property_snapshot s using(article_id,schema_revision,value_revision)
            where p.article_id=$1 and p.revision=$2 and h.command_id=$3 and h.actor_id=$4 and h.reason='scheduled-published'
            """, pending.Id, pending.Revision, scheduleCommand.IdempotencyKey, owner.Id));

        await Article(WireRoutes.Retract, new(target.Id, target.Revision, Guid.NewGuid(), "", ""));
        var afterRetraction = Wire.DecodePropertyEditor(await Snapshot(pending.Id, pending.Revision, saved.Revision, owner));
        var originallySaved = Wire.DecodePropertyEditor(savedBytes);
        var reference = Assert.Single(afterRetraction.Fields, field => field.Kind == PropertyFieldKind.ArticleReference);
        Assert.IsType<PropertyFieldValue.Unavailable>(reference.Value);
        Assert.Equal(savedBytes, Wire.EncodePropertyEditor(afterRetraction with
        {
            Fields = afterRetraction.Fields.Select((field, index) => field.DefinitionId == reference.DefinitionId
                ? field with { Value = originallySaved.Fields[index].Value } : field).ToArray()
        }));

        Assert.Equal(1, await db.ScalarAsync<int>(ct, """
            update public.article_property_snapshot_field set data='{}'::jsonb
            where article_id=$1 and schema_revision=$2 and value_revision=$3 and definition_id=$4 returning 1
            """, pending.Id, pendingSnapshot.SchemaRevision, pendingSnapshot.ValueRevision, pendingText.DefinitionId));
        var error = await Snapshot(pending.Id, pending.Revision, pending.Revision, owner, HttpStatusCode.InternalServerError);
        Assert.Equal(WireLayouts.ErrorBytes, Aeds.Decode(error, FrameType.ApiError).Length);
        Assert.Equal(Wire.EncodePropertyEditor(afterRetraction), await Snapshot(pending.Id, pending.Revision, saved.Revision, owner));

        static (int, long, long, long) Coordinates(PropertyEditorWorkspace snapshot) =>
            (snapshot.ArticleId, snapshot.ArticleRevision, snapshot.SchemaRevision, snapshot.ValueRevision);

        Task<byte[]> Snapshot(int id, long current, long selected, (Guid Id, string Token, string Handle)? session,
            HttpStatusCode status = HttpStatusCode.OK, int offset = 0) => Request(HttpMethod.Get,
                FormattableString.Invariant($"/api/v2/authoring/draft/{id}/revisions/{selected}.aeds?revision={current}&map=properties") +
                (offset == 0 ? "" : FormattableString.Invariant($"&offset={offset}")), session, status: status);

        Task<Draft> Article(string path, ArticleCommand command) =>
            SiteAedsFixture.ArticleCommand(client, path, owner.Token, owner.Handle, command, ct);

        async Task<PropertyCommandReceipt> Define(PropertyDefinitionCommand command, PropertyFieldKind kind, PropertyFieldOption[] choices) =>
            Wire.DecodePropertyCommandReceipt(await Request(HttpMethod.Post, WireRoutes.PropertySchemaCommand, owner,
                Wire.EncodePropertySchemaInput(new(command, kind, choices))));

        async Task<PropertyValueBatchReceipt> Batch(PropertyValueBatchInput input) =>
            Wire.DecodePropertyValueBatchReceipt(await Request(HttpMethod.Post, WireRoutes.PropertyValueCommand, owner,
                Wire.EncodePropertyValueBatch(input)));

        Task<byte[]> Request(HttpMethod method, string path, (Guid Id, string Token, string Handle)? session,
            byte[]? bytes = null, HttpStatusCode status = HttpStatusCode.OK) =>
            SiteAedsFixture.ExpectStatus(client, method, path, bytes, session?.Token, session?.Handle, status, ct);
    }
}
