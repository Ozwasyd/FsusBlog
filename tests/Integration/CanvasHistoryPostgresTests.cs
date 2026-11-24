using static FsusBlog.V2.Integration.Tests.CanvasFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class CanvasHistoryPostgresTests
{
    [PostgresFact]
    public async Task RestoresNodeEdgesAndViewportWithOneRevisionAndReplaysExactReceipt()
    {
        await using var test = await Fixture.Open();
        var article = await test.SaveArticle("Source", "Exactly the same body.");
        var document = Guid.NewGuid();
        var articleNode = Guid.NewGuid();
        var note = Guid.NewGuid();
        var frame = Guid.NewGuid();
        var edge = Guid.NewGuid();
        var originalViewport = new CanvasViewport(-70, 100, 1750);
        var initial = await test.Write(new(document, Guid.NewGuid(), 0, CanvasGraphAction.Create, "Original", originalViewport,
        [
            PutNode(articleNode, 0, article: article.Id),
            PutNode(note, 3, text: "Private sketch 🐈"),
            PutNode(frame, 4, text: "Frame", members: [articleNode, note]),
            new CanvasChangeFrame.PutEdge(new(edge, 0, note, articleNode, 0, "Visual"))
        ]));
        Assert.Equal((1L, 3, 1), (initial.Revision, initial.NodeCount, initial.EdgeCount));
        long articleRows = await test.Count("public.article_revision");
        long outboxRows = await test.Count("public.blog_outbox");

        var editViewport = new CanvasViewport(0, -25, 800);
        var edited = await test.Write(Command(document, initial.Revision, CanvasGraphAction.Edit) with
        {
            Title = "After deletion", Viewport = editViewport, Changes = [new CanvasChangeFrame.DropNode(note)]
        });
        Assert.Equal((2L, 2, 0), (edited.Revision, edited.NodeCount, edited.EdgeCount));
        Assert.Equal(new[] { articleNode }, Assert.IsType<Guid[]>(await test.Scalar(
            "select member_ids from public.canvas_node where canvas_id=$1 and id=$2", document, frame)));

        var undo = Command(document, edited.Revision, CanvasGraphAction.Undo);
        var results = await Task.WhenAll(test.Write(undo), test.Write(undo));
        var restored = results[0];
        Assert.Equal(restored, results[1]);
        Assert.Equal((3L, "Original", originalViewport, 3, 1),
            (restored.Revision, restored.Title, restored.Viewport, restored.NodeCount, restored.EdgeCount));
        Assert.Equal("Private sketch 🐈", await test.Scalar("select note from public.canvas_node where canvas_id=$1 and id=$2", document, note));
        Assert.Equal(new[] { articleNode, note }, Assert.IsType<Guid[]>(await test.Scalar(
            "select member_ids from public.canvas_node where canvas_id=$1 and id=$2", document, frame)));
        Assert.Equal(note, await test.Scalar("select source_node_id from public.canvas_edge where canvas_id=$1 and id=$2", document, edge));

        var redo = Command(document, restored.Revision, CanvasGraphAction.Redo);
        var redone = await test.Write(redo);
        Assert.Equal((4L, "After deletion", editViewport, 2, 0),
            (redone.Revision, redone.Title, redone.Viewport, redone.NodeCount, redone.EdgeCount));
        Assert.Equal(restored, await test.Write(undo));
        await Denied(Rejection.Conflict, test.Write(undo with { ExpectedRevision = redone.Revision }));
        Assert.Equal(redone, await test.Write(redo));
        Assert.Equal(4L, await test.Scalar("select count(*) from public.canvas_document_event where canvas_id=$1", document));
        Assert.Equal(2L, await test.Scalar("select target_revision from public.canvas_history_transition where canvas_id=$1 and revision=$2", document, redone.Revision));
        Assert.Equal(articleRows, await test.Count("public.article_revision"));
        Assert.Equal(outboxRows, await test.Count("public.blog_outbox"));
        Assert.Equal(article, await test.ReadArticle(article.Id));
    }

    [PostgresFact]
    public async Task InvalidEditTitlePrecedesUnavailableReferenceWithoutAdvancingHistory()
    {
        await using var test = await Fixture.Open();
        var article = await test.SaveArticle("Temporary reference", "Synthetic source.");
        var document = Guid.NewGuid();
        var note = Guid.NewGuid();
        var initial = await test.Write(Command(document, 0, CanvasGraphAction.Create) with
        {
            Title = "Unchanged", Changes = [PutNode(note, 3, text: "Original note")]
        });
        Assert.True((await test.DeleteArticle(article)).Deleted);
        var edit = Command(document, initial.Revision, CanvasGraphAction.Edit) with
        {
            Title = "<invalid>", Changes = [PutNode(Guid.NewGuid(), 0, article: article.Id)]
        };
        var error = await Assert.ThrowsAsync<BusinessException>(() => test.Write(edit));
        Assert.Equal(Rejection.Invalid, error.Rejection);
        Assert.Equal("Enter a valid Canvas title.", error.Message);
        await Denied(Rejection.NotFound, test.Write(edit with { Title = "Valid title" }));
        Assert.Equal(initial.Revision, await test.Scalar(
            "select revision from public.authoring_canvas where id=$1", document));
        Assert.Equal(initial.Title, await test.Scalar(
            "select title from public.authoring_canvas where id=$1", document));
        Assert.Equal("Original note", await test.Scalar(
            "select note from public.canvas_node where canvas_id=$1 and id=$2", document, note));
        Assert.Equal(1L, await test.Scalar("select count(*) from public.canvas_node where canvas_id=$1", document));
        Assert.Equal(1L, await test.Scalar("select count(*) from public.canvas_document_event where canvas_id=$1", document));
        Assert.Equal(0L, await test.Scalar("select count(*) from public.canvas_history_patch where canvas_id=$1", document));
        Assert.Equal(0L, await test.Scalar("select count(*) from public.canvas_history_transition where canvas_id=$1", document));
    }

    [PostgresFact]
    public async Task MetadataOnlyHistoryPreservesEveryGraphRowAndRejectsNoOp()
    {
        await using var test = await Fixture.Open();
        var document = Guid.NewGuid();
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        var originalViewport = new CanvasViewport(-70, 100, 1750);
        var initial = await test.Write(Command(document, 0, CanvasGraphAction.Create) with
        {
            Title = "Original", Viewport = originalViewport,
            Changes = [PutNode(first, 3, text: "First 🐈"), PutNode(second, 3, text: "Second"),
                new CanvasChangeFrame.PutEdge(new(Guid.NewGuid(), 0, first, second, 0, "Visual"))]
        });
        var nodes = Assert.IsType<string>(await Snapshot("canvas_node"));
        var edges = Assert.IsType<string>(await Snapshot("canvas_edge"));
        var edit = Command(document, initial.Revision, CanvasGraphAction.Edit) with
        {
            Title = "Metadata only", Viewport = new(50, -25, 800)
        };
        var edited = await test.Write(edit);
        await AssertState(edited, 2, edit.Title, edit.Viewport!.Value, false);
        var undo = Command(document, edited.Revision, CanvasGraphAction.Undo);
        var restored = await test.Write(undo);
        await AssertState(restored, 3, initial.Title, originalViewport, true);
        var redo = Command(document, restored.Revision, CanvasGraphAction.Redo);
        var redone = await test.Write(redo);
        await AssertState(redone, 4, edited.Title, edited.Viewport, false);
        Assert.Equal(edited, await test.Write(edit));
        Assert.Equal(restored, await test.Write(undo));
        Assert.Equal(redone, await test.Write(redo));
        var error = await Assert.ThrowsAsync<BusinessException>(() => test.Write(
            Command(document, redone.Revision, CanvasGraphAction.Edit) with
            { Title = redone.Title, Viewport = redone.Viewport }));
        Assert.Equal(Rejection.Invalid, error.Rejection);
        Assert.Equal("Choose a Canvas change.", error.Message);
        await AssertState(redone, 4, edited.Title, edited.Viewport, false);
        Assert.Equal(3L, await test.Scalar(
            "select count(*) from public.canvas_history_transition where canvas_id=$1", document));
        Assert.Equal(1L, await test.Scalar(
            "select count(*) from public.canvas_history_patch where canvas_id=$1", document));

        async Task<object?> Snapshot(string table) => await test.Scalar(
            $"select jsonb_agg(to_jsonb(t) order by id)::text from public.{table} t where canvas_id=$1", document);

        async Task AssertState(CanvasGraphReceipt receipt, long revision, string title, CanvasViewport viewport, bool undone)
        {
            Assert.Equal((revision, title, viewport, 2, 1),
                (receipt.Revision, receipt.Title, receipt.Viewport, receipt.NodeCount, receipt.EdgeCount));
            Assert.Equal(nodes, await Snapshot("canvas_node"));
            Assert.Equal(edges, await Snapshot("canvas_edge"));
            Assert.Equal(revision, await test.Scalar(
                "select revision from public.authoring_canvas where id=$1", document));
            Assert.Equal(revision, await test.Scalar(
                "select count(*) from public.canvas_document_event where canvas_id=$1", document));
            Assert.Equal(undone, await test.Scalar(
                "select undone from public.canvas_history_patch where canvas_id=$1 and edit_revision=2", document));
            Assert.Equal(revision, await test.Scalar(
                "select moved_at_revision from public.canvas_history_patch where canvas_id=$1 and edit_revision=2", document));
        }
    }

    [PostgresFact]
    public async Task NewBranchDiscardsRedoAndOneConcurrentCommandOwnsTheNextRevision()
    {
        await using var test = await Fixture.Open();
        var document = Guid.NewGuid();
        var start = await test.Write(Command(document, 0, CanvasGraphAction.Create) with { Title = "Start" });
        var first = await test.Write(Command(document, start.Revision, CanvasGraphAction.Edit) with { Title = "First" });
        var second = await test.Write(Command(document, first.Revision, CanvasGraphAction.Edit) with { Title = "Second" });
        var undo = Command(document, second.Revision, CanvasGraphAction.Undo);
        var unrolled = await test.Write(undo);
        Assert.Equal("First", unrolled.Title);
        var branch = await test.Write(Command(document, unrolled.Revision, CanvasGraphAction.Edit) with { Title = "Branch" });
        Assert.Equal(new[] { second.Revision }, Assert.IsType<long[]>(await test.Scalar(
            "select discarded_redo from public.canvas_history_transition where canvas_id=$1 and revision=$2", document, branch.Revision)));
        Assert.Equal(0L, await test.Scalar("select count(*) from public.canvas_history_patch where canvas_id=$1 and edit_revision=$2", document, second.Revision));
        await Denied(Rejection.Conflict, test.Write(Command(document, branch.Revision, CanvasGraphAction.Redo)));

        var commandA = Command(document, branch.Revision, CanvasGraphAction.Undo);
        var commandB = Command(document, branch.Revision, CanvasGraphAction.Undo);
        var outcomes = await Task.WhenAll(Attempt(commandA, null), Attempt(commandB, null));
        var winner = Assert.Single(outcomes, receipt => receipt is not null)!;
        Assert.Equal((branch.Revision + 1, "First"), (winner.Revision, winner.Title));
        Assert.Single(outcomes, receipt => receipt is null);
        Assert.Equal(winner.Revision, await test.Scalar("select revision from public.authoring_canvas where id=$1", document));
        Assert.Equal(winner.Revision, await test.Scalar("select count(*) from public.canvas_document_event where canvas_id=$1", document));
        Assert.Equal(unrolled, await test.Write(undo));

        async Task<CanvasGraphReceipt?> Attempt(CanvasGraphCommand command, string? session)
        {
            try { return await test.Write(command, session); }
            catch (BusinessException error) when (error.Rejection == Rejection.Conflict) { return null; }
        }
    }

    [PostgresFact]
    public async Task TamperedSealAndDatabaseFaultCannotCommitPartialHistory()
    {
        await using var test = await Fixture.Open();
        var document = Guid.NewGuid();
        var node = Guid.NewGuid();
        var start = await test.Write(Command(document, 0, CanvasGraphAction.Create) with
        {
            Title = "Start", Changes = [PutNode(node, 3, text: "original note")]
        });
        var changed = await test.Write(Command(document, start.Revision, CanvasGraphAction.Edit) with
        {
            Title = "Edited", Changes = [new CanvasChangeFrame.DropNode(node)]
        });
        var undo = Command(document, changed.Revision, CanvasGraphAction.Undo);
        var good = Assert.IsType<byte[]>(await test.Scalar(
            "select payload from public.canvas_history_patch where canvas_id=$1 and edit_revision=$2", document, changed.Revision));
        await test.Scalar("""
            update public.canvas_history_patch set payload=set_byte(payload,0,(get_byte(payload,0)+1)%256)
            where canvas_id=$1 and edit_revision=$2
            """, document, changed.Revision);
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => test.Write(undo));
        Assert.Contains("seal", error.Message, StringComparison.OrdinalIgnoreCase);
        await AssertUnchanged();
        await test.Scalar("update public.canvas_history_patch set payload=$3 where canvas_id=$1 and edit_revision=$2",
            document, changed.Revision, good);

        await test.Scalar("alter table public.canvas_history_transition add constraint reject_undo check(target_revision is null)");
        var fault = await Assert.ThrowsAsync<Npgsql.PostgresException>(() => test.Write(undo));
        Assert.Equal("reject_undo", fault.ConstraintName);
        await AssertUnchanged();
        await test.Scalar("alter table public.canvas_history_transition drop constraint reject_undo");
        var recovered = await test.Write(undo);
        Assert.Equal((changed.Revision + 1, "Start", 1), (recovered.Revision, recovered.Title, recovered.NodeCount));
        Assert.Equal("original note", await test.Scalar("select note from public.canvas_node where canvas_id=$1 and id=$2", document, node));

        async Task AssertUnchanged()
        {
            Assert.Equal(changed.Revision, await test.Scalar("select revision from public.authoring_canvas where id=$1", document));
            Assert.Equal(changed.Title, await test.Scalar("select title from public.authoring_canvas where id=$1", document));
            Assert.Equal(0L, await test.Scalar("select count(*) from public.canvas_node where canvas_id=$1", document));
            Assert.Equal(0L, await test.Scalar("select count(*) from public.canvas_document_event where canvas_id=$1 and command_id=$2", document, undo.CommandId));
            Assert.Equal(false, await test.Scalar("select undone from public.canvas_history_patch where canvas_id=$1 and edit_revision=$2", document, changed.Revision));
        }
    }

    [PostgresFact]
    public async Task CannotRestoreReferenceAfterItsArticleIsDeleted()
    {
        await using var test = await Fixture.Open();
        var article = await test.SaveArticle("Article", "Article source.");
        var document = Guid.NewGuid();
        var node = Guid.NewGuid();
        var created = await test.Write(Command(document, 0, CanvasGraphAction.Create) with
        {
            Title = "Reference", Changes = [PutNode(node, 0, article: article.Id)]
        });
        var removed = await test.Write(Command(document, created.Revision, CanvasGraphAction.Edit) with
        {
            Changes = [new CanvasChangeFrame.DropNode(node)]
        });
        var deleted = await test.DeleteArticle(article);
        Assert.True(deleted.Deleted);
        long articleRows = await test.Count("public.article_revision");
        long outboxRows = await test.Count("public.blog_outbox");
        await Denied(Rejection.NotFound, test.Write(Command(document, removed.Revision, CanvasGraphAction.Undo)));
        Assert.Equal(removed.Revision, await test.Scalar("select revision from public.authoring_canvas where id=$1", document));
        Assert.Equal(0L, await test.Scalar("select count(*) from public.canvas_node where canvas_id=$1", document));
        Assert.Equal(false, await test.Scalar("select undone from public.canvas_history_patch where canvas_id=$1 and edit_revision=$2", document, removed.Revision));
        Assert.Equal(articleRows, await test.Count("public.article_revision"));
        Assert.Equal(outboxRows, await test.Count("public.blog_outbox"));
    }

    [PostgresFact]
    public async Task RetainsOneHundredCompleteEditsAndAnOlderReceiptRemainsReplayable()
    {
        await using var test = await Fixture.Open();
        var document = Guid.NewGuid();
        var latest = await test.Write(Command(document, 0, CanvasGraphAction.Create) with { Title = "Start" });
        var oldest = Command(document, latest.Revision, CanvasGraphAction.Edit) with { Title = "Edit 0" };
        var original = latest = await test.Write(oldest);
        for (int n = 1; n <= 100; n++)
            latest = await test.Write(Command(document, latest.Revision, CanvasGraphAction.Edit) with { Title = $"Edit {n}" });

        Assert.Equal(100L, await test.Scalar("select count(*) from public.canvas_history_patch where canvas_id=$1", document));
        Assert.Equal(3L, await test.Scalar("select min(edit_revision) from public.canvas_history_patch where canvas_id=$1", document));
        Assert.Equal(original, await test.Write(oldest));
        for (int n = 99; n >= 0; n--)
        {
            latest = await test.Write(Command(document, latest.Revision, CanvasGraphAction.Undo));
            Assert.Equal($"Edit {n}", latest.Title);
        }
        await Denied(Rejection.Conflict, test.Write(Command(document, latest.Revision, CanvasGraphAction.Undo)));
        Assert.Equal(100L, await test.Scalar("select count(*) from public.canvas_history_patch where canvas_id=$1 and undone", document));
        var next = await test.Write(Command(document, latest.Revision, CanvasGraphAction.Redo));
        Assert.Equal("Edit 1", next.Title);
    }

    private static CanvasGraphCommand Command(Guid document, long revision, CanvasGraphAction action) =>
        new(document, Guid.NewGuid(), revision, action, "", null, []);

    private static CanvasChangeFrame PutNode(Guid id, int kind, string? text = null, int? article = null, Guid[]? members = null) =>
        new CanvasChangeFrame.PutNode(new(id, kind, 0, 0, 12_000, 8_000, article, Text: text, MemberIds: members));

    private sealed class Fixture(CanvasFixture fixture, Guid ownerId, string ownerToken) : IAsyncDisposable
    {
        internal static async Task<Fixture> Open()
        {
            var fixture = await CanvasFixture.Open();
            try
            {
                var (token, owner) = await fixture.Author("Canvas history owner");
                return new(fixture, owner.Id, token);
            }
            catch { await fixture.DisposeAsync(); throw; }
        }

        internal async Task<string> Session() => (await fixture.SignIn(ownerId)).Token;

        internal Task<CanvasGraphReceipt> Write(CanvasGraphCommand command, string? session = null)
        {
            byte[] fingerprint = SHA256.HashData(Wire.EncodeCanvasGraphCommand(command));
            return fixture.WithGraph(session ?? ownerToken, graph => graph.Write(command, fingerprint, fixture.Token));
        }

        internal Task<ArticleState> SaveArticle(string title, string body) => fixture.Save(ownerToken, title, body);

        internal Task<ArticleState> DeleteArticle(ArticleState article) =>
            fixture.Command(ownerToken, ArticleAction.Delete, new(article.Id, article.Revision, Guid.NewGuid(), "", ""));

        internal Task<ArticleState> ReadArticle(int id) => fixture.Read(ownerToken, id);

        internal async Task<long> Count(string table) => Assert.IsType<long>(await Scalar($"select count(*) from {table}"));

        internal Task<object?> Scalar(string sql, params object[] args) => fixture.Scalar(sql, args);

        public ValueTask DisposeAsync() => fixture.DisposeAsync();
    }
}
