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
        var target = await Publication(await Article("Reference target", owner), ArticleAction.Publish, owner);
        var options = new[] { new PropertyFieldOption(Guid.NewGuid(), "Red"), new PropertyFieldOption(Guid.NewGuid(), "Blue"),
            new PropertyFieldOption(Guid.NewGuid(), "Green") };
        long schema = 0;
        var definitions = new (PropertyFieldKind Kind, PropertyFieldValue Primary, PropertyFieldValue Empty)[]
        {
            (PropertyFieldKind.Text, new PropertyFieldValue.Text(""), new PropertyFieldValue.Null()),
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
            await Schema(owner, 1, id, schema++, 0, $"property-{fields.Count}", $"Field {fields.Count}", kind, choice ? options : []);
            fields.Add(id);
        }
        var outsiderFrame = Wire.EncodePropertyArticleQuery(new(schema, fields[0], 1, new PropertyFieldValue.Missing(), ""));
        foreach (var (actor, status) in new (string?, HttpStatusCode)[] { (owner, NotFound), (null, Unauthorized), (outsider, Conflict) })
            await Send(WireRoutes.PropertyArticleQuery, outsiderFrame, actor, status);
        await Group([Present(0, 1)], status: NotFound);

        for (var i = 0; i < fields.Count; i++)
        {
            await Put(primary, fields[i], definitions[i].Primary, i, 1);
            await Put(empty, fields[i], definitions[i].Empty, i, 1);
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
            Assert.Equal(primary.Id, await SingleFilter(i, definitions[i].Primary));
            var qualified = await Qualified(new(lexicalQuery, "", null, null, schema,
                [new(fields[i], 2, PropertyComparison.Equal, definitions[i].Primary)]));
            Assert.Equal((primary.Id, 1), (Assert.Single(qualified.Rows).Id, qualified.Total));
            Assert.Equal(new[] { 1, 0, 0, 0 }, qualified.StateCounts);
            var missingRows = (await Filter(i, new PropertyFieldValue.Missing())).Rows;
            Assert.Contains(missingRows, row => row.Id == missing.Id);
            Assert.DoesNotContain(missingRows, row => row.Id == foreign.Id);
            int[] presentIds = definitions[i].Empty is PropertyFieldValue.Null ? [primary.Id] : [empty.Id, primary.Id];
            Assert.Equal(presentIds, Ids(await Group([Present(i)])));
        }
        await Group([Present(0, 1)], status: Conflict);
        Assert.Equal(empty.Id, await SingleFilter(0, new PropertyFieldValue.Null()));
        Assert.Empty((await Filter(1, new PropertyFieldValue.Number(9007199254740993.1234568m))).Rows);
        await Filter(1, new PropertyFieldValue.Text("0"), BadRequest);

        var summaryMatches = new List<ArticleState>();
        for (var i = 0; i < WireLimits.PropertyPageSize; i++)
        {
            var article = await Article($"Number page {i}", owner, (i == 0 ? summaryPrefix : "Private ") + matchText);
            await Put(article, fields[1], definitions[1].Primary, 0, 2);
            summaryMatches.Add(article);
        }
        var firstPage = await Filter(1, definitions[1].Primary);
        Assert.Equal(WireLimits.PropertyPageSize, firstPage.Rows.Count);
        Assert.NotEmpty(firstPage.NextCursor);
        Assert.Equal(primary.Id, await SingleFilter(1, definitions[1].Primary, firstPage.NextCursor));
        await Filter(1, new PropertyFieldValue.Number(0), BadRequest, firstPage.NextCursor);
        await Filter(1, definitions[1].Primary, BadRequest, (firstPage.NextCursor[0] == 'A' ? "B" : "A") + firstPage.NextCursor[1..]);

        var score = ((PropertyFieldValue.Number)definitions[1].Primary).Value;
        var time = ((PropertyFieldValue.Date)definitions[3].Primary).Value;
        var lower = new PropertyCondition(fields[1], 2, PropertyComparison.AtLeast, new PropertyFieldValue.Number(score));
        var upper = new PropertyCondition(fields[1], 2, PropertyComparison.LessThan, new PropertyFieldValue.Number(score + 0.0000001m));
        var date = new PropertyCondition(fields[3], 2, PropertyComparison.AtMost, new PropertyFieldValue.Date(time.ToOffset(TimeSpan.FromHours(8))));
        var falseCondition = new PropertyCondition(fields[2], 2, PropertyComparison.Equal, new PropertyFieldValue.Boolean(false));
        Assert.Equal(primary.Id, await SingleGroup([lower, upper, date]));
        Assert.Empty((await Group([lower, upper, date with { Comparison = PropertyComparison.LessThan }])).Rows);
        Assert.Empty((await Group([lower with { Comparison = PropertyComparison.GreaterThan }, upper])).Rows);
        Assert.Equal(empty.Id, await SingleGroup([lower with { Comparison = PropertyComparison.LessThan }]));
        Assert.Equal(primary.Id, await SingleGroup([date with { Comparison = PropertyComparison.GreaterThan,
            Value = new PropertyFieldValue.Date(time.AddMilliseconds(-1)) }]));
        Assert.Equal(primary.Id, await SingleGroup([lower, falseCondition]));
        var modified = await ModifiedAt(primary.Id);
        var dateSearch = new AuthorTextQualifiedQuery(lexicalQuery, "", modified, modified + 1, schema, [lower, upper, date, falseCondition]);
        var inRange = await Qualified(dateSearch);
        Assert.Equal((primary.Id, 1), (Assert.Single(inRange.Rows).Id, inRange.Total));
        var beyond = await Qualified(dateSearch with { UpdatedFromUnixMs = null, UpdatedUntilUnixMs = modified });
        Assert.Empty(beyond.Rows);
        Assert.Equal(0, beyond.Total);
        Assert.Equal(new[] { 0, 0, 0, 0 }, beyond.StateCounts);
        Assert.Contains((await Qualified(dateSearch with { SchemaRevision = 0, Conditions = [] })).Rows, row => row.Id == primary.Id);

        var allScores = new AuthorTextQualifiedQuery(lexicalQuery, "", null, null, schema, [lower, upper]);
        var rankedScores = await Qualified(allScores);
        Assert.Equal(summaryMatches.Count + 1, rankedScores.Total);
        Assert.NotEmpty(rankedScores.NextCursor);
        var scoreContinuation = allScores with { Cursor = rankedScores.NextCursor };
        var trailingScores = await Qualified(scoreContinuation);
        Assert.Equal(rankedScores.Total, trailingScores.Total);
        Assert.Equal(rankedScores.StateCounts, trailingScores.StateCounts);
        Assert.Empty(rankedScores.Rows.Select(row => row.Id).Intersect(trailingScores.Rows.Select(row => row.Id)));
        await Qualified(scoreContinuation with { UpdatedUntilUnixMs = modified + 1 }, Conflict);
        await Qualified(scoreContinuation with { Conditions = [lower] }, Conflict);
        var changedOffPage = summaryMatches.Single(item => item.Id == trailingScores.Rows[^1].Id);
        var rankTimeBeforeEdit = await ModifiedAt(changedOffPage.Id);
        await Put(changedOffPage, fields[1], new PropertyFieldValue.Number(0), 1, 2);
        Assert.Equal(rankTimeBeforeEdit, await ModifiedAt(changedOffPage.Id));
        await Qualified(scoreContinuation, Conflict);
        Assert.Equal(rankedScores.Total - 1, (await Qualified(allScores)).Total);
        await Put(changedOffPage, fields[1], definitions[1].Primary, 2, 2);
        var groupPage = await Group([lower, upper]);
        Assert.Equal(Ids(firstPage), Ids(groupPage));
        Assert.NotEmpty(groupPage.NextCursor);
        Assert.Equal(primary.Id, await SingleGroup([upper, lower], groupPage.NextCursor));
        await Group([lower], groupPage.NextCursor, BadRequest);
        var presentPage = await Group([Present(1)]);
        Assert.Equal(groupPage.Rows.ToArray(), presentPage.Rows.ToArray());
        Assert.Equal(new[] { empty.Id, primary.Id }, Ids(await Group([Present(1)], presentPage.NextCursor)));
        await Group([Present(1)], groupPage.NextCursor, BadRequest);
        await Group([lower, upper with { DefinitionRevision = 1 }], status: Conflict);
        await Group([lower with { DefinitionId = fields[2] }], status: BadRequest);
        var (_, anotherOwnerSession, peerHandle) = await db.SignIn(ownerId, ct);
        var groupContinuation = Wire.EncodePropertyArticleQueryGroup(new(schema, [lower, upper], groupPage.NextCursor));
        await Send(WireRoutes.PropertyArticleQuery, groupContinuation, anotherOwnerSession, BadRequest);
        await Send(WireRoutes.PropertyArticleQuery, groupContinuation, null, Unauthorized);
        Assert.Throws<ProtocolException>(() => Wire.EncodePropertyArticleQueryGroup(new(schema, [lower, lower], "")));
        Assert.Throws<ProtocolException>(() => Wire.EncodePropertyArticleQueryGroup(new(schema, [], "")));

        var viewId = Guid.NewGuid();
        var save = new SavedViewCommand(SavedViewAction.Save, viewId, 0, 0, Guid.NewGuid(), "  Re\u0301vision  ", new(schema, [upper, lower], ""));
        var packet = Wire.EncodeSavedViewCommand(save);
        await Qualified(scoreContinuation, Conflict, anotherOwnerSession, peerHandle);
        (owner, handle) = (anotherOwnerSession, peerHandle);
        var firstSave = await Saved(WireRoutes.SavedViews, packet);
        Assert.Equal(firstSave, await Saved(WireRoutes.SavedViews, packet));
        Assert.Equal(new SavedViewReceipt(viewId, 1, 1, false), Wire.DecodeSavedViewReceipt(firstSave));
        await SaveView(save with { Name = "Changed replay" }, Conflict);
        await SaveView(save with { Id = Guid.NewGuid(), RequestId = Guid.NewGuid(), CollectionRevision = 1, Name = "RÉVISION" }, Conflict);
        Assert.Equal(new SavedViewSummary(viewId, 1, "Révision"), Assert.Single(Wire.DecodeSavedViewCatalog(await Saved(WireRoutes.SavedViews)).Views));
        var openView = Wire.EncodeSavedViewExecute(new(viewId, 1, ""));
        foreach (var (route, frame) in new (string, byte[]?)[] { (WireRoutes.SavedViews, null), (WireRoutes.SavedViewPlacement, null), (WireRoutes.SavedViewExecute, openView) })
            await Send(route, frame, null, Unauthorized);
        var started = await RunViewFrame(openView);
        Assert.Equal(Ids(groupPage), Ids(started));
        var continuation = Wire.EncodeSavedViewExecute(new(viewId, 1, started.NextCursor));
        await RunViewStatus(viewId, 1, groupPage.NextCursor, BadRequest);
        await Saved(WireRoutes.SavedViewExecute, continuation, NotFound, outsider, outsiderHandle);
        Assert.Empty(Wire.DecodeSavedViewCatalog(await Saved(WireRoutes.SavedViews, session: outsider, sessionId: outsiderHandle)).Views);
        Assert.Equal(primary.Id, Assert.Single((await RunViewFrame(continuation)).Rows).Id);
        var priorSavedHandle = handle;
        (_, owner, handle) = await db.SignIn(ownerId, ct);
        await Saved(WireRoutes.SavedViewExecute, continuation, BadRequest, owner, handle);
        await Saved(WireRoutes.SavedViewExecute, continuation, Conflict, owner, priorSavedHandle);

        var editedName = new SavedViewCommand(SavedViewAction.Rename, viewId, 1, 1, Guid.NewGuid(), "Range review", null);
        var attempts = await Task.WhenAll(SaveView(editedName), SaveView(editedName));
        Assert.Equal(attempts[0], attempts[1]);
        await SaveView(editedName with { RequestId = Guid.NewGuid() }, Conflict);
        await Saved(WireRoutes.SavedViewExecute, continuation, Conflict);
        await RunViewStatus(viewId, 2, started.NextCursor, BadRequest);
        var currentRun = Wire.EncodeSavedViewExecute(new(viewId, 2, ""));
        await Schema(owner, 2, fields[1], schema++, 2, "", "New score label", PropertyFieldKind.Text, []);
        Assert.NotEmpty((await RunViewFrame(currentRun)).Rows);

        target = await Publication(target, ArticleAction.Retract, owner);
        await Filter(6, definitions[6].Primary, NotFound);
        Assert.Empty((await Group([Present(6)])).Rows);
        await Group([lower with { DefinitionRevision = 3 }, new(fields[6], 2, PropertyComparison.Equal, definitions[6].Primary)], status: NotFound);
        await Qualified(new(lexicalQuery, "", null, null, schema, [ReferenceAnyOf(target.Id)]), NotFound);
        await Filterable(fields[1], schema, 3, false);
        await Filter(1, definitions[1].Primary, Conflict, firstPage.NextCursor);
        schema++;
        await Send(WireRoutes.PropertyArticleQuery, Wire.EncodePropertyArticleQuery(new(schema, fields[1], 4, new PropertyFieldValue.Missing(), "")), owner, NotFound);
        await Group([date, lower with { DefinitionRevision = 4 }], status: NotFound);
        await Saved(WireRoutes.SavedViewExecute, currentRun, Conflict);
        var removal = new SavedViewCommand(SavedViewAction.Retire, viewId, 2, 2, Guid.NewGuid(), "", null);
        var secondId = Guid.NewGuid();
        await SaveView(new(SavedViewAction.Save, secondId, 0, 2, Guid.NewGuid(), "Date review", new(schema, [date], "")));
        var pin = new SavedViewPlacementCommand(SavedViewPlacementAction.Pin, viewId, 2, 3, Guid.NewGuid(), Guid.Empty);
        var pinPacket = Wire.EncodeSavedViewPlacementCommand(pin);
        var pinReceipt = await Saved(WireRoutes.SavedViewPlacement, pinPacket);
        Assert.Equal(pinReceipt, await Saved(WireRoutes.SavedViewPlacement, pinPacket));
        await SaveView(removal with { RequestId = pin.RequestId, CollectionRevision = 4 }, Conflict);
        await Place(SavedViewPlacementAction.Pin, secondId, 1, 4);
        var changedOrder = Wire.EncodeSavedViewPlacementCommand(new(SavedViewPlacementAction.MoveBefore, secondId, 1, 5, Guid.NewGuid(), viewId));
        var otherOrder = Wire.EncodeSavedViewPlacementCommand(new(SavedViewPlacementAction.MoveBefore, viewId, 2, 5, Guid.NewGuid(), Guid.Empty));
        var replies = await Task.WhenAll(Response(WireRoutes.SavedViewPlacement, changedOrder, owner, handle),
            Response(WireRoutes.SavedViewPlacement, otherOrder, owner, handle));
        Assert.Single(replies, reply => reply.Status == OK);
        Assert.Single(replies, reply => reply.Status == Conflict);
        Assert.Equal(new[] { secondId, viewId }, (await Placement()).Pins.Select(item => item.Id));
        await Place(SavedViewPlacementAction.Default, viewId, 2, 6);
        Assert.Equal(viewId, (await Placement()).Default?.Id);
        await SaveView(removal with { CollectionRevision = 7 }, Conflict);
        await Place(SavedViewPlacementAction.Default, secondId, 1, 7);
        Assert.Equal(secondId, (await Placement()).Default?.Id);
        Assert.True(Wire.DecodeSavedViewReceipt(await SaveView(removal with { CollectionRevision = 8 })).Retired);
        foreach (var (query, status, actor, actorHandle) in new (string, HttpStatusCode, string?, string?)[]
        {
            ($"?view={viewId:D}&viewSchema=1", NotFound, null, null),
            ($"?view={secondId:D}&viewSchema=1", NotFound, outsider, outsiderHandle),
            ($"?view={secondId:D}&viewSchema=2", BadRequest, null, null),
            ("?offset=25&revision=8", Conflict, null, null),
            ($"?view={secondId:D}&viewSchema=1&viewSchema=1", BadRequest, null, null),
        })
            await Saved(WireRoutes.SavedViewPlacement + query, status: status, session: actor, sessionId: actorHandle);
        var selected = await Placement($"?view={secondId:D}&viewSchema=1");
        Assert.Equal((secondId, true), (selected.Requested?.Id, selected.RequestedPinned));
        Assert.Single(selected.Pins);
        await Place(SavedViewPlacementAction.Unpin, secondId, 1, 9);
        var unpinned = await Placement($"?view={secondId:D}&viewSchema=1");
        Assert.True(unpinned.Pins.Count == 0 && !unpinned.RequestedPinned && unpinned.Default?.Id == secondId);
        await Place(SavedViewPlacementAction.ClearDefault, secondId, 1, 10);
        Assert.Null((await Placement()).Default);
        await Saved(WireRoutes.SavedViewExecute, currentRun, NotFound);
        Assert.Equal(secondId, Assert.Single(Wire.DecodeSavedViewCatalog(await Saved(WireRoutes.SavedViews)).Views).Id);

        var presentViewId = Guid.NewGuid();
        var presentConditions = new[] { Present(5), Present(0) };
        var directPresence = await Group(presentConditions);
        Assert.Equal(primary.Id, Assert.Single(directPresence.Rows).Id);
        var openPresence = await SaveAndVerifyView(presentViewId, 11, "Stored values", new(schema, presentConditions, ""), directPresence.Rows);

        var (red, blue, green) = (options[0].Id, options[1].Id, options[2].Id);
        var left = await Article("Red and Blue", owner);
        await Put(left, fields[5], new PropertyFieldValue.MultiSelect([blue, red]), 0, 2);
        var right = await Article("Blue and Green", owner);
        await Put(right, fields[5], new PropertyFieldValue.MultiSelect([blue, green]), 0, 2);
        var nullChoices = await Article("Null choices", owner);
        await Put(nullChoices, fields[5], new PropertyFieldValue.Null(), 0, 2);
        await Schema(outsider, 1, fields[5], 0, 0, "same-field", "Same field", PropertyFieldKind.MultiSelect, options);
        await PutAs(outsider, foreign, 1, 0, fields[5], 1, new PropertyFieldValue.MultiSelect([red]));
        Assert.Equal(left.Id, await SingleFilter(5, new PropertyFieldValue.MultiSelect([red, blue])));
        Assert.Equal(new[] { left.Id, empty.Id }, Ids(await Group([AnyOf(red)])));
        Assert.Equal(right.Id, await SingleGroup([AnyOf(green)]));
        Assert.Empty((await Group([AnyOf()])).Rows);
        foreach (var (cond, status) in new[] { (AnyOf(Guid.NewGuid()), BadRequest),
            (AnyOf(red) with { DefinitionId = fields[4] }, BadRequest), (AnyOf(red) with { DefinitionRevision = 1 }, Conflict) })
            await Group([cond], status: status);
        var overlap = new[] { AnyOf(green, red), Present(5) };
        var directOverlap = await Group(overlap);
        Assert.Equal(new[] { right.Id, left.Id, empty.Id }, Ids(directOverlap));
        Assert.Equal(directOverlap.Rows.ToArray(), (await Group([Present(5), AnyOf(red, green)])).Rows.ToArray());

        var overlapId = Guid.NewGuid();
        var openOverlap = await SaveAndVerifyView(overlapId, 12, "Selected alternatives", new(schema, overlap, ""), directOverlap.Rows);
        Assert.Equal(overlapId, (await Placement($"?view={overlapId:D}&viewSchema=1")).Requested?.Id);

        await Put(nullChoices, fields[4], new PropertyFieldValue.Null(), 1, 2);
        await Schema(outsider, 1, fields[4], 1, 0, "same-single", "Same single field", PropertyFieldKind.SingleSelect, options);
        await PutAs(outsider, foreign, 2, 1, fields[4], 1, new PropertyFieldValue.SingleSelect(red));
        Assert.Equal(primary.Id, await SingleGroup([SingleAnyOf(red)]));
        Assert.Empty((await Group([SingleAnyOf(green)])).Rows);
        var single = await Group([SingleAnyOf(blue, red)]);
        Assert.Equal(new[] { empty.Id, primary.Id }, Ids(single));
        Assert.Equal(single.Rows.ToArray(), (await Group([SingleAnyOf(red, blue)])).Rows.ToArray());
        foreach (var (cond, status) in new[] { (SingleAnyOf(red) with { DefinitionId = fields[5] }, BadRequest),
            (SingleAnyOf(Guid.NewGuid()), BadRequest), (SingleAnyOf(red) with { DefinitionRevision = 1 }, Conflict) })
            await Group([cond], status: status);

        var openSingle = await SaveAndVerifyView(Guid.NewGuid(), 13, "Single-selection alternatives",
            new(schema, [SingleAnyOf(blue, red)], ""), single.Rows);
        await Filterable(fields[5], schema++, 2, false);
        await Group([AnyOf(red) with { DefinitionRevision = 3 }], status: NotFound);
        await Saved(WireRoutes.SavedViewExecute, openPresence, Conflict);
        await Saved(WireRoutes.SavedViewExecute, openOverlap, Conflict);
        await Filterable(fields[4], schema++, 2, false);
        await Group([SingleAnyOf(red) with { DefinitionRevision = 3 }], status: NotFound);
        await Saved(WireRoutes.SavedViewExecute, openSingle, Conflict);

        target = await Publication(target, ArticleAction.Publish, owner);
        var secondTarget = await Publication(right, ArticleAction.Publish, owner);
        var foreignTarget = await Publication(foreign, ArticleAction.Publish, outsider);
        await Put(left, fields[6], new PropertyFieldValue.ArticleReference([secondTarget.Id]), 1, 2);
        await Put(nullChoices, fields[6], new PropertyFieldValue.Null(), 2, 2);
        Assert.Empty((await Group([ReferenceAnyOf()])).Rows);
        Assert.Equal(primary.Id, await SingleGroup([ReferenceAnyOf(target.Id)]));
        var references = await Group([ReferenceAnyOf(secondTarget.Id, target.Id)]);
        Assert.Equal(new[] { left.Id, primary.Id }, Ids(references));
        foreach (var (cond, status) in new[]
        {
            (ReferenceAnyOf(target.Id, missing.Id), NotFound),
            (ReferenceAnyOf(foreignTarget.Id, target.Id), NotFound),
            (ReferenceAnyOf(target.Id) with { DefinitionId = fields[2] }, BadRequest),
            (ReferenceAnyOf(target.Id) with { DefinitionRevision = 1 }, Conflict),
        })
            await Group([cond], status: status);

        var referenceViewId = Guid.NewGuid();
        var referenceView = new SavedViewCommand(SavedViewAction.Save, referenceViewId, 0, 14, Guid.NewGuid(),
            "Published reference alternatives", new(schema, [ReferenceAnyOf(target.Id, secondTarget.Id)], ""));
        await SaveView(referenceView with { RequestId = Guid.NewGuid(), Query = new(schema, [ReferenceAnyOf(target.Id, missing.Id)], "") }, NotFound);
        var openReferences = await SaveAndVerifyView(referenceViewId, 14, referenceView.Name, referenceView.Query!, references.Rows);
        await Publication(secondTarget, ArticleAction.Retract, owner);
        await Group([ReferenceAnyOf(target.Id, secondTarget.Id)], status: NotFound);
        await Saved(WireRoutes.SavedViewExecute, openReferences, Conflict);
        Assert.Equal(primary.Id, await SingleGroup([ReferenceAnyOf(target.Id)]));

        await Filterable(fields[1], schema++, 4, true);
        var afterSummary = await Article("Beyond the excerpt", owner, summaryPrefix + "x" + matchText);
        var wildcardOnly = await Article("C12XYNeedle", owner);
        await Put(afterSummary, fields[1], definitions[1].Primary, 0, 5);
        await Put(wildcardOnly, fields[1], definitions[1].Primary, 0, 5);
        var scoreMatch = new PropertyCondition(fields[1], 5, PropertyComparison.Equal, definitions[1].Primary);
        var scoreOnly = await Group([scoreMatch]);
        Assert.Contains(scoreOnly.Rows, row => row.Id == afterSummary.Id);
        Assert.Contains(scoreOnly.Rows, row => row.Id == wildcardOnly.Id);

        await Schema(outsider, 1, fields[1], 2, 0, "same-score", "Same score", PropertyFieldKind.Number, []);
        await PutAs(outsider, foreignTarget, 3, 2, fields[1], 1, definitions[1].Primary);
        await Filterable(fields[1], 3, 1, true, outsider);
        Assert.Equal(foreignTarget.Id, Assert.Single((await QueryGroup(new(4, [scoreMatch with { DefinitionRevision = 2 }], "", keyword),
            outsider, outsiderHandle)).Rows).Id);

        var keywordQuery = new PropertyArticleQueryGroup(schema, [scoreMatch], "", keyword);
        var keywordFrame = Wire.EncodePropertyArticleQueryGroup(keywordQuery);
        await Send(WireRoutes.PropertyArticleQuery, keywordFrame, owner, Conflict);
        await Send(WireRoutes.PropertyArticleQuery, keywordFrame, owner, Conflict, peerHandle);
        var keywordPage = await QueryGroup(keywordQuery);
        Assert.Equal(summaryMatches.Select(row => row.Id).Reverse(), Ids(keywordPage));
        Assert.NotEmpty(keywordPage.NextCursor);
        Assert.Equal(primary.Id, Assert.Single((await QueryGroup(keywordQuery with { Conditions = [scoreMatch, Present(2)] })).Rows).Id);
        var keywordContinuation = keywordQuery with { Cursor = keywordPage.NextCursor };
        var continuationFrame = Wire.EncodePropertyArticleQueryGroup(keywordContinuation);
        var keywordTail = await QueryGroup(keywordContinuation);
        Assert.Equal(primary.Id, Assert.Single(keywordTail.Rows).Id);
        Assert.Empty(keywordTail.NextCursor);
        await Send(WireRoutes.PropertyArticleQuery, Wire.EncodePropertyArticleQueryGroup(keywordContinuation with { Keyword = keyword[1..] }), owner, BadRequest, handle);
        await Group([scoreMatch], keywordPage.NextCursor, BadRequest);
        (_, owner, handle) = await db.SignIn(ownerId, ct);
        await Send(WireRoutes.PropertyArticleQuery, continuationFrame, owner, BadRequest, handle);

        var keywordViewId = Guid.NewGuid();
        var keywordView = new SavedViewCommand(SavedViewAction.Save, keywordViewId, 0, 15, Guid.NewGuid(), "Keyword and score", keywordQuery);
        var keywordSaveFrame = Wire.EncodeSavedViewCommand(keywordView);
        var keywordSave = await Saved(WireRoutes.SavedViews, keywordSaveFrame);
        Assert.Equal(keywordSave, await Saved(WireRoutes.SavedViews, keywordSaveFrame));
        await SaveView(keywordView with { Query = keywordQuery with { Keyword = keyword[1..] } }, Conflict);
        var savedKeywordPage = await RunView(keywordViewId);
        Assert.Equal(keywordPage.Rows.ToArray(), savedKeywordPage.Rows.ToArray());
        Assert.NotEmpty(savedKeywordPage.NextCursor);
        var savedKeywordTail = await RunView(keywordViewId, 1, savedKeywordPage.NextCursor);
        Assert.Equal(keywordTail.Rows.ToArray(), savedKeywordTail.Rows.ToArray());
        Assert.Empty(savedKeywordTail.NextCursor);
        await RunViewStatus(keywordViewId, 1, keywordPage.NextCursor, BadRequest);
        foreach (var (id, version) in new[] { (secondId, 1), (referenceViewId, 5), (keywordViewId, 6) })
            Assert.Equal(version, await SavedDefinitionVersion(id));

        var lowScore = scoreMatch with { Value = new PropertyFieldValue.Number(0), AnyOf = true };
        var highScore = scoreMatch with { AnyOf = true };
        var alternativePage = await Group([lowScore, highScore]);
        var expectedScores = summaryMatches.Select(item => item.Id).Concat([afterSummary.Id, wildcardOnly.Id, empty.Id, primary.Id]).OrderDescending().ToArray();
        Assert.Equal(expectedScores.Take(WireLimits.PropertyPageSize), Ids(alternativePage));
        Assert.NotEmpty(alternativePage.NextCursor);
        Assert.Equal(expectedScores.Skip(WireLimits.PropertyPageSize), Ids(await Group([highScore, lowScore], alternativePage.NextCursor)));
        await Group([highScore, lowScore with { Value = new PropertyFieldValue.Number(1) }], alternativePage.NextCursor, BadRequest);
        Assert.Equal(primary.Id, await SingleGroup([lowScore, highScore, Present(2), falseCondition]));
        var qualifiedAlternatives = await Qualified(new(lexicalQuery, "", null, null, schema, [lowScore, highScore, Present(2)]));
        Assert.Equal(new[] { empty.Id, primary.Id }.Order(), qualifiedAlternatives.Rows.Select(row => row.Id).Order());
        var alternativeViewId = Guid.NewGuid();
        var alternativeQuery = new PropertyArticleQueryGroup(schema, [highScore, lowScore, Present(2)], "", keyword);
        await SaveView(new(SavedViewAction.Save, alternativeViewId, 0, 16, Guid.NewGuid(), "Either score", alternativeQuery));
        var runAlternatives = Wire.EncodeSavedViewExecute(new(alternativeViewId, 1, ""));
        Assert.Equal(new[] { empty.Id, primary.Id }, Ids(await RunViewFrame(runAlternatives)));
        await Saved(WireRoutes.SavedViewExecute, runAlternatives, NotFound, outsider, outsiderHandle);
        Assert.Equal(7, await SavedDefinitionVersion(alternativeViewId));

        foreach (var article in summaryMatches)
            await Put(article, fields[6], new PropertyFieldValue.ArticleReference([target.Id]), article.Id == changedOffPage.Id ? 3 : 1, 2);
        var referenceSearch = new AuthorTextQualifiedQuery(lexicalQuery, "", null, null, schema, [Present(6)]);
        var referencePage = await Qualified(referenceSearch);
        Assert.Equal(summaryMatches.Count + 1, referencePage.Total);
        Assert.NotEmpty(referencePage.NextCursor);
        var referenceContinuation = referenceSearch with { Cursor = referencePage.NextCursor };
        await Publication(target, ArticleAction.Retract, owner);
        await Qualified(referenceContinuation, Conflict);
        Assert.Equal(0, (await Qualified(referenceSearch)).Total);

        var laterScoreSearch = allScores with { SchemaRevision = schema, Conditions = [scoreMatch] };
        var laterScores = await Qualified(laterScoreSearch);
        Assert.NotEmpty(laterScores.NextCursor);
        await Filterable(fields[1], schema, 5, false);
        await Qualified(laterScoreSearch with { Cursor = laterScores.NextCursor }, Conflict);

        static int[] Ids(PropertyArticlePage page) => page.Rows.Select(row => row.Id).ToArray();
        Task<int> SavedDefinitionVersion(Guid id) =>
            db.Scalar<int>("select get_byte(definition,0) from public.author_saved_view where owner_id=$1 and id=$2", ownerId, id);
        Task<long> ModifiedAt(int id) =>
            db.Scalar<long>("select floor(extract(epoch from updated_at)*1000)::bigint from public.article where id=$1", id);
        Task<byte[]> Schema(string actor, int op, Guid id, long schemaRev, long rev, string key, string label, PropertyFieldKind kind, PropertyFieldOption[] opts) =>
            Send(WireRoutes.PropertySchemaCommand, Wire.EncodePropertySchemaInput(new(new(op, id, Guid.NewGuid(), schemaRev, rev, key, label), kind, opts)), actor);
        Task<byte[]> Filterable(Guid id, long schemaRev, long rev, bool enabled, string? actor = null) =>
            Send(WireRoutes.PropertyFilterability, Wire.EncodePropertyFilterabilityCommand(new(id, Guid.NewGuid(), schemaRev, rev, enabled)), actor ?? owner);
        Task<byte[]> SaveView(SavedViewCommand cmd, HttpStatusCode status = OK) =>
            Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(cmd), status);
        Task<byte[]> Place(SavedViewPlacementAction action, Guid id, long viewRev, long collRev) =>
            Saved(WireRoutes.SavedViewPlacement, Wire.EncodeSavedViewPlacementCommand(new(action, id, viewRev, collRev, Guid.NewGuid(), Guid.Empty)));
        async Task<SavedViewPlacement> Placement(string query = "") =>
            Wire.DecodeSavedViewPlacement(await Saved(WireRoutes.SavedViewPlacement + query));
        Task<PropertyArticlePage> RunView(Guid id, long rev = 1, string cursor = "") =>
            RunViewFrame(Wire.EncodeSavedViewExecute(new(id, rev, cursor)));
        async Task<PropertyArticlePage> RunViewFrame(byte[] frame) =>
            Wire.DecodePropertyArticlePage(await Saved(WireRoutes.SavedViewExecute, frame));
        Task<byte[]> RunViewStatus(Guid id, long rev, string cursor, HttpStatusCode status) =>
            Saved(WireRoutes.SavedViewExecute, Wire.EncodeSavedViewExecute(new(id, rev, cursor)), status);
        async Task<PropertyArticlePage> QueryGroup(PropertyArticleQueryGroup query, string? actor = null, string? actorHandle = null) =>
            Wire.DecodePropertyArticlePage(await Send(WireRoutes.PropertyArticleQuery, Wire.EncodePropertyArticleQueryGroup(query),
                actor ?? owner, OK, actorHandle ?? handle));
        async Task<byte[]> SaveAndVerifyView(Guid id, long collRev, string name, PropertyArticleQueryGroup query, IReadOnlyList<PropertyArticleRow> expected)
        {
            await SaveView(new(SavedViewAction.Save, id, 0, collRev, Guid.NewGuid(), name, query));
            var open = Wire.EncodeSavedViewExecute(new(id, 1, ""));
            Assert.Equal(expected.ToArray(), (await RunViewFrame(open)).Rows.ToArray());
            await Saved(WireRoutes.SavedViewExecute, open, NotFound, outsider, outsiderHandle);
            return open;
        }
        async Task<AuthorTextFacetedPage> Qualified(AuthorTextQualifiedQuery query, HttpStatusCode status = OK, string? session = null, string? sessionId = null)
        {
            if (status != OK)
            {
                await Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextQualifiedQuery(query), session ?? owner, status, sessionId ?? handle);
                return new(false, "", 0, [0, 0, 0, 0], false, [], false, [], []);
            }
            return await AuthorPropertyFixture.Ready(async () => Wire.DecodeAuthorTextFacetedPage(
                await Send(WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextQualifiedQuery(query), session ?? owner, OK, sessionId ?? handle)),
                page => page.Ready, "The fixture index did not finish within eight requests.");
        }
        Task<byte[]> Saved(string route, byte[]? frame = null, HttpStatusCode status = OK, string? session = null, string? sessionId = null) =>
            Send(route, frame, session ?? owner, status, sessionId ?? handle);
        PropertyCondition Present(int index, long revision = 2) =>
            new(fields[index], revision, PropertyComparison.IsPresent, new PropertyFieldValue.Missing());
        PropertyCondition AnyOf(params Guid[] alternatives) =>
            new(fields[5], 2, PropertyComparison.MultiSelectAnyOf, new PropertyFieldValue.MultiSelect(alternatives));
        PropertyCondition SingleAnyOf(params Guid[] alternatives) =>
            new(fields[4], 2, PropertyComparison.SingleSelectAnyOf, new PropertyFieldValue.MultiSelect(alternatives));
        PropertyCondition ReferenceAnyOf(params int[] alternatives) =>
            new(fields[6], 2, PropertyComparison.ReferenceAnyOf, new PropertyFieldValue.ArticleReference(alternatives));
        async Task<int> SingleGroup(PropertyCondition[] conditions, string cursor = "") =>
            Assert.Single((await Group(conditions, cursor)).Rows).Id;
        async Task<int> SingleFilter(int index, PropertyFieldValue value, string cursor = "") =>
            Assert.Single((await Filter(index, value, cursor: cursor)).Rows).Id;
        async Task<PropertyArticlePage> Group(PropertyCondition[] conditions, string cursor = "", HttpStatusCode status = OK)
        {
            var packet = await Send(WireRoutes.PropertyArticleQuery, Wire.EncodePropertyArticleQueryGroup(new(schema, conditions, cursor)), owner, status);
            return status == OK ? Wire.DecodePropertyArticlePage(packet) : new("", []);
        }
        async Task<PropertyArticlePage> Filter(int index, PropertyFieldValue value, HttpStatusCode status = OK, string cursor = "")
        {
            var packet = await Send(WireRoutes.PropertyArticleQuery, Wire.EncodePropertyArticleQuery(new(schema, fields[index], 2, value, cursor)), owner, status);
            return status == OK ? Wire.DecodePropertyArticlePage(packet) : new("", []);
        }
        Task<byte[]> Put(ArticleState article, Guid field, PropertyFieldValue value, long version, long definition) =>
            PutAs(owner, article, schema, version, field, definition, value);
        Task<byte[]> PutAs(string actor, ArticleState article, long schemaRev, long version, Guid field, long definition, PropertyFieldValue value) =>
            Send(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueInput(new(article.Id, article.Revision, schemaRev, version,
                field, definition, Guid.NewGuid(), value)), actor);
        Task<ArticleState> Article(string title, string token, string body = "Private") =>
            PublicationFixture.EditDraft(store, token, ArticleAction.Save, new(0, 0, Guid.NewGuid(), title, body), ct);
        Task<ArticleState> Publication(ArticleState article, ArticleAction action, string token) =>
            PublicationFixture.EditDraft(store, token, action, new(article.Id, article.Revision, Guid.NewGuid(), "", ""), ct);
        async Task<byte[]> Send(string route, byte[]? packet, string? session, HttpStatusCode status = OK, string? sessionId = null)
        {
            var response = await Response(route, packet, session, sessionId);
            Assert.Equal(status, response.Status);
            return response.Body;
        }
        async Task<(HttpStatusCode Status, byte[] Body)> Response(string route, byte[]? packet, string? session, string? sessionId)
        {
            using var result = await SiteAedsFixture.Send(server.Client, packet is null ? HttpMethod.Get : HttpMethod.Post, route, packet, session, sessionId, ct);
            Assert.True(result.Headers.CacheControl?.NoStore);
            return (result.StatusCode, await result.Content.ReadAsByteArrayAsync(ct));
        }
    }
}
