using System.Data.Common;

using FsusBlog.Contracts.Schema;

namespace FsusBlog.Shared.Algorithms.Schema;

/// <summary>Current-only PostgreSQL rendering and native comparison of the sole neutral journal control facts.</summary>
public static class PgCurrentSchemaControlShape
{
    /// <summary>Renders the original control shape; no historical descriptor or payload participates.</summary>
    /// <returns>Current-only PostgreSQL DDL derived from the sole neutral shape.</returns>
    public static string CreateApplyJournalSql()
    {
        SchemaTableModel shape = CurrentSchemaControlShape.DescribeApplyJournal();
        var definitions = shape.Columns.Values.Select(column =>
            $"{Quote(column.Name)} {SchemaPhysicalTypeProjection.ToPhysical(SchemaProviderKind.PostgreSql, column.DataType, column.MaxLength)} NOT NULL").ToList();
        foreach (SchemaConstraintModel constraint in shape.Constraints.Values)
        {
            string clause = constraint.Kind switch
            {
                "primary-key" => $"PRIMARY KEY ({Columns(constraint.Columns)})",
                "unique" => $"UNIQUE ({Columns(constraint.Columns)})",
                "check" => $"CHECK ({constraint.Expression})",
                _ => throw new InvalidOperationException("current_schema_control_constraint_unavailable")
            };
            definitions.Add($"CONSTRAINT {Quote(constraint.Name)} {clause}");
        }
        return $"CREATE TABLE IF NOT EXISTS public.{Quote(shape.Name)} ({string.Join(", ", definitions)});";
    }

    /// <summary>Creates and validates on the caller-owned actual RR transaction, without committing or reading journal contents.</summary>
    /// <param name="connection">The caller's actual open PostgreSQL connection.</param>
    /// <param name="transaction">Its same caller-owned RepeatableRead transaction.</param>
    /// <param name="cancellationToken">The original caller's cancellation boundary.</param>
    /// <returns>Completion only after execution and actual complete shape validation.</returns>
    public static async Task EnsureApplyJournalAsync(DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        PgCurrentSchemaEffectObserver.RequireSnapshot(connection, transaction);
        await using DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = CreateApplyJournalSql();
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        await ValidateApplyJournalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Compares every measured control column, raw expression, index, constraint and attached trigger; never examines payload.</summary>
    /// <param name="connection">The caller's actual open PostgreSQL connection.</param>
    /// <param name="transaction">Its same caller-owned RepeatableRead transaction.</param>
    /// <param name="cancellationToken">The original caller's cancellation boundary.</param>
    /// <returns>Completion only after native control shape comparison succeeds.</returns>
    public static async Task ValidateApplyJournalAsync(DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        string name = CurrentSchemaControlShape.ApplyJournalTableName;
        SchemaModelSnapshot tables = await PgCurrentSchemaCatalogObserver.ReadTableAsync(
            connection, transaction, name, cancellationToken).ConfigureAwait(false);
        PgCurrentSchemaEffectObservation effects = await PgCurrentSchemaEffectObserver.ReadControlTableAsync(
            connection, transaction, name, cancellationToken).ConfigureAwait(false);
        if (CompareApplyJournal(tables, effects).Count != 0)
            throw new InvalidOperationException("offline_apply_journal_physical_shape_changed");
    }

    /// <summary>Uses the same complete native comparer as current runtime; independent global effects remain the whole-target observer's responsibility.</summary>
    /// <param name="actual">The complete actual control relational measurement.</param>
    /// <param name="effects">Its complete raw expression and attached-effect measurements.</param>
    /// <returns>Every shape difference, not a payload or plan admission.</returns>
    public static IReadOnlyList<string> CompareApplyJournal(SchemaModelSnapshot actual, PgCurrentSchemaEffectObservation effects)
    {
        SchemaTableModel expected = CurrentSchemaControlShape.ProjectApplyJournal(SchemaProviderKind.PostgreSql);
        var wanted = new SchemaModelSnapshot(new Dictionary<string, SchemaTableModel>(StringComparer.Ordinal)
        {
            [expected.Name] = expected
        }, provider: SchemaProviderKind.PostgreSql);
        return PgCurrentSchemaNativeObserver.Compare(new(wanted, [], []), actual, effects);
    }

    private static string Columns(IReadOnlyList<string> columns) => string.Join(", ", columns.Select(Quote));
    private static string Quote(string name) => "\"" + name.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";
}
