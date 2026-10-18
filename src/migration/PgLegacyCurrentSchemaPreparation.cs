using System.Data.Common;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;
using FsusBlog.Contracts.SchemaMigration;

namespace FsusBlog.Migration;

// Structural staging only. No registered legacy operation, completion receipt,
// commit or cleanup authority is exposed until every legacy data-domain owner
// has converted and verified its actual inputs on this original transaction.
internal sealed class PgLegacyCurrentSchemaPreparation
{
    private readonly DbConnection _connection;
    private readonly DbTransaction _transaction;
    private readonly string _quotedSchema;
    private readonly OwnedCurrentSchemaTarget _owned;

    private PgLegacyCurrentSchemaPreparation(DbConnection connection, DbTransaction transaction,
        string quotedSchema, OwnedCurrentSchemaTarget owned, OfflineMigrationSourceObservation source)
    {
        _connection = connection;
        _transaction = transaction;
        _quotedSchema = quotedSchema;
        _owned = owned;
        OriginalSource = source;
    }

    internal OfflineMigrationSourceObservation OriginalSource
    {
        get;
    }
    internal CurrentSchemaIdentity Target => _owned.Target;
    internal OwnedCurrentSchemaTarget OwnedTarget => _owned;
    internal string RequireRetainedSchemaName() => _quotedSchema[1..^1].Replace("\"\"", "\"", StringComparison.Ordinal);

    internal static async Task<PgLegacyCurrentSchemaPreparation> StageAsync(
        OwnedCurrentSchemaTarget owned, OfflineMigrationSourceObservation admittedSource,
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(owned);
        ArgumentNullException.ThrowIfNull(admittedSource);
        OfflineMigrationSourceObserver.RequirePostgreSqlStageSession(connection, transaction);
        await owned.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        CompiledCurrentSchemaBootstrap compiled = owned.Compile(SchemaProviderKind.PostgreSql);
        if (compiled.Commands.Count == 0)
            throw new InvalidOperationException("legacy_target_prepare_empty_owned_commands");
        var observer = new OfflineMigrationSourceObserver();
        OfflineMigrationSourceObservation before = await observer.ObserveLegacyAfterValidatedJournalAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        RequireUnchangedSource(admittedSource, before);

        // Native locks precede the second observation and every structural DDL.
        // This is not plan admission: the original executor still owns that
        // precondition, backup proof, journal, and final transaction boundary.
        string tables = string.Join(',', OfflineMigrationSourceFingerprints.LegacyTables
            .OrderBy(static table => table.Name, StringComparer.Ordinal)
            .Select(static table => "public." + SchemaMigrationSql.QuoteIdentifier(table.Name)));
        await ExecuteAsync(connection, transaction, "LOCK TABLE " + tables + " IN ACCESS EXCLUSIVE MODE", cancellationToken).ConfigureAwait(false);
        OfflineMigrationSourceObservation locked = await observer.ObserveLegacyAfterValidatedJournalAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        RequireUnchangedSource(before, locked);

        string quotedSchema = SchemaMigrationSql.QuoteIdentifier("__fsus_legacy_stage_" + Guid.NewGuid().ToString("N"));
        await ExecuteAsync(connection, transaction, "CREATE SCHEMA " + quotedSchema, cancellationToken).ConfigureAwait(false);
        foreach (OfflineMigrationSourceFingerprints.LegacyTable table in OfflineMigrationSourceFingerprints.LegacyTables
                     .OrderBy(static table => table.Name, StringComparer.Ordinal))
        {
            await ExecuteAsync(connection, transaction,
                "ALTER TABLE public." + SchemaMigrationSql.QuoteIdentifier(table.Name) + " SET SCHEMA " + quotedSchema,
                cancellationToken).ConfigureAwait(false);
        }

        // Only successful native moves can create this capability. Read all
        // original 49 fields and five sequence states through the sole framer;
        // changing the schema locator changes no content vocabulary or hash.
        var staged = new PgLegacyCurrentSchemaPreparation(connection, transaction, quotedSchema, owned, locked);
        await staged.RevalidateSourceAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await CurrentSchemaBootstrapCompiler.ExecuteAsync(compiled, connection, transaction, cancellationToken).ConfigureAwait(false);
        await staged.ReadStagedCurrentTargetAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await staged.RevalidateSourceAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        return staged;
    }

    internal string RequireOriginalSession(DbConnection connection, DbTransaction transaction)
    {
        OfflineMigrationSourceObserver.RequirePostgreSqlStageSession(connection, transaction);
        if (!ReferenceEquals(connection, _connection) || !ReferenceEquals(transaction, _transaction))
            throw new InvalidOperationException("legacy_target_prepare_stage_session_changed");
        return _quotedSchema;
    }

    internal async Task RevalidateSourceAsync(DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        _ = RequireOriginalSession(connection, transaction);
        string actual = await OfflineMigrationSourceObserver.ReadStagedLegacyContentAsync(this, connection, transaction, cancellationToken).ConfigureAwait(false);
        if (actual != OriginalSource.ContentDigest)
            throw new InvalidOperationException("legacy_target_prepare_staged_content_changed");
    }

    // A public-current domain observation inside an unfinished staging
    // transaction, not proof that the isolated historical domain was cleaned
    // or that a whole migration is eligible to commit or publish a receipt.
    internal async Task<CurrentSchemaAdmissionObservation> ReadStagedCurrentTargetAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        _ = RequireOriginalSession(connection, transaction);
        return await new PgCurrentSchemaOwnedTargetObserver(_owned).ObserveAsync(
            connection, transaction, OriginalSource.Database, cancellationToken).ConfigureAwait(false);
    }

    internal static void RequireUnchangedSource(OfflineMigrationSourceObservation expected, OfflineMigrationSourceObservation actual)
    {
        if (expected.Database != actual.Database || expected.ExtractorId != actual.ExtractorId
            || expected.ExtractorVersion != actual.ExtractorVersion || expected.ContentDigest != actual.ContentDigest
            || !OfflineMigrationPlanValidation.Equal(OfflineMigrationPlanValidation.NormalizeFacts(expected.Schema), OfflineMigrationPlanValidation.NormalizeFacts(actual.Schema))
            || !OfflineMigrationPlanValidation.Equal(OfflineMigrationPlanValidation.NormalizeFacts(expected.History), OfflineMigrationPlanValidation.NormalizeFacts(actual.History))
            || !OfflineMigrationPlanValidation.Equal(OfflineMigrationPlanValidation.NormalizeFacts(expected.BusinessShape), OfflineMigrationPlanValidation.NormalizeFacts(actual.BusinessShape)))
            throw new InvalidOperationException("legacy_target_prepare_source_changed");
    }

    private static async Task ExecuteAsync(DbConnection connection, DbTransaction transaction, string sql, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await using DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandTimeout = 30;
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }
}
