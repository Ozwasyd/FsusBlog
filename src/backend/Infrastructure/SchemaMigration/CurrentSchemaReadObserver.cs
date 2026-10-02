using System.Data;

using SqlSugar;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;
using FsusBlog.Contracts.SchemaMigration;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

/// <summary>Fresh physical schema evidence with the independently derived canonical target identity.</summary>
public sealed record CurrentSchemaReadObservation(
    CurrentSchemaIdentity CanonicalIdentity,
    SchemaModelSnapshot ActualSchema,
    string ActualDigest);

/// <summary>
/// Observes the current schema without issuing DDL, backfill or history writes.
/// This is schema evidence, not a migration receipt or startup admission.
/// </summary>
public sealed class CurrentSchemaReadObserver(
    ISqlSugarClient db,
    ISchemaModelInspector inspector)
{
    /// <summary>Reads current schema and rejects native database identity changes across that observation.</summary>
    public async Task<CurrentSchemaAdmissionObservation> ReadAdmissionAsync(CancellationToken cancellationToken)
    {
        CurrentSchemaDatabaseIdentity before = await ReadDatabaseIdentityAsync(cancellationToken).ConfigureAwait(false);
        CurrentSchemaReadObservation schema = await ReadAsync(cancellationToken).ConfigureAwait(false);
        CurrentSchemaDatabaseIdentity after = await ReadDatabaseIdentityAsync(cancellationToken).ConfigureAwait(false);
        if (before != after)
        {
            throw new InvalidOperationException("current_schema_database_identity_changed");
        }
        CurrentSchemaIdentity identity = schema.CanonicalIdentity;
        return new CurrentSchemaAdmissionObservation(
            new CurrentSchemaTargetIdentity(
                identity.ModelVersion,
                identity.ExtractorVersion,
                identity.GeneratorVersion,
                identity.SourceDigest,
                identity.ContentDigest),
            after,
            schema.ActualDigest);
    }

    private async Task<CurrentSchemaDatabaseIdentity> ReadDatabaseIdentityAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (db.CurrentConnectionConfig.DbType != SqlSugar.DbType.PostgreSQL)
        {
            throw new InvalidOperationException("current_schema_provider_observer_unsupported");
        }
        DataTable rows = await db.Ado.GetDataTableAsync("""
            SELECT control.system_identifier::text AS instance_id,
                   current_database()::text AS database_name,
                   database_identity.oid::text AS database_oid
            FROM pg_catalog.pg_control_system() AS control
            CROSS JOIN pg_catalog.pg_database AS database_identity
            WHERE database_identity.datname = current_database();
            """).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (rows.Rows.Count != 1)
        {
            throw new InvalidOperationException("current_schema_database_identity_unobserved");
        }
        DataRow row = rows.Rows[0];
        var identity = new CurrentSchemaDatabaseIdentity(
            CurrentSchemaProviderKind.PostgreSql,
            Convert.ToString(row["instance_id"])!,
            $"{Convert.ToString(row["database_oid"])}/{Convert.ToString(row["database_name"])}");
        CurrentSchemaReceiptCodec.ValidateDatabase(identity);
        return identity;
    }

    private static readonly string[] s_allowedExtraTables =
    [
        CurrentSchemaStartupVerifier.HistoryTableName,
        "article_view_projection_watermark",
        "article_asset_cleanup_queue",
        "article_asset_reference",
        "asset_library_article_ref",
        "asset_library_item",
        "authoring_canvas_operation_journal",
        "authoring_canvas_operation_command",
        "authoring_canvas_operation_command_fact",
        "authoring_canvas_operation_history_state",
        "authoring_canvas_operation_fact",
        "authoring_canvas_operation_receipt",
        "sys_visit_log",
        "__fsus_schema_online_state",
        "__fsus_schema_backfill_progress"
    ];

    /// <summary>Compares a fresh schema observation with the original canonical authority without modifying the database.</summary>
    public async Task<CurrentSchemaReadObservation> ReadAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        IReadOnlyList<Type> entityTypes = inspector.GetManagedEntityTypes();
        CurrentSchemaCanonicalModel canonical = inspector.BuildCanonicalModel(entityTypes);
        SchemaModelSnapshot expected = CurrentSchemaCanonicalAuthority.ProjectProvider(
            canonical,
            SchemaProviderKind.PostgreSql);
        SchemaModelSnapshot actual;
        try
        {
            actual = await inspector.ReadActualModelAsync(db, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            throw new CurrentSchemaMismatchException(
                canonical.Identity.ContentDigest,
                "unavailable",
                "fsusblog.current-schema.mismatch.unreadable",
                [$"actual schema could not be read without writes: {exception.GetType().Name}"]);
        }

        cancellationToken.ThrowIfCancellationRequested();
        string actualDigest = CurrentSchemaCanonicalAuthority.ComputeObservationDigest(actual.Tables);
        IReadOnlyList<string> errors = SchemaModelComparer.Compare(
            expected,
            actual,
            s_allowedExtraTables,
            SchemaAllowedExtraLinkNames.Names,
            CurrentSchemaRuntimeRollupTables.TableNames);
        if (actual.Provider != SchemaProviderKind.PostgreSql)
        {
            errors = [.. errors, "actual schema provider is not PostgreSQL"];
        }
        if (errors.Count > 0)
        {
            throw new CurrentSchemaMismatchException(
                canonical.Identity.ContentDigest,
                actualDigest,
                "fsusblog.current-schema.mismatch",
                errors);
        }

        return new CurrentSchemaReadObservation(canonical.Identity, actual, actualDigest);
    }
}
