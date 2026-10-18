using System.Text.Json;

using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthoringCanvasOperationTransactionIntegrationTests(PostgresSchemaMigrationFixture fixture) : IDisposable
{
    private readonly AuthoringCanvasAuthenticatedTestScope _authenticatedRequest = new();

    public void Dispose() => _authenticatedRequest.Dispose();

    private const string NoteCanary = "PRIVATE-CANVAS-OPERATION-CANARY";
    private static readonly AuthoringCanvasOwner s_owner = new(1, "primary-site");
    private static readonly AuthoringCanvasGeometry s_geometry = new(10, 20, 240, 120);

    [Fact]
    public async Task Transaction_PersistsSealedCommandsRecoversAndMaintainsUndoRedoBranch()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (AuthoringCanvasDocumentStore store, Guid canvasId, AuthoringCanvasNode before) =
            await CreateCanvasWithNoteAsync(db, "before");
        var transaction = new PostgresAuthoringCanvasOperationTransaction(db, store, TimeProvider.System);
        var engine = new AuthoringCanvasOperationEngine(store, transaction, new TrustedReferenceValidator());
        var databaseVerifier = new AuthoringCanvasOperationDatabaseVerifier(db, store, transaction);
        AuthoringCanvasOperationDatabaseBaseline databaseBaseline =
            await databaseVerifier.CaptureBaselineAsync(s_owner, canvasId);
        AuthoringCanvasOperationSnapshot initial = await SnapshotAsync(store, canvasId);
        AuthoringCanvasNode after = before with
        {
            NoteSource = NoteCanary
        };
        AuthoringCanvasOperationRequest request = await RequestAsync(
            store,
            transaction,
            canvasId,
            Command(AuthoringCanvasOperationKind.EditNote, before, after));

        AuthoringCanvasOperationReceipt applied = await engine.ApplyAsync(request);
        AuthoringCanvasOperationReceipt replayed = await engine.ApplyAsync(request);
        Assert.Equal(AuthoringCanvasOperationStatus.IdempotentReplay, replayed.Status);
        Assert.Equal(applied.JournalId, replayed.JournalId);
        Assert.DoesNotContain(NoteCanary, JsonSerializer.Serialize(applied), StringComparison.Ordinal);
        Assert.Equal(1, await CountAsync(db, "authoring_canvas_operation_journal"));
        Assert.Equal(1, await CountAsync(db, "authoring_canvas_operation_command"));
        Assert.Equal(2, await CountAsync(db, "authoring_canvas_operation_command_fact"));
        Assert.Equal(2, await CountAsync(db, "authoring_canvas_operation_fact"));
        Assert.Equal(1, await CountAsync(db, "authoring_canvas_operation_receipt"));
        await AssertDocumentValidAsync(store, canvasId);

        AuthoringCanvasHistoryWindow appliedHistory = await transaction.ReadHistoryAsync(s_owner, canvasId);
        AuthoringCanvasOperationReceipt undone = await engine.UndoAsync(new AuthoringCanvasHistoryRequest(
            Guid.CreateVersion7(),
            canvasId,
            s_owner,
            1,
            appliedHistory.Revision,
            appliedHistory.CanvasContentDigest,
            appliedHistory.HistoryDigest,
            applied.JournalId,
            AuthoringCanvasJournalMode.Undo));
        Assert.Equal(0, undone.UndoDepth);
        Assert.Equal(1, undone.RedoDepth);
        await AssertDocumentValidAsync(store, canvasId);

        AuthoringCanvasHistoryWindow undoneHistory = await transaction.ReadHistoryAsync(s_owner, canvasId);
        AuthoringCanvasOperationReceipt redone = await engine.RedoAsync(new AuthoringCanvasHistoryRequest(
            Guid.CreateVersion7(),
            canvasId,
            s_owner,
            1,
            undoneHistory.Revision,
            undoneHistory.CanvasContentDigest,
            undoneHistory.HistoryDigest,
            applied.JournalId,
            AuthoringCanvasJournalMode.Redo));
        Assert.Equal(1, redone.UndoDepth);
        Assert.Equal(0, redone.RedoDepth);
        await AssertDocumentValidAsync(store, canvasId);

        AuthoringCanvasHistoryWindow redoneHistory = await transaction.ReadHistoryAsync(s_owner, canvasId);
        _ = await engine.UndoAsync(new AuthoringCanvasHistoryRequest(
            Guid.CreateVersion7(),
            canvasId,
            s_owner,
            1,
            redoneHistory.Revision,
            redoneHistory.CanvasContentDigest,
            redoneHistory.HistoryDigest,
            applied.JournalId,
            AuthoringCanvasJournalMode.Undo));
        await AssertDocumentValidAsync(store, canvasId);
        AuthoringCanvasOperationSnapshot branchBefore = await SnapshotAsync(store, canvasId);
        AuthoringCanvasNode branchSource = Assert.Single(branchBefore.Nodes);
        AuthoringCanvasNode branchTarget = branchSource with
        {
            NoteSource = "branch"
        };
        AuthoringCanvasOperationReceipt branched = await engine.ApplyAsync(await RequestAsync(
            store,
            transaction,
            canvasId,
            Command(AuthoringCanvasOperationKind.EditNote, branchSource, branchTarget)));
        Assert.Equal(0, branched.RedoDepth);

        AuthoringCanvasHistoryWindow currentHistory = await transaction.ReadHistoryAsync(s_owner, canvasId);
        AuthoringCanvasOperationSnapshot current = await SnapshotAsync(store, canvasId);
        AuthoringCanvasOperationVerificationResult verified = AuthoringCanvasOperationVerifier.Verify(
            initial,
            await transaction.ReadJournalAsync(s_owner, canvasId, 0, 10_000),
            await transaction.ReadReceiptsAsync(s_owner, canvasId, 0, 10_000),
            current);
        Assert.True(verified.Valid, string.Join(',', verified.Reasons));
        Assert.Single(currentHistory.UndoEntries);
        await AssertDocumentValidAsync(store, canvasId);
        AuthoringCanvasOperationDatabaseVerificationResult databaseVerified =
            await databaseVerifier.VerifyAsync(databaseBaseline);
        Assert.True(databaseVerified.Valid, string.Join(',', databaseVerified.Reasons));
        Assert.Equal(5, databaseVerified.VerifiedJournalEntries);

        await db.Ado.ExecuteCommandAsync(
            "UPDATE article SET marker = 'mutated-outside-canvas' WHERE id = 1;");
        AuthoringCanvasOperationDatabaseVerificationResult externalMutation =
            await databaseVerifier.VerifyAsync(databaseBaseline);
        Assert.False(externalMutation.Valid);
        Assert.Contains("external_article_or_relation_mutation_detected", externalMutation.Reasons);

        await db.Ado.ExecuteCommandAsync(
            "UPDATE authoring_canvas_operation_receipt SET undo_depth = 99 WHERE journal_id = @JournalId;",
            new SugarParameter("@JournalId", branched.JournalId));
        AuthoringCanvasValidationException receiptTamper = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => transaction.ReadReceiptsAsync(s_owner, canvasId, 0, 10_000));
        Assert.Equal("canvas_operation_receipt_digest_invalid", receiptTamper.Code);

        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE authoring_canvas_operation_command_fact
            SET fact_payload = jsonb_set(fact_payload, '{Node,NoteSource}', '"tampered"'::jsonb)
            WHERE journal_id = @JournalId AND direction = 1;
            """,
            new SugarParameter("@JournalId", branched.JournalId));
        await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => transaction.ReadHistoryAsync(s_owner, canvasId));
    }

    [Fact]
    public async Task CanvasDelete_CascadesAllDocumentOwnedOperationState()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (AuthoringCanvasDocumentStore store, Guid canvasId, AuthoringCanvasNode before) =
            await CreateCanvasWithNoteAsync(db, "before");
        var transaction = new PostgresAuthoringCanvasOperationTransaction(db, store, TimeProvider.System);
        var engine = new AuthoringCanvasOperationEngine(store, transaction, new TrustedReferenceValidator());
        _ = await engine.ApplyAsync(await RequestAsync(
            store,
            transaction,
            canvasId,
            Command(AuthoringCanvasOperationKind.EditNote, before, before with
            {
                NoteSource = NoteCanary
            })));
        AuthoringCanvasDocumentHeader header = (await store.GetAsync(s_owner, canvasId))!;

        _ = await store.DeleteAsync(new DeleteAuthoringCanvasCommand(
            canvasId,
            s_owner,
            header.Revision,
            Guid.CreateVersion7()));

        Assert.Null(await store.GetAsync(s_owner, canvasId));
        foreach (string table in new[]
        {
            "authoring_canvas_operation_command_fact",
            "authoring_canvas_operation_command",
            "authoring_canvas_operation_fact",
            "authoring_canvas_operation_receipt",
            "authoring_canvas_operation_history_state",
            "authoring_canvas_operation_journal"
        })
        {
            Assert.Equal(0, await CountAsync(db, table));
        }
        Assert.Equal(2, await CountAsync(db, "external_canvas_operation_marker"));
        Assert.True(await CountAsync(db, "authoring_canvas_receipt") > 0);
    }

    [Fact]
    public async Task Commit_CancellationDuringAdvisoryLockAndLastWriteRollsBackWithoutPartialRows()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (AuthoringCanvasDocumentStore store, Guid canvasId, AuthoringCanvasNode before) =
            await CreateCanvasWithNoteAsync(db, "before");
        var transaction = new PostgresAuthoringCanvasOperationTransaction(db, store, TimeProvider.System);
        var engine = new AuthoringCanvasOperationEngine(store, transaction, new TrustedReferenceValidator());
        AuthoringCanvasOperationRequest request = await RequestAsync(
            store,
            transaction,
            canvasId,
            Command(AuthoringCanvasOperationKind.EditNote, before, before with
            {
                NoteSource = "after"
            }));
        AuthoringCanvasDocumentHeader original = (await store.GetAsync(s_owner, canvasId))!;

        await using (var holder = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString))
        {
            await holder.OpenAsync();
            await using NpgsqlTransaction holderTransaction = await holder.BeginTransactionAsync();
            await using NpgsqlCommand hold = holder.CreateCommand();
            hold.Transaction = holderTransaction;
            hold.CommandText = "SELECT pg_advisory_xact_lock(hashtextextended(@identity, 0));";
            hold.Parameters.AddWithValue("identity", $"authoring-canvas-document:{canvasId:D}");
            await hold.ExecuteNonQueryAsync();
            using var cancelled = new CancellationTokenSource(TimeSpan.FromMilliseconds(150));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => engine.ApplyAsync(request, cancelled.Token));
            await holderTransaction.RollbackAsync();
        }
        await AssertUnchangedAsync(db, store, canvasId, original);

        await db.Ado.ExecuteCommandAsync(
            """
            CREATE FUNCTION delay_canvas_operation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                PERFORM pg_sleep(0.5);
                RETURN NEW;
            END;
            $$;
            CREATE TRIGGER delay_canvas_operation_receipt
                BEFORE INSERT ON authoring_canvas_operation_receipt
                FOR EACH ROW EXECUTE FUNCTION delay_canvas_operation_receipt();
            """);
        using (var cancelled = new CancellationTokenSource(TimeSpan.FromMilliseconds(100)))
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => engine.ApplyAsync(request, cancelled.Token));
        }
        await AssertUnchangedAsync(db, store, canvasId, original);
    }

    [Fact]
    public async Task Commit_RevalidatesWholeLockedSnapshotBeyondAffectedFacts()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (AuthoringCanvasDocumentStore store, Guid canvasId, AuthoringCanvasNode before) =
            await CreateCanvasWithNoteAsync(db, "before");
        AuthoringCanvasDocumentHeader header = (await store.GetAsync(s_owner, canvasId))!;
        var unrelated = new AuthoringCanvasNode(
            Guid.CreateVersion7(),
            AuthoringCanvasNodeType.PlainTextNote,
            1,
            s_geometry with
            {
                X = 400
            },
            NoteSource: "unrelated");
        _ = await store.PutNodeAsync(new PutAuthoringCanvasNodeCommand(
            canvasId,
            s_owner,
            header.Revision,
            Guid.CreateVersion7(),
            unrelated));
        var transaction = new PostgresAuthoringCanvasOperationTransaction(db, store, TimeProvider.System);
        var engine = new AuthoringCanvasOperationEngine(store, transaction, new TrustedReferenceValidator());
        AuthoringCanvasOperationRequest request = await RequestAsync(
            store,
            transaction,
            canvasId,
            Command(AuthoringCanvasOperationKind.EditNote, before, before with
            {
                NoteSource = "after"
            }));
        AuthoringCanvasDocumentHeader original = (await store.GetAsync(s_owner, canvasId))!;
        await db.Ado.ExecuteCommandAsync(
            "UPDATE authoring_canvas_node SET note_source = 'mixed-revision' WHERE canvas_id = @CanvasId AND node_id = @NodeId;",
            new SugarParameter("@CanvasId", canvasId),
            new SugarParameter("@NodeId", unrelated.Id));

        AuthoringCanvasValidationException exception = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => engine.ApplyAsync(request));

        Assert.Equal("canvas_operation_snapshot_integrity_invalid", exception.Code);
        AuthoringCanvasDocumentHeader current = (await store.GetAsync(s_owner, canvasId))!;
        Assert.Equal(original.Revision, current.Revision);
        Assert.Equal(original.ContentDigest, current.ContentDigest);
        Assert.Equal(0, await CountAsync(db, "authoring_canvas_operation_journal"));
        Assert.Equal(0, await CountAsync(db, "authoring_canvas_operation_receipt"));
        Assert.Equal(2, await CountAsync(db, "external_canvas_operation_marker"));
        AuthoringCanvasVerificationResult verification = await store.VerifyAsync(s_owner, canvasId);
        Assert.False(verification.Valid);
        Assert.Contains(verification.Reasons, static reason => reason.StartsWith(
            "node_digest_mismatch:",
            StringComparison.Ordinal));
    }

    [Fact]
    public async Task ProductionAdapter_ClassifiesCommitBoundaryFailureAndRecoversCommittedReceipt()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (AuthoringCanvasDocumentStore store, Guid canvasId, AuthoringCanvasNode before) =
            await CreateCanvasWithNoteAsync(db, "before");
        var transaction = new PostgresAuthoringCanvasOperationTransaction(db, store, TimeProvider.System);
        var engine = new AuthoringCanvasOperationEngine(store, transaction, new TrustedReferenceValidator());
        AuthoringCanvasOperationRequest request = await RequestAsync(
            store,
            transaction,
            canvasId,
            Command(AuthoringCanvasOperationKind.EditNote, before, before with
            {
                NoteSource = "after"
            }));
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE FUNCTION reject_canvas_operation_commit() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION 'forced deferred commit failure';
            END;
            $$;
            CREATE CONSTRAINT TRIGGER reject_canvas_operation_commit
                AFTER INSERT ON authoring_canvas_operation_receipt
                DEFERRABLE INITIALLY DEFERRED
                FOR EACH ROW EXECUTE FUNCTION reject_canvas_operation_commit();
            """);

        await Assert.ThrowsAsync<AuthoringCanvasUnknownCommitResultException>(() => engine.ApplyAsync(request));
        Assert.Equal(0, await CountAsync(db, "authoring_canvas_operation_receipt"));
        await db.Ado.ExecuteCommandAsync(
            "DROP TRIGGER reject_canvas_operation_commit ON authoring_canvas_operation_receipt;");

        AuthoringCanvasOperationReceipt committed = await engine.ApplyAsync(request);
        using SqlSugarClient recoveryDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        var recoveryStore = new AuthoringCanvasDocumentStore(recoveryDb, TimeProvider.System);
        var recovery = new PostgresAuthoringCanvasOperationTransaction(
            recoveryDb,
            recoveryStore,
            TimeProvider.System);
        AuthoringCanvasOperationReceipt? recovered = await recovery.RecoverAsync(
            new AuthoringCanvasOperationRecoveryQuery(
                canvasId,
                s_owner,
                request.RequestId,
                AuthoringCanvasOperationContract.ComputeTransactionDigest(request)));
        Assert.NotNull(recovered);
        Assert.Equal(committed.JournalId, recovered.JournalId);
        Assert.Equal(AuthoringCanvasOperationStatus.IdempotentReplay, recovered.Status);
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE admin_principal(id bigint PRIMARY KEY, status text NOT NULL DEFAULT 'active', validationversion bigint NOT NULL DEFAULT 1);
            INSERT INTO admin_principal(id) VALUES (1);
            CREATE TABLE article(id integer PRIMARY KEY, marker text NOT NULL);
            CREATE TABLE article_revision(id bigint PRIMARY KEY, article_id integer NOT NULL);
            CREATE TABLE article_tag(article_id integer NOT NULL, tag_id integer NOT NULL);
            CREATE TABLE article_mutation_outbox_edge(id bigint PRIMARY KEY, article_id integer NOT NULL);
            INSERT INTO article(id, marker) VALUES (1, 'article');
            INSERT INTO article_revision(id, article_id) VALUES (1, 1);
            INSERT INTO article_tag(article_id, tag_id) VALUES (1, 1);
            INSERT INTO article_mutation_outbox_edge(id, article_id) VALUES (1, 1);
            CREATE TABLE external_canvas_operation_marker(id integer PRIMARY KEY, marker text NOT NULL);
            INSERT INTO external_canvas_operation_marker(id, marker) VALUES (1, 'article'), (2, 'relation');
            """);
        await ApplyMigrationAsync(db, AuthoringCanvasDocumentMigrationDefinitions.BuildMigration());
        await ApplyMigrationAsync(db, AuthoringCanvasOperationJournalMigrationDefinitions.BuildMigration());
        await AuthoringCanvasAuthenticatedTestScope.AttachAsync(db, s_owner.AdminPrincipalId);
        return db;
    }

    private static async Task<(AuthoringCanvasDocumentStore Store, Guid CanvasId, AuthoringCanvasNode Node)>
        CreateCanvasWithNoteAsync(SqlSugarClient db, string source)
    {
        var store = new AuthoringCanvasDocumentStore(db, TimeProvider.System);
        Guid canvasId = Guid.CreateVersion7();
        AuthoringCanvasWriteReceipt created = await store.CreateAsync(new CreateAuthoringCanvasCommand(
            canvasId,
            s_owner,
            "Operation journal",
            new AuthoringCanvasViewport(0, 0, 1),
            Guid.CreateVersion7()));
        var node = new AuthoringCanvasNode(
            Guid.CreateVersion7(),
            AuthoringCanvasNodeType.PlainTextNote,
            0,
            s_geometry,
            NoteSource: source);
        _ = await store.PutNodeAsync(new PutAuthoringCanvasNodeCommand(
            canvasId,
            s_owner,
            created.Revision,
            Guid.CreateVersion7(),
            node));
        return (store, canvasId, node);
    }

    private static async Task<AuthoringCanvasOperationRequest> RequestAsync(
        IAuthoringCanvasDocumentStore store,
        IAuthoringCanvasOperationTransaction transaction,
        Guid canvasId,
        AuthoringCanvasClosedCommand command)
    {
        AuthoringCanvasDocumentHeader header = (await store.GetAsync(s_owner, canvasId))!;
        AuthoringCanvasHistoryWindow history = await transaction.ReadHistoryAsync(s_owner, canvasId);
        return new AuthoringCanvasOperationRequest(
            Guid.CreateVersion7(),
            canvasId,
            s_owner,
            1,
            header.Revision,
            header.ContentDigest,
            history.HistoryDigest,
            [command]);
    }

    private static AuthoringCanvasClosedCommand Command(
        AuthoringCanvasOperationKind kind,
        AuthoringCanvasNode before,
        AuthoringCanvasNode after)
        => AuthoringCanvasOperationContract.SealCommand(
            Guid.CreateVersion7(),
            kind,
            [AuthoringCanvasOperationContract.Present(before)],
            [AuthoringCanvasOperationContract.Present(after)]);

    private static async Task<AuthoringCanvasOperationSnapshot> SnapshotAsync(
        IAuthoringCanvasDocumentStore store,
        Guid canvasId)
    {
        AuthoringCanvasDocumentHeader header = (await store.GetAsync(s_owner, canvasId))!;
        AuthoringCanvasPage<AuthoringCanvasNode> nodes = await store.ReadNodesAsync(s_owner, canvasId, null, 256);
        AuthoringCanvasPage<AuthoringCanvasEdge> edges = await store.ReadEdgesAsync(s_owner, canvasId, null, 256);
        return new AuthoringCanvasOperationSnapshot(header, nodes.Items, edges.Items);
    }

    private static async Task AssertUnchangedAsync(
        SqlSugarClient db,
        IAuthoringCanvasDocumentStore store,
        Guid canvasId,
        AuthoringCanvasDocumentHeader original)
    {
        AuthoringCanvasDocumentHeader current = (await store.GetAsync(s_owner, canvasId))!;
        Assert.Equal(original.Revision, current.Revision);
        Assert.Equal(original.ContentDigest, current.ContentDigest);
        Assert.Equal(0, await CountAsync(db, "authoring_canvas_operation_journal"));
        Assert.Equal(0, await CountAsync(db, "authoring_canvas_operation_receipt"));
        Assert.Equal(2, await CountAsync(db, "external_canvas_operation_marker"));
        await AssertDocumentValidAsync(store, canvasId);
    }

    private static async Task AssertDocumentValidAsync(
        IAuthoringCanvasDocumentStore store,
        Guid canvasId)
    {
        AuthoringCanvasVerificationResult verification = await store.VerifyAsync(s_owner, canvasId);
        Assert.True(verification.Valid, string.Join(',', verification.Reasons));
    }

    private static async Task ApplyMigrationAsync(SqlSugarClient db, ISchemaMigrationDescriptor migration)
    {
        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
    }

    private static Task<int> CountAsync(SqlSugarClient db, string table)
        => db.Ado.GetIntAsync($"SELECT COUNT(*) FROM {table};");

    private sealed class TrustedReferenceValidator : IAuthoringCanvasOperationReferenceValidator
    {
        public Task<string> ValidateAsync(
            AuthoringCanvasOperationReferenceValidationRequest request,
            CancellationToken cancellationToken = default)
            => Task.FromResult(AuthoringCanvasContract.ComputeCommandDigest(
                "integration-reference-validation",
                request.CanvasId,
                request.CanvasRevision));
    }
}
