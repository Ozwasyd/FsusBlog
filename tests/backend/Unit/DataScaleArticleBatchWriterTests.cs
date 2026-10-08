using System.Data.Common;
using System.Security.Cryptography;

using FsusBlog.Server.Services.Fixtures.DataScale;

using Microsoft.Data.Sqlite;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Real SQLite component transactions with diagnostic IDs, not full seed/native provenance acceptance.</summary>
public sealed class DataScaleArticleBatchWriterTests
{
    private static readonly byte[] s_key = SHA256.HashData("task-owned-component-key"u8);

    [Theory]
    [InlineData(ArticleScaleVariant.Published)]
    [InlineData(ArticleScaleVariant.Scheduled)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate)]
    [InlineData(ArticleScaleVariant.Archived)]
    [InlineData(ArticleScaleVariant.Deleted)]
    public async Task CanonicalBatch_CommitsAuthenticatedCheckpointAndRerunsWithoutWrites(ArticleScaleVariant variant)
    {
        var (authority, schema) = Authority(variant);
        await using SqliteConnection db = await DataScaleArticlePhysicalProjectionTests.OpenGraphSchemaAsync(schema);
        var checkpoints = new List<DataScaleBatchCheckpoint>();
        Task Persist(DataScaleBatchCheckpoint checkpoint, CancellationToken token)
        {
            checkpoints.Add(checkpoint);
            return Task.CompletedTask;
        }
        DataScaleArticleBatchExecution first = await DataScaleArticleBatchWriter.WriteAsync(
            db, DataScaleBulkProvider.Sqlite, authority, null, s_key, Persist, CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.Committed, first.Transport.State);
        Assert.True(first.CleanupEligible);
        Assert.False(first.CompleteSeedAccepted);
        Assert.Equal([DataScaleBatchCheckpointStage.Prepared, DataScaleBatchCheckpointStage.CommitPending,
            DataScaleBatchCheckpointStage.Committed], checkpoints.Select(checkpoint => checkpoint.Stage).ToArray());
        DataScaleArticleBatchExecution replay = await DataScaleArticleBatchWriter.WriteAsync(
            db, DataScaleBulkProvider.Sqlite, authority, first.Checkpoint, s_key, Persist, CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.Committed, replay.Transport.State);
        Assert.True(replay.AlreadyPresent);
        Assert.True(replay.CleanupEligible);
        Assert.Equal(0, replay.Transport.WriteCommands);
        Assert.Equal(0, replay.Transport.RowsSubmitted);
        Assert.Equal(3, checkpoints.Count);
        await using DbTransaction transaction = await db.BeginTransactionAsync();
        DataScalePhysicalRecoveryObservation observed = await DataScaleArticleBatchWriter.ValidateCleanupAsync(
            db, transaction, DataScaleBulkProvider.Sqlite, authority, replay.Checkpoint!, s_key, CancellationToken.None);
        Assert.Equal(DataScalePhysicalRecoveryState.Exact, observed.State);
    }

    [Fact]
    public async Task MissingPostCommitTerminal_RemainsPendingEvenAfterExactReadback()
    {
        var (authority, schema) = Authority(ArticleScaleVariant.Published);
        await using SqliteConnection db = await DataScaleArticlePhysicalProjectionTests.OpenGraphSchemaAsync(schema);
        Task FailTerminal(DataScaleBatchCheckpoint checkpoint, CancellationToken token)
            => checkpoint.Stage == DataScaleBatchCheckpointStage.Committed
                ? Task.FromException(new IOException("injected terminal publication failure")) : Task.CompletedTask;
        DataScaleArticleBatchExecution first = await DataScaleArticleBatchWriter.WriteAsync(
            db, DataScaleBulkProvider.Sqlite, authority, null, s_key, FailTerminal, CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.Committed, first.Transport.State);
        Assert.Equal(DataScaleBatchCheckpointStage.CommitPending, first.Checkpoint!.Stage);
        Assert.False(first.CleanupEligible);
        DataScaleArticleBatchExecution replay = await DataScaleArticleBatchWriter.WriteAsync(
            db, DataScaleBulkProvider.Sqlite, authority, first.Checkpoint, s_key,
            (_, _) => Task.CompletedTask, CancellationToken.None);
        Assert.True(replay.AlreadyPresent);
        Assert.False(replay.CleanupEligible);
        Assert.Equal(DataScaleBatchCheckpointStage.CommitPending, replay.Checkpoint!.Stage);
        Assert.Equal(0, replay.Transport.WriteCommands);
        await using DbTransaction transaction = await db.BeginTransactionAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => DataScaleArticleBatchWriter.ValidateCleanupAsync(
            db, transaction, DataScaleBulkProvider.Sqlite, authority, replay.Checkpoint, s_key, CancellationToken.None));
    }

    [Fact]
    public async Task ExistingExactRowsWithoutCheckpoint_DoNotBecomeOwnedByANewInvocation()
    {
        var (authority, schema) = Authority(ArticleScaleVariant.Published);
        await using SqliteConnection db = await DataScaleArticlePhysicalProjectionTests.OpenGraphSchemaAsync(schema);
        DataScaleArticleBatchExecution first = await DataScaleArticleBatchWriter.WriteAsync(
            db, DataScaleBulkProvider.Sqlite, authority, null, s_key, (_, _) => Task.CompletedTask, CancellationToken.None);
        Assert.True(first.CleanupEligible);
        DataScaleArticleBatchExecution refused = await DataScaleArticleBatchWriter.WriteAsync(
            db, DataScaleBulkProvider.Sqlite, authority, null, s_key,
            (_, _) => throw new InvalidOperationException("must not claim existing rows"), CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.RolledBack, refused.Transport.State);
        Assert.Null(refused.Checkpoint);
        Assert.False(refused.CleanupEligible);
        Assert.Equal(0, refused.Transport.WriteCommands);
    }

    [Fact]
    public async Task TerminalGraphTamper_RefusesReplayAndCleanupWithoutRepairingRows()
    {
        var (authority, schema) = Authority(ArticleScaleVariant.Published);
        await using SqliteConnection db = await DataScaleArticlePhysicalProjectionTests.OpenGraphSchemaAsync(schema);
        DataScaleArticleBatchExecution first = await DataScaleArticleBatchWriter.WriteAsync(
            db, DataScaleBulkProvider.Sqlite, authority, null, s_key, (_, _) => Task.CompletedTask, CancellationToken.None);
        await using (DbCommand tamper = db.CreateCommand())
        {
            tamper.CommandText = "UPDATE article_body SET markdown_content='tampered'";
            await tamper.ExecuteNonQueryAsync();
        }
        DataScaleArticleBatchExecution replay = await DataScaleArticleBatchWriter.WriteAsync(
            db, DataScaleBulkProvider.Sqlite, authority, first.Checkpoint, s_key, (_, _) => Task.CompletedTask, CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.RolledBack, replay.Transport.State);
        Assert.Equal(0, replay.Transport.WriteCommands);
        Assert.False(replay.CleanupEligible);
        Assert.Equal(first.Checkpoint, replay.Checkpoint);
        await using DbTransaction transaction = await db.BeginTransactionAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => DataScaleArticleBatchWriter.ValidateCleanupAsync(
            db, transaction, DataScaleBulkProvider.Sqlite, authority, first.Checkpoint!, s_key, CancellationToken.None));
    }

    [Fact]
    public async Task PreparedPublicationFailure_RollsBackWithNoInsertedRows()
    {
        var (authority, schema) = Authority(ArticleScaleVariant.Published);
        await using SqliteConnection db = await DataScaleArticlePhysicalProjectionTests.OpenGraphSchemaAsync(schema);
        DataScaleArticleBatchExecution failed = await DataScaleArticleBatchWriter.WriteAsync(
            db, DataScaleBulkProvider.Sqlite, authority, null, s_key,
            (_, _) => Task.FromException(new IOException("injected preparation failure")), CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.RolledBack, failed.Transport.State);
        Assert.Equal(0, failed.Transport.WriteCommands);
        Assert.Null(failed.Checkpoint);
        await using DbCommand count = db.CreateCommand();
        count.CommandText = "SELECT COUNT(*) FROM article";
        Assert.Equal(0L, await count.ExecuteScalarAsync());
    }

    internal static (DataScaleArticleBatchAuthority Authority, Dictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding> Schema)
        Authority(ArticleScaleVariant variant)
    {
        var (plan, graph, bindings) = DataScaleArticlePhysicalProjectionTests.Graph(variant);
        Dictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding> schema = DataScaleArticlePhysicalProjectionTests.Schema();
        return (new(plan, [graph], bindings, schema, DataScaleArticlePhysicalProjectionTests.Principals(plan),
            "component-run", "component-runtime", new string('a', 40), "component-factory-batch",
            DataScaleArticleBatchAuthority.ComputeGraphDigest([graph])), schema);
    }
}
