using System.Data.Common;
using System.Security.Cryptography;

using FsusBlog.Server.Services.Fixtures.DataScale;

using Microsoft.Data.Sqlite;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DataScaleArticleTaxonomyTests
{
    private static readonly byte[] s_key = SHA256.HashData("task-taxonomy-component-key"u8);

    [Theory]
    [InlineData(ArticleScaleVariant.Published)]
    [InlineData(ArticleScaleVariant.Scheduled)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate)]
    [InlineData(ArticleScaleVariant.Archived)]
    [InlineData(ArticleScaleVariant.Deleted)]
    public async Task CanonicalTaxonomy_CommitsCompositeLinksAndRereadsExactGraph(ArticleScaleVariant variant)
    {
        var (authority, schema) = Authority(variant);
        await using SqliteConnection db = await OpenAsync(schema);
        DataScaleArticleBatchExecution first = await DataScaleArticleBatchWriter.WriteAsync(db, DataScaleBulkProvider.Sqlite,
            authority, null, s_key, (_, _) => Task.CompletedTask, CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.Committed, first.Transport.State);
        Assert.True(first.CleanupEligible);
        Assert.False(first.CompleteSeedAccepted);
        Assert.DoesNotContain(authority.Batch.LogicalReferences, row => row.Kind == ArticleScaleRowKind.ArticleTaxonomyReference);
        Assert.Contains(authority.Batch.LogicalReferences, row => row.Kind == ArticleScaleRowKind.ArticleAuditCoordinate);
        await using (DbCommand links = db.CreateCommand())
        {
            links.CommandText = "SELECT COUNT(*) FROM article_tag";
            Assert.Equal(2L, await links.ExecuteScalarAsync());
        }
        DataScaleArticleBatchExecution replay = await DataScaleArticleBatchWriter.WriteAsync(db, DataScaleBulkProvider.Sqlite,
            authority, first.Checkpoint, s_key, (_, _) => throw new InvalidOperationException("exact replay must not publish a new intent"),
            CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.Committed, replay.Transport.State);
        Assert.True(replay.AlreadyPresent);
        Assert.Equal(0, replay.Transport.WriteCommands);
        await using DbTransaction transaction = await db.BeginTransactionAsync();
        Assert.Equal(DataScalePhysicalRecoveryState.Exact, (await DataScaleArticleBatchWriter.ValidateCleanupAsync(db, transaction,
            DataScaleBulkProvider.Sqlite, authority, replay.Checkpoint!, s_key, CancellationToken.None)).State);
    }

    [Theory]
    [InlineData("category")]
    [InlineData("tag")]
    public async Task MissingExternalTaxonomyKey_RefusesBeforeAnyProductRowsWithoutNativeFkHelp(string table)
    {
        var (authority, schema) = Authority(ArticleScaleVariant.Published);
        await using SqliteConnection db = await OpenAsync(schema, false);
        await using (DbCommand missing = db.CreateCommand())
        {
            missing.CommandText = "DELETE FROM " + table + " WHERE id=2";
            await missing.ExecuteNonQueryAsync();
        }
        DataScaleArticleBatchExecution refused = await DataScaleArticleBatchWriter.WriteAsync(db, DataScaleBulkProvider.Sqlite,
            authority, null, s_key, (_, _) => throw new InvalidOperationException("must not publish intent for orphan inputs"), CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.RolledBack, refused.Transport.State);
        Assert.Equal(0, refused.Transport.WriteCommands);
        Assert.Null(refused.Checkpoint);
        await using DbCommand count = db.CreateCommand();
        count.CommandText = "SELECT COUNT(*) FROM article";
        Assert.Equal(0L, await count.ExecuteScalarAsync());
    }

    [Theory]
    [InlineData("extra")]
    [InlineData("missing")]
    [InlineData("changed")]
    public async Task OwnedLinkGroupTamper_RefusesExactReplayAndReadOnlyCleanup(string scenario)
    {
        var (authority, schema) = Authority(ArticleScaleVariant.Published);
        await using SqliteConnection db = await OpenAsync(schema);
        DataScaleArticleBatchExecution first = await DataScaleArticleBatchWriter.WriteAsync(db, DataScaleBulkProvider.Sqlite,
            authority, null, s_key, (_, _) => Task.CompletedTask, CancellationToken.None);
        await using (DbCommand tamper = db.CreateCommand())
        {
            tamper.CommandText = scenario switch
            {
                "extra" => "INSERT INTO article_tag(article_id,tag_id) VALUES(701,9)",
                "missing" => "DELETE FROM article_tag WHERE tag_id=2",
                _ => "UPDATE article_tag SET tag_id=9 WHERE tag_id=2"
            };
            await tamper.ExecuteNonQueryAsync();
        }
        DataScaleArticleBatchExecution replay = await DataScaleArticleBatchWriter.WriteAsync(db, DataScaleBulkProvider.Sqlite,
            authority, first.Checkpoint, s_key, (_, _) => throw new InvalidOperationException("must not repair changed links"), CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.RolledBack, replay.Transport.State);
        Assert.Equal(0, replay.Transport.WriteCommands);
        Assert.False(replay.CleanupEligible);
        await using DbTransaction transaction = await db.BeginTransactionAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => DataScaleArticleBatchWriter.ValidateCleanupAsync(db, transaction,
            DataScaleBulkProvider.Sqlite, authority, first.Checkpoint!, s_key, CancellationToken.None));
    }

    [Fact]
    public async Task PostconditionJournalFailure_RollsBackArticleAndTaxonomyTogether()
    {
        var (authority, schema) = Authority(ArticleScaleVariant.Published);
        await using SqliteConnection db = await OpenAsync(schema);
        DataScaleArticleBatchExecution result = await DataScaleArticleBatchWriter.WriteAsync(db, DataScaleBulkProvider.Sqlite,
            authority, null, s_key, (checkpoint, _) => checkpoint.Stage == DataScaleBatchCheckpointStage.CommitPending
                ? Task.FromException(new IOException("injected precommit publication failure")) : Task.CompletedTask, CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.RolledBack, result.Transport.State);
        Assert.True(result.Transport.RowsSubmitted > 0);
        Assert.Equal(DataScaleBatchCheckpointStage.RolledBack, result.Checkpoint!.Stage);
        await using DbCommand count = db.CreateCommand();
        count.CommandText = "SELECT (SELECT COUNT(*) FROM article)+(SELECT COUNT(*) FROM article_tag)";
        Assert.Equal(0L, await count.ExecuteScalarAsync());
    }

    [Fact]
    public async Task UnownedArticleLinks_RemainUntouchedAndDoNotEnterTheOwnedDigest()
    {
        var (authority, schema) = Authority(ArticleScaleVariant.Published);
        await using SqliteConnection db = await OpenAsync(schema);
        DataScaleBulkTableRows article = authority.Batch.Tables.Single(table => table.Table == "article");
        await using (DbCommand other = db.CreateCommand())
        {
            other.CommandText = "INSERT INTO article(" + string.Join(',', article.Columns.Select(column => "\"" + column.Name + "\""))
                + ") VALUES(" + string.Join(',', Enumerable.Range(0, article.Columns.Count).Select(index => "@p" + index)) + ")";
            for (int index = 0; index < article.Columns.Count; index++)
            {
                var parameter = other.CreateParameter();
                parameter.ParameterName = "@p" + index;
                parameter.DbType = article.Columns[index].Type;
                object? value = article.Columns[index].Name switch
                {
                    "id" => 9999,
                    "current_revision_id" or "current_publication_id" => null,
                    _ => article.Rows[0][index]
                };
                parameter.Value = value ?? DBNull.Value;
                other.Parameters.Add(parameter);
            }
            await other.ExecuteNonQueryAsync();
            other.Parameters.Clear();
            other.CommandText = "INSERT INTO article_tag(article_id,tag_id) VALUES(9999,9)";
            await other.ExecuteNonQueryAsync();
        }
        DataScaleArticleBatchExecution result = await DataScaleArticleBatchWriter.WriteAsync(db, DataScaleBulkProvider.Sqlite,
            authority, null, s_key, (_, _) => Task.CompletedTask, CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.Committed, result.Transport.State);
        await using DbCommand unchanged = db.CreateCommand();
        unchanged.CommandText = "SELECT COUNT(*) FROM article_tag WHERE article_id=9999 AND tag_id=9";
        Assert.Equal(1L, await unchanged.ExecuteScalarAsync());
    }

    internal static DataScaleArticleTaxonomySchema TaxonomySchema()
        => new(new("article_tag", new Dictionary<string, string> { ["ArticleId"] = "article_id", ["TagId"] = "tag_id" }),
            new("category", new Dictionary<string, string> { ["Id"] = "id", ["Name"] = "name", ["Description"] = "description" }),
            new("tag", new Dictionary<string, string> { ["Id"] = "id", ["Name"] = "name", ["Description"] = "description" }));

    internal static (DataScaleArticleBatchAuthority Authority, Dictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding> Schema)
        Authority(ArticleScaleVariant variant)
    {
        var (plan, graph, bindings) = DataScaleArticlePhysicalProjectionTests.Graph(variant);
        var schema = DataScaleArticlePhysicalProjectionTests.Schema();
        return (new(plan, [graph], bindings, schema, DataScaleArticlePhysicalProjectionTests.Principals(plan), "taxonomy-component-run",
            "taxonomy-component-runtime", new string('a', 40), "canonical-taxonomy-batch", DataScaleArticleBatchAuthority.ComputeGraphDigest([graph]),
            taxonomySchema: TaxonomySchema()), schema);
    }

    private static async Task<SqliteConnection> OpenAsync(IReadOnlyDictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding> schema,
        bool foreignKeys = true)
    {
        SqliteConnection db = await DataScaleArticlePhysicalProjectionTests.OpenGraphSchemaAsync(schema);
        await using DbCommand domain = db.CreateCommand();
        domain.CommandText = "CREATE TABLE category(id INTEGER PRIMARY KEY,name TEXT,description TEXT);"
            + "CREATE TABLE tag(id INTEGER PRIMARY KEY,name TEXT,description TEXT);"
            + "INSERT INTO category(id,name) VALUES(1,'one'),(2,'two'),(3,'three'),(4,'four'),(5,'five');"
            + "INSERT INTO tag(id,name) VALUES(1,'one'),(2,'two'),(3,'three'),(4,'four'),(5,'five'),(6,'six'),(7,'seven'),(8,'eight'),(9,'nine'),(10,'ten');"
            + "CREATE TABLE article_tag(article_id INTEGER NOT NULL,tag_id INTEGER NOT NULL,PRIMARY KEY(article_id,tag_id)"
            + (foreignKeys ? ",FOREIGN KEY(article_id) REFERENCES article(id),FOREIGN KEY(tag_id) REFERENCES tag(id)" : "") + ")";
        try
        {
            await domain.ExecuteNonQueryAsync();
            return db;
        }
        catch
        {
            await db.DisposeAsync();
            throw;
        }
    }
}
