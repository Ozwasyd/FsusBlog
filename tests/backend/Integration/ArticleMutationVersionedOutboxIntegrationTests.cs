using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;

namespace FsusBlog.Server.Tests;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleMutationVersionedOutboxIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task ExpandMigration_BackfillsLegacyCoordinatesOnPostgresAndIsIdempotent()
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(databaseName);
        await fixture.ExecuteAsync(connectionString, """
            CREATE TABLE article_mutation_outbox (
                id bigint PRIMARY KEY,
                aggregate_id integer NOT NULL,
                article_revision_id bigint NULL,
                revision_no integer NULL,
                responsibility_snapshot_id bigint NULL,
                article_publication_id bigint NULL
            );
            CREATE TABLE article_publication (
                id bigint PRIMARY KEY,
                rights_snapshot_id bigint NOT NULL,
                responsibility_snapshot_id bigint NULL
            );
            CREATE TABLE article_responsibility_snapshot (
                id bigint PRIMARY KEY,
                responsibility_version integer NOT NULL
            );
            INSERT INTO article_publication(id, rights_snapshot_id, responsibility_snapshot_id)
            VALUES (401, 201, 301);
            INSERT INTO article_responsibility_snapshot(id, responsibility_version)
            VALUES (301, 7);
            INSERT INTO article_mutation_outbox(
                id, aggregate_id, article_revision_id, revision_no,
                responsibility_snapshot_id, article_publication_id)
            VALUES (1, 1215, 101, 1, NULL, 401);
            """);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        ISchemaMigrationDescriptor migration = ArticleMutationOutboxVersionMigrationDefinitions.BuildMigration();

        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }

        Assert.Equal(1, await fixture.QueryScalarAsync<int>(
            connectionString,
            "SELECT schema_version FROM article_mutation_outbox WHERE id = 1;"));
        Assert.Equal(201, await fixture.QueryScalarAsync<long>(
            connectionString,
            "SELECT rights_snapshot_id FROM article_mutation_outbox WHERE id = 1;"));
        Assert.Equal(301, await fixture.QueryScalarAsync<long>(
            connectionString,
            "SELECT responsibility_snapshot_id FROM article_mutation_outbox WHERE id = 1;"));
        Assert.Equal(7, await fixture.QueryScalarAsync<int>(
            connectionString,
            "SELECT responsibility_version FROM article_mutation_outbox WHERE id = 1;"));
        Assert.True(await fixture.IndexExistsAsync(
            connectionString,
            "idx_article_mutation_outbox_version_coordinate"));
    }

    [Fact]
    public async Task ContinuousUpdates_OutOfOrderReplayUsesPersistedPostgresCoordinates()
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(databaseName);
        await fixture.ExecuteAsync(connectionString, """
            CREATE TABLE article (
                id integer PRIMARY KEY,
                current_revision_id bigint NULL,
                current_publication_id bigint NULL
            );
            CREATE TABLE article_revision (
                id bigint PRIMARY KEY,
                article_id integer NOT NULL,
                revision_no integer NOT NULL
            );
            CREATE TABLE article_rights_snapshot (
                id bigint PRIMARY KEY,
                article_id integer NOT NULL,
                article_revision_id bigint NOT NULL
            );
            CREATE TABLE article_responsibility_snapshot (
                id bigint PRIMARY KEY,
                article_id integer NOT NULL,
                article_revision_id bigint NOT NULL,
                responsibility_version integer NOT NULL
            );
            CREATE TABLE article_publication (
                id bigint PRIMARY KEY,
                article_id integer NOT NULL,
                publication_no integer NOT NULL,
                article_revision_id bigint NOT NULL,
                revision_no integer NOT NULL,
                rights_snapshot_id bigint NOT NULL,
                responsibility_snapshot_id bigint NULL
            );

            INSERT INTO article_revision(id, article_id, revision_no)
            VALUES (101, 1215, 1), (102, 1215, 2);
            INSERT INTO article_rights_snapshot(id, article_id, article_revision_id)
            VALUES (201, 1215, 101), (202, 1215, 102);
            INSERT INTO article_responsibility_snapshot(
                id, article_id, article_revision_id, responsibility_version)
            VALUES (301, 1215, 101, 1), (302, 1215, 102, 2);
            INSERT INTO article_publication(
                id, article_id, publication_no, article_revision_id, revision_no,
                rights_snapshot_id, responsibility_snapshot_id)
            VALUES
                (401, 1215, 1, 101, 1, 201, 301),
                (402, 1215, 2, 102, 2, 202, 302);
            INSERT INTO article(id, current_revision_id, current_publication_id)
            VALUES (1215, 102, 402);
            """);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);

        ArticleMutationVersionDisposition oldDisposition = await ArticleMutationOutboxVersionGuard.EvaluateAsync(
            db,
            Envelope(101, 1, 201, 301, 1, 401, 1),
            CancellationToken.None);
        ArticleMutationVersionDisposition currentDisposition = await ArticleMutationOutboxVersionGuard.EvaluateAsync(
            db,
            Envelope(102, 2, 202, 302, 2, 402, 2),
            CancellationToken.None);

        Assert.Equal(ArticleMutationVersionDispositionKind.Skip, oldDisposition.Kind);
        Assert.Equal("superseded-by-release:402", oldDisposition.Reason);
        Assert.Equal(ArticleMutationVersionDispositionKind.Process, currentDisposition.Kind);
        Assert.Null(currentDisposition.Reason);
    }

    private static ArticleMutationOutboxEnvelope Envelope(
        long revisionId,
        int revisionNo,
        long rightsSnapshotId,
        long responsibilitySnapshotId,
        int responsibilityVersion,
        long releaseId,
        int releaseNo)
        => new(
            ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion,
            $"event-{releaseId}",
            1215,
            ArticleMutationEventTypes.Updated,
            new ArticleMutationVersionReference(
                revisionId,
                revisionNo,
                releaseId,
                releaseNo,
                responsibilitySnapshotId,
                rightsSnapshotId,
                responsibilityVersion),
            new ArticleMutationScopeChange(null, null),
            new DateTime(2026, 7, 20, 8, 0, 0, DateTimeKind.Utc));
}
