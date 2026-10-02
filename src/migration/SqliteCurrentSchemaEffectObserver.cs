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
    // This compares a supplied native vector, not its provenance. Only the sole
    // complete current provider projection may furnish production expected facts;
    // it must not derive them from this observer or caller-controlled JSON.
    internal static async Task<SqliteCurrentSchemaEffectObservation> ReadAndMatchTriggerFactsAsync(
        DbConnection connection, DbTransaction transaction,
        IReadOnlyList<SqliteImmutableTriggerObservation> expected,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(expected);
        cancellationToken.ThrowIfCancellationRequested();
        if (expected.Count > OfflineMigrationSourceObserver.MaximumMetadataRows)
            throw new InvalidOperationException("sqlite_current_trigger_facts_invalid");
        // Freeze before the native await: a mutable caller list cannot change the
        // admitted vector midway through the original snapshot observation.
        var frozen = ImmutableArray.CreateBuilder<SqliteImmutableTriggerObservation>(expected.Count);
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long characters = 0;
        foreach (SqliteImmutableTriggerObservation facts in expected)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (frozen.Count >= OfflineMigrationSourceObserver.MaximumMetadataRows || facts is null
                || facts.Name is null || facts.Table is null
                || facts.Name.Length > OfflineMigrationSourceObserver.MaximumCellCharacters
                || facts.Table.Length > OfflineMigrationSourceObserver.MaximumCellCharacters
                || facts.Message?.Length > OfflineMigrationSourceObserver.MaximumCellCharacters)
                throw new InvalidOperationException("sqlite_current_trigger_facts_invalid");
            string sql = SqliteImmutableTriggerObserver.Render(facts);
            characters += sql.Length;
            if (!names.Add(facts.Name) || sql.Length > OfflineMigrationSourceObserver.MaximumCellCharacters
                || characters > OfflineMigrationSourceObserver.MaximumMetadataCharacters)
                throw new InvalidOperationException("sqlite_current_trigger_facts_invalid");
            frozen.Add(facts);
        }
        SqliteCurrentSchemaEffectObservation observation = await ReadAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        if (observation.Triggers.Length != frozen.Count)
            throw new InvalidOperationException("sqlite_current_trigger_effect_mismatch");
        var actualByName = observation.Triggers.ToDictionary(static facts => facts.Name, StringComparer.Ordinal);
        foreach (SqliteImmutableTriggerObservation facts in frozen)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!actualByName.TryGetValue(facts.Name, out SqliteImmutableTriggerObservation? actual) || actual != facts)
                throw new InvalidOperationException("sqlite_current_trigger_effect_mismatch");
        }
        // An empty vector can match an empty native catalog, but confers no
        // target, recipe closure, completed apply, registry or receipt authority.
        return observation;
    }

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
