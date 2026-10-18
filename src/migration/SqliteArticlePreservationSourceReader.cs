using System.Data.Common;
using System.Runtime.ExceptionServices;

using Microsoft.Data.Sqlite;

using FsusBlog.Contracts.Migration;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Migration;

/// <summary>
/// Reads the original known SQLite article profile through its native session
/// and the sole article reader. Neither a file path nor a payload seal creates
/// a source capability. Missing original FILESTAT/held-file proof still refuses.
/// </summary>
internal static class SqliteArticlePreservationSourceReader
{
    internal static async Task<ArticlePreservationSourceReadResult> ReadOriginalSessionAsync(
        string connectionString, OfflineMigrationSourceObserver observer,
        CurrentSchemaArtifactReference originArtifact, Uri documentBase,
        ArticlePreservationLimits limits, TimeSpan readBudget, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArticlePreservationSourceReader.RequireReadBudget(limits, readBudget);
        ArticlePreservationSourceReader.RequireReadInputs(originArtifact, documentBase);
        ArgumentNullException.ThrowIfNull(observer);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(readBudget);
        ArticlePreservationSourceReadResult? result = null;
        OfflineMigrationSourceObservation completed = await OfflineMigrationSqliteNativeSession.ObserveAsync(
            connectionString, async (connection, transaction, token) =>
            {
                using OfflineMigrationSqliteDatabaseIdentity.Snapshot held =
                    await OfflineMigrationSqliteDatabaseIdentity.CaptureAsync(connection, transaction, token).ConfigureAwait(false);
                ArticlePreservationSourceReadResult actual = await ReadAsync(
                    connection, transaction, held, observer, originArtifact, documentBase, limits, readBudget, token).ConfigureAwait(false);
                // Do not expose a partial result before the original native
                // owner has verified the boundary and completed all cleanup.
                result = actual;
                return actual.Observation;
            }, deadline.Token).ConfigureAwait(false);
        deadline.Token.ThrowIfCancellationRequested();
        if (result is null || !ReferenceEquals(completed, result.Observation))
            throw new InvalidOperationException("article_preservation_sqlite_original_result_missing");
        return result;
    }

    internal static async Task<ArticlePreservationSourceReadResult> ReadAsync(
        DbConnection connection, DbTransaction transaction,
        OfflineMigrationSqliteDatabaseIdentity.Snapshot originalHeldSource,
        OfflineMigrationSourceObserver observer, CurrentSchemaArtifactReference originArtifact,
        Uri documentBase, ArticlePreservationLimits limits, TimeSpan readBudget, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(originalHeldSource);
        ArticlePreservationSourceReader.RequireReadBudget(limits, readBudget);
        ArticlePreservationSourceReader.RequireReadInputs(originArtifact, documentBase);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(readBudget);
        await originalHeldSource.ValidateAsync(connection, transaction, deadline.Token).ConfigureAwait(false);
        ArticlePreservationSourceReadResult actual = await ArticlePreservationSourceReader.ReadAsync(
            CurrentSchemaProviderKind.Sqlite, connection, transaction, observer,
            originArtifact, documentBase, limits, readBudget, deadline.Token).ConfigureAwait(false);
        await originalHeldSource.ValidateAsync(connection, transaction, deadline.Token).ConfigureAwait(false);
        if (actual.Observation.Database != originalHeldSource.Database)
            throw new InvalidOperationException("article_preservation_sqlite_held_database_changed");
        deadline.Token.ThrowIfCancellationRequested();
        return actual;
    }

    // The sole common reader calls this after its actual known-profile match,
    // before GetTextReader can hydrate a SQLite text cell. This is only a lower
    // bound for its existing UTF-8 metadata budget: relation charges and all
    // strict text/row/taxonomy validation remain in the original common owner.
    internal static async Task RequireBoundedTextAsync(
        DbConnection connection, DbTransaction transaction, ArticlePreservationLimits limits,
        TimeSpan readBudget, CancellationToken cancellationToken)
    {
        if (connection.GetType() != typeof(SqliteConnection) || transaction.GetType() != typeof(SqliteTransaction))
            throw new InvalidOperationException("article_preservation_sqlite_original_driver_required");
        ArticlePreservationSourceReader.RequireReadSession(CurrentSchemaProviderKind.Sqlite, connection, transaction);
        ArticlePreservationSourceReader.RequireReadBudget(limits, readBudget);
        var domains = new[] { "article", "category", "tag" };
        string[] sums = domains.Select(name =>
        {
            OfflineMigrationSourceFingerprints.LegacyTable table =
                OfflineMigrationSourceFingerprints.LegacyTables.Single(value => value.Name == name);
            string rowBytes = string.Join("+", table.Columns
                .Where(column => column.Type == "text" || column.Type.StartsWith("varchar(", StringComparison.Ordinal))
                .Select(column => "COALESCE(length(CAST(" + Quote(column.Name) + " AS BLOB)),0)"));
            return "SELECT COALESCE(SUM(" + rowBytes + "),0) AS bytes FROM main." + Quote(table.Name);
        }).Append("SELECT COALESCE(SUM(COALESCE(length(CAST(\"value\" AS BLOB)),0)),0) AS bytes"
            + " FROM main.\"sys_systemconfig\" WHERE \"key\"=@author").ToArray();
        DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandTimeout = checked((int)Math.Ceiling(readBudget.TotalSeconds));
        command.CommandText = "SELECT SUM(bytes) FROM (" + string.Join(" UNION ALL ", sums) + ")";
        DbParameter author = command.CreateParameter();
        author.ParameterName = "@author";
        author.Value = PublicSiteAuthorPolicy.ConfigurationKey;
        command.Parameters.Add(author);
        Exception? primary = null;
        try
        {
            RequireTextBytes(await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false), limits.MaximumMetadataBytes);
        }
        catch (Exception failure)
        {
            primary = failure;
        }
        try
        {
            await command.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception cleanup)
        {
            primary ??= cleanup;
            primary.Data["article_preservation_sqlite_cleanup"] = "source_command_disposal_failed";
        }
        if (primary is not null)
            ExceptionDispatchInfo.Capture(primary).Throw();
    }

    // Production passes SQLite's real aggregate storage value, never a parsed
    // string, rounded REAL or caller receipt claim. Passing cannot mint a proof.
    internal static void RequireTextBytes(object? actual, long maximumBytes)
    {
        if (maximumBytes <= 0 || actual is not long bytes || bytes < 0 || bytes > maximumBytes)
            throw new InvalidOperationException("article_preservation_source_byte_budget");
    }

    private static string Quote(string value) => SchemaMigrationSql.QuoteIdentifier(value);
}
