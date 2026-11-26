using static FsusBlog.V2.Integration.Tests.CanvasFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class CanvasHistoryPostgresTests
{
    [PostgresFact]
    public async Task RestoresNodeEdgesAndViewportWithOneRevisionAndReplaysExactReceipt()
    {
        await using var test = await OpenOwner();
        var article = await test.Save("Source", "Exactly the same body.");
        var (document, articleNode, note, frame, edge) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var originalViewport = new CanvasViewport(-70, 100, 1750);
        var initial = await test.Write(CreateGraph(document, "Original", originalViewport,
        [
            PutNode(articleNode, 0, article: article.Id), PutNode(note, 3, text: "Private sketch 🐈"),
            PutNode(frame, 4, text: "Frame", members: [articleNode, note]),
            new CanvasChangeFrame.PutEdge(new(edge, 0, note, articleNode, 0, "Visual"))
        ]));
        Assert.Equal((1L, 3, 1), (initial.Revision, initial.NodeCount, initial.EdgeCount));
        var (articleRows, outboxRows) = (await test.Base.TableCount("public.article_revision"), await test.Base.TableCount("public.blog_outbox"));

        var editViewport = new CanvasViewport(0, -25, 800);
        var edited = await test.Write(GraphCommand(document, initial.Revision, CanvasGraphAction.Edit,
            "After deletion", editViewport, [new CanvasChangeFrame.DropNode(note)]));
        Assert.Equal((2L, 2, 0), (edited.Revision, edited.NodeCount, edited.EdgeCount));
        Assert.Equal(new[] { articleNode }, Assert.IsType<Guid[]>(await test.Scalar(
            "select member_ids from public.canvas_node where canvas_id=$1 and id=$2", document, frame)));

        var undo = GraphCommand(document, edited.Revision, CanvasGraphAction.Undo);
        var results = await Task.WhenAll(test.Write(undo), test.Write(undo));
        var restored = results[0];
        Assert.Equal(restored, results[1]);
        Assert.Equal((3L, "Original", originalViewport, 3, 1),
            (restored.Revision, restored.Title, restored.Viewport, restored.NodeCount, restored.EdgeCount));
        Assert.Equal("Private sketch 🐈", await test.Scalar("select note from public.canvas_node where canvas_id=$1 and id=$2", document, note));
        Assert.Equal(new[] { articleNode, note }, Assert.IsType<Guid[]>(await test.Scalar(
            "select member_ids from public.canvas_node where canvas_id=$1 and id=$2", document, frame)));
        Assert.Equal(note, await test.Scalar("select source_node_id from public.canvas_edge where canvas_id=$1 and id=$2", document, edge));

        var redo = GraphCommand(document, restored.Revision, CanvasGraphAction.Redo);
        var redone = await test.Write(redo);
        Assert.Equal((4L, "After deletion", editViewport, 2, 0),
            (redone.Revision, redone.Title, redone.Viewport, redone.NodeCount, redone.EdgeCount));
        Assert.Equal(restored, await test.Write(undo));
        await Denied(Rejection.Conflict, test.Write(undo with { ExpectedRevision = redone.Revision }));
        Assert.Equal(redone, await test.Write(redo));
        Assert.Equal((4L, 2L, articleRows, outboxRows), (await test.Base.CanvasCount("canvas_document_event", document),
            await test.Scalar("select target_revision from public.canvas_history_transition where canvas_id=$1 and revision=$2", document, redone.Revision),
            await test.Base.TableCount("public.article_revision"), await test.Base.TableCount("public.blog_outbox")));
        Assert.Equal(article, await test.Base.Read(test.Token, article.Id));
    }

    [PostgresFact]
    public async Task InvalidEditTitlePrecedesUnavailableReferenceWithoutAdvancingHistory()
    {
        await using var test = await OpenOwner();
        var article = await test.Save("Temporary reference", "Synthetic source.");
        var (document, note) = (Guid.NewGuid(), Guid.NewGuid());
        var initial = await test.Write(CreateGraph(document, "Unchanged", changes: [PutNode(note, 3, text: "Original note")]));
        Assert.True((await test.Base.Command(test.Token, ArticleAction.Delete, new(article.Id, article.Revision, Guid.NewGuid(), "", ""))).Deleted);
        var edit = GraphCommand(document, initial.Revision, CanvasGraphAction.Edit,
            "<invalid>", changes: [PutNode(Guid.NewGuid(), 0, article: article.Id)]);
        var error = await Assert.ThrowsAsync<BusinessException>(() => test.Write(edit));
        Assert.Equal((Rejection.Invalid, "Enter a valid Canvas title."), (error.Rejection, error.Message));
        await Denied(Rejection.NotFound, test.Write(edit with { Title = "Valid title" }));
        Assert.Equal((initial.Revision, initial.Title, "Original note", 1L, 1L, 0L, 0L),
            (await test.Scalar("select revision from public.authoring_canvas where id=$1", document),
                await test.Scalar("select title from public.authoring_canvas where id=$1", document),
                await test.Scalar("select note from public.canvas_node where canvas_id=$1 and id=$2", document, note),
                await test.Base.CanvasCount("canvas_node", document), await test.Base.CanvasCount("canvas_document_event", document),
                await test.Base.CanvasCount("canvas_history_patch", document), await test.Base.CanvasCount("canvas_history_transition", document)));
    }

    [PostgresFact]
    public async Task MetadataOnlyHistoryPreservesEveryGraphRowAndRejectsNoOp()
    {
        await using var test = await OpenOwner();
        var (document, first, second) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var originalViewport = new CanvasViewport(-70, 100, 1750);
        var initial = await test.Write(CreateGraph(document, "Original", originalViewport,
        [
            PutNode(first, 3, text: "First 🐈"), PutNode(second, 3, text: "Second"),
            new CanvasChangeFrame.PutEdge(new(Guid.NewGuid(), 0, first, second, 0, "Visual"))
        ]));
        var nodes = Assert.IsType<string>(await Snapshot("canvas_node"));
        var edges = Assert.IsType<string>(await Snapshot("canvas_edge"));
        var edit = GraphCommand(document, initial.Revision, CanvasGraphAction.Edit, "Metadata only", new(50, -25, 800));
        var edited = await test.Write(edit);
        await AssertState(edited, 2, edit.Title, edit.Viewport!.Value, false);
        var undo = GraphCommand(document, edited.Revision, CanvasGraphAction.Undo);
        var restored = await test.Write(undo);
        await AssertState(restored, 3, initial.Title, originalViewport, true);
        var redo = GraphCommand(document, restored.Revision, CanvasGraphAction.Redo);
        var redone = await test.Write(redo);
        await AssertState(redone, 4, edited.Title, edited.Viewport, false);
        Assert.Equal((edited, restored, redone), (await test.Write(edit), await test.Write(undo), await test.Write(redo)));
        var error = await Assert.ThrowsAsync<BusinessException>(() => test.Write(
            GraphCommand(document, redone.Revision, CanvasGraphAction.Edit, redone.Title, redone.Viewport)));
        Assert.Equal((Rejection.Invalid, "Choose a Canvas change."), (error.Rejection, error.Message));
        await AssertState(redone, 4, edited.Title, edited.Viewport, false);
        Assert.Equal((3L, 1L), (await test.Base.CanvasCount("canvas_history_transition", document), await test.Base.CanvasCount("canvas_history_patch", document)));

        async Task<object?> Snapshot(string table) => await test.Scalar(
            $"select jsonb_agg(to_jsonb(t) order by id)::text from public.{table} t where canvas_id=$1", document);

        async Task AssertState(CanvasGraphReceipt receipt, long revision, string title, CanvasViewport viewport, bool undone)
        {
            Assert.Equal((revision, title, viewport, 2, 1),
                (receipt.Revision, receipt.Title, receipt.Viewport, receipt.NodeCount, receipt.EdgeCount));
            Assert.Equal((nodes, edges, revision, revision, undone, revision), (await Snapshot("canvas_node"), await Snapshot("canvas_edge"),
                await test.Scalar("select revision from public.authoring_canvas where id=$1", document),
                await test.Base.CanvasCount("canvas_document_event", document),
                await test.Scalar("select undone from public.canvas_history_patch where canvas_id=$1 and edit_revision=2", document),
                await test.Scalar("select moved_at_revision from public.canvas_history_patch where canvas_id=$1 and edit_revision=2", document)));
        }
    }

    [PostgresFact]
    public async Task NewBranchDiscardsRedoAndOneConcurrentCommandOwnsTheNextRevision()
    {
        await using var test = await OpenOwner();
        var document = Guid.NewGuid();
        var start = await test.Write(CreateGraph(document, "Start"));
        var first = await test.Write(GraphCommand(document, start.Revision, CanvasGraphAction.Edit, "First"));
        var second = await test.Write(GraphCommand(document, first.Revision, CanvasGraphAction.Edit, "Second"));
        var undo = GraphCommand(document, second.Revision, CanvasGraphAction.Undo);
        var unrolled = await test.Write(undo);
        Assert.Equal("First", unrolled.Title);
        var branch = await test.Write(GraphCommand(document, unrolled.Revision, CanvasGraphAction.Edit, "Branch"));
        Assert.Equal(new[] { second.Revision }, Assert.IsType<long[]>(await test.Scalar(
            "select discarded_redo from public.canvas_history_transition where canvas_id=$1 and revision=$2", document, branch.Revision)));
        Assert.Equal(0L, await test.Scalar("select count(*) from public.canvas_history_patch where canvas_id=$1 and edit_revision=$2", document, second.Revision));
        await Denied(Rejection.Conflict, test.Write(GraphCommand(document, branch.Revision, CanvasGraphAction.Redo)));

        var outcomes = await Task.WhenAll(Attempt(GraphCommand(document, branch.Revision, CanvasGraphAction.Undo)),
            Attempt(GraphCommand(document, branch.Revision, CanvasGraphAction.Undo)));
        var winner = Assert.Single(outcomes, receipt => receipt is not null)!;
        Assert.Equal((branch.Revision + 1, "First"), (winner.Revision, winner.Title));
        Assert.Single(outcomes, receipt => receipt is null);
        Assert.Equal((winner.Revision, winner.Revision), (await test.Scalar("select revision from public.authoring_canvas where id=$1", document),
            await test.Base.CanvasCount("canvas_document_event", document)));
        Assert.Equal(unrolled, await test.Write(undo));

        async Task<CanvasGraphReceipt?> Attempt(CanvasGraphCommand command)
        {
            try { return await test.Write(command); }
            catch (BusinessException error) when (error.Rejection == Rejection.Conflict) { return null; }
        }
    }

    [PostgresFact]
    public async Task TamperedSealAndDatabaseFaultCannotCommitPartialHistory()
    {
        await using var test = await OpenOwner();
        var (document, node) = (Guid.NewGuid(), Guid.NewGuid());
        var start = await test.Write(CreateGraph(document, "Start", changes: [PutNode(node, 3, text: "original note")]));
        var changed = await test.Write(GraphCommand(document, start.Revision, CanvasGraphAction.Edit,
            "Edited", changes: [new CanvasChangeFrame.DropNode(node)]));
        var undo = GraphCommand(document, changed.Revision, CanvasGraphAction.Undo);
        var good = Assert.IsType<byte[]>(await test.Scalar(
            "select payload from public.canvas_history_patch where canvas_id=$1 and edit_revision=$2", document, changed.Revision));
        await test.Scalar("""
            update public.canvas_history_patch set payload=set_byte(payload,0,(get_byte(payload,0)+1)%256)
            where canvas_id=$1 and edit_revision=$2
            """, document, changed.Revision);
        Assert.Contains("seal", (await Assert.ThrowsAsync<InvalidOperationException>(() => test.Write(undo))).Message, StringComparison.OrdinalIgnoreCase);
        await AssertUnchanged();
        await test.Scalar("update public.canvas_history_patch set payload=$3 where canvas_id=$1 and edit_revision=$2", document, changed.Revision, good);

        await test.Scalar("alter table public.canvas_history_transition add constraint reject_undo check(target_revision is null)");
        Assert.Equal("reject_undo", (await Assert.ThrowsAsync<Npgsql.PostgresException>(() => test.Write(undo))).ConstraintName);
        await AssertUnchanged();
        await test.Scalar("alter table public.canvas_history_transition drop constraint reject_undo");
        var recovered = await test.Write(undo);
        Assert.Equal((changed.Revision + 1, "Start", 1), (recovered.Revision, recovered.Title, recovered.NodeCount));
        Assert.Equal("original note", await test.Scalar("select note from public.canvas_node where canvas_id=$1 and id=$2", document, node));

        async Task AssertUnchanged() => Assert.Equal((changed.Revision, changed.Title, 0L, 0L, false),
            (await test.Scalar("select revision from public.authoring_canvas where id=$1", document),
                await test.Scalar("select title from public.authoring_canvas where id=$1", document),
                await test.Base.CanvasCount("canvas_node", document),
                await test.Scalar("select count(*) from public.canvas_document_event where canvas_id=$1 and command_id=$2", document, undo.CommandId),
                await test.Scalar("select undone from public.canvas_history_patch where canvas_id=$1 and edit_revision=$2", document, changed.Revision)));
    }

    [PostgresFact]
    public async Task CannotRestoreReferenceAfterItsArticleIsDeleted()
    {
        await using var test = await OpenOwner();
        var article = await test.Save("Article", "Article source.");
        var (document, node) = (Guid.NewGuid(), Guid.NewGuid());
        var created = await test.Write(CreateGraph(document, "Reference", changes: [PutNode(node, 0, article: article.Id)]));
        var removed = await test.Write(GraphCommand(document, created.Revision, CanvasGraphAction.Edit,
            changes: [new CanvasChangeFrame.DropNode(node)]));
        Assert.True((await test.Base.Command(test.Token, ArticleAction.Delete, new(article.Id, article.Revision, Guid.NewGuid(), "", ""))).Deleted);
        var (articleRows, outboxRows) = (await test.Base.TableCount("public.article_revision"), await test.Base.TableCount("public.blog_outbox"));
        await Denied(Rejection.NotFound, test.Write(GraphCommand(document, removed.Revision, CanvasGraphAction.Undo)));
        Assert.Equal((removed.Revision, 0L, false, articleRows, outboxRows),
            (await test.Scalar("select revision from public.authoring_canvas where id=$1", document),
                await test.Base.CanvasCount("canvas_node", document),
                await test.Scalar("select undone from public.canvas_history_patch where canvas_id=$1 and edit_revision=$2", document, removed.Revision),
                await test.Base.TableCount("public.article_revision"), await test.Base.TableCount("public.blog_outbox")));
    }

    [PostgresFact]
    public async Task RetainsOneHundredCompleteEditsAndAnOlderReceiptRemainsReplayable()
    {
        await using var test = await OpenOwner();
        var document = Guid.NewGuid();
        var latest = await test.Write(CreateGraph(document, "Start"));
        var oldest = GraphCommand(document, latest.Revision, CanvasGraphAction.Edit, "Edit 0");
        var original = latest = await test.Write(oldest);
        for (int n = 1; n <= 100; n++)
            latest = await test.Write(GraphCommand(document, latest.Revision, CanvasGraphAction.Edit, $"Edit {n}"));

        Assert.Equal((100L, 3L), (await test.Base.CanvasCount("canvas_history_patch", document),
            await test.Scalar("select min(edit_revision) from public.canvas_history_patch where canvas_id=$1", document)));
        Assert.Equal(original, await test.Write(oldest));
        for (int n = 99; n >= 0; n--)
        {
            latest = await test.Write(GraphCommand(document, latest.Revision, CanvasGraphAction.Undo));
            Assert.Equal($"Edit {n}", latest.Title);
        }
        await Denied(Rejection.Conflict, test.Write(GraphCommand(document, latest.Revision, CanvasGraphAction.Undo)));
        Assert.Equal(100L, await test.Scalar("select count(*) from public.canvas_history_patch where canvas_id=$1 and undone", document));
        Assert.Equal("Edit 1", (await test.Write(GraphCommand(document, latest.Revision, CanvasGraphAction.Redo))).Title);
    }

    private static async Task<OwnerFixture> OpenOwner()
    {
        var fixture = await CanvasFixture.Open();
        try { return new(fixture, (await fixture.Author("Canvas history owner")).Token); }
        catch { await fixture.DisposeAsync(); throw; }
    }

    private sealed class OwnerFixture(CanvasFixture fixture, string token) : IAsyncDisposable
    {
        internal CanvasFixture Base => fixture;
        internal string Token => token;
        internal Task<CanvasGraphReceipt> Write(CanvasGraphCommand command) => fixture.WriteGraph(token, command);
        internal Task<ArticleState> Save(string title, string body) => fixture.Save(token, title, body);
        internal Task<object?> Scalar(string sql, params object[] args) => fixture.Scalar(sql, args);
        public ValueTask DisposeAsync() => fixture.DisposeAsync();
    }
}
