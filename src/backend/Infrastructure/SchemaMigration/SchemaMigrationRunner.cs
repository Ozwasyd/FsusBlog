using System.Data;
using System.Reflection;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public interface ISchemaMigrationRunner
{
    Task RunAsync(CancellationToken cancellationToken);
}

internal sealed record SchemaMigrationHistoryEntry(
    string MigrationId,
    string Checksum,
    DateTime AppliedAtUtc,
    string AppVersion,
    bool Succeeded);

public sealed class SchemaMigrationRunner(
    ISqlSugarClient db,
    ISchemaMigrationRegistry registry,
    ISchemaModelInspector inspector,
    ISchemaMigrationLock migrationLock,
    ILogger<SchemaMigrationRunner> logger) : ISchemaMigrationRunner
{
    internal const string HistoryTableName = "__fsus_schema_migration_history";

    private readonly ISqlSugarClient _db = db;
    private readonly ISchemaMigrationRegistry _registry = registry;
    private readonly ISchemaModelInspector _inspector = inspector;
    private readonly ISchemaMigrationLock _migrationLock = migrationLock;
    private readonly ILogger<SchemaMigrationRunner> _logger = logger;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        _db.DbMaintenance.CreateDatabase();
        await EnsureHistoryTableAsync(cancellationToken).ConfigureAwait(false);

        await using IAsyncDisposable schemaLock = await _migrationLock.AcquireAsync(cancellationToken).ConfigureAwait(false);
        await EnsureHistoryTableAsync(cancellationToken).ConfigureAwait(false);

        IReadOnlyList<ISchemaMigrationDescriptor> descriptors = ValidateAndSort(_registry.GetDescriptors());
        Dictionary<string, SchemaMigrationHistoryEntry> appliedHistory = await LoadHistoryAsync(cancellationToken).ConfigureAwait(false);
        ValidateAppliedChecksums(descriptors, appliedHistory);

        var executedDescriptors = new List<ISchemaMigrationDescriptor>();

        IReadOnlyList<Type> entityTypes = _inspector.GetManagedEntityTypes();

        await ExecutePhaseAsync(SchemaMigrationPhase.PreCodeFirst, descriptors, appliedHistory, executedDescriptors, cancellationToken).ConfigureAwait(false);

        _db.CodeFirst.InitTables([.. entityTypes]);

        await ExecutePhaseAsync(SchemaMigrationPhase.PostCodeFirst, descriptors, appliedHistory, executedDescriptors, cancellationToken).ConfigureAwait(false);

        await _inspector.ValidateAsync(
            _db,
            entityTypes,
            [
                HistoryTableName,
                "daily_read_stats",
                "region_read_stats",
                "event_type_read_stats",
                "article_view_projection_watermark",
                "asset_library_article_ref",
                "author_daily_read_stats",
                "author_route_stats",
                "author_rum_stats",
                "author_rum_page_type_stats",
                "author_rum_aot_source_stats",
                "author_aot_stats"
            ],
            cancellationToken).ConfigureAwait(false);

        if (executedDescriptors.Count > 0)
        {
            await PersistHistoryAsync(executedDescriptors, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task ExecutePhaseAsync(
        SchemaMigrationPhase phase,
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors,
        IReadOnlyDictionary<string, SchemaMigrationHistoryEntry> appliedHistory,
        List<ISchemaMigrationDescriptor> executedDescriptors,
        CancellationToken cancellationToken)
    {
        foreach (ISchemaMigrationDescriptor descriptor in descriptors)
        {
            if (descriptor.Phase != phase || appliedHistory.ContainsKey(descriptor.MigrationId))
            {
                continue;
            }

            _logger.LogInformation(
                "Applying schema migration {MigrationId} ({Phase}) with {StepCount} step(s).",
                descriptor.MigrationId,
                descriptor.Phase,
                descriptor.Steps.Count);

            if (descriptor.Transactional)
            {
                var result = await _db.Ado.UseTranAsync(async () =>
                {
                    for (int i = 0; i < descriptor.Steps.Count; i++)
                    {
                        await descriptor.Steps[i].ExecuteAsync(_db, cancellationToken).ConfigureAwait(false);
                    }
                }).ConfigureAwait(false);

                if (!result.IsSuccess)
                {
                    throw new InvalidOperationException(
                        $"Schema migration {descriptor.MigrationId} failed.",
                        result.ErrorException);
                }
            }
            else
            {
                for (int i = 0; i < descriptor.Steps.Count; i++)
                {
                    await descriptor.Steps[i].ExecuteAsync(_db, cancellationToken).ConfigureAwait(false);
                }
            }

            executedDescriptors.Add(descriptor);
        }
    }

    private static IReadOnlyList<ISchemaMigrationDescriptor> ValidateAndSort(IReadOnlyList<ISchemaMigrationDescriptor> descriptors)
    {
        string[] duplicates = descriptors
            .GroupBy(static descriptor => descriptor.MigrationId, StringComparer.Ordinal)
            .Where(static group => group.Count() > 1)
            .Select(static group => group.Key)
            .OrderBy(static id => id, StringComparer.Ordinal)
            .ToArray();

        if (duplicates.Length > 0)
        {
            throw new InvalidOperationException($"Duplicate schema migration ids found: {string.Join(", ", duplicates)}");
        }

        return descriptors
            .OrderBy(static descriptor => descriptor.Phase)
            .ThenBy(static descriptor => descriptor.MigrationId, StringComparer.Ordinal)
            .ToArray();
    }

    private static void ValidateAppliedChecksums(
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors,
        IReadOnlyDictionary<string, SchemaMigrationHistoryEntry> appliedHistory)
    {
        foreach (ISchemaMigrationDescriptor descriptor in descriptors)
        {
            if (!appliedHistory.TryGetValue(descriptor.MigrationId, out SchemaMigrationHistoryEntry? applied))
            {
                continue;
            }

            if (!string.Equals(applied.Checksum, descriptor.Checksum, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"Schema migration checksum mismatch for {descriptor.MigrationId}. Applied checksum {applied.Checksum} differs from current descriptor checksum {descriptor.Checksum}.");
            }
        }
    }

    private async Task EnsureHistoryTableAsync(CancellationToken cancellationToken)
    {
        await _db.Ado.ExecuteCommandAsync($"""
            CREATE TABLE IF NOT EXISTS {SchemaMigrationSql.QuoteIdentifier(HistoryTableName)} (
                migration_id varchar(160) PRIMARY KEY,
                checksum varchar(128) NOT NULL,
                applied_at_utc timestamp NOT NULL,
                app_version varchar(64) NOT NULL,
                succeeded boolean NOT NULL
            );
            """).ConfigureAwait(false);
    }

    private async Task<Dictionary<string, SchemaMigrationHistoryEntry>> LoadHistoryAsync(CancellationToken cancellationToken)
    {
        DataTable table = await _db.Ado.GetDataTableAsync($"""
            SELECT migration_id, checksum, applied_at_utc, app_version, succeeded
            FROM {SchemaMigrationSql.QuoteIdentifier(HistoryTableName)};
            """).ConfigureAwait(false);

        var history = new Dictionary<string, SchemaMigrationHistoryEntry>(StringComparer.Ordinal);
        foreach (DataRow row in table.Rows)
        {
            string migrationId = Convert.ToString(row["migration_id"]) ?? string.Empty;
            if (string.IsNullOrWhiteSpace(migrationId))
            {
                continue;
            }

            history[migrationId] = new SchemaMigrationHistoryEntry(
                migrationId,
                Convert.ToString(row["checksum"]) ?? string.Empty,
                Convert.ToDateTime(row["applied_at_utc"]),
                Convert.ToString(row["app_version"]) ?? string.Empty,
                Convert.ToBoolean(row["succeeded"]));
        }

        return history;
    }

    private async Task PersistHistoryAsync(IReadOnlyList<ISchemaMigrationDescriptor> executedDescriptors, CancellationToken cancellationToken)
    {
        string appVersion = ResolveAppVersion();
        DateTime appliedAtUtc = DateTime.UtcNow;

        var result = await _db.Ado.UseTranAsync(async () =>
        {
            for (int i = 0; i < executedDescriptors.Count; i++)
            {
                ISchemaMigrationDescriptor descriptor = executedDescriptors[i];
                await _db.Ado.ExecuteCommandAsync(
                    $"""
                    INSERT INTO {SchemaMigrationSql.QuoteIdentifier(HistoryTableName)}(
                        migration_id, checksum, applied_at_utc, app_version, succeeded
                    )
                    VALUES (@migration_id, @checksum, @applied_at_utc, @app_version, @succeeded)
                    ON CONFLICT (migration_id) DO UPDATE
                    SET checksum = EXCLUDED.checksum,
                        applied_at_utc = EXCLUDED.applied_at_utc,
                        app_version = EXCLUDED.app_version,
                        succeeded = EXCLUDED.succeeded;
                    """,
                    new SugarParameter("@migration_id", descriptor.MigrationId),
                    new SugarParameter("@checksum", descriptor.Checksum),
                    new SugarParameter("@applied_at_utc", appliedAtUtc),
                    new SugarParameter("@app_version", appVersion),
                    new SugarParameter("@succeeded", true)).ConfigureAwait(false);
            }
        }).ConfigureAwait(false);

        if (!result.IsSuccess)
        {
            throw new InvalidOperationException("Failed to persist schema migration history.", result.ErrorException);
        }
    }

    private static string ResolveAppVersion()
        => Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "unknown";
}
