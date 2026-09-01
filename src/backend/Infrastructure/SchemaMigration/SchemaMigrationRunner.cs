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
        "daily_read_stats",
        "region_read_stats",
        "event_type_read_stats",
        "article_view_projection_watermark",
        "author_daily_read_stats",
        "author_route_stats",
        "author_rum_stats",
        "author_rum_page_type_stats",
        "author_rum_aot_source_stats",
        "author_aot_stats",
        "sys_deployment_fence",
        "sys_fenced_commit",
        "public_article_projection",
        "public_article_projection_backfill",
        "public_article_projection_shadow_mismatch",
        "comment_moderation_event",
        "plugin_registry",
        "theme_registry",
        "theme_config",
        "theme_activation",
        "theme_activation_history",
        "theme_asset",
        "customization_profile",
        "customization_version",
        "customization_draft",
        "customization_change_set",
        "authoring_canvas_document",
        "authoring_canvas_node",
        "authoring_canvas_frame_member",
        "authoring_canvas_edge",
        "authoring_canvas_receipt",
        "authoring_canvas_idempotency",
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
        IReadOnlyList<string> errors = SchemaModelComparer.Compare(expected, actual, s_allowedExtraTables);
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
