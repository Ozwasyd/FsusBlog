using System.Data;
using System.Globalization;
using System.Reflection;

using FsusBlog.Contracts.Schema;
using FsusBlog.Migration;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Tests.TestInfrastructure;

using Npgsql;

namespace FsusBlog.Server.Tests.Integration;

// Native component coverage, not successful whole-checkpoint recovery. That
// route still requires the original complete registry and committed media unit.
// No fixture constructor manufactures an owned target or nonarticle capability.
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class PgLegacyNonArticleRecoveryIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task OriginalNativeCapabilityRejectsASameCountCurrentCellChange()
    {
        OwnedCurrentSchemaTarget owned = await InvokeOriginalOwnerAsync();
        string connectionString = await CreateOriginalLegacyDatabaseAsync();
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead);
        PgLegacyNonArticlePreparation prepared = await MigrateOriginalAsync(owned, connection, transaction);
        await prepared.RevalidateAsync(connection, transaction, CancellationToken.None);

        SchemaTableModel config = Table(owned, "SystemConfig");
        SchemaColumnModel key = Column(config, "SystemConfig", "Key");
        SchemaColumnModel value = Column(config, "SystemConfig", "Value");
        long before = await CountAsync(connection, transaction, config);
        await using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = "UPDATE public." + Quote(config.Name) + " SET " + Quote(value.Name)
                + "=@value WHERE " + Quote(key.Name) + "=@key";
            command.Parameters.AddWithValue("value", "same-count-tampered-title");
            command.Parameters.AddWithValue("key", "SiteTitle");
            Assert.Equal(1, await command.ExecuteNonQueryAsync());
        }
        Assert.Equal(before, await CountAsync(connection, transaction, config));
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            prepared.RevalidateAsync(connection, transaction, CancellationToken.None));
        Assert.Equal("legacy_nonarticle_readback_mismatch:FsusBlog.Server.Entities.SystemConfig", error.Message);
        // Original caller owns rollback; the production component never commits.
        await transaction.RollbackAsync();
    }

    [Theory]
    [InlineData(100, false)]
    [InlineData(101, true)]
    [InlineData(102, true)]
    public async Task OriginalNativeCapabilityChecksTheCapturedUserSequenceFloor(long next, bool valid)
    {
        OwnedCurrentSchemaTarget owned = await InvokeOriginalOwnerAsync();
        string connectionString = await CreateOriginalLegacyDatabaseAsync();
        // This is the original fixture's historical sequence, before capture.
        // The private production capability must measure its real next value.
        await fixture.ExecuteAsync(connectionString, "ALTER SEQUENCE public.sys_user_id_seq RESTART WITH 101");
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead);
        PgLegacyNonArticlePreparation prepared = await MigrateOriginalAsync(owned, connection, transaction);
        await prepared.RevalidateAsync(connection, transaction, CancellationToken.None);

        SchemaTableModel user = Table(owned, "User");
        SchemaColumnModel id = Column(user, "User", "Id");
        SchemaOwnedSequenceModel sequence = owned.ProjectExpectedPhysicalTarget(SchemaProviderKind.PostgreSql)
            .Tables.Tables[user.Name].Columns[id.Name].OwnedSequence
            ?? throw new InvalidOperationException("original_user_sequence_missing");
        await using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = "ALTER SEQUENCE " + Quote(sequence.Schema) + "." + Quote(sequence.Name)
                + " RESTART WITH " + next.ToString(CultureInfo.InvariantCulture);
            await command.ExecuteNonQueryAsync();
        }
        if (valid)
        {
            await prepared.RevalidateAsync(connection, transaction, CancellationToken.None);
        }
        else
        {
            InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                prepared.RevalidateAsync(connection, transaction, CancellationToken.None));
            Assert.Equal("legacy_current_account_sequence_rewound", error.Message);
        }
        await transaction.RollbackAsync();
    }

    private static async Task<OwnedCurrentSchemaTarget> InvokeOriginalOwnerAsync()
    {
        // Consume the original current owner's compiled assembly and its real
        // source metadata. InvokeOriginalOwner independently checks the PE stamp,
        // Shared bytes, runtime sidecars and complete producer before/after list.
        Assembly original = typeof(SqlSugarInitializer).Assembly;
        string revision = original.GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(attribute => attribute.Key == "FsusBlog.SourceCommit").Value
            ?? throw new InvalidOperationException("original_current_source_commit_missing");
        string evidence = Path.Combine(BackendTestPaths.RepositoryRoot, ".tmp",
            "1761-pg-nonarticle-integration", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(evidence);
        // Keep original raw producer evidence on either success or failure.
        // Missing/mismatched producer inputs fail; do not copy a foreign binary,
        // substitute an observed schema, skip export or fall back to a DTO.
        return await OwnedCurrentSchemaTarget.InvokeOriginalOwnerAsync(
            original.Location, revision, evidence, CancellationToken.None);
    }

    private async Task<string> CreateOriginalLegacyDatabaseAsync()
    {
        string database = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(database);
        await fixture.ExecuteAsync(connectionString, BackendTestPaths.ReadAllTextFromRoot(
            "tests", "backend", "Fixtures", "legacy-20260517-minimal.sql"));
        return connectionString;
    }

    private static async Task<PgLegacyNonArticlePreparation> MigrateOriginalAsync(
        OwnedCurrentSchemaTarget owned, NpgsqlConnection connection, NpgsqlTransaction transaction)
    {
        await OfflineMigrationStateStore.EnsureApplyJournalAsync(connection, transaction, CancellationToken.None);
        OfflineMigrationSourceObservation source = await new OfflineMigrationSourceObserver()
            .ObserveLegacyAfterValidatedJournalAsync(connection, transaction, CancellationToken.None);
        Assert.Equal(OfflineMigrationSourceFingerprints.LegacyId,
            OfflineMigrationSourceFingerprints.CreateRegistry().Match(source).Id);
        PgLegacyCurrentSchemaPreparation staged = await PgLegacyCurrentSchemaPreparation.StageAsync(
            owned, source, connection, transaction, CancellationToken.None);
        return await PgLegacyNonArticlePreparation.MigrateAsync(staged, connection, transaction, CancellationToken.None);
    }

    private static SchemaTableModel Table(OwnedCurrentSchemaTarget owned, string entity)
        => owned.ReadBoundInput().EntityProjection.Schema.Tables.Values
            .Single(table => table.Owner?.Owner == "FsusBlog.Server.Entities." + entity);

    private static SchemaColumnModel Column(SchemaTableModel table, string entity, string property)
        => table.Columns.Values.Single(column =>
            column.Owner?.Owner == "FsusBlog.Server.Entities." + entity + "." + property);

    private static async Task<long> CountAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, SchemaTableModel table)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT COUNT(*) FROM public." + Quote(table.Name);
        return Convert.ToInt64(await command.ExecuteScalarAsync(), CultureInfo.InvariantCulture);
    }

    private static string Quote(string value) => SchemaMigrationSql.QuoteIdentifier(value);
}
