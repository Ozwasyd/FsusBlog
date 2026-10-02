using System.Data;
using System.Data.Common;

using SqlSugar;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;
using FsusBlog.Contracts.SchemaMigration;
using FsusBlog.Shared.Algorithms.Schema;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

/// <summary>Fresh complete native schema/effect evidence and the single entity-plus-recipe target identity.</summary>
public sealed record CurrentSchemaReadObservation(
    CurrentSchemaIdentity CanonicalIdentity,
    SchemaModelSnapshot ActualSchema,
    string ActualDigest);

/// <summary>Observes current facts without DDL, backfill, journal/history interpretation or receipt issuance.</summary>
public sealed class CurrentSchemaReadObserver(ISqlSugarClient db, ISchemaModelInspector inspector)
{
    private readonly Func<CancellationToken, Task<PgCurrentSchemaNativeObservation>>? _testNativeReader;

    // A unit-only native-fact seam: production admission cannot construct or consume this reader.
    internal CurrentSchemaReadObserver(ISchemaModelInspector inspector,
        Func<CancellationToken, Task<PgCurrentSchemaNativeObservation>> testNativeReader)
        : this(null!, inspector)
    {
        _testNativeReader = testNativeReader;
    }

    /// <summary>Reads the database tuple and complete current facts on the same actual read-only native RR snapshot.</summary>
    public async Task<CurrentSchemaAdmissionObservation> ReadAdmissionAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (_testNativeReader is not null)
        {
            throw new InvalidOperationException("current_schema_native_admission_requires_actual_database");
        }
        (PgCurrentSchemaNativeObservation native, CurrentSchemaDatabaseIdentity database) =
            await ReadNativeAsync(cancellationToken).ConfigureAwait(false);
        CurrentSchemaReadObservation schema = CompareObservation(native);
        CurrentSchemaIdentity identity = schema.CanonicalIdentity;
        return new CurrentSchemaAdmissionObservation(
            new CurrentSchemaTargetIdentity(identity.ModelVersion, identity.ExtractorVersion, identity.GeneratorVersion,
                identity.SourceDigest, identity.ContentDigest), database, schema.ActualDigest);
    }

    /// <summary>Reads complete native relational/effect facts and rejects missing, unknown or altered current recipes.</summary>
    public async Task<CurrentSchemaReadObservation> ReadAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        PgCurrentSchemaNativeObservation native;
        try
        {
            native = _testNativeReader is not null
                ? await _testNativeReader(cancellationToken).ConfigureAwait(false)
                : (await ReadNativeAsync(cancellationToken).ConfigureAwait(false)).Native;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            CurrentSchemaIdentity expected = Expected().Identity;
            throw new CurrentSchemaMismatchException(expected.ContentDigest, "unavailable",
                "fsusblog.current-schema.mismatch.unreadable",
                [$"actual complete schema/effects could not be read without writes: {exception.GetType().Name}"]);
        }
        cancellationToken.ThrowIfCancellationRequested();
        return CompareObservation(native);
    }

    private (CurrentSchemaIdentity Identity, CurrentSchemaCompletePhysicalProjection Physical) Expected()
    {
        CurrentSchemaCanonicalModel canonical = inspector.BuildCanonicalModel(inspector.GetManagedEntityTypes());
        CurrentSchemaProjection entity = CurrentSchemaCanonicalAuthority.Generate(canonical);
        IReadOnlyList<CurrentSchemaRequiredRecipeReference> recipes = CurrentSchemaOwnedProjectionExporter.DescribeRequiredRecipes();
        return (CurrentSchemaOwnedTargetProjection.Observe(entity, recipes),
            CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(entity, recipes, SchemaProviderKind.PostgreSql));
    }

    private CurrentSchemaReadObservation CompareObservation(PgCurrentSchemaNativeObservation native)
    {
        (CurrentSchemaIdentity identity, CurrentSchemaCompletePhysicalProjection expected) = Expected();
        string actualDigest = CurrentSchemaCanonicalAuthority.ComputeObservationDigest(native.Tables.Tables);
        IReadOnlyList<string> errors;
        try
        {
            errors = PgCurrentSchemaNativeObserver.Compare(expected, native.Tables, native.Effects);
        }
        catch (InvalidOperationException exception)
        {
            errors = [exception.Message];
        }
        if (errors.Count > 0)
        {
            throw new CurrentSchemaMismatchException(identity.ContentDigest, actualDigest,
                "fsusblog.current-schema.mismatch", errors);
        }
        return new CurrentSchemaReadObservation(identity, native.Tables, actualDigest);
    }

    private async Task<(PgCurrentSchemaNativeObservation Native, CurrentSchemaDatabaseIdentity Database)> ReadNativeAsync(
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (db.CurrentConnectionConfig.DbType != SqlSugar.DbType.PostgreSQL
            || db.Ado.Connection is not DbConnection connection
            || connection.GetType().FullName != "Npgsql.NpgsqlConnection"
            || db.Ado.Transaction is not null)
        {
            throw new InvalidOperationException("current_schema_provider_snapshot_unavailable");
        }
        bool opened = connection.State == ConnectionState.Closed;
        try
        {
            if (opened)
            {
                await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
            }
            await using DbTransaction transaction = await connection.BeginTransactionAsync(
                IsolationLevel.RepeatableRead, cancellationToken).ConfigureAwait(false);
            await using (DbCommand readOnly = connection.CreateCommand())
            {
                readOnly.Transaction = transaction;
                readOnly.CommandText = "SET TRANSACTION READ ONLY;";
                await readOnly.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            }
            CurrentSchemaDatabaseIdentity before = await ReadDatabaseIdentityAsync(
                connection, transaction, cancellationToken).ConfigureAwait(false);
            PgCurrentSchemaNativeObservation native = await PgCurrentSchemaNativeObserver.ReadAsync(
                connection, transaction, cancellationToken).ConfigureAwait(false);
            CurrentSchemaDatabaseIdentity after = await ReadDatabaseIdentityAsync(
                connection, transaction, cancellationToken).ConfigureAwait(false);
            if (before != after)
            {
                throw new InvalidOperationException("current_schema_database_identity_changed");
            }
            // Read-only transaction disposal is actually awaited. No commit, DDL, journal or repair path exists here.
            return (native, after);
        }
        finally
        {
            if (opened)
            {
                await connection.CloseAsync().ConfigureAwait(false);
            }
        }
    }

    private static async Task<CurrentSchemaDatabaseIdentity> ReadDatabaseIdentityAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        await using DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            SELECT control.system_identifier::text AS instance_id,
                   current_database()::text AS database_name,
                   database_identity.oid::text AS database_oid
            FROM pg_catalog.pg_control_system() AS control
            CROSS JOIN pg_catalog.pg_database AS database_identity
            WHERE database_identity.datname = current_database();
            """;
        await using DbDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException("current_schema_database_identity_unobserved");
        }
        var identity = new CurrentSchemaDatabaseIdentity(CurrentSchemaProviderKind.PostgreSql,
            reader.GetString(0), $"{reader.GetString(2)}/{reader.GetString(1)}");
        if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException("current_schema_database_identity_unobserved");
        }
        CurrentSchemaReceiptCodec.ValidateDatabase(identity);
        return identity;
    }
}
