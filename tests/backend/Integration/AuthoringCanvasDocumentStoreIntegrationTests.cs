using FsusBlog.Shared.Contracts.AuthoringCanvas;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthoringCanvasDocumentStoreIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly AuthoringCanvasOwner s_owner = new(1, "primary-site");
    private static readonly AuthoringCanvasOwner s_otherOwner = new(2, "primary-site");
    private static readonly AuthoringCanvasGeometry s_geometry = new(10, 20, 240, 120);

    [Fact]
    public async Task Store_EnforcesClosedLifecycleCasIdempotencyPrivacyAndDeleteIsolation()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var store = new AuthoringCanvasDocumentStore(db, TimeProvider.System);
        Guid canvasId = Guid.CreateVersion7();
        Guid createRequest = Guid.CreateVersion7();
        var create = new CreateAuthoringCanvasCommand(
            canvasId,
            s_owner,
            "Research map",
            new AuthoringCanvasViewport(0, 0, 1),
            createRequest);

        AuthoringCanvasWriteReceipt created = await store.CreateAsync(create);
        AuthoringCanvasWriteReceipt replayed = await store.CreateAsync(create);

        Assert.Equal(1, created.Revision);
        Assert.True(replayed.IdempotentReplay);
        Assert.Equal(created.ReceiptId, replayed.ReceiptId);
        await Assert.ThrowsAsync<AuthoringCanvasIdempotencyConflictException>(() => store.CreateAsync(
            create with
            {
                Title = "Different command"
            }));
        Assert.Null(await store.GetAsync(s_otherOwner, canvasId));
        Assert.Null(await store.GetAsync(new AuthoringCanvasOwner(1, "other-site"), canvasId));

        Guid articleId = Guid.CreateVersion7();
        Guid headingId = Guid.CreateVersion7();
        Guid blockId = Guid.CreateVersion7();
        Guid noteId = Guid.CreateVersion7();
        Guid frameId = Guid.CreateVersion7();
        var articleNode = new AuthoringCanvasNode(
            articleId,
            AuthoringCanvasNodeType.ArticleReference,
            0,
            s_geometry,
            TargetArticleId: 9001,
            ReferenceState: AuthoringCanvasReferenceState.Current);
        var concurrentCommand = new PutAuthoringCanvasNodeCommand(
            canvasId,
            s_owner,
            created.Revision,
            Guid.CreateVersion7(),
            articleNode);
        using SqlSugarClient secondConnection = PostgresSqlSugarTestClient.Create(
            db.CurrentConnectionConfig.ConnectionString);
        var secondDeviceStore = new AuthoringCanvasDocumentStore(secondConnection, TimeProvider.System);
        AuthoringCanvasWriteReceipt[] concurrentReceipts = await Task.WhenAll(
            store.PutNodeAsync(concurrentCommand),
            secondDeviceStore.PutNodeAsync(concurrentCommand));
        Assert.Equal(concurrentReceipts[0].ReceiptId, concurrentReceipts[1].ReceiptId);
        Assert.Single(concurrentReceipts, static receipt => receipt.IdempotentReplay);

        AuthoringCanvasNode[] nodes =
        [
            new(headingId, AuthoringCanvasNodeType.HeadingReference, 1, s_geometry,
                TargetArticleId: 9001, TargetHeadingIdentity: "heading-a",
                ReferenceState: AuthoringCanvasReferenceState.Pinned, PinnedTargetRevision: 7),
            new(blockId, AuthoringCanvasNodeType.BlockReference, 2, s_geometry,
                TargetArticleId: 9001, TargetBlockIdentity: "block-a",
                ReferenceState: AuthoringCanvasReferenceState.Missing),
            new(noteId, AuthoringCanvasNodeType.PlainTextNote, 3, s_geometry,
                NoteSource: "Private plain-text note\nwith Markdown-lite emphasis."),
            new(frameId, AuthoringCanvasNodeType.GroupFrame, 4, new(0, 0, 800, 600),
                FrameLabel: "Evidence", Members: [headingId, blockId, noteId])
        ];
        long revision = concurrentReceipts[0].Revision;
        foreach (AuthoringCanvasNode node in nodes)
        {
            AuthoringCanvasWriteReceipt receipt = await store.PutNodeAsync(new PutAuthoringCanvasNodeCommand(
                canvasId,
                s_owner,
                revision,
                Guid.CreateVersion7(),
                node));
            revision = receipt.Revision;
        }

        AuthoringCanvasEdge[] edges =
        [
            new(Guid.CreateVersion7(), AuthoringCanvasEdgeType.VisualOnly, 0, articleId, noteId),
            new(Guid.CreateVersion7(), AuthoringCanvasEdgeType.ExplicitReferenceNote, 1,
                articleId, blockId, "compare")
        ];
        foreach (AuthoringCanvasEdge edge in edges)
        {
            AuthoringCanvasWriteReceipt receipt = await store.PutEdgeAsync(new PutAuthoringCanvasEdgeCommand(
                canvasId,
                s_owner,
                revision,
                Guid.CreateVersion7(),
                edge));
            revision = receipt.Revision;
        }

        await Assert.ThrowsAsync<AuthoringCanvasRevisionConflictException>(() => store.UpdateMetadataAsync(
            new UpdateAuthoringCanvasMetadataCommand(
                canvasId,
                s_owner,
                ExpectedRevision: 1,
                Guid.CreateVersion7(),
                "stale tab",
                new AuthoringCanvasViewport(0, 0, 1))));
        AuthoringCanvasPage<AuthoringCanvasNode> firstPage = await store.ReadNodesAsync(
            s_owner, canvasId, null, 2);
        AuthoringCanvasPage<AuthoringCanvasNode> secondPage = await store.ReadNodesAsync(
            s_owner, canvasId, firstPage.NextCursor, 2);
        Assert.Equal(2, firstPage.Items.Count);
        Assert.Equal(2, secondPage.Items.Count);
        Assert.NotNull(firstPage.NextCursor);
        Assert.DoesNotContain(
            (await store.ReadNodesAsync(s_owner, canvasId, null, 10)).Items,
            static node => node.NoteSource?.Contains("<", StringComparison.Ordinal) == true);

        await Assert.ThrowsAsync<AuthoringCanvasValidationException>(() => store.DeleteNodeAsync(
            new DeleteAuthoringCanvasNodeCommand(
                canvasId, s_owner, revision, Guid.CreateVersion7(), noteId)));
        AuthoringCanvasWriteReceipt deletedNode = await store.DeleteNodeAsync(
            new DeleteAuthoringCanvasNodeCommand(
                canvasId, s_owner, revision, Guid.CreateVersion7(), articleId));
        revision = deletedNode.Revision;
        Assert.Equal(4, deletedNode.NodeCount);
        Assert.Equal(0, deletedNode.EdgeCount);
        Assert.DoesNotContain(
            (await store.ReadEdgesAsync(s_owner, canvasId, null, 10)).Items,
            edge => edge.SourceNodeId == articleId || edge.TargetNodeId == articleId);

        AuthoringCanvasVerificationResult verified = await store.VerifyAsync(s_owner, canvasId);
        Assert.True(verified.Valid, string.Join(',', verified.Reasons));
        await db.Ado.ExecuteCommandAsync(
            "UPDATE authoring_canvas_node SET content_digest = @Digest WHERE canvas_id = @CanvasId AND node_id = @NodeId;",
            new SugarParameter("@Digest", new string('f', 64)),
            new SugarParameter("@CanvasId", canvasId),
            new SugarParameter("@NodeId", headingId));
        AuthoringCanvasVerificationResult tampered = await store.VerifyAsync(s_owner, canvasId);
        Assert.False(tampered.Valid);
        Assert.Contains(tampered.Reasons, reason => reason == $"node_digest_mismatch:{headingId:D}");

        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE external_canvas_delete_marker(id integer PRIMARY KEY, marker varchar(32) NOT NULL);
            INSERT INTO external_canvas_delete_marker(id, marker) VALUES (1, 'article'), (2, 'relation');
            """);
        await store.DeleteAsync(new DeleteAuthoringCanvasCommand(
            canvasId, s_owner, revision, Guid.CreateVersion7()));

        Assert.Null(await store.GetAsync(s_owner, canvasId));
        Assert.Equal(2, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM external_canvas_delete_marker;"));
        Assert.Equal(0, await db.Ado.GetIntAsync(
            "SELECT COUNT(*) FROM authoring_canvas_node WHERE canvas_id = @CanvasId;",
            new SugarParameter("@CanvasId", canvasId)));
        Assert.True(await db.Ado.GetIntAsync(
            "SELECT COUNT(*) FROM authoring_canvas_receipt WHERE canvas_id = @CanvasId;",
            new SugarParameter("@CanvasId", canvasId)) > 0);
    }

    [Fact]
    public async Task Store_PagesTenThousandNodesAndEdgesAndRejectsOverflow()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var store = new AuthoringCanvasDocumentStore(db, TimeProvider.System);
        Guid canvasId = Guid.CreateVersion7();
        AuthoringCanvasWriteReceipt created = await store.CreateAsync(new CreateAuthoringCanvasCommand(
            canvasId,
            s_owner,
            "Scale fixture",
            new AuthoringCanvasViewport(0, 0, 1),
            Guid.CreateVersion7()));
        Assert.Equal(0, await CountNodesAsync(store, canvasId));
        Assert.Equal(0, await CountEdgesAsync(store, canvasId));
        Guid firstNodeId = Guid.Parse("00000000-0000-0000-0000-000000000001");
        Guid secondNodeId = Guid.Parse("00000000-0000-0000-0000-000000000002");
        AuthoringCanvasWriteReceipt firstNode = await store.PutNodeAsync(new PutAuthoringCanvasNodeCommand(
            canvasId,
            s_owner,
            created.Revision,
            Guid.CreateVersion7(),
            new AuthoringCanvasNode(
                firstNodeId,
                AuthoringCanvasNodeType.PlainTextNote,
                0,
                s_geometry,
                NoteSource: "note-1")));
        Assert.Equal(1, await CountNodesAsync(store, canvasId));
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO authoring_canvas_node(
                canvas_id, node_id, node_type, node_order, position_x, position_y, width, height,
                note_source, content_digest)
            SELECT @CanvasId,
                   ('00000000-0000-0000-0000-' || lpad(value::text, 12, '0'))::uuid,
                   'plain-text-note', value - 1, value, value, 120, 80,
                   'note-' || value, @Digest
            FROM generate_series(2, 10000) AS value;

            UPDATE authoring_canvas_document
            SET node_count = 10000
            WHERE id = @CanvasId;
            """,
            new SugarParameter("@CanvasId", canvasId),
            new SugarParameter("@Digest", new string('a', 64)));

        Assert.Equal(10_000, await CountNodesAsync(store, canvasId));
        Assert.Equal(100, (await store.ReadNodesAsync(s_owner, canvasId, null, 100)).Items.Count);
        AuthoringCanvasWriteReceipt firstEdge = await store.PutEdgeAsync(new PutAuthoringCanvasEdgeCommand(
            canvasId,
            s_owner,
            firstNode.Revision,
            Guid.CreateVersion7(),
            new AuthoringCanvasEdge(
                Guid.Parse("10000000-0000-0000-0000-000000000001"),
                AuthoringCanvasEdgeType.VisualOnly,
                0,
                firstNodeId,
                secondNodeId)));
        Assert.Equal(1, await CountEdgesAsync(store, canvasId));
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO authoring_canvas_edge(
                canvas_id, edge_id, edge_type, edge_order, source_node_id, target_node_id, label, content_digest)
            SELECT @CanvasId,
                   ('10000000-0000-0000-0000-' || lpad(value::text, 12, '0'))::uuid,
                   CASE WHEN value % 2 = 0 THEN 'visual-only' ELSE 'explicit-reference-note' END,
                   value - 1,
                   '00000000-0000-0000-0000-000000000001'::uuid,
                   '00000000-0000-0000-0000-000000000002'::uuid,
                   NULL,
                   @Digest
            FROM generate_series(2, 10000) AS value;

            UPDATE authoring_canvas_document
            SET edge_count = 10000
            WHERE id = @CanvasId;
            """,
            new SugarParameter("@CanvasId", canvasId),
            new SugarParameter("@Digest", new string('a', 64)));

        Assert.Equal(10_000, await CountEdgesAsync(store, canvasId));
        Assert.Equal(100, (await store.ReadEdgesAsync(s_owner, canvasId, null, 100)).Items.Count);
        await Assert.ThrowsAsync<AuthoringCanvasBudgetExceededException>(() => store.PutNodeAsync(
            new PutAuthoringCanvasNodeCommand(
                canvasId,
                s_owner,
                firstEdge.Revision,
                Guid.CreateVersion7(),
                new AuthoringCanvasNode(
                    Guid.CreateVersion7(),
                    AuthoringCanvasNodeType.PlainTextNote,
                    10_001,
                    s_geometry,
                    NoteSource: "overflow"))));
        await Assert.ThrowsAsync<AuthoringCanvasBudgetExceededException>(() => store.PutEdgeAsync(
            new PutAuthoringCanvasEdgeCommand(
                canvasId,
                s_owner,
                firstEdge.Revision,
                Guid.CreateVersion7(),
                new AuthoringCanvasEdge(
                    Guid.CreateVersion7(),
                    AuthoringCanvasEdgeType.VisualOnly,
                    10_001,
                    Guid.Parse("00000000-0000-0000-0000-000000000001"),
                    Guid.Parse("00000000-0000-0000-0000-000000000002")))));
        await Assert.ThrowsAsync<AuthoringCanvasValidationException>(() => store.ReadNodesAsync(
            s_owner,
            canvasId,
            null,
            AuthoringCanvasContract.MaxPageSize + 1));
    }

    [Fact]
    public async Task Store_RejectsOneHundredAndFirstPrivateCanvasAndMigrationIsIdempotent()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var store = new AuthoringCanvasDocumentStore(db, TimeProvider.System);
        for (int index = 0; index < AuthoringCanvasContract.MaxCanvasesPerOwner; index++)
        {
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO authoring_canvas_document(
                    id, owner_admin_principal_id, site_scope, schema_version, revision, title,
                    viewport_x, viewport_y, viewport_zoom, node_count, edge_count,
                    created_at_utc, updated_at_utc, content_digest)
                VALUES (@CanvasId, 1, 'primary-site', 1, 1, @Title,
                        0, 0, 1, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, @Digest);
                """,
                new SugarParameter("@CanvasId", Guid.CreateVersion7()),
                new SugarParameter("@Title", $"canvas-{index}"),
                new SugarParameter("@Digest", new string('b', 64)));
        }

        await Assert.ThrowsAsync<AuthoringCanvasBudgetExceededException>(() => store.CreateAsync(
            new CreateAuthoringCanvasCommand(
                Guid.CreateVersion7(),
                s_owner,
                "overflow",
                new AuthoringCanvasViewport(0, 0, 1),
                Guid.CreateVersion7())));
        await ApplyMigrationAsync(db);
        Assert.Equal(6, await db.Ado.GetIntAsync(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'authoring_canvas_%';"));
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE admin_principal(id bigint PRIMARY KEY);
            INSERT INTO admin_principal(id) VALUES (1), (2);
            """);
        await ApplyMigrationAsync(db);
        return db;
    }

    private static async Task ApplyMigrationAsync(SqlSugarClient db)
    {
        ISchemaMigrationDescriptor migration = AuthoringCanvasDocumentMigrationDefinitions.BuildMigration();
        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
    }

    private static async Task<int> CountNodesAsync(
        IAuthoringCanvasDocumentStore store,
        Guid canvasId)
    {
        int count = 0;
        AuthoringCanvasPageCursor? cursor = null;
        do
        {
            AuthoringCanvasPage<AuthoringCanvasNode> page = await store.ReadNodesAsync(
                s_owner,
                canvasId,
                cursor,
                AuthoringCanvasContract.MaxPageSize);
            count += page.Items.Count;
            cursor = page.NextCursor;
        }
        while (cursor is not null);
        return count;
    }

    private static async Task<int> CountEdgesAsync(
        IAuthoringCanvasDocumentStore store,
        Guid canvasId)
    {
        int count = 0;
        AuthoringCanvasPageCursor? cursor = null;
        do
        {
            AuthoringCanvasPage<AuthoringCanvasEdge> page = await store.ReadEdgesAsync(
                s_owner,
                canvasId,
                cursor,
                AuthoringCanvasContract.MaxPageSize);
            count += page.Items.Count;
            cursor = page.NextCursor;
        }
        while (cursor is not null);
        return count;
    }
}
