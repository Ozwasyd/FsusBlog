using System.Collections.Immutable;
using System.Data.Common;

using FsusBlog.Algorithms;

namespace FsusBlog.Migration;

internal sealed record SqliteCurrentSchemaEffectObservation(
    SqliteCurrentSchemaCatalog Catalog,
    ImmutableArray<SqliteImmutableTriggerObservation> Triggers);

// A native effects observer, not a second current recipe, DDL provider, migration
// step or verified-current factory. The original complete expected owner must
// still bind these distinct actual actions to its legal SQLite target semantics.
internal static class SqliteCurrentSchemaEffectObserver
{
    internal static async Task<SqliteCurrentSchemaEffectObservation> ReadAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        SqliteCurrentSchemaCatalog catalog = await SqliteCurrentSchemaCatalogObserver.ReadAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        var triggers = ImmutableArray.CreateBuilder<SqliteImmutableTriggerObservation>();
        foreach (SqliteSchemaObject item in catalog.Objects.Where(static item => item.Kind == "trigger"))
        {
            cancellationToken.ThrowIfCancellationRequested();
            SqliteImmutableTriggerObservation actual = SqliteImmutableTriggerObserver.Decode(item.Sql
                ?? throw new InvalidOperationException("sqlite_current_trigger_sql_missing"));
            if (actual.Name != item.Name || actual.Table != item.Table)
            {
                throw new InvalidOperationException("sqlite_current_trigger_catalog_binding_mismatch");
            }
            triggers.Add(actual);
        }
        cancellationToken.ThrowIfCancellationRequested();
        return new(catalog, triggers.ToImmutable());
    }
}
