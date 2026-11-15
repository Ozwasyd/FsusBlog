using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Sessions;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PropertyQueryPostgresTests
{
    [PostgresFact]
    public async Task ExactOwnedFiltersRejectDisabledFieldsAndKeepDistinctValueStates()
    {
        using var stop = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = stop.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(db.DataSource);
        var owner = await SignIn("First owner");
        var outsider = await SignIn("Second owner");
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);
        var primary = await Article("Match", owner);
        var empty = await Article("Empty", owner);
        var missing = await Article("Missing", owner);
        var foreign = await Article("Other owner", outsider);
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
            Assert.Contains((await Filter(i, new PropertyFieldValue.Missing())).Rows, row => row.Id == missing.Id);
            Assert.DoesNotContain((await Filter(i, new PropertyFieldValue.Missing())).Rows, row => row.Id == foreign.Id);
            int[] presentIds = definitions[i].Item3 is PropertyFieldValue.Null ? [primary.Id] : [empty.Id, primary.Id];
            Assert.Equal(presentIds, (await Group([Present(i)])).Rows.Select(row => row.Id));
        }
        await Group([Present(0, 1)], status: HttpStatusCode.Conflict);
        Assert.Equal(empty.Id, Assert.Single((await Filter(0, new PropertyFieldValue.Null())).Rows).Id);
        Assert.Empty((await Filter(1, new PropertyFieldValue.Number(9007199254740993.1234568m))).Rows);
        await Filter(1, new PropertyFieldValue.Text("0"), HttpStatusCode.BadRequest);

        for (var i = 0; i < WireLimits.PropertyPageSize; i++)
        {
            var article = await Article($"Number page {i}", owner);
            await Put(article, fields[1], definitions[1].Item2, 0, 2);
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
        var ownerId = await store.WithSession(owner, true, (_, _, actor) => Task.FromResult(actor.Id), ct);
        var anotherOwnerSession = await Ticket(ownerId);
        var groupContinuation = Wire.EncodePropertyArticleQueryGroup(new(schema, [lower, upper], groupPage.NextCursor));
        await Send(WireRoutes.PropertyArticleQuery, groupContinuation, anotherOwnerSession, HttpStatusCode.BadRequest);
        await Send(WireRoutes.PropertyArticleQuery, groupContinuation, null, HttpStatusCode.Unauthorized);
        Assert.Throws<ProtocolException>(() => Wire.EncodePropertyArticleQueryGroup(new(schema, [lower, lower], "")));
        Assert.Throws<ProtocolException>(() => Wire.EncodePropertyArticleQueryGroup(new(schema, [], "")));

        var viewId = Guid.NewGuid();
        var save = new SavedViewCommand(SavedViewAction.Save, viewId, 0, 0, Guid.NewGuid(), "  Re\u0301vision  ",
            new(schema, [upper, lower], ""));
        var packet = Wire.EncodeSavedViewCommand(save);
        var (handle, peerHandle) = (SiteSessions.Id(ownerId, Store.TokenDigest(owner)!),
            SiteSessions.Id(ownerId, Store.TokenDigest(anotherOwnerSession)!));
        var firstSave = await Saved(WireRoutes.SavedViews, packet);
        Assert.Equal(firstSave, await Saved(WireRoutes.SavedViews, packet));
        Assert.Equal(new SavedViewReceipt(viewId, 1, 1, false), Wire.DecodeSavedViewReceipt(firstSave));
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(save with { Name = "Changed replay" }), HttpStatusCode.Conflict);
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(save with { Id = Guid.NewGuid(),
            RequestId = Guid.NewGuid(), CollectionRevision = 1, Name = "RÉVISION" }), HttpStatusCode.Conflict);
        var saved = Wire.DecodeSavedViewCatalog(await Saved(WireRoutes.SavedViews));
        Assert.Equal(new SavedViewSummary(viewId, 1, "Révision"), Assert.Single(saved.Views));
        var started = Wire.DecodePropertyArticlePage(await Saved(WireRoutes.SavedViewExecute,
            Wire.EncodeSavedViewExecute(new(viewId, 1, ""))));
        Assert.Equal(groupPage.Rows.Select(row => row.Id), started.Rows.Select(row => row.Id));
        var continuation = Wire.EncodeSavedViewExecute(new(viewId, 1, started.NextCursor));
        await Saved(WireRoutes.SavedViewExecute, continuation, HttpStatusCode.BadRequest, anotherOwnerSession, peerHandle);
        await Saved(WireRoutes.SavedViewExecute, continuation, HttpStatusCode.Conflict, anotherOwnerSession, handle);
        await Saved(WireRoutes.SavedViewExecute, Wire.EncodeSavedViewExecute(new(viewId, 1, groupPage.NextCursor)), HttpStatusCode.BadRequest);
        var outsiderId = await store.WithSession(outsider, true, (_, _, actor) => Task.FromResult(actor.Id), ct);
        var outsiderHandle = SiteSessions.Id(outsiderId, Store.TokenDigest(outsider)!);
        await Saved(WireRoutes.SavedViewExecute, continuation, HttpStatusCode.NotFound, outsider, outsiderHandle);
        Assert.Empty(Wire.DecodeSavedViewCatalog(await Saved(WireRoutes.SavedViews, session: outsider, sessionId: outsiderHandle)).Views);
        Assert.Equal(primary.Id, Assert.Single(Wire.DecodePropertyArticlePage(await Saved(WireRoutes.SavedViewExecute, continuation)).Rows).Id);

        var editedName = new SavedViewCommand(SavedViewAction.Rename, viewId, 1, 1, Guid.NewGuid(), "Range review", null);
        var attempts = await Task.WhenAll(
            Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(editedName), session: owner, sessionId: handle),
            Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(editedName), session: anotherOwnerSession, sessionId: peerHandle));
        Assert.Equal(attempts[0], attempts[1]);
        await Saved(WireRoutes.SavedViews, Wire.EncodeSavedViewCommand(editedName with { RequestId = Guid.NewGuid() }), HttpStatusCode.Conflict);
        await Saved(WireRoutes.SavedViewExecute, continuation, HttpStatusCode.Conflict);
        await Saved(WireRoutes.SavedViewExecute, Wire.EncodeSavedViewExecute(new(viewId, 2, started.NextCursor)), HttpStatusCode.BadRequest);
        var currentRun = Wire.EncodeSavedViewExecute(new(viewId, 2, ""));
        var renamedProperty = Wire.EncodePropertySchemaInput(new(new(2, fields[1], Guid.NewGuid(), schema++, 2, "", "New score label"),
            PropertyFieldKind.Text, []));
        await Send(WireRoutes.PropertySchemaCommand, renamedProperty, owner);
        Assert.NotEmpty(Wire.DecodePropertyArticlePage(await Saved(WireRoutes.SavedViewExecute, currentRun)).Rows);

        await store.WithSession(owner, true, (c, t, a) => Store.Execute(c, t, a, ArticleAction.Retract,
            new(target.Id, target.Revision, Guid.NewGuid(), "", ""), ct), ct);
        await Filter(6, definitions[6].Item2, HttpStatusCode.NotFound);
        Assert.Empty((await Group([Present(6)])).Rows);
        await Group([lower with { DefinitionRevision = 3 }, new(fields[6], 2, PropertyComparison.Equal, definitions[6].Item2)], status: HttpStatusCode.NotFound);
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
            Response(WireRoutes.SavedViewPlacement, otherOrder, anotherOwnerSession, peerHandle));
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

        Task<byte[]> Saved(string route, byte[]? frame = null, HttpStatusCode status = HttpStatusCode.OK,
            string? session = null, string? sessionId = null) => Send(route, frame, session ?? owner, status, sessionId ?? handle);

        PropertyCondition Present(int index, long revision = 2) =>
            new(fields[index], revision, PropertyComparison.IsPresent, new PropertyFieldValue.Missing());

        PropertyCondition AnyOf(params Guid[] alternatives) =>
            new(fields[5], 2, PropertyComparison.MultiSelectAnyOf, new PropertyFieldValue.MultiSelect(alternatives));

        PropertyCondition SingleAnyOf(params Guid[] alternatives) =>
            new(fields[4], 2, PropertyComparison.SingleSelectAnyOf, new PropertyFieldValue.MultiSelect(alternatives));

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
        async Task<ArticleState> Article(string title, string token) => (await store.WithSession(token, true, (c, t, a) =>
            Store.Execute(c, t, a, ArticleAction.Save, new(0, 0, Guid.NewGuid(), title, "Private"), ct), ct)).Article;
        async Task<string> SignIn(string name)
        {
            var id = Guid.NewGuid();
            await using var conn = await db.DataSource.OpenConnectionAsync(ct);
            await using (var create = Store.Sql(conn, null, "insert into public.blog_user values($1,$2,true,true,1)", id, name))
                await create.ExecuteNonQueryAsync(ct);
            return await Ticket(id);
        }
        async Task<string> Ticket(Guid id)
        {
            var key = RandomNumberGenerator.GetBytes(32);
            await using var conn = await db.DataSource.OpenConnectionAsync(ct);
            await using var ticket = Store.Sql(conn, null, "insert into public.login_ticket values($1,$2,now()+interval '2 minutes')", SHA256.HashData(key), id);
            await ticket.ExecuteNonQueryAsync(ct);
            return (await store.SignIn(Convert.ToHexStringLower(key), ct)).Token;
        }
        async Task<byte[]> Send(string route, byte[]? packet, string? session, HttpStatusCode status = HttpStatusCode.OK, string? sessionId = null)
        {
            var response = await Response(route, packet, session, sessionId);
            Assert.Equal(status, response.Status);
            return response.Body;
        }
        async Task<(HttpStatusCode Status, byte[] Body)> Response(string route, byte[]? packet, string? session, string? sessionId)
        {
            using var request = new HttpRequestMessage(packet is null ? HttpMethod.Get : HttpMethod.Post, route);
            if (packet is not null)
            {
                request.Content = new ByteArrayContent(packet);
                request.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
            }
            if (session is not null) request.Headers.Add("Cookie", $"fsus-v2-session={session}");
            if (sessionId is not null) request.Headers.Add(WireHeaders.CurrentSession, sessionId);
            using var result = await server.Client.SendAsync(request, ct);
            Assert.True(result.Headers.CacheControl?.NoStore);
            return (result.StatusCode, await result.Content.ReadAsByteArrayAsync(ct));
        }
    }
}
