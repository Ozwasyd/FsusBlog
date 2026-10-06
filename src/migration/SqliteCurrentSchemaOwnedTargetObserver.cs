using System.Collections.Immutable;
using System.Data.Common;

namespace FsusBlog.Migration;

// Both snapshots are measured catalog facts, not an expected target, source
// fingerprint, database incarnation, or permission to execute a migration.
internal sealed record SqliteCurrentOwnedSnapshot(
    SqliteCurrentSchemaCatalog Complete,
    SqliteCurrentSchemaCatalog Domain);

/// <summary>
/// Reads the operation's business domain on its borrowed native transaction. Only
/// the independently validated sole apply control is excluded; planning admission
/// and authenticated journal replay remain with their original owners.
/// </summary>
internal static class SqliteCurrentSchemaOwnedTargetObserver
{
    internal static async Task<SqliteCurrentOwnedSnapshot> ReadOwnedDomainAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        // The original reader checks exact driver/transaction objects, isolation,
        // namespace and complete catalog budgets; no caller callback supplies facts.
        SqliteCurrentSchemaCatalog complete = await SqliteCurrentSchemaCatalogObserver.ReadAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        string control = OfflineMigrationStateStore.ApplyJournalTableName;
        bool controlPresent = complete.Objects.Any(item => item.Name == control);
        if (controlPresent)
        {
            // Validate the full original shape and all attached effects before
            // excluding any object. A view or malformed table with this name fails.
            await OfflineMigrationStateStore.ValidateApplyJournalAsync(
                connection, transaction, cancellationToken).ConfigureAwait(false);
        }

        ImmutableArray<SqliteSchemaObject> objects = complete.Objects.Where(item =>
            !controlPresent || !((item.Kind == "table" && item.Name == control)
                || (item.Kind == "index" && item.Table == control && item.Sql is null))).ToImmutableArray();
        SqliteCurrentSchemaCatalog domain = complete with
        {
            Objects = objects,
            // sqlite_schema is the reader's measured native catalog, not a
            // business table. sqlite_sequence and every other object remain.
            Tables = complete.Tables.Where(item => item.Name != "sqlite_schema"
                && (!controlPresent || item.Name != control)).ToImmutableArray(),
            Columns = complete.Columns.Where(item => !controlPresent || item.Table != control).ToImmutableArray(),
            Indexes = complete.Indexes.Where(item => !controlPresent || item.Table != control).ToImmutableArray(),
            ForeignKeys = complete.ForeignKeys.Where(item => !controlPresent || item.Table != control).ToImmutableArray()
        };
        cancellationToken.ThrowIfCancellationRequested();
        return new(complete, domain);
    }

    /// <summary>
    /// Requires an empty business domain measured now on the original transaction.
    /// It does not authenticate control rows, select an empty plan, or mint a target.
    /// </summary>
    internal static async Task<SqliteCurrentOwnedSnapshot> RequireEmptyDomainAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        SqliteCurrentOwnedSnapshot snapshot = await ReadOwnedDomainAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        SqliteCurrentSchemaCatalog domain = snapshot.Domain;
        if (!domain.Objects.IsEmpty || !domain.Tables.IsEmpty || !domain.Columns.IsEmpty
            || !domain.Indexes.IsEmpty || !domain.ForeignKeys.IsEmpty
            || !domain.ForeignKeyViolations.IsEmpty || !domain.SequenceValues.IsEmpty)
        {
            throw new InvalidOperationException("sqlite_current_owned_empty_business_domain_required");
        }
        cancellationToken.ThrowIfCancellationRequested();
        return snapshot;
    }
}
