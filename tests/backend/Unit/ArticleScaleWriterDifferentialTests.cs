using System.Data;

using FsusBlog.Server.Services.Fixtures.DataScale;

using Microsoft.Data.Sqlite;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleScaleWriterDifferentialTests
{
    [Theory]
    [InlineData("PayloadJson")]
    [InlineData("CurrentRevisionId")]
    [InlineData("ContentCanonicalHash")]
    [InlineData("CreatedAt")]
    [InlineData("NewBusinessField")]
    public void EveryPersistedFieldParticipatesInDiff(string field)
    {
        DataScaleArticlePhysicalBatch production = Batch(field, "expected");
        ArticleScaleWriterDifferentialResult result = ArticleScaleWriterDifferential.Compare(production, Batch(field, "tampered"));
        Assert.False(result.PhysicalEquivalent);
        Assert.False(result.QualificationEligible);
        ArticleScaleFieldDifference difference = Assert.Single(result.Differences);
        Assert.Equal(field, difference.Field);
        Assert.Equal("expected", difference.ProductionValue);
        Assert.Equal("tampered", difference.BulkValue);
        Assert.NotEqual(result.ProductionDigest, result.BulkDigest);
    }

    [Fact]
    public void EqualPhysicalRowsCannotCertifyMissingLogicalAndRecoveryPostconditions()
    {
        DataScaleArticlePhysicalBatch batch = Batch("PayloadJson", "{}") with
        {
            LogicalReferences = [new(ArticleScaleRowKind.ArticleAuditCoordinate, "article/audit/1", new Dictionary<string, object?>())]
        };
        ArticleScaleWriterDifferentialResult result = ArticleScaleWriterDifferential.Compare(batch, batch);
        Assert.True(result.PhysicalEquivalent);
        Assert.False(result.QualificationEligible);
        Assert.Contains("logical-persistence-unverified:ArticleAuditCoordinate", result.MissingPostconditions);
        Assert.Contains("semantic-orphan-verifier-unavailable", result.MissingPostconditions);
        Assert.Contains("owned-recovery-verifier-unavailable", result.MissingPostconditions);
    }

    [Fact]
    public void MissingAndExtraRowsAreComparedEvenWhenTotalCountsMatch()
    {
        DataScaleArticlePhysicalBatch left = Batch("PayloadJson", "{}", 1);
        DataScaleArticlePhysicalBatch right = Batch("PayloadJson", "{}", 2);
        ArticleScaleWriterDifferentialResult result = ArticleScaleWriterDifferential.Compare(left, right);
        Assert.Contains(result.Differences, difference => difference.Kind == "missing-row");
        Assert.Contains(result.Differences, difference => difference.Kind == "extra-row");
    }

    [Fact]
    public void NewColumnCannotBeSilentlyIgnored()
    {
        ArticleScaleWriterDifferentialResult result = ArticleScaleWriterDifferential.Compare(
            Batch("PayloadJson", "{}"), Batch("NewColumn", "{}"));
        Assert.Equal("schema-mismatch", Assert.Single(result.Differences).Kind);
    }

    [Fact]
    public async Task IndependentReadbackFindsExtraRowsOutsideExpectedKeySet()
    {
        using var cancellation = new CancellationTokenSource();
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync(cancellation.Token);
        await using var command = connection.CreateCommand();
        command.CommandText = "CREATE TABLE article(Id INTEGER PRIMARY KEY, PayloadJson TEXT); INSERT INTO article VALUES (1, '{}'), (2, '{\"extra\":true}');";
        await command.ExecuteNonQueryAsync(cancellation.Token);
        DataScaleArticlePhysicalBatch model = Batch("PayloadJson", "{}");
        DataScaleArticlePhysicalBatch observed = await ArticleScaleWriterDifferential.ObserveIsolatedRootAsync(
            connection, DataScaleBulkProvider.Sqlite, model, cancellation.Token);
        Assert.Equal("extra-row", Assert.Single(ArticleScaleWriterDifferential.Compare(model, observed).Differences).Kind);
    }

    [Fact]
    public async Task ReadbackChecksUnprojectedPublicationRowsAndPreservesLogicalReferences()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "CREATE TABLE article(Id INTEGER PRIMARY KEY, PayloadJson TEXT); INSERT INTO article VALUES (1, '{}'); CREATE TABLE article_publication(Id INTEGER PRIMARY KEY);";
        await command.ExecuteNonQueryAsync();
        DataScaleArticlePhysicalBatch model = Batch("PayloadJson", "{}") with
        {
            LogicalReferences = [new(ArticleScaleRowKind.ArticleTaxonomyReference, "canonical/article/1/taxonomy", new Dictionary<string, object?>())]
        };
        string[] roster = ["article", "article_publication"];
        DataScaleArticlePhysicalBatch observed = await ArticleScaleWriterDifferential.ObserveIsolatedRootAsync(
            connection, DataScaleBulkProvider.Sqlite, model, CancellationToken.None, roster);
        Assert.Same(model.LogicalReferences, observed.LogicalReferences);
        Assert.False(ArticleScaleWriterDifferential.Compare(model, observed).QualificationEligible);

        command.CommandText = "INSERT INTO article_publication VALUES (991);";
        await command.ExecuteNonQueryAsync();
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            ArticleScaleWriterDifferential.ObserveIsolatedRootAsync(connection, DataScaleBulkProvider.Sqlite,
                model, CancellationToken.None, roster));
        Assert.Equal("differential_unprojected_table_contains_rows:article_publication", failure.Message);
    }

    [Fact]
    public async Task ReadbackRefusesIncompleteDuplicateOrUnsafeTableRosters()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        foreach (string[] roster in new[] { Array.Empty<string>(), new[] { "article", "article" } })
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => ArticleScaleWriterDifferential.ObserveIsolatedRootAsync(
                connection, DataScaleBulkProvider.Sqlite, Batch("PayloadJson", "{}"), CancellationToken.None, roster));
        }
        await Assert.ThrowsAsync<ArgumentException>(() => ArticleScaleWriterDifferential.ObserveIsolatedRootAsync(
            connection, DataScaleBulkProvider.Sqlite, Batch("PayloadJson", "{}"), CancellationToken.None,
            ["article", "publication; DELETE FROM article"]));
    }

    [Fact]
    public async Task UnprojectedTableProbeHonorsCancellation()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ArticleScaleWriterDifferential.ObserveIsolatedRootAsync(
            connection, DataScaleBulkProvider.Sqlite, Batch("PayloadJson", "{}"), cancellation.Token, ["article", "article_publication"]));
    }

    [Fact]
    public async Task IndependentReadbackRefusesAnUnprojectedProductionColumn()
    {
        using var cancellation = new CancellationTokenSource();
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync(cancellation.Token);
        await using var command = connection.CreateCommand();
        command.CommandText = "CREATE TABLE article(Id INTEGER PRIMARY KEY, PayloadJson TEXT, NewBusinessField TEXT);";
        await command.ExecuteNonQueryAsync(cancellation.Token);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            ArticleScaleWriterDifferential.ObserveIsolatedRootAsync(connection, DataScaleBulkProvider.Sqlite,
                Batch("PayloadJson", "{}"), cancellation.Token));
        Assert.Contains("differential_database_schema_drift", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ExplicitNativeRoleMappingNormalizesKeysWithoutIgnoringBusinessValues()
    {
        ArticleScaleDifferentialIdentityBindings Identities(long id)
            => new(new Dictionary<string, IReadOnlyDictionary<long, string>>
            {
                ["article"] = new Dictionary<long, string> { [id] = "fixture:article/1" }
            },
                new Dictionary<string, IReadOnlyDictionary<string, string>>());
        DataScaleArticlePhysicalBatch left = Batch("CreatedAt", "exact-instant", 1);
        DataScaleArticlePhysicalBatch right = Batch("CreatedAt", "exact-instant", 99);
        ArticleScaleWriterDifferentialResult equal = ArticleScaleWriterDifferential.Compare(left, right, Identities(1), Identities(99));
        Assert.True(equal.IdentityNormalizedEquivalent);
        Assert.False(equal.PhysicalEquivalent);
        Assert.False(equal.QualificationEligible);
        ArticleScaleWriterDifferentialResult drift = ArticleScaleWriterDifferential.Compare(left,
            Batch("CreatedAt", "different-instant", 99), Identities(1), Identities(99));
        Assert.Equal("CreatedAt", Assert.Single(drift.Differences).Field);
        Assert.Throws<InvalidOperationException>(() => ArticleScaleWriterDifferential.Compare(left, right, Identities(1)));
        Assert.Throws<InvalidOperationException>(() => ArticleScaleWriterDifferential.Compare(left, right, Identities(1), Identities(98)));
    }

    [Fact]
    public void IdentityDispositionsCannotHideBusinessStatusDrift()
    {
        var columns = new DataScaleBulkColumn[] { new("Id", DbType.Int64), new("CurrentRevisionId", DbType.Int64), new("Status", DbType.Int32) };
        DataScaleArticlePhysicalBatch BatchWithPointer(long id, long revision, int status)
            => new([new("article", columns, [new object?[] { id, revision, status }])],
                new Dictionary<string, int> { ["article"] = 0 }, [], new Dictionary<string, long>());
        ArticleScaleDifferentialIdentityBindings Roles(long id, long revision, bool normalizeStatus = false)
            => new(new Dictionary<string, IReadOnlyDictionary<long, string>>
            {
                ["article"] = new Dictionary<long, string> { [id] = "article-role" },
                ["revision"] = new Dictionary<long, string> { [revision] = "revision-role" }
            }, new Dictionary<string, IReadOnlyDictionary<string, string>>
            {
                ["article"] = normalizeStatus
                    ? new Dictionary<string, string> { ["CurrentRevisionId"] = "revision", ["Status"] = "revision" }
                    : new Dictionary<string, string> { ["CurrentRevisionId"] = "revision" }
            });
        DataScaleArticlePhysicalBatch left = BatchWithPointer(1, 11, 2);
        DataScaleArticlePhysicalBatch right = BatchWithPointer(88, 899, 2);
        Assert.True(ArticleScaleWriterDifferential.Compare(left, right, Roles(1, 11), Roles(88, 899)).IdentityNormalizedEquivalent);
        Assert.Equal("Status", Assert.Single(ArticleScaleWriterDifferential.Compare(left, BatchWithPointer(88, 899, 1),
            Roles(1, 11), Roles(88, 899)).Differences).Field);
        Assert.Throws<InvalidOperationException>(() => ArticleScaleWriterDifferential.Compare(left, right,
            Roles(1, 11, true), Roles(88, 899, true)));
    }

    [Fact]
    public void DuplicateKeysAndTruncatedRowsAreRefused()
    {
        DataScaleArticlePhysicalBatch batch = Batch("PayloadJson", "{}");
        DataScaleBulkTableRows table = batch.Tables[0];
        Assert.Throws<InvalidOperationException>(() => ArticleScaleWriterDifferential.Compare(batch,
            batch with
            {
                Tables = [table with { Rows = [table.Rows[0], table.Rows[0]] }]
            }));
        Assert.Throws<InvalidOperationException>(() => ArticleScaleWriterDifferential.Compare(batch,
            batch with
            {
                Tables = [table with { Rows = [new object?[] { 1L }] }]
            }));
    }

    private static DataScaleArticlePhysicalBatch Batch(string field, object? value, long id = 1)
        => new([new("article", [new("Id", DbType.Int64), new(field, DbType.String)], [new object?[] { id, value }])],
            new Dictionary<string, int> { ["article"] = 0 }, [], new Dictionary<string, long>());
}
