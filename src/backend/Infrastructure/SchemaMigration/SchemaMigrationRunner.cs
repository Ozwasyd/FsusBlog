using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public interface ISchemaMigrationRunner
{
    Task RunAsync(CancellationToken cancellationToken);
}

public sealed class CurrentSchemaMismatchException : InvalidOperationException
{
    public CurrentSchemaMismatchException(
        string expectedDigest,
        string actualDigest,
        string mismatchRef,
        IReadOnlyList<string> errors)
        : base(
            $"schema_current_mismatch ref={mismatchRef} expectedDigest={expectedDigest} actualDigest={actualDigest}{FormatErrors(errors)}")
    {
        ExpectedDigest = expectedDigest;
        ActualDigest = actualDigest;
        MismatchRef = mismatchRef;
        Errors = errors;
    }

    public string ExpectedDigest
    {
        get;
    }

    public string ActualDigest
    {
        get;
    }

    public string MismatchRef
    {
        get;
    }

    public IReadOnlyList<string> Errors
    {
        get;
    }

    private static string FormatErrors(IReadOnlyList<string> errors)
        => errors.Count == 0
            ? string.Empty
            : $"{Environment.NewLine}- {string.Join($"{Environment.NewLine}- ", errors)}";
}

public sealed class CurrentSchemaStartupVerifier(
    ISqlSugarClient db,
    ISchemaModelInspector inspector) : ISchemaMigrationRunner
{
    internal const string HistoryTableName = "__fsus_schema_migration_history";

    private static readonly string[] s_allowedExtraTables =
    [
        HistoryTableName,
        "article_view_projection_watermark",
        "article_asset_cleanup_queue",
        "article_asset_reference",
        "asset_library_article_ref",
        "asset_library_item",
        "sys_visit_log",
        "__fsus_schema_online_state",
        "__fsus_schema_backfill_progress"
    ];

    public async Task RunAsync(CancellationToken cancellationToken)
    {
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

        string actualDigest = CurrentSchemaCanonicalAuthority.ComputeObservationDigest(actual.Tables);
        IReadOnlyList<string> errors = SchemaModelComparer.Compare(
            expected,
            actual,
            s_allowedExtraTables,
            SchemaAllowedExtraLinkNames.Names,
            CurrentSchemaRuntimeRollupTables.TableNames);
        if (errors.Count > 0)
        {
            throw new CurrentSchemaMismatchException(
                canonical.Identity.ContentDigest,
                actualDigest,
                "fsusblog.current-schema.mismatch",
                errors);
        }
    }
}
