using System.Security.Cryptography;
using System.Net;
using System.Net.Http.Headers;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Sessions;

namespace FsusBlog.V2.Integration.Tests;

public sealed class CanvasPostgresTests
{
    [Fact]
    public void ConversionEscapesServerLabelAndRetainsEveryByteOutsideExplicitInsertion()
    {
        var owner = Guid.NewGuid();
        var actor = new Identity(owner, "Author", 1, true, DateTimeOffset.MaxValue);
        var body = "\uFEFF# Author's note\r\n\r\nExisting source 🐝";
        var host = new ArticleState(1, owner, 1, "Host", body, 1, false);
        var target = new CanvasTarget(2, owner, 3, "[See] \\ ](https://other.invalid)");
        var edge = new CanvasEdge(Guid.NewGuid(), Guid.NewGuid(), 1, 1, 2, true);
        var intent = new CanvasLinkIntent(edge.CanvasId, edge.EdgeId, 1, 1, 3, body.Length);

        var appended = CanvasStore.Build(edge, intent, host, target, actor);
        Assert.Equal(body, appended.Body[..body.Length]);
        Assert.StartsWith("\r\n\r\n[", appended.Inserted);
        Assert.EndsWith("](/article/2)", appended.Inserted);
        Assert.Contains("\\[See\\]", appended.Inserted);
        Assert.Equal(Rejection.Conflict, Assert.Throws<BusinessException>(() =>
            CanvasStore.Build(edge, intent with { SourceOffset = body.Length - 1 }, host, target, actor)).Rejection);
        Assert.Equal(Rejection.Invalid, Assert.Throws<BusinessException>(() =>
            CanvasStore.Build(edge with { ExplicitReference = false }, intent, host, target, actor)).Rejection);
        Assert.Equal(appended, CanvasStore.Build(edge with { ExplicitReference = false },
            intent with { VisualOnly = true }, host, target, actor));
        Assert.Equal(Rejection.Invalid, Assert.Throws<BusinessException>(() =>
            CanvasStore.Build(edge, intent with { VisualOnly = true }, host, target, actor)).Rejection);
        Assert.Equal(Rejection.Invalid, Assert.Throws<BusinessException>(() =>
            CanvasStore.Build(edge, intent with { SourceOffset = 3 }, host with { Body = "```" }, target, actor)).Rejection);
    }

    [PostgresFact]
    public async Task KestrelDecodesCanvasAedsAndRechecksSessionBeforeCommit()
    {
        await using var test = await Fixture.Open();
        var owner = await test.Author("HTTP owner");
        var host = await test.Save(owner.Token, "Host", "Visible source");
        var target = await test.Publish(owner.Token, await test.Save(owner.Token, "Target", "Draft target"));
        await using var server = await ServerProcess.Start(test.ConnectionString, test.Token);
        var input = new CanvasCreate(Guid.NewGuid(), Guid.NewGuid(), host.Id, target.Id);
        var payload = Wire.EncodeCanvasCreate(input);
        var invalid = (byte[])payload.Clone();
        invalid[^1] ^= 1;
        Aeds.Decode(await Post(WireRoutes.CanvasCreate, payload, HttpStatusCode.Unauthorized, null), FrameType.ApiError);
        Aeds.Decode(await Post(WireRoutes.CanvasCreate, invalid, HttpStatusCode.BadRequest, owner.Token), FrameType.ApiError);
        var canvas = Wire.DecodeCanvasCreated(await Post(WireRoutes.CanvasCreate, payload, HttpStatusCode.OK, owner.Token));
        var plan = Wire.DecodeCanvasLinkPlan(await Post(WireRoutes.CanvasPreview, Wire.EncodeCanvasPreview(
            new(canvas.CanvasId, canvas.EdgeId, canvas.CanvasRevision, host.Revision, target.Revision, host.Body.Length)),
            HttpStatusCode.OK, owner.Token));
        var receipt = Wire.DecodeCanvasLinked(await Post(WireRoutes.CanvasConfirm, Wire.EncodeCanvasConfirm(new(plan.PlanId)),
            HttpStatusCode.OK, owner.Token));
        Assert.Equal(new(plan.PlanId, host.Id, host.Revision + 1, canvas.CanvasRevision + 1), receipt);

        var current = await test.Read(owner.Token, host.Id);
        const string visualSelection = "?edge=visual-only";
        var wrongSelection = Wire.EncodeCanvasPreview(new(canvas.CanvasId, canvas.EdgeId, receipt.CanvasRevision,
            current.Revision, target.Revision, current.Body.Length));
        Aeds.Decode(await Post(WireRoutes.CanvasPreview + visualSelection, wrongSelection, HttpStatusCode.BadRequest, owner.Token), FrameType.ApiError);

        var document = Guid.NewGuid();
        var from = Guid.NewGuid();
        var to = Guid.NewGuid();
        var visualEdge = Guid.NewGuid();
        var visualGraph = new CanvasGraphCommand(document, Guid.NewGuid(), 0, CanvasGraphAction.Create, "Visual plan", new(0, 0, 1000),
        [
            new CanvasChangeFrame.PutNode(new(from, 0, 0, 0, 12000, 8000, host.Id)),
            new CanvasChangeFrame.PutNode(new(to, 0, 16000, 0, 12000, 8000, target.Id)),
            new CanvasChangeFrame.PutEdge(new(visualEdge, 0, from, to, 0, null)),
        ]);
        await Post(WireRoutes.CanvasGraphWrite, Wire.EncodeCanvasGraphCommand(visualGraph), HttpStatusCode.OK, owner.Token);
        var visual = Wire.EncodeCanvasPreview(new(document, visualEdge, 1, current.Revision, target.Revision, current.Body.Length));
        Aeds.Decode(await Post(WireRoutes.CanvasPreview, visual, HttpStatusCode.BadRequest, owner.Token), FrameType.ApiError);
        Aeds.Decode(await Post(WireRoutes.CanvasPreview + visualSelection + "&edge=visual-only", visual,
            HttpStatusCode.BadRequest, owner.Token), FrameType.ApiError);
        var visualPlan = Wire.DecodeCanvasLinkPlan(await Post(WireRoutes.CanvasPreview + visualSelection, visual, HttpStatusCode.OK, owner.Token));
        Assert.Equal(current, await test.Read(owner.Token, host.Id));
        var confirmation = Wire.EncodeCanvasConfirm(new(visualPlan.PlanId));
        var visualReceipt = Wire.DecodeCanvasLinked(await Post(WireRoutes.CanvasConfirm, confirmation, HttpStatusCode.OK, owner.Token));
        Assert.Equal(new(visualPlan.PlanId, host.Id, current.Revision + 1, 2), visualReceipt);
        Assert.Equal(visualReceipt, Wire.DecodeCanvasLinked(await Post(WireRoutes.CanvasConfirm, confirmation, HttpStatusCode.OK, owner.Token)));
        Assert.Equal(current.Body + visualPlan.InsertedMarkdown, (await test.Read(owner.Token, host.Id)).Body);
        Assert.Equal(false, await test.Scalar("select explicit_reference from public.canvas_edge where canvas_id=$1 and id=$2", document, visualEdge));

        await test.Mutate("update public.blog_user set generation=generation+1 where id=$1", owner.User.Id);
        Aeds.Decode(await Post(WireRoutes.CanvasConfirm, Wire.EncodeCanvasConfirm(new(plan.PlanId)),
            HttpStatusCode.Unauthorized, owner.Token), FrameType.ApiError);

        async Task<byte[]> Post(string path, byte[] bytes, HttpStatusCode status, string? token)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = new ByteArrayContent(bytes) };
            request.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
            if (token is not null) request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            using var response = await server.Client.SendAsync(request, test.Token);
            Assert.Equal(status, response.StatusCode);
            Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
            Assert.True(response.Headers.CacheControl?.NoStore);
            return await response.Content.ReadAsByteArrayAsync(test.Token);
        }
    }

    [PostgresFact]
    public async Task PortableBundleKeepsOnlyCanvasFactsAndRebindsExplicitly()
    {
        await using var test = await Fixture.Open();
        var owner = await test.Author("Canvas export owner");
        var other = await test.Author("Canvas import owner");
        var from = await test.Save(owner.Token, "Private source <article>", "# Source mapped ^block");
        var into = await test.Save(other.Token, "Private target article", "# Target mapped ^block");
        var bad = await test.Save(other.Token, "Another private title", "Unrelated content");
        var canvas = Guid.NewGuid();
        var note = Guid.NewGuid();
        var reference = Guid.NewGuid();
        var edge = Guid.NewGuid();
        await using var server = await ServerProcess.Start(test.ConnectionString, test.Token);
        var initial = new CanvasGraphCommand(canvas, Guid.NewGuid(), 0, CanvasGraphAction.Create, "Portable research", new(1310, -2150, 1200),
        [
            new CanvasChangeFrame.PutNode(new(note, 3, 10, 95, 12000, 8000, Text: "Plain note 🐝")),
            new CanvasChangeFrame.PutNode(new(reference, 1, 13500, 0, 12000, 8000, from.Id, "block", from.Revision)),
            new CanvasChangeFrame.PutEdge(new(edge, 0, note, reference, 0, null)),
        ]);
        await Send(HttpMethod.Post, WireRoutes.CanvasGraphWrite, owner.Token, HttpStatusCode.OK, Wire.EncodeCanvasGraphCommand(initial));
        string export = WireRoutes.CanvasBundleExport.Replace("{id:guid}", canvas.ToString("D"));
        var packed = await Send(HttpMethod.Get, export + "?revision=1", owner.Token, HttpStatusCode.OK, package: true);
        Assert.Equal(packed, await Send(HttpMethod.Get, export + "?revision=1", owner.Token, HttpStatusCode.OK, package: true));
        var json = System.Text.Encoding.UTF8.GetString(packed);
        Assert.Contains("Plain note", json, StringComparison.Ordinal);
        foreach (var hidden in new[] { owner.User.Id.ToString("D"), canvas.ToString("D"), note.ToString("D"),
            reference.ToString("D"), edge.ToString("D"), from.Title, from.Body })
            Assert.DoesNotContain(hidden, json, StringComparison.Ordinal);
        await Send(HttpMethod.Get, export + "?revision=1", other.Token, HttpStatusCode.NotFound);
        await Send(HttpMethod.Get, export + "?revision=2", owner.Token, HttpStatusCode.Conflict);
        await Send(HttpMethod.Get, export + "?revision=1", null, HttpStatusCode.Unauthorized);

        var before = await test.Scalar("select count(*) from public.authoring_canvas");
        var originalRows = await test.Scalar("select count(*) from public.article_revision");
        var originalOutbox = await test.Scalar("select count(*) from public.blog_outbox");
        var plan = Wire.DecodeCanvasBundlePlan(await Send(HttpMethod.Post, WireRoutes.CanvasBundlePlan, other.Token,
            HttpStatusCode.OK, Wire.EncodeCanvasBundleIntake(packed)));
        Assert.Equal((1L, "Portable research", 2, 1), (plan.SourceRevision, plan.Title, plan.NodeCount, plan.EdgeCount));
        Assert.Equal(new(1, 1, true, "block"), Assert.Single(plan.References));
        Assert.Equal(before, await test.Scalar("select count(*) from public.authoring_canvas"));
        var tampered = (byte[])packed.Clone();
        tampered[^4] ^= 1;
        await Send(HttpMethod.Post, WireRoutes.CanvasBundlePlan, other.Token, HttpStatusCode.BadRequest, Wire.EncodeCanvasBundleIntake(tampered));
        var command = new CanvasBundleExecute(Guid.NewGuid(), Guid.NewGuid(), plan.Digest, [new(1, into.Id, into.Revision)], packed);
        await Send(HttpMethod.Post, WireRoutes.CanvasBundleExecute, other.Token, HttpStatusCode.BadRequest,
            Wire.EncodeCanvasBundleExecute(command with { Bundle = tampered }));
        await Send(HttpMethod.Post, WireRoutes.CanvasBundleExecute, other.Token, HttpStatusCode.BadRequest,
            Wire.EncodeCanvasBundleExecute(command with { Mappings = [] }));
        await Send(HttpMethod.Post, WireRoutes.CanvasBundleExecute, other.Token, HttpStatusCode.NotFound,
            Wire.EncodeCanvasBundleExecute(command with { Mappings = [new(1, from.Id, from.Revision)] }));
        await Send(HttpMethod.Post, WireRoutes.CanvasBundleExecute, other.Token, HttpStatusCode.NotFound,
            Wire.EncodeCanvasBundleExecute(command with { Mappings = [new(1, bad.Id, bad.Revision)] }));
        Assert.Equal(before, await test.Scalar("select count(*) from public.authoring_canvas"));

        var commandBytes = Wire.EncodeCanvasBundleExecute(command);
        var imported = Wire.DecodeCanvasGraphReceipt(await Send(HttpMethod.Post, WireRoutes.CanvasBundleExecute, other.Token, HttpStatusCode.OK, commandBytes));
        Assert.Equal((command.CanvasId, 1L, 2, 1, new CanvasViewport(1310, -2150, 1200)),
            (imported.Id, imported.Revision, imported.NodeCount, imported.EdgeCount, imported.Viewport));
        Assert.Equal(imported, Wire.DecodeCanvasGraphReceipt(await Send(HttpMethod.Post, WireRoutes.CanvasBundleExecute, other.Token, HttpStatusCode.OK, commandBytes)));
        var importedPath = WireRoutes.CanvasBundleExport.Replace("{id:guid}", imported.Id.ToString("D"));
        Assert.Equal(packed, await Send(HttpMethod.Get, importedPath + "?revision=1", other.Token, HttpStatusCode.OK, package: true));
        Assert.Equal(into.Id, await test.Scalar("select article_id from public.canvas_node where canvas_id=$1 and kind=1", imported.Id));
        Assert.Equal(originalRows, await test.Scalar("select count(*) from public.article_revision"));
        Assert.Equal(originalOutbox, await test.Scalar("select count(*) from public.blog_outbox"));
        Assert.Equal(2L, await test.Scalar("select count(*) from public.authoring_canvas"));
        await Send(HttpMethod.Post, WireRoutes.CanvasBundleExecute, other.Token, HttpStatusCode.NotFound,
            Wire.EncodeCanvasBundleExecute(command with { CommandId = Guid.NewGuid() }));

        async Task<byte[]> Send(HttpMethod method, string path, string? token, HttpStatusCode status, byte[]? body = null, bool package = false)
        {
            using var request = new HttpRequestMessage(method, path);
            if (body is not null)
            {
                request.Content = new ByteArrayContent(body);
                request.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
            }
            if (token is not null) request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            using var response = await server.Client.SendAsync(request, test.Token);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            var payload = await response.Content.ReadAsByteArrayAsync(test.Token);
            if (package)
            {
                Assert.Equal(Wire.CanvasBundleContentType, response.Content.Headers.ContentType?.MediaType);
                Assert.Equal("attachment", response.Content.Headers.ContentDisposition?.DispositionType);
            }
            else if (status != HttpStatusCode.OK) Aeds.Decode(payload, FrameType.ApiError);
            return payload;
        }
    }

    [PostgresFact]
    public async Task ImportsAndExportsTenThousandNodesAndEdgesThroughTheCanonicalStore()
    {
        await using var test = await Fixture.Open();
        var owner = await test.Author("Canvas load owner");
        var noteIds = Enumerable.Range(1, 10_000).Select(i => new Guid(i, 0, 0, new byte[8])).ToArray();
        var graph = new CanvasGraph(
            [.. noteIds.Select((node, i) => new CanvasNode(node, CanvasNodeKind.PlainTextNote,
                new(i * 4200, 0, 12000, 8000), Text: "A minimal local note"))],
            [.. noteIds.Select((node, i) => new CanvasGraphEdge(new(i + 20_000, 0, 0, new byte[8]),
                CanvasGraphEdgeKind.VisualOnly, node, noteIds[(i + 1) % noteIds.Length], i))]);
        var bytes = CanvasPortableBundle.Export("10,000 portable nodes", new(0, 0, 1000), 1, graph).Encode();
        var digest = CanvasBundleStore.Digest(bytes);
        var command = new CanvasBundleExecute(Guid.NewGuid(), Guid.NewGuid(), digest, [], bytes);
        var fingerprint = SHA256.HashData(Wire.EncodeCanvasBundleExecute(command));
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var imported = await test.WithGraph(owner.Token, graphStore => graphStore.ImportBundle(command, fingerprint, test.Token));
        var insertMs = clock.ElapsedMilliseconds;
        Assert.Equal((10_000, 10_000), (imported.NodeCount, imported.EdgeCount));
        Assert.Equal(10_000L, await test.Scalar("select count(*) from public.canvas_node where canvas_id=$1", imported.Id));
        Assert.Equal(10_000L, await test.Scalar("select count(*) from public.canvas_edge where canvas_id=$1", imported.Id));
        var first = await test.WithGraph(owner.Token, store => store.Page(imported.Id, 1, 0, test.Token));
        Assert.Equal(WireLimits.CanvasGraphMaxPageNodes, first.Nodes.Count);
        Assert.Equal(WireLimits.CanvasGraphMaxPageNodes, first.NextOffset);
        var last = await test.WithGraph(owner.Token, store => store.Page(imported.Id, 1, 19_999, test.Token));
        Assert.Equal(-1, last.NextOffset);
        Assert.Single(last.Edges);
        clock.Restart();
        Assert.Equal(bytes, await test.WithGraph(owner.Token, store => store.ExportBundle(imported.Id, 1, test.Token)));
        Console.WriteLine($"Canvas 10,000 nodes+10,000 edges: package {bytes.Length} bytes, import {insertMs} ms, export {clock.ElapsedMilliseconds} ms.");
    }

    [PostgresFact]
    public async Task ResolvesOnlyStoredOwnerCoordinatesAndPinsExactSource()
    {
        await using var test = await Fixture.Open();
        var owner = await test.Author("Canvas resolver owner");
        var outsider = await test.Author("Canvas resolver outsider");
        var otherBrowser = await test.SignIn(owner.User.Id);
        var ownerSession = SiteSessions.Id(owner.User.Id, Store.TokenDigest(owner.Token)!);
        var otherSession = SiteSessions.Id(owner.User.Id, Store.TokenDigest(otherBrowser.Token)!);
        var outsiderSession = SiteSessions.Id(outsider.User.Id, Store.TokenDigest(outsider.Token)!);
        var foreign = await test.Save(outsider.Token, "Sensitive foreign title", "Sensitive foreign source");
        const string initialBody = "Utility 🐈\r\n\r\n# Pinned heading ^overview\r\n\r\nPinned paragraph ^detail";
        var initial = await test.Save(owner.Token, "Old private title", initialBody);
        var crlfSource = await test.Save(owner.Token, "Current source with CRLF", initialBody);
        var unsupported = new List<(Guid Node, int Article, string Body)>();
        foreach (var body in new[] {
            initialBody + "\r\nSecond paragraph\n",
            "Utility 🐈\n\nPinned paragraph ^detail\n\nSecond paragraph\r\n",
            initialBody + "\r\nSecond paragraph\r"
        })
        {
            var source = await test.Save(owner.Token, "Current source with unsupported line endings", body);
            unsupported.Add((Guid.NewGuid(), source.Id, body));
        }
        var current = await test.Save(owner.Token, "New private title", "# Latest heading ^overview\n\n" +
            "First instance ^ambiguous\n\nSecond instance ^ambiguous\n\n" +
            "```markdown\n# Looks like a heading ^hidden\n```", initial.Id, initial.Revision);

        Guid canvas = Guid.NewGuid();
        Guid heading = Guid.NewGuid();
        Guid pin = Guid.NewGuid();
        Guid currentPin = Guid.NewGuid();
        Guid article = Guid.NewGuid();
        Guid crlfBlock = Guid.NewGuid();
        Guid crlfArticle = Guid.NewGuid();
        Guid ambiguous = Guid.NewGuid();
        Guid hidden = Guid.NewGuid();
        Guid mismatchedKind = Guid.NewGuid();
        Guid wrong = Guid.NewGuid();
        var input = new CanvasGraphCommand(canvas, Guid.NewGuid(), 0, CanvasGraphAction.Create, "Owned Canvas", new(600, 120, 1000),
        [
            Node(heading, 1, current.Id, "overview", null),
            Node(pin, 2, current.Id, "detail", initial.Revision),
            Node(currentPin, 1, current.Id, "overview", current.Revision),
            Node(article, 0, current.Id, null, null),
            Node(crlfBlock, 2, crlfSource.Id, "detail", null),
            Node(crlfArticle, 0, crlfSource.Id, null, null),
            .. unsupported.Select(source => Node(source.Node, 2, source.Article, "detail", null)),
            Node(ambiguous, 2, current.Id, "ambiguous", null),
            Node(hidden, 1, current.Id, "hidden", null),
            Node(mismatchedKind, 1, current.Id, "detail", initial.Revision),
            Node(wrong, 0, current.Id, null, null)
        ]);
        await using var server = await ServerProcess.Start(test.ConnectionString, test.Token);
        var frame = Wire.EncodeCanvasGraphCommand(input);
        var created = Wire.DecodeCanvasGraphReceipt(await Request(HttpMethod.Post, WireRoutes.CanvasGraphWrite, owner.Token, HttpStatusCode.OK, frame));
        Assert.Equal(1, created.Revision);

        var live = await Resolve(heading);
        Assert.Equal((CanvasReferenceState.Resolved, "New private title", current.Id, current.Revision, false, "Latest heading", 17),
            (live.State, live.Title, live.ArticleId, live.ArticleRevision, live.Pinned, live.Excerpt, live.SourceOffset));
        Assert.Equal(live, await Resolve(heading, requireCurrent: true));
        Assert.Equal(live with { NodeId = currentPin, Pinned = true }, await Resolve(currentPin, requireCurrent: true));
        var historical = await Resolve(pin);
        Assert.Equal((CanvasReferenceState.Resolved, "Old private title", current.Id, initial.Revision, true, "Pinned paragraph", initialBody.IndexOf("^detail", StringComparison.Ordinal)),
            (historical.State, historical.Title, historical.ArticleId, historical.ArticleRevision, historical.Pinned, historical.Excerpt, historical.SourceOffset));
        Assert.Equal(Stale(pin), await Resolve(pin, requireCurrent: true));
        var metadata = await Resolve(article);
        Assert.Equal((CanvasReferenceState.Resolved, "New private title", current.Revision),
            (metadata.State, metadata.Title, metadata.ArticleRevision));
        Assert.Null(metadata.Excerpt);
        Assert.Null(metadata.SourceOffset);
        Assert.Equal(metadata, await Resolve(article, requireCurrent: true));
        var crlfPreview = await Resolve(crlfBlock);
        Assert.Equal((CanvasReferenceState.Resolved, crlfSource.Revision, initialBody.IndexOf("^detail", StringComparison.Ordinal)),
            (crlfPreview.State, crlfPreview.ArticleRevision, crlfPreview.SourceOffset));
        Assert.Equal(crlfPreview, await Resolve(crlfBlock, requireCurrent: true));
        Assert.Equal(crlfSource.Revision, (await Resolve(crlfArticle, requireCurrent: true)).ArticleRevision);
        foreach (var source in unsupported)
        {
            var preview = await Resolve(source.Node);
            Assert.Equal(CanvasReferenceState.Resolved, preview.State);
            Assert.Equal(source.Body.IndexOf("^detail", StringComparison.Ordinal), preview.SourceOffset);
            Assert.Equal(Stale(source.Node), await Resolve(source.Node, requireCurrent: true));
        }
        foreach (var (node, expected) in new[] {
            (ambiguous, CanvasReferenceState.DuplicateAnchor), (hidden, CanvasReferenceState.MissingAnchor),
            (mismatchedKind, CanvasReferenceState.MissingAnchor)
        })
        {
            var missed = await Resolve(node);
            Assert.Equal(expected, missed.State);
            Assert.Null(missed.Excerpt);
            Assert.Null(missed.SourceOffset);
        }

        // Exercise the endpoint's regression boundary for a corrupted or migrated old reference.
        await test.Mutate("update public.canvas_node set article_id=$3 where canvas_id=$1 and id=$2", canvas, wrong, foreign.Id);
        var unavailable = new CanvasReferenceResolution(canvas, wrong, 1, CanvasReferenceState.Unavailable, null, null, false, null, null, null);
        Assert.Equal(unavailable, await Resolve(wrong));
        Assert.Equal(unavailable, await Resolve(wrong, requireCurrent: true));
        await Request(HttpMethod.Get, Route(heading, 1), outsider.Token, HttpStatusCode.NotFound);
        await Request(HttpMethod.Get, Route(heading, 1), null, HttpStatusCode.Unauthorized);
        await Request(HttpMethod.Get, Route(heading, 3), owner.Token, HttpStatusCode.Conflict);
        await Request(HttpMethod.Get, Route(heading, 1, "&current=1"), outsider.Token, HttpStatusCode.NotFound, sessions: [outsiderSession]);
        await Request(HttpMethod.Get, Route(heading, 1, "&current=1"), null, HttpStatusCode.Unauthorized, sessions: [ownerSession]);
        await Request(HttpMethod.Get, Route(heading, 3, "&current=1"), owner.Token, HttpStatusCode.Conflict, sessions: [ownerSession]);
        await Request(HttpMethod.Get, Route(heading, 1, "&current=1"), owner.Token, HttpStatusCode.Conflict);
        await Request(HttpMethod.Get, Route(heading, 1, "&current=1"), owner.Token, HttpStatusCode.Conflict, sessions: [otherSession]);
        await Request(HttpMethod.Get, Route(heading, 1, "&current=1"), owner.Token, HttpStatusCode.Conflict, sessions: [ownerSession, ownerSession]);
        foreach (var malformed in new[] { "&current", "&current=", "&current=0", "&current=true", "&current=01", "&current=1&current=1" })
            await Request(HttpMethod.Get, Route(heading, 1, malformed), owner.Token, HttpStatusCode.BadRequest, sessions: [ownerSession]);

        var noWriteCount = await test.Scalar("select count(*) from public.canvas_document_event where canvas_id=$1", canvas);
        Assert.Equal(1L, noWriteCount);
        var bodyEdit = await test.Save(owner.Token, "Another private title", "# Latest changed ^overview", current.Id, current.Revision);
        Assert.Equal(bodyEdit.Revision, (await Resolve(heading, requireCurrent: true)).ArticleRevision);
        Assert.Equal(initial.Revision, (await Resolve(pin)).ArticleRevision);
        Assert.Equal(current.Revision, (await Resolve(currentPin)).ArticleRevision);
        Assert.Equal(Stale(currentPin), await Resolve(currentPin, requireCurrent: true));
        await test.Mutate("update public.article set deleted=true where id=$1", current.Id);
        Assert.Equal(CanvasReferenceState.Unavailable, (await Resolve(heading)).State);
        Assert.Equal(CanvasReferenceState.Unavailable, (await Resolve(pin)).State);
        await test.Mutate("update public.blog_user set generation=generation+1 where id=$1", owner.User.Id);
        await Request(HttpMethod.Get, Route(heading, 1), owner.Token, HttpStatusCode.Unauthorized);
        await Request(HttpMethod.Get, Route(heading, 1, "&current=1"), owner.Token, HttpStatusCode.Unauthorized, sessions: [ownerSession]);

        static CanvasChangeFrame Node(Guid id, int kind, int target, string? anchor, long? pinned) =>
            new CanvasChangeFrame.PutNode(new(id, kind, 0, 0, 12000, 8000, target, anchor, pinned));
        CanvasReferenceResolution Stale(Guid id) => new(canvas, id, 1, CanvasReferenceState.StaleRevision, null, null, false, null, null, null);
        string Route(Guid id, long revision, string mode = "") =>
            WireRoutes.CanvasReference.Replace("{id:guid}", canvas.ToString("D")).Replace("{nodeId:guid}", id.ToString("D"))
            + $"?revision={revision}{mode}";
        async Task<CanvasReferenceResolution> Resolve(Guid id, bool requireCurrent = false) =>
            Wire.DecodeCanvasReferenceResolution(await Request(HttpMethod.Get, Route(id, 1, requireCurrent ? "&current=1" : ""),
                owner.Token, HttpStatusCode.OK, sessions: requireCurrent ? [ownerSession] : null));

        async Task<byte[]> Request(HttpMethod method, string path, string? token, HttpStatusCode status, byte[]? body = null, string[]? sessions = null)
        {
            using var request = new HttpRequestMessage(method, path);
            if (body is not null)
            {
                request.Content = new ByteArrayContent(body);
                request.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
            }
            if (token is not null) request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            if (sessions is not null) request.Headers.Add(WireHeaders.CurrentSession, sessions);
            using var response = await server.Client.SendAsync(request, test.Token);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            var bytes = await response.Content.ReadAsByteArrayAsync(test.Token);
            if (status != HttpStatusCode.OK) Aeds.Decode(bytes, FrameType.ApiError);
            return bytes;
        }
    }

    [PostgresFact]
    public async Task GraphRoutesApplyOneOrderedRevisionAndKeepPrivateProvenance()
    {
        await using var test = await Fixture.Open();
        var owner = await test.Author("Graph owner");
        var other = await test.Author("Graph outsider");
        var reader = await test.Author("Graph reader", false);
        var source = await test.Save(owner.Token, "Source", "Article body");
        var target = await test.Publish(owner.Token, await test.Save(owner.Token, "Public target", "Target body"));
        var foreign = await test.Save(other.Token, "Other owner's article", "Private");
        await using var server = await ServerProcess.Start(test.ConnectionString, test.Token);
        var id = Guid.NewGuid();
        var from = Guid.NewGuid();
        var to = Guid.NewGuid();
        var note = Guid.NewGuid();
        var group = Guid.NewGuid();
        var edge = Guid.NewGuid();
        var loop = Guid.NewGuid();
        var title = "Planning";
        var create = new CanvasGraphCommand(id, Guid.NewGuid(), 0, CanvasGraphAction.Create, title, new(600, -200, 1750),
        [
            Node(from, 0, source.Id), Node(to, 0, target.Id), Node(note, 3, text: "Private planning note"),
            Node(group, 4, text: "Drafts", members: [from, note]),
            new CanvasChangeFrame.PutEdge(new(edge, 1, from, to, 1, "Commit manually")),
            new CanvasChangeFrame.PutEdge(new(loop, 0, note, note, 0, null))
        ]);
        await Send(HttpMethod.Get, WireRoutes.CanvasGraphList, null, HttpStatusCode.Unauthorized);
        await Write(create, reader.Token, HttpStatusCode.Forbidden);
        var head = Wire.DecodeCanvasGraphReceipt(await Write(create, owner.Token));
        Assert.Equal((id, 1L, title, 4, 2), (head.Id, head.Revision, head.Title, head.NodeCount, head.EdgeCount));
        Assert.Equal(head, Wire.DecodeCanvasGraphReceipt(await Write(create, owner.Token)));
        await Write(create with { Title = "Different payload" }, owner.Token, HttpStatusCode.Conflict);
        await Write(create, other.Token, HttpStatusCode.NotFound);
        await GetPage(other.Token, 0, 0, HttpStatusCode.NotFound);
        Assert.Empty(Wire.DecodeCanvasGraphList(await Send(HttpMethod.Get, WireRoutes.CanvasGraphList, other.Token)));
        Assert.Equal(head, Assert.Single(Wire.DecodeCanvasGraphList(await Send(HttpMethod.Get, WireRoutes.CanvasGraphList, owner.Token))));
        var first = Wire.DecodeCanvasGraphPage(await GetPage(owner.Token, 0, 0));
        Assert.Equal(4, first.NextOffset);
        Assert.Equal(4, first.Nodes.Count);
        var last = Wire.DecodeCanvasGraphPage(await GetPage(owner.Token, head.Revision, first.NextOffset));
        Assert.Equal(-1, last.NextOffset);
        Assert.Equal(new[] { loop, edge }, last.Edges.Select(value => value.Id));
        await GetPage(owner.Token, 0, first.NextOffset, HttpStatusCode.BadRequest);

        var graphEdit = new CanvasGraphCommand(id, Guid.NewGuid(), head.Revision, CanvasGraphAction.Edit,
            "", null, [new CanvasChangeFrame.DropNode(note)]);
        await Write(graphEdit with { Changes = [Node(Guid.NewGuid(), 0, foreign.Id)] }, owner.Token, HttpStatusCode.NotFound);
        await Write(graphEdit with { Changes = [new CanvasChangeFrame.DropNode(note), new CanvasChangeFrame.DropNode(Guid.NewGuid())] },
            owner.Token, HttpStatusCode.NotFound);
        Assert.Equal(4L, await test.Scalar("select count(*) from public.canvas_node where canvas_id=$1", id));
        Assert.Equal(1L, await test.Scalar("select count(*) from public.canvas_document_event where canvas_id=$1", id));

        var competing = graphEdit with { CommandId = Guid.NewGuid(), Title = "Renamed", Changes = [] };
        // Hold the transaction behind a deliberately closed fault point. Graph and receipt revert together.
        await test.Mutate("alter table public.canvas_document_event add constraint test_graph_commit_failure check(revision=1)");
        await Write(graphEdit, owner.Token, HttpStatusCode.ServiceUnavailable);
        await test.Mutate("alter table public.canvas_document_event drop constraint test_graph_commit_failure");
        Assert.Equal(4L, await test.Scalar("select count(*) from public.canvas_node where canvas_id=$1", id));
        Assert.Equal(1L, await test.Scalar("select revision from public.authoring_canvas where id=$1", id));

        var changed = Wire.DecodeCanvasGraphReceipt(await Write(graphEdit, owner.Token));
        Assert.Equal((2L, 3, 1), (changed.Revision, changed.NodeCount, changed.EdgeCount));
        Assert.Equal(changed, Wire.DecodeCanvasGraphReceipt(await Write(graphEdit, owner.Token)));
        await Write(competing, owner.Token, HttpStatusCode.Conflict);
        await GetPage(owner.Token, head.Revision, first.NextOffset, HttpStatusCode.Conflict);
        var graph = Wire.DecodeCanvasGraphPage(await GetPage(owner.Token, changed.Revision, 0));
        Assert.Equal(from, Assert.Single(Assert.Single(graph.Nodes, value => value.Id == group).MemberIds!));

        var planBytes = await Send(HttpMethod.Post, WireRoutes.CanvasPreview, owner.Token, body: Wire.EncodeCanvasPreview(
            new(id, edge, changed.Revision, source.Revision, target.Revision, source.Body.Length)));
        var plan = Wire.DecodeCanvasLinkPlan(planBytes);
        var link = Wire.DecodeCanvasLinked(await Send(HttpMethod.Post, WireRoutes.CanvasConfirm, owner.Token,
            body: Wire.EncodeCanvasConfirm(new(plan.PlanId))));
        Assert.Equal(3L, link.CanvasRevision);
        var delete = new CanvasGraphCommand(id, Guid.NewGuid(), link.CanvasRevision, CanvasGraphAction.Delete, "", null, []);
        var deleted = Wire.DecodeCanvasGraphReceipt(await Write(delete, owner.Token));
        Assert.True(deleted.Deleted);
        Assert.Equal((4L, 0, 0), (deleted.Revision, deleted.NodeCount, deleted.EdgeCount));
        Assert.Equal(deleted, Wire.DecodeCanvasGraphReceipt(await Write(delete, owner.Token)));
        Assert.Empty(Wire.DecodeCanvasGraphList(await Send(HttpMethod.Get, WireRoutes.CanvasGraphList, owner.Token)));
        await GetPage(owner.Token, deleted.Revision, 0, HttpStatusCode.NotFound);
        Assert.Equal(4L, await test.Scalar("select count(*) from public.canvas_document_event where canvas_id=$1", id));
        Assert.Equal(0L, await test.Scalar("select count(*) from public.canvas_edge where canvas_id=$1", id));
        Assert.Equal(0L, await test.Scalar("select count(*) from public.canvas_node where canvas_id=$1", id));
        Assert.Equal(1L, await test.Scalar("select count(*) from public.canvas_link_plan where canvas_id=$1", id));
        Assert.EndsWith("[Public target](/article/" + target.Id + ")", (await test.Read(owner.Token, source.Id)).Body);

        await test.Mutate("update public.blog_user set generation=generation+1 where id=$1", owner.User.Id);
        await Write(delete, owner.Token, HttpStatusCode.Unauthorized);

        static CanvasChangeFrame Node(Guid id, int kind, int? article = null, string? text = null, Guid[]? members = null) =>
            new CanvasChangeFrame.PutNode(new(id, kind, 0, 0, 12000, 8000, article, Text: text, MemberIds: members));

        Task<byte[]> Write(CanvasGraphCommand command, string token, HttpStatusCode status = HttpStatusCode.OK) =>
            Send(HttpMethod.Post, WireRoutes.CanvasGraphWrite, token, status, Wire.EncodeCanvasGraphCommand(command));

        Task<byte[]> GetPage(string token, long revision, int offset, HttpStatusCode status = HttpStatusCode.OK) =>
            Send(HttpMethod.Get, $"/api/v2/authoring/canvas/documents/{id:D}.aeds?revision={revision}&offset={offset}", token, status);

        async Task<byte[]> Send(HttpMethod method, string path, string? token, HttpStatusCode status = HttpStatusCode.OK, byte[]? body = null)
        {
            using var request = new HttpRequestMessage(method, path);
            if (body is not null)
            {
                request.Content = new ByteArrayContent(body);
                request.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
            }
            if (token is not null) request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            using var response = await server.Client.SendAsync(request, test.Token);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            byte[] bytes = await response.Content.ReadAsByteArrayAsync(test.Token);
            if (status != HttpStatusCode.OK) Aeds.Decode(bytes, FrameType.ApiError);
            return bytes;
        }
    }

    [PostgresFact]
    public async Task ConfirmAtomicallyAppendsOnceAndRetainsImmutablePublication()
    {
        await using var test = await Fixture.Open();
        var owner = await test.Author("owner");
        var outsider = await test.Author("outsider");
        var ignored = await test.Author("reader", false);
        var host = await test.Save(owner.Token, "Host", "Visible source");
        var original = await test.Publish(owner.Token, host);
        var unpublished = await test.Save(owner.Token, "Unpublished title", "Private target source");
        await Denied(Rejection.NotFound, test.WithCanvas(owner.Token, op => op.Create(
            new(Guid.NewGuid(), Guid.NewGuid(), host.Id, unpublished.Id), test.Token)));
        var target = await test.Publish(owner.Token, await test.Save(owner.Token, "Target", "Published target source"));
        var privateDraft = await test.Save(owner.Token, "Private target title", "Private draft", target.Id, target.Revision);
        var other = await test.Save(outsider.Token, "Other", "Private");
        var input = new CanvasCreate(Guid.NewGuid(), Guid.NewGuid(), original.Id, target.Id);
        var canvas = await test.WithCanvas(owner.Token, op => op.Create(input, test.Token));
        Assert.Equal(canvas, await test.WithCanvas(owner.Token, op => op.Create(input, test.Token)));

        await Denied(Rejection.NotFound, test.WithCanvas(outsider.Token, op => op.Create(input, test.Token)));
        await Denied(Rejection.Forbidden, test.WithCanvas(ignored.Token, op => op.Create(input, test.Token)));
        await Denied(Rejection.NotFound, test.WithCanvas(owner.Token, op => op.Create(
            new(Guid.NewGuid(), Guid.NewGuid(), host.Id, other.Id), test.Token)));

        var preview = new CanvasPreview(canvas.CanvasId, canvas.EdgeId, 1, original.Revision, target.Revision, original.Body.Length);
        await Denied(Rejection.NotFound, test.WithCanvas(outsider.Token, op => op.Preview(preview, test.Token)));
        var plan = await test.WithCanvas(owner.Token, op => op.Preview(preview, test.Token));
        Assert.Equal($"\n\n[Target](/article/{target.Id})", plan.InsertedMarkdown);
        var anotherOwnerSession = await test.SignIn(owner.User.Id);
        await Denied(Rejection.NotFound, test.WithCanvas(anotherOwnerSession.Token, op => op.Confirm(plan.PlanId, test.Token)));
        Assert.Equal(original, await test.Read(owner.Token, host.Id));
        Assert.Equal(1L, await test.Scalar("select revision from public.authoring_canvas where id=$1", canvas.CanvasId));
        await Denied(Rejection.NotFound, test.WithCanvas(outsider.Token, op => op.Confirm(plan.PlanId, test.Token)));

        var first = test.WithCanvas(owner.Token, op => op.Confirm(plan.PlanId, test.Token));
        var repeat = test.WithCanvas(owner.Token, op => op.Confirm(plan.PlanId, test.Token));
        var results = await Task.WhenAll(first, repeat);
        Assert.Equal(results[0], results[1]);
        Assert.Equal(new CanvasLinked(plan.PlanId, host.Id, original.Revision + 1, 2), results[0]);

        var edited = await test.Read(owner.Token, host.Id);
        Assert.Equal(original.Body + plan.InsertedMarkdown, edited.Body);
        Assert.Equal(original.Revision, edited.PublishedRevision);
        Assert.Equal(privateDraft, await test.Read(owner.Token, target.Id));
        Assert.Equal(original.Body, await test.Scalar(
            "select body from public.article_revision where article_id=$1 and revision=$2", host.Id, original.Revision));
        Assert.Equal(1L, await test.Scalar("select count(*) from public.canvas_edge where canvas_id=$1", canvas.CanvasId));
        Assert.Equal(1L, await test.Scalar("select count(*) from public.blog_outbox where article_id=$1 and revision=$2 and kind='save'",
            edited.Id, edited.Revision));
    }

    [PostgresFact]
    public async Task ExpiryDriftAndFailedReceiptPreserveBothAuthorities()
    {
        await using var test = await Fixture.Open();
        var author = await test.Author("author");
        var host = await test.Save(author.Token, "Host", "Source");
        var target = await test.Publish(author.Token, await test.Save(author.Token, "Target", "# Original title"));
        var canvas = await test.WithCanvas(author.Token, op => op.Create(
            new(Guid.NewGuid(), Guid.NewGuid(), host.Id, target.Id), test.Token));
        var preview = new CanvasPreview(canvas.CanvasId, canvas.EdgeId, 1, host.Revision, target.Revision, host.Body.Length);

        var expired = await test.WithCanvas(author.Token, op => op.Preview(preview, test.Token));
        await test.Mutate("update public.canvas_link_plan set expires_at=clock_timestamp() where id=$1", expired.PlanId);
        await Denied(Rejection.Conflict, test.WithCanvas(author.Token, op => op.Confirm(expired.PlanId, test.Token)));

        var stale = await test.WithCanvas(author.Token, op => op.Preview(preview, test.Token));
        var changed = await test.Publish(author.Token,
            await test.Save(author.Token, "New target label", target.Body, target.Id, target.Revision));
        await Denied(Rejection.Conflict, test.WithCanvas(author.Token, op => op.Confirm(stale.PlanId, test.Token)));
        await test.Mutate("update public.canvas_edge set explicit_reference=false where canvas_id=$1", canvas.CanvasId);
        var visualIntent = preview with { TargetRevision = changed.Revision };
        var visualPlan = await test.WithCanvas(author.Token, op => op.Preview(visualIntent, test.Token, true));
        await test.Mutate("update public.canvas_edge set explicit_reference=true where canvas_id=$1", canvas.CanvasId);
        await Denied(Rejection.Conflict, test.WithCanvas(author.Token, op => op.Confirm(visualPlan.PlanId, test.Token)));
        await test.Mutate("update public.canvas_edge set explicit_reference=false where canvas_id=$1", canvas.CanvasId);
        await Denied(Rejection.Invalid, test.WithCanvas(author.Token, op => op.Preview(
            preview with { TargetRevision = changed.Revision }, test.Token)));
        await test.Mutate("update public.canvas_edge set explicit_reference=true where canvas_id=$1", canvas.CanvasId);

        var current = await test.WithCanvas(author.Token, op => op.Preview(
            preview with { TargetRevision = changed.Revision }, test.Token));
        await test.Mutate("alter table public.canvas_link_plan add constraint test_receipt_failure check(applied_revision is null)");
        var fault = await Assert.ThrowsAsync<Npgsql.PostgresException>(() =>
            test.WithCanvas(author.Token, op => op.Confirm(current.PlanId, test.Token)));
        Assert.Equal("test_receipt_failure", fault.ConstraintName);
        Assert.Equal(host, await test.Read(author.Token, host.Id));
        Assert.Equal(1L, await test.Scalar("select revision from public.authoring_canvas where id=$1", canvas.CanvasId));
        Assert.Equal(0L, await test.Scalar("select count(*) from public.article_command where command_id=$1", current.PlanId));
        Assert.Equal(0L, await test.Scalar("select count(*) from public.blog_outbox where article_id=$1 and revision>1", host.Id));

        await test.Mutate("alter table public.canvas_link_plan drop constraint test_receipt_failure");
        var retry = await test.WithCanvas(author.Token, op => op.Confirm(current.PlanId, test.Token));
        Assert.Equal(2L, retry.ArticleRevision);
        await test.Mutate("update public.blog_user set generation=generation+1 where id=$1", author.User.Id);
        await Denied(Rejection.Unauthorized, test.WithCanvas(author.Token, op => op.Confirm(current.PlanId, test.Token)));
    }

    private static async Task Denied<T>(Rejection rejection, Task<T> command) =>
        Assert.Equal(rejection, (await Assert.ThrowsAsync<BusinessException>(() => command)).Rejection);

    private sealed class Fixture(ScratchDatabase database, CancellationTokenSource deadline) : IAsyncDisposable
    {
        private readonly Store _store = new(database.DataSource);
        internal CancellationToken Token => deadline.Token;
        internal string ConnectionString => database.ConnectionString;

        internal static async Task<Fixture> Open()
        {
            var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
            try
            {
                return new(await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, deadline.Token), deadline);
            }
            catch { deadline.Dispose(); throw; }
        }

        internal async Task<(string Token, Identity User)> Author(string name, bool author = true)
        {
            var id = Guid.NewGuid();
            await Mutate("insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)", id, name, author);
            return await SignIn(id);
        }

        internal async Task<(string Token, Identity User)> SignIn(Guid id)
        {
            var secret = RandomNumberGenerator.GetBytes(32);
            await Mutate("insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '2 minutes')",
                SHA256.HashData(secret), id);
            return await _store.SignIn(Convert.ToHexStringLower(secret), Token);
        }

        internal Task<T> WithGraph<T>(string token, Func<CanvasGraphStore, Task<T>> operation) =>
            _store.WithSession(token, true, (db, tx, actor) => operation(new(db, tx, actor)), Token);

        internal Task<T> WithCanvas<T>(string token, Func<CanvasStore, Task<T>> operation) =>
            _store.WithSession(token, true, (db, tx, actor) => operation(new(db, tx, actor, Store.TokenDigest(token)!)), Token);

        internal Task<ArticleState> Read(string token, int id) =>
            _store.WithSession(token, true, (db, tx, actor) => Store.Find(db, tx, actor, id, false, Token), Token);

        internal Task<ArticleState> Save(string token, string title, string body, int id = 0, long revision = 0) =>
            Command(token, ArticleAction.Save, new(id, revision, Guid.NewGuid(), title, body));

        internal Task<ArticleState> Publish(string token, ArticleState source) =>
            Command(token, ArticleAction.Publish, new(source.Id, source.Revision, Guid.NewGuid(), "", ""));

        private async Task<ArticleState> Command(string token, ArticleAction action, Edit edit)
        {
            edit = Publishing.Validate(action, edit);
            return (await _store.WithSession(token, true, (db, tx, actor) => Store.Execute(db, tx, actor, action, edit, Token), Token)).Article;
        }

        internal async Task Mutate(string sql, params object[] args) => await Scalar(sql, args);
        internal async Task<object?> Scalar(string sql, params object[] args)
        {
            await using var db = await database.DataSource.OpenConnectionAsync(Token);
            await using var command = Store.Sql(db, null, sql, args);
            return await command.ExecuteScalarAsync(Token);
        }

        public async ValueTask DisposeAsync()
        {
            try { await database.DisposeAsync(); }
            finally { deadline.Dispose(); }
        }
    }
}
