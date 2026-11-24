namespace FsusBlog.V2.Integration.Tests;

public sealed class PropertyQueryPostgresTests
{
    [PostgresFact]
    public async Task ExactOwnedFiltersRejectDisabledFieldsAndKeepDistinctValueStates()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(db.DataSource);
        var (ownerId, owner, handle) = await db.SignIn("First owner", ct);
        var (_, outsider, outsiderHandle) = await db.SignIn("Second owner", ct);
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);
        const string matchText = "C12%_Needle";
        const string keyword = "c12%_needle";
        const string lexicalQuery = "needle";
        var summaryPrefix = string.Concat(Enumerable.Repeat("😀", 200 - matchText.Length));
        var primary = await Article("Match " + matchText, owner);
        var empty = await Article("Empty " + matchText, owner);
        var missing = await Article("Missing", owner);
        var foreign = await Article("Other owner " + matchText, outsider);
        var target = await Article("Reference target", owner);
        target = (await store.WithSession(owner, true, (c, t, a) => Store.Execute(c, t, a, ArticleAction.Publish,
            new(target.Id, target.Revision, Guid.NewGuid(), "", ""), ct), ct)).Article;
        var options = new[] { new PropertyFieldOption(Guid.NewGuid(), "Red"), new PropertyFieldOption(Guid.NewGuid(), "Blue"),
            new PropertyFieldOption(Guid.NewGuid(), "Green") };
        long schema = 0;
        var definitions = new[]
        {
            (PropertyFieldKind.Text, (PropertyFieldValue)new PropertyFieldValue.Text(""), (PropertyFieldValue)new PropertyFieldValue.Null()),
            (PropertyFieldKind.Number, new PropertyFieldValue.Number(9007199254740993.1234567m), new PropertyFieldValue.Number(0)),
            (PropertyFieldKind.Boolean, new PropertyFieldValue.Boolean(false), new PropertyFieldValue.Boolean(true)),
            (PropertyFieldKind.Date, new PropertyFieldValue.Date(DateTimeOffset.FromUnixTimeMilliseconds(1794669740123)), new PropertyFieldValue.Null()),
            (PropertyFieldKind.SingleSelect, new PropertyFieldValue.SingleSelect(options[0].Id), new PropertyFieldValue.SingleSelect(options[1].Id)),
            (PropertyFieldKind.MultiSelect, new PropertyFieldValue.MultiSelect([]), new PropertyFieldValue.MultiSelect([options[0].Id])),
            (PropertyFieldKind.ArticleReference, new PropertyFieldValue.ArticleReference([target.Id]), new PropertyFieldValue.Null()),
            (PropertyFieldKind.Url, new PropertyFieldValue.Url("https://example.net/guide"), new PropertyFieldValue.Null()),
        };
        var fields = new List<Guid>();
        foreach (var (kind, _, _) in definitions)
        {
            var id = Guid.NewGuid();
            var choice = kind is PropertyFieldKind.SingleSelect or PropertyFieldKind.MultiSelect;
            await Send(WireRoutes.PropertySchemaCommand, Wire.EncodePropertySchemaInput(new(
                new(1, id, Guid.NewGuid(), schema++, 0, $"property-{fields.Count}", $"Field {fields.Count}"), kind, choice ? options : [])), owner);
            fields.Add(id);
        }
        var disabled = new PropertyArticleQuery(schema, fields[0], 1, new PropertyFieldValue.Missing(), "");
        await Send(WireRoutes.PropertyArticleQuery, Wire.EncodePropertyArticleQuery(disabled), owner, HttpStatusCode.NotFound);
        await Group([Present(0, 1)], status: HttpStatusCode.NotFound);
        var outsiderFrame = Wire.EncodePropertyArticleQuery(disabled);
        await Send(WireRoutes.PropertyArticleQuery, outsiderFrame, null, HttpStatusCode.Unauthorized);
        await Send(WireRoutes.PropertyArticleQuery, outsiderFrame, outsider, HttpStatusCode.Conflict);

        for (var i = 0; i < fields.Count; i++)
        {
            await Put(primary, fields[i], definitions[i].Item2, i, 1);
            await Put(empty, fields[i], definitions[i].Item3, i, 1);
        }
        for (var i = 0; i < fields.Count; i++)
        {
            var toggle = Wire.EncodePropertyFilterabilityCommand(new(fields[i], Guid.NewGuid(), schema++, 1, true));
            var first = await Send(WireRoutes.PropertyFilterability, toggle, owner);
            Assert.Equal(first, await Send(WireRoutes.PropertyFilterability, toggle, owner));
        }
        var catalog = Wire.DecodePropertyFilterCatalog(await Send(WireRoutes.PropertyFilterCatalog, null, owner));
        Assert.Equal(schema, catalog.SchemaRevision);
        Assert.All(catalog.Fields, field => Assert.True(field.Enabled && !field.Deprecated));
        for (var i = 0; i < fields.Count; i++)
        {
            Assert.Equal(primary.Id, Assert.Single((await Filter(i, definitions[i].Item2)).Rows).Id);
            var qualified = await Qualified(new(lexicalQuery, "", null, null, schema,
                [new(fields[i], 2, PropertyComparison.Equal, definitions[i].Item2)]));
            Assert.Equal(primary.Id, Assert.Single(qualified.Rows).Id);
            Assert.Equal(1, qualified.Total);
            Assert.Equal(new[] { 1, 0, 0, 0 }, qualified.StateCounts);
            Assert.Contains((await Filter(i, new PropertyFieldValue.Missing())).Rows, row => row.Id == missing.Id);
            Assert.DoesNotContain((await Filter(i, new PropertyFieldValue.Missing())).Rows, row => row.Id == foreign.Id);
            int[] presentIds = definitions[i].Item3 is PropertyFieldValue.Null ? [primary.Id] : [empty.Id, primary.Id];
            Assert.Equal(presentIds, (await Group([Present(i)])).Rows.Select(row => row.Id));
        }
        await Group([Present(0, 1)], status: HttpStatusCode.Conflict);
        Assert.Equal(empty.Id, Assert.Single((await Filter(0, new PropertyFieldValue.Null())).Rows).Id);
        Assert.Empty((await Filter(1, new PropertyFieldValue.Number(9007199254740993.1234568m))).Rows);
        await Filter(1, new PropertyFieldValue.Text("0"), HttpStatusCode.BadRequest);

        var summaryMatches = new List<ArticleState>();
        for (var i = 0; i < WireLimits.PropertyPageSize; i++)
        {
            var body = (i == 0 ? summaryPrefix : "Private ") + matchText;
            var article = await Article($"Number page {i}", owner, body);
            await Put(article, fields[1], definitions[1].Item2, 0, 2);
            summaryMatches.Add(article);
        }
        var firstPage = await Filter(1, definitions[1].Item2);
        Assert.Equal(WireLimits.PropertyPageSize, firstPage.Rows.Count);
        Assert.NotEmpty(firstPage.NextCursor);
        Assert.Equal(primary.Id, Assert.Single((await Filter(1, definitions[1].Item2, cursor: firstPage.NextCursor)).Rows).Id);
        await Filter(1, new PropertyFieldValue.Number(0), HttpStatusCode.BadRequest, firstPage.NextCursor);
        await Filter(1, definitions[1].Item2, HttpStatusCode.BadRequest,
            (firstPage.NextCursor[0] == 'A' ? "B" : "A") + firstPage.NextCursor[1..]);

        var score = ((PropertyFieldValue.Number)definitions[1].Item2).Value;
        var time = ((PropertyFieldValue.Date)definitions[3].Item2).Value;
        var lower = new PropertyCondition(fields[1], 2, PropertyComparison.AtLeast, new PropertyFieldValue.Number(score));
        var upper = new PropertyCondition(fields[1], 2, PropertyComparison.LessThan, new PropertyFieldValue.Number(score + 0.0000001m));
        var date = new PropertyCondition(fields[3], 2, PropertyComparison.AtMost, new PropertyFieldValue.Date(time.ToOffset(TimeSpan.FromHours(8))));
        Assert.Equal(primary.Id, Assert.Single((await Group([lower, upper, date])).Rows).Id);
        Assert.Empty((await Group([lower, upper, date with { Comparison = PropertyComparison.LessThan }])).Rows);
        Assert.Empty((await Group([lower with { Comparison = PropertyComparison.GreaterThan }, upper])).Rows);
        Assert.Equal(empty.Id, Assert.Single((await Group([lower with { Comparison = PropertyComparison.LessThan }])).Rows).Id);
        Assert.Equal(primary.Id, Assert.Single((await Group([date with { Comparison = PropertyComparison.GreaterThan,
            Value = new PropertyFieldValue.Date(time.AddMilliseconds(-1)) }])).Rows).Id);
        Assert.Equal(primary.Id, Assert.Single((await Group([lower, new(fields[2], 2, PropertyComparison.Equal,
            new PropertyFieldValue.Boolean(false))])).Rows).Id);
        var falseCondition = new PropertyCondition(fields[2], 2, PropertyComparison.Equal, new PropertyFieldValue.Boolean(false));
        var modified = await ModifiedAt(primary.Id);
        var dateSearch = new AuthorTextQualifiedQuery(lexicalQuery, "", modified, modified + 1, schema, [lower, upper, date, falseCondition]);
        var inRange = await Qualified(dateSearch);
        Assert.Equal(primary.Id, Assert.Single(inRange.Rows).Id);
        Assert.Equal(1, inRange.Total);
        var beyond = await Qualified(dateSearch with { UpdatedFromUnixMs = null, UpdatedUntilUnixMs = modified });
        Assert.Empty(beyond.Rows);
        Assert.Equal(0, beyond.Total);
        Assert.Equal(new[] { 0, 0, 0, 0 }, beyond.StateCounts);
        var dateOnly = await Qualified(dateSearch with { SchemaRevision = 0, Conditions = [] });
        Assert.Contains(dateOnly.Rows, row => row.Id == primary.Id);

        var allScores = new AuthorTextQualifiedQuery(lexicalQuery, "", null, null, schema, [lower, upper]);
        var rankedScores = await Qualified(allScores);
        Assert.Equal(summaryMatches.Count + 1, rankedScores.Total);
        Assert.NotEmpty(rankedScores.NextCursor);
        var scoreContinuation = allScores with { Cursor = rankedScores.NextCursor };
        var trailingScores = await Qualified(scoreContinuation);
        Assert.Equal(rankedScores.Total, trailingScores.Total);
        Assert.Equal(rankedScores.StateCounts, trailingScores.StateCounts);
        Assert.Empty(rankedScores.Rows.Select(row => row.Id).Intersect(trailingScores.Rows.Select(row => row.Id)));
        await Qualified(scoreContinuation with { UpdatedUntilUnixMs = modified + 1 }, HttpStatusCode.Conflict);
        await Qualified(scoreContinuation with { Conditions = [lower] }, HttpStatusCode.Conflict);
        var changedOffPage = summaryMatches.Single(item => item.Id == trailingScores.Rows[^1].Id);
        var rankTimeBeforeEdit = await ModifiedAt(changedOffPage.Id);
        await Put(changedOffPage, fields[1], new PropertyFieldValue.Number(0), 1, 2);
        Assert.Equal(rankTimeBeforeEdit, await ModifiedAt(changedOffPage.Id));
        await Qualified(scoreContinuation, HttpStatusCode.Conflict);
        Assert.Equal(rankedScores.Total - 1, (await Qualified(allScores)).Total);
        await Put(changedOffPage, fields[1], definitions[1].Item2, 2, 2);
        var groupPage = await Group([lower, upper]);
        Assert.Equal(firstPage.Rows.Select(row => row.Id), groupPage.Rows.Select(row => row.Id));
        Assert.NotEmpty(groupPage.NextCursor);
        Assert.Equal(primary.Id, Assert.Single((await Group([upper, lower], groupPage.NextCursor)).Rows).Id);
        await Group([lower], groupPage.NextCursor, HttpStatusCode.BadRequest);
        var presentPage = await Group([Present(1)]);
        Assert.Equal(groupPage.Rows.ToArray(), presentPage.Rows.ToArray());
        Assert.Equal(new[] { empty.Id, primary.Id }, (await Group([Present(1)], presentPage.NextCursor)).Rows.Select(row => row.Id));
        await Group([Present(1)], groupPage.NextCursor, HttpStatusCode.BadRequest);
        await Group([lower, upper with { DefinitionRevision = 1 }], status: HttpStatusCode.Conflict);
        await Group([lower with { DefinitionId = fields[2] }], status: HttpStatusCode.BadRequest);
        var (_, anotherOwnerSession, peerHandle) = await db.SignIn(ownerId, ct);
        var groupContinuation = Wire.EncodePropertyArticleQueryGroup(new(schema, [lower, upper], groupPage.NextCursor));
        await Send(WireRoutes.PropertyArticleQuery, groupContinuation, anotherOwnerSession, HttpStatusCode.BadRequest);
        await Send(WireRoutes.PropertyArticleQuery, groupContinuation, null, HttpStatusCode.Unauthorized);
        Assert.Throws<ProtocolException>(() => Wire.EncodePropertyArticleQueryGroup(new(schema, [lower, lower], "")));
        Assert.Throws<ProtocolException>(() => Wire.EncodePropertyArticleQueryGroup(new(schema, [], "")));

        var viewId = Guid.NewGuid();
        var save = new SavedViewCommand(SavedViewAction.Save, viewId, 0, 0, Guid.NewGuid(), "  Re\u0301vision  ",
            new(schema, [upper, lower], ""));
        var packet = Wire.EncodeSavedViewCommand(save);
        await Qualified(scoreContinuation, HttpStatusCode.Conflict, anotherOwnerSession, peerHandle);
        (owner, handle) = (anotherOwnerSession, peerHandle);
        var firstSave = await Saved(WireRoutes.SavedViews, packet);
        Assert.Equal(firstSave, await Saved(WireRoutes.SavedViews, packet));
        Assert.Equal(new SavedViewReceipt(viewId, 1, 1, false), Wire.DecodeSavedViewReceipt(firstSave));
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(save with { Name = "Changed replay" }), HttpStatusCode.Conflict);
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(save with { Id = Guid.NewGuid(),
            RequestId = Guid.NewGuid(), CollectionRevision = 1, Name = "RÉVISION" }), HttpStatusCode.Conflict);
        var saved = Wire.DecodeSavedViewCatalog(await Saved(WireRoutes.SavedViews));
        Assert.Equal(new SavedViewSummary(viewId, 1, "Révision"), Assert.Single(saved.Views));
        var openView = Wire.EncodeSavedViewExecute(new(viewId, 1, ""));
        await Send(WireRoutes.SavedViews, null, null, HttpStatusCode.Unauthorized);
        await Send(WireRoutes.SavedViewPlacement, null, null, HttpStatusCode.Unauthorized);
        await Send(WireRoutes.SavedViewExecute, openView, null, HttpStatusCode.Unauthorized);
        var started = Wire.DecodePropertyArticlePage(await Saved(WireRoutes.SavedViewExecute, openView));
        Assert.Equal(groupPage.Rows.Select(row => row.Id), started.Rows.Select(row => row.Id));
        var continuation = Wire.EncodeSavedViewExecute(new(viewId, 1, started.NextCursor));
        await Saved(WireRoutes.SavedViewExecute, Wire.EncodeSavedViewExecute(new(viewId, 1, groupPage.NextCursor)), HttpStatusCode.BadRequest);
        await Saved(WireRoutes.SavedViewExecute, continuation, HttpStatusCode.NotFound, outsider, outsiderHandle);
        Assert.Empty(Wire.DecodeSavedViewCatalog(await Saved(WireRoutes.SavedViews, session: outsider, sessionId: outsiderHandle)).Views);
        Assert.Equal(primary.Id, Assert.Single(Wire.DecodePropertyArticlePage(await Saved(WireRoutes.SavedViewExecute, continuation)).Rows).Id);
        var priorSavedHandle = handle;
        (_, owner, handle) = await db.SignIn(ownerId, ct);
        await Saved(WireRoutes.SavedViewExecute, continuation, HttpStatusCode.BadRequest, owner, handle);
        await Saved(WireRoutes.SavedViewExecute, continuation, HttpStatusCode.Conflict, owner, priorSavedHandle);

        var editedName = new SavedViewCommand(SavedViewAction.Rename, viewId, 1, 1, Guid.NewGuid(), "Range review", null);
        var attempts = await Task.WhenAll(
            Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(editedName), session: owner, sessionId: handle),
            Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(editedName), session: owner, sessionId: handle));
        Assert.Equal(attempts[0], attempts[1]);
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(editedName with { RequestId = Guid.NewGuid() }), HttpStatusCode.Conflict);
        await Saved(WireRoutes.SavedViewExecute, continuation, HttpStatusCode.Conflict);
        await Saved(WireRoutes.SavedViewExecute, Wire.EncodeSavedViewExecute(new(viewId, 2, started.NextCursor)), HttpStatusCode.BadRequest);
        var currentRun = Wire.EncodeSavedViewExecute(new(viewId, 2, ""));
        var renamedProperty = Wire.EncodePropertySchemaInput(new(new(2, fields[1], Guid.NewGuid(), schema++, 2, "", "New score label"),
            PropertyFieldKind.Text, []));
        await Send(WireRoutes.PropertySchemaCommand, renamedProperty, owner);
        Assert.NotEmpty(Wire.DecodePropertyArticlePage(await Saved(WireRoutes.SavedViewExecute, currentRun)).Rows);

        target = await Publication(target, ArticleAction.Retract, owner);
        await Filter(6, definitions[6].Item2, HttpStatusCode.NotFound);
        Assert.Empty((await Group([Present(6)])).Rows);
        await Group([lower with { DefinitionRevision = 3 }, new(fields[6], 2, PropertyComparison.Equal, definitions[6].Item2)], status: HttpStatusCode.NotFound);
        await Qualified(new(lexicalQuery, "", null, null, schema, [ReferenceAnyOf(target.Id)]), HttpStatusCode.NotFound);
        await Send(WireRoutes.PropertyFilterability, Wire.EncodePropertyFilterabilityCommand(new(fields[1], Guid.NewGuid(), schema, 3, false)), owner);
        await Filter(1, definitions[1].Item2, HttpStatusCode.Conflict, firstPage.NextCursor);
        schema++;
        await Send(WireRoutes.PropertyArticleQuery, Wire.EncodePropertyArticleQuery(new(schema, fields[1], 4,
            new PropertyFieldValue.Missing(), "")), owner, HttpStatusCode.NotFound);
        await Group([date, lower with { DefinitionRevision = 4 }], status: HttpStatusCode.NotFound);
        await Saved(WireRoutes.SavedViewExecute, currentRun, HttpStatusCode.Conflict);
        var removal = new SavedViewCommand(SavedViewAction.Retire, viewId, 2, 2, Guid.NewGuid(), "", null);
        var secondId = Guid.NewGuid();
        var secondView = new SavedViewCommand(SavedViewAction.Save, secondId, 0, 2, Guid.NewGuid(), "Date review",
            new(schema, [date], ""));
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(secondView));
        var pin = new SavedViewPlacementCommand(SavedViewPlacementAction.Pin, viewId, 2, 3, Guid.NewGuid(), Guid.Empty);
        var pinPacket = Wire.EncodeSavedViewPlacementCommand(pin);
        var pinReceipt = await Saved(WireRoutes.SavedViewPlacement, pinPacket);
        Assert.Equal(pinReceipt, await Saved(WireRoutes.SavedViewPlacement, pinPacket));
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(removal with { RequestId = pin.RequestId, CollectionRevision = 4 }), HttpStatusCode.Conflict);
        await Saved(WireRoutes.SavedViewPlacement, Wire.EncodeSavedViewPlacementCommand(new(SavedViewPlacementAction.Pin,
            secondId, 1, 4, Guid.NewGuid(), Guid.Empty)));
        var reorder = new SavedViewPlacementCommand(SavedViewPlacementAction.MoveBefore, secondId, 1, 5, Guid.NewGuid(), viewId);
        var changedOrder = Wire.EncodeSavedViewPlacementCommand(reorder);
        var otherOrder = Wire.EncodeSavedViewPlacementCommand(new(SavedViewPlacementAction.MoveBefore, viewId, 2, 5, Guid.NewGuid(), Guid.Empty));
        var replies = await Task.WhenAll(
            Response(WireRoutes.SavedViewPlacement, changedOrder, owner, handle),
            Response(WireRoutes.SavedViewPlacement, otherOrder, owner, handle));
        Assert.Single(replies, reply => reply.Status == HttpStatusCode.OK);
        Assert.Single(replies, reply => reply.Status == HttpStatusCode.Conflict);
        var placement = Wire.DecodeSavedViewPlacement(await Saved(WireRoutes.SavedViewPlacement));
        Assert.Equal(new[] { secondId, viewId }, placement.Pins.Select(item => item.Id));
        await Saved(WireRoutes.SavedViewPlacement, Wire.EncodeSavedViewPlacementCommand(new(SavedViewPlacementAction.Default,
            viewId, 2, 6, Guid.NewGuid(), Guid.Empty)));
        Assert.Equal(viewId, Wire.DecodeSavedViewPlacement(await Saved(WireRoutes.SavedViewPlacement)).Default?.Id);
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(removal with { CollectionRevision = 7 }), HttpStatusCode.Conflict);
        await Saved(WireRoutes.SavedViewPlacement, Wire.EncodeSavedViewPlacementCommand(new(SavedViewPlacementAction.Default,
            secondId, 1, 7, Guid.NewGuid(), Guid.Empty)));
        Assert.Equal(secondId, Wire.DecodeSavedViewPlacement(await Saved(WireRoutes.SavedViewPlacement)).Default?.Id);
        Assert.True(Wire.DecodeSavedViewReceipt(await Saved(WireRoutes.SavedViews,
            Wire.EncodeSavedViewCommand(removal with { CollectionRevision = 8 }))).Retired);
        await Saved(WireRoutes.SavedViewPlacement + $"?view={viewId:D}&viewSchema=1", status: HttpStatusCode.NotFound);
        await Saved(WireRoutes.SavedViewPlacement + $"?view={secondId:D}&viewSchema=1", status: HttpStatusCode.NotFound,
            session: outsider, sessionId: outsiderHandle);
        await Saved(WireRoutes.SavedViewPlacement + $"?view={secondId:D}&viewSchema=2", status: HttpStatusCode.BadRequest);
        var selected = Wire.DecodeSavedViewPlacement(await Saved(WireRoutes.SavedViewPlacement + $"?view={secondId:D}&viewSchema=1"));
        Assert.Equal(secondId, selected.Requested?.Id);
        Assert.True(selected.RequestedPinned);
        Assert.Single(selected.Pins);
        await Saved(WireRoutes.SavedViewPlacement + "?offset=25&revision=8", status: HttpStatusCode.Conflict);
        await Saved(WireRoutes.SavedViewPlacement + $"?view={secondId:D}&viewSchema=1&viewSchema=1", status: HttpStatusCode.BadRequest);
        await Saved(WireRoutes.SavedViewPlacement, Wire.EncodeSavedViewPlacementCommand(new(SavedViewPlacementAction.Unpin,
            secondId, 1, 9, Guid.NewGuid(), Guid.Empty)));
        var unpinned = Wire.DecodeSavedViewPlacement(await Saved(WireRoutes.SavedViewPlacement + $"?view={secondId:D}&viewSchema=1"));
        Assert.True(unpinned.Pins.Count == 0 && !unpinned.RequestedPinned && unpinned.Default?.Id == secondId);
        await Saved(WireRoutes.SavedViewPlacement, Wire.EncodeSavedViewPlacementCommand(new(SavedViewPlacementAction.ClearDefault,
            secondId, 1, 10, Guid.NewGuid(), Guid.Empty)));
        Assert.Null(Wire.DecodeSavedViewPlacement(await Saved(WireRoutes.SavedViewPlacement)).Default);
        await Saved(WireRoutes.SavedViewExecute, currentRun, HttpStatusCode.NotFound);
        Assert.Equal(secondId, Assert.Single(Wire.DecodeSavedViewCatalog(await Saved(WireRoutes.SavedViews)).Views).Id);

        var presentViewId = Guid.NewGuid();
        var presentConditions = new[] { Present(5), Present(0) };
        var directPresence = await Group(presentConditions);
        Assert.Equal(primary.Id, Assert.Single(directPresence.Rows).Id);
        var savePresence = new SavedViewCommand(SavedViewAction.Save, presentViewId, 0, 11, Guid.NewGuid(), "Stored values",
            new(schema, presentConditions, ""));
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(savePresence));
        var openPresence = Wire.EncodeSavedViewExecute(new(presentViewId, 1, ""));
        var savedPresence = Wire.DecodePropertyArticlePage(await Saved(WireRoutes.SavedViewExecute, openPresence));
        Assert.Equal(directPresence.Rows.ToArray(), savedPresence.Rows.ToArray());
        await Saved(WireRoutes.SavedViewExecute, openPresence, HttpStatusCode.NotFound, outsider, outsiderHandle);

        var (red, blue, green) = (options[0].Id, options[1].Id, options[2].Id);
        var left = await Article("Red and Blue", owner);
        await Put(left, fields[5], new PropertyFieldValue.MultiSelect([blue, red]), 0, 2);
        var right = await Article("Blue and Green", owner);
        await Put(right, fields[5], new PropertyFieldValue.MultiSelect([blue, green]), 0, 2);
        var nullChoices = await Article("Null choices", owner);
        await Put(nullChoices, fields[5], new PropertyFieldValue.Null(), 0, 2);
        await Send(WireRoutes.PropertySchemaCommand, Wire.EncodePropertySchemaInput(new(
            new(1, fields[5], Guid.NewGuid(), 0, 0, "same-field", "Same field"), PropertyFieldKind.MultiSelect, options)), outsider);
        await Send(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueInput(new(foreign.Id, foreign.Revision, 1, 0,
            fields[5], 1, Guid.NewGuid(), new PropertyFieldValue.MultiSelect([red]))), outsider);
        Assert.Equal(left.Id, Assert.Single((await Filter(5, new PropertyFieldValue.MultiSelect([red, blue]))).Rows).Id);
        Assert.Equal(new[] { left.Id, empty.Id }, (await Group([AnyOf(red)])).Rows.Select(row => row.Id));
        Assert.Equal(right.Id, Assert.Single((await Group([AnyOf(green)])).Rows).Id);
        Assert.Empty((await Group([AnyOf()])).Rows);
        await Group([AnyOf(Guid.NewGuid())], status: HttpStatusCode.BadRequest);
        await Group([AnyOf(red) with { DefinitionId = fields[4] }], status: HttpStatusCode.BadRequest);
        await Group([AnyOf(red) with { DefinitionRevision = 1 }], status: HttpStatusCode.Conflict);
        var overlap = new[] { AnyOf(green, red), Present(5) };
        var directOverlap = await Group(overlap);
        Assert.Equal(new[] { right.Id, left.Id, empty.Id }, directOverlap.Rows.Select(row => row.Id));
        Assert.Equal(directOverlap.Rows.ToArray(), (await Group([Present(5), AnyOf(red, green)])).Rows.ToArray());

        var overlapId = Guid.NewGuid();
        var saveOverlap = new SavedViewCommand(SavedViewAction.Save, overlapId, 0, 12, Guid.NewGuid(), "Selected alternatives",
            new(schema, overlap, ""));
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(saveOverlap));
        var stable = Wire.DecodeSavedViewPlacement(await Saved(WireRoutes.SavedViewPlacement + $"?view={overlapId:D}&viewSchema=1"));
        Assert.Equal(overlapId, stable.Requested?.Id);
        var openOverlap = Wire.EncodeSavedViewExecute(new(overlapId, 1, ""));
        Assert.Equal(directOverlap.Rows.ToArray(),
            Wire.DecodePropertyArticlePage(await Saved(WireRoutes.SavedViewExecute, openOverlap)).Rows.ToArray());
        await Saved(WireRoutes.SavedViewExecute, openOverlap, HttpStatusCode.NotFound, outsider, outsiderHandle);

        await Put(nullChoices, fields[4], new PropertyFieldValue.Null(), 1, 2);
        await Send(WireRoutes.PropertySchemaCommand, Wire.EncodePropertySchemaInput(new(
            new(1, fields[4], Guid.NewGuid(), 1, 0, "same-single", "Same single field"), PropertyFieldKind.SingleSelect, options)), outsider);
        await Send(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueInput(new(foreign.Id, foreign.Revision, 2, 1,
            fields[4], 1, Guid.NewGuid(), new PropertyFieldValue.SingleSelect(red))), outsider);
        Assert.Equal(primary.Id, Assert.Single((await Group([SingleAnyOf(red)])).Rows).Id);
        Assert.Empty((await Group([SingleAnyOf(green)])).Rows);
        var single = await Group([SingleAnyOf(blue, red)]);
        Assert.Equal(new[] { empty.Id, primary.Id }, single.Rows.Select(row => row.Id));
        Assert.Equal(single.Rows.ToArray(), (await Group([SingleAnyOf(red, blue)])).Rows.ToArray());
        await Group([SingleAnyOf(red) with { DefinitionId = fields[5] }], status: HttpStatusCode.BadRequest);
        await Group([SingleAnyOf(Guid.NewGuid())], status: HttpStatusCode.BadRequest);
        await Group([SingleAnyOf(red) with { DefinitionRevision = 1 }], status: HttpStatusCode.Conflict);

        var singleViewId = Guid.NewGuid();
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(new(SavedViewAction.Save, singleViewId, 0, 13,
            Guid.NewGuid(), "Single-selection alternatives", new(schema, [SingleAnyOf(blue, red)], ""))));
        var openSingle = Wire.EncodeSavedViewExecute(new(singleViewId, 1, ""));
        Assert.Equal(single.Rows.ToArray(), Wire.DecodePropertyArticlePage(await Saved(WireRoutes.SavedViewExecute, openSingle)).Rows.ToArray());
        await Saved(WireRoutes.SavedViewExecute, openSingle, HttpStatusCode.NotFound, outsider, outsiderHandle);
        await Send(WireRoutes.PropertyFilterability, Wire.EncodePropertyFilterabilityCommand(new(fields[5], Guid.NewGuid(), schema++, 2, false)), owner);
        await Group([AnyOf(red) with { DefinitionRevision = 3 }], status: HttpStatusCode.NotFound);
        await Saved(WireRoutes.SavedViewExecute, openPresence, HttpStatusCode.Conflict);
        await Saved(WireRoutes.SavedViewExecute, openOverlap, HttpStatusCode.Conflict);
        await Send(WireRoutes.PropertyFilterability, Wire.EncodePropertyFilterabilityCommand(new(fields[4], Guid.NewGuid(), schema++, 2, false)), owner);
        await Group([SingleAnyOf(red) with { DefinitionRevision = 3 }], status: HttpStatusCode.NotFound);
        await Saved(WireRoutes.SavedViewExecute, openSingle, HttpStatusCode.Conflict);

        target = await Publication(target, ArticleAction.Publish, owner);
        var secondTarget = await Publication(right, ArticleAction.Publish, owner);
        var foreignTarget = await Publication(foreign, ArticleAction.Publish, outsider);
        await Put(left, fields[6], new PropertyFieldValue.ArticleReference([secondTarget.Id]), 1, 2);
        await Put(nullChoices, fields[6], new PropertyFieldValue.Null(), 2, 2);
        Assert.Empty((await Group([ReferenceAnyOf()])).Rows);
        Assert.Equal(primary.Id, Assert.Single((await Group([ReferenceAnyOf(target.Id)])).Rows).Id);
        var references = await Group([ReferenceAnyOf(secondTarget.Id, target.Id)]);
        Assert.Equal(new[] { left.Id, primary.Id }, references.Rows.Select(row => row.Id));
        await Group([ReferenceAnyOf(target.Id, missing.Id)], status: HttpStatusCode.NotFound);
        await Group([ReferenceAnyOf(foreignTarget.Id, target.Id)], status: HttpStatusCode.NotFound);
        await Group([ReferenceAnyOf(target.Id) with { DefinitionId = fields[2] }], status: HttpStatusCode.BadRequest);
        await Group([ReferenceAnyOf(target.Id) with { DefinitionRevision = 1 }], status: HttpStatusCode.Conflict);

        var referenceViewId = Guid.NewGuid();
        var referenceView = new SavedViewCommand(SavedViewAction.Save, referenceViewId, 0, 14, Guid.NewGuid(),
            "Published reference alternatives", new(schema, [ReferenceAnyOf(target.Id, secondTarget.Id)], ""));
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(referenceView with
        {
            RequestId = Guid.NewGuid(), Query = new(schema, [ReferenceAnyOf(target.Id, missing.Id)], ""),
        }), HttpStatusCode.NotFound);
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(referenceView));
        var openReferences = Wire.EncodeSavedViewExecute(new(referenceViewId, 1, ""));
        Assert.Equal(references.Rows.ToArray(),
            Wire.DecodePropertyArticlePage(await Saved(WireRoutes.SavedViewExecute, openReferences)).Rows.ToArray());
        await Saved(WireRoutes.SavedViewExecute, openReferences, HttpStatusCode.NotFound, outsider, outsiderHandle);
        await Publication(secondTarget, ArticleAction.Retract, owner);
        await Group([ReferenceAnyOf(target.Id, secondTarget.Id)], status: HttpStatusCode.NotFound);
        await Saved(WireRoutes.SavedViewExecute, openReferences, HttpStatusCode.Conflict);
        Assert.Equal(primary.Id, Assert.Single((await Group([ReferenceAnyOf(target.Id)])).Rows).Id);

        await Send(WireRoutes.PropertyFilterability, Wire.EncodePropertyFilterabilityCommand(
            new(fields[1], Guid.NewGuid(), schema++, 4, true)), owner);
        var afterSummary = await Article("Beyond the excerpt", owner, summaryPrefix + "x" + matchText);
        var wildcardOnly = await Article("C12XYNeedle", owner);
        await Put(afterSummary, fields[1], definitions[1].Item2, 0, 5);
        await Put(wildcardOnly, fields[1], definitions[1].Item2, 0, 5);
        var scoreMatch = new PropertyCondition(fields[1], 5, PropertyComparison.Equal, definitions[1].Item2);
        var scoreOnly = await Group([scoreMatch]);
        Assert.Contains(scoreOnly.Rows, row => row.Id == afterSummary.Id);
        Assert.Contains(scoreOnly.Rows, row => row.Id == wildcardOnly.Id);

        await Send(WireRoutes.PropertySchemaCommand, Wire.EncodePropertySchemaInput(new(
            new(1, fields[1], Guid.NewGuid(), 2, 0, "same-score", "Same score"), PropertyFieldKind.Number, [])), outsider);
        await Send(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueInput(new(foreignTarget.Id, foreignTarget.Revision, 3, 2,
            fields[1], 1, Guid.NewGuid(), definitions[1].Item2)), outsider);
        await Send(WireRoutes.PropertyFilterability, Wire.EncodePropertyFilterabilityCommand(
            new(fields[1], Guid.NewGuid(), 3, 1, true)), outsider);
        var outsideKeyword = Wire.EncodePropertyArticleQueryGroup(new(4, [scoreMatch with { DefinitionRevision = 2 }], "", keyword));
        var outsidePage = Wire.DecodePropertyArticlePage(await Send(WireRoutes.PropertyArticleQuery, outsideKeyword, outsider, sessionId: outsiderHandle));
        Assert.Equal(foreignTarget.Id, Assert.Single(outsidePage.Rows).Id);

        var keywordQuery = new PropertyArticleQueryGroup(schema, [scoreMatch], "", keyword);
        var keywordFrame = Wire.EncodePropertyArticleQueryGroup(keywordQuery);
        await Send(WireRoutes.PropertyArticleQuery, keywordFrame, owner, HttpStatusCode.Conflict);
        await Send(WireRoutes.PropertyArticleQuery, keywordFrame, owner, HttpStatusCode.Conflict, peerHandle);
        var keywordPage = Wire.DecodePropertyArticlePage(await Send(WireRoutes.PropertyArticleQuery, keywordFrame, owner, sessionId: handle));
        Assert.Equal(summaryMatches.Select(row => row.Id).Reverse(), keywordPage.Rows.Select(row => row.Id));
        Assert.NotEmpty(keywordPage.NextCursor);
        var combinedFrame = Wire.EncodePropertyArticleQueryGroup(keywordQuery with { Conditions = [scoreMatch, Present(2)] });
        var combinedPage = Wire.DecodePropertyArticlePage(await Send(WireRoutes.PropertyArticleQuery, combinedFrame, owner, sessionId: handle));
        Assert.Equal(primary.Id, Assert.Single(combinedPage.Rows).Id);
        var keywordContinuation = keywordQuery with { Cursor = keywordPage.NextCursor };
        var continuationFrame = Wire.EncodePropertyArticleQueryGroup(keywordContinuation);
        var keywordTail = Wire.DecodePropertyArticlePage(await Send(WireRoutes.PropertyArticleQuery, continuationFrame, owner, sessionId: handle));
        Assert.Equal(primary.Id, Assert.Single(keywordTail.Rows).Id);
        Assert.Empty(keywordTail.NextCursor);
        await Send(WireRoutes.PropertyArticleQuery, Wire.EncodePropertyArticleQueryGroup(keywordContinuation with { Keyword = keyword[1..] }),
            owner, HttpStatusCode.BadRequest, handle);
        await Group([scoreMatch], keywordPage.NextCursor, HttpStatusCode.BadRequest);
        (_, owner, handle) = await db.SignIn(ownerId, ct);
        await Send(WireRoutes.PropertyArticleQuery, continuationFrame, owner, HttpStatusCode.BadRequest, handle);

        var keywordViewId = Guid.NewGuid();
        var keywordView = new SavedViewCommand(SavedViewAction.Save, keywordViewId, 0, 15, Guid.NewGuid(), "Keyword and score", keywordQuery);
        var keywordSaveFrame = Wire.EncodeSavedViewCommand(keywordView);
        var keywordSave = await Saved(WireRoutes.SavedViews, keywordSaveFrame);
        Assert.Equal(keywordSave, await Saved(WireRoutes.SavedViews, keywordSaveFrame));
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(keywordView with
        {
            Query = keywordQuery with { Keyword = keyword[1..] },
        }), HttpStatusCode.Conflict);
        var savedKeywordPage = Wire.DecodePropertyArticlePage(await Saved(WireRoutes.SavedViewExecute,
            Wire.EncodeSavedViewExecute(new(keywordViewId, 1, ""))));
        Assert.Equal(keywordPage.Rows.ToArray(), savedKeywordPage.Rows.ToArray());
        Assert.NotEmpty(savedKeywordPage.NextCursor);
        var savedKeywordTail = Wire.DecodePropertyArticlePage(await Saved(WireRoutes.SavedViewExecute,
            Wire.EncodeSavedViewExecute(new(keywordViewId, 1, savedKeywordPage.NextCursor))));
        Assert.Equal(keywordTail.Rows.ToArray(), savedKeywordTail.Rows.ToArray());
        Assert.Empty(savedKeywordTail.NextCursor);
        await Saved(WireRoutes.SavedViewExecute, Wire.EncodeSavedViewExecute(new(keywordViewId, 1, keywordPage.NextCursor)), HttpStatusCode.BadRequest);
        Assert.Equal(1, await SavedDefinitionVersion(secondId));
        Assert.Equal(5, await SavedDefinitionVersion(referenceViewId));
        Assert.Equal(6, await SavedDefinitionVersion(keywordViewId));

        var lowScore = scoreMatch with { Value = new PropertyFieldValue.Number(0), AnyOf = true };
        var highScore = scoreMatch with { AnyOf = true };
        var alternativePage = await Group([lowScore, highScore]);
        var expectedScores = summaryMatches.Select(item => item.Id).Concat([afterSummary.Id, wildcardOnly.Id, empty.Id, primary.Id])
            .OrderDescending().ToArray();
        Assert.Equal(expectedScores.Take(WireLimits.PropertyPageSize), alternativePage.Rows.Select(row => row.Id));
        Assert.NotEmpty(alternativePage.NextCursor);
        Assert.Equal(expectedScores.Skip(WireLimits.PropertyPageSize),
            (await Group([highScore, lowScore], alternativePage.NextCursor)).Rows.Select(row => row.Id));
        await Group([highScore, lowScore with { Value = new PropertyFieldValue.Number(1) }], alternativePage.NextCursor, HttpStatusCode.BadRequest);
        Assert.Equal(primary.Id, Assert.Single((await Group([lowScore, highScore, Present(2),
            falseCondition])).Rows).Id);
        var qualifiedAlternatives = await Qualified(new(lexicalQuery, "", null, null, schema, [lowScore, highScore, Present(2)]));
        Assert.Equal(new[] { empty.Id, primary.Id }.Order(), qualifiedAlternatives.Rows.Select(row => row.Id).Order());
        var alternativeViewId = Guid.NewGuid();
        var alternativeQuery = new PropertyArticleQueryGroup(schema, [highScore, lowScore, Present(2)], "", keyword);
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(new(SavedViewAction.Save, alternativeViewId, 0, 16,
            Guid.NewGuid(), "Either score", alternativeQuery)));
        var runAlternatives = Wire.EncodeSavedViewExecute(new(alternativeViewId, 1, ""));
        Assert.Equal(new[] { empty.Id, primary.Id }, Wire.DecodePropertyArticlePage(
            await Saved(WireRoutes.SavedViewExecute, runAlternatives)).Rows.Select(row => row.Id));
        await Saved(WireRoutes.SavedViewExecute, runAlternatives, HttpStatusCode.NotFound, outsider, outsiderHandle);
        Assert.Equal(7, await SavedDefinitionVersion(alternativeViewId));

        foreach (var article in summaryMatches)
            await Put(article, fields[6], new PropertyFieldValue.ArticleReference([target.Id]),
                article.Id == changedOffPage.Id ? 3 : 1, 2);
        var referenceSearch = new AuthorTextQualifiedQuery(lexicalQuery, "", null, null, schema, [Present(6)]);
        var referencePage = await Qualified(referenceSearch);
        Assert.Equal(summaryMatches.Count + 1, referencePage.Total);
        Assert.NotEmpty(referencePage.NextCursor);
        var referenceContinuation = referenceSearch with { Cursor = referencePage.NextCursor };
        await Publication(target, ArticleAction.Retract, owner);
        await Qualified(referenceContinuation, HttpStatusCode.Conflict);
        Assert.Equal(0, (await Qualified(referenceSearch)).Total);

        var laterScoreSearch = allScores with { SchemaRevision = schema, Conditions = [scoreMatch] };
        var laterScores = await Qualified(laterScoreSearch);
        Assert.NotEmpty(laterScores.NextCursor);
        await Send(WireRoutes.PropertyFilterability, Wire.EncodePropertyFilterabilityCommand(
            new(fields[1], Guid.NewGuid(), schema, 5, false)), owner);
        await Qualified(laterScoreSearch with { Cursor = laterScores.NextCursor }, HttpStatusCode.Conflict);

        async Task<int> SavedDefinitionVersion(Guid id)
        {
            await using var conn = await db.DataSource.OpenConnectionAsync(ct);
            return Assert.IsType<int>(await FixtureSql.ScalarAsync(conn, null, ct, "select get_byte(definition,0) from public.author_saved_view where owner_id=$1 and id=$2", ownerId, id));
        }

        async Task<long> ModifiedAt(int id)
        {
            await using var conn = await db.DataSource.OpenConnectionAsync(ct);
            return Assert.IsType<long>(await FixtureSql.ScalarAsync(conn, null, ct, "select floor(extract(epoch from updated_at)*1000)::bigint from public.article where id=$1", id));
        }

        async Task<AuthorTextFacetedPage> Qualified(AuthorTextQualifiedQuery query, HttpStatusCode status = HttpStatusCode.OK,
            string? session = null, string? sessionId = null)
        {
            for (var attempt = 0; attempt < 8; attempt++)
            {
                var bytes = await Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextQualifiedQuery(query), session ?? owner,
                    status, sessionId ?? handle);
                if (status != HttpStatusCode.OK) return new(false, "", 0, [0, 0, 0, 0], false, [], false, [], []);
                var page = Wire.DecodeAuthorTextFacetedPage(bytes);
                if (page.Ready) return page;
            }
            throw new InvalidOperationException("The fixture index did not finish within eight requests.");
        }

        Task<byte[]> Saved(string route, byte[]? frame = null, HttpStatusCode status = HttpStatusCode.OK,
            string? session = null, string? sessionId = null) => Send(route, frame, session ?? owner, status, sessionId ?? handle);

        PropertyCondition Present(int index, long revision = 2) =>
            new(fields[index], revision, PropertyComparison.IsPresent, new PropertyFieldValue.Missing());

        PropertyCondition AnyOf(params Guid[] alternatives) =>
            new(fields[5], 2, PropertyComparison.MultiSelectAnyOf, new PropertyFieldValue.MultiSelect(alternatives));

        PropertyCondition SingleAnyOf(params Guid[] alternatives) =>
            new(fields[4], 2, PropertyComparison.SingleSelectAnyOf, new PropertyFieldValue.MultiSelect(alternatives));

        PropertyCondition ReferenceAnyOf(params int[] alternatives) =>
            new(fields[6], 2, PropertyComparison.ReferenceAnyOf, new PropertyFieldValue.ArticleReference(alternatives));

        async Task<PropertyArticlePage> Group(PropertyCondition[] conditions, string cursor = "", HttpStatusCode status = HttpStatusCode.OK)
        {
            var packet = await Send(WireRoutes.PropertyArticleQuery,
                Wire.EncodePropertyArticleQueryGroup(new(schema, conditions, cursor)), owner, status);
            return status == HttpStatusCode.OK ? Wire.DecodePropertyArticlePage(packet) : new("", []);
        }

        async Task<PropertyArticlePage> Filter(int index, PropertyFieldValue value, HttpStatusCode status = HttpStatusCode.OK, string cursor = "")
        {
            var packet = await Send(WireRoutes.PropertyArticleQuery, Wire.EncodePropertyArticleQuery(new(schema, fields[index], 2, value, cursor)), owner, status);
            return status == HttpStatusCode.OK ? Wire.DecodePropertyArticlePage(packet) : new("", []);
        }
        Task<byte[]> Put(ArticleState article, Guid field, PropertyFieldValue value, long version, long definition) =>
            Send(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueInput(new(article.Id, article.Revision, schema, version,
                field, definition, Guid.NewGuid(), value)), owner);
        async Task<ArticleState> Article(string title, string token, string body = "Private") => (await store.WithSession(token, true, (c, t, a) =>
            Store.Execute(c, t, a, ArticleAction.Save, new(0, 0, Guid.NewGuid(), title, body), ct), ct)).Article;
        async Task<ArticleState> Publication(ArticleState article, ArticleAction action, string token) =>
            (await store.WithSession(token, true, (c, t, a) => Store.Execute(c, t, a, action,
                new(article.Id, article.Revision, Guid.NewGuid(), "", ""), ct), ct)).Article;
        async Task<byte[]> Send(string route, byte[]? packet, string? session, HttpStatusCode status = HttpStatusCode.OK, string? sessionId = null)
        {
            var response = await Response(route, packet, session, sessionId);
            Assert.Equal(status, response.Status);
            return response.Body;
        }
        async Task<(HttpStatusCode Status, byte[] Body)> Response(string route, byte[]? packet, string? session, string? sessionId)
        {
            using var request = SiteAedsFixture.Request(packet is null ? HttpMethod.Get : HttpMethod.Post, route, packet, session, sessionId);
            using var result = await server.Client.SendAsync(request, ct);
            Assert.True(result.Headers.CacheControl?.NoStore);
            return (result.StatusCode, await result.Content.ReadAsByteArrayAsync(ct));
        }
    }
}
