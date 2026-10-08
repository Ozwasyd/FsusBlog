namespace FsusBlog.Contracts.Schema;

/// <summary>Closed current expression-key capability; no SQL, parsing, allocator or admission authority.</summary>
public static class SchemaIndexExpressionSemantics
{
    /// <summary>Checks the original three-column timestamp GREATEST shape without discarding operand order or null semantics.</summary>
    /// <param name="key">The complete key, with exactly one column or expression representation.</param>
    /// <param name="columns">The actual target table's independently supplied column facts.</param>
    /// <returns>The complete ordered column dependencies.</returns>
    public static IReadOnlyList<string> RequireColumns(SchemaIndexKeyModel key, IReadOnlyDictionary<string, SchemaColumnModel> columns)
    {
        if (key.Expression is null)
        {
            return columns.ContainsKey(key.Column) ? [key.Column]
                : throw new InvalidOperationException("current_schema_index_key_column_unbound");
        }
        SchemaExpressionNode expression = key.Expression;
        if (key.Column != string.Empty || key.MySqlPhysical is not null
            || expression.Kind != "call" || expression.Value != "greatest"
            || expression.Arguments is null || expression.Arguments.Count != 3)
        {
            throw new InvalidOperationException("current_schema_index_expression_capability_unavailable");
        }
        var dependencies = new List<string>();
        foreach (SchemaExpressionNode argument in expression.Arguments)
        {
            if (argument is null || argument.Kind != "column" || argument.Arguments is null || argument.Arguments.Count != 0
                || !columns.TryGetValue(argument.Value, out SchemaColumnModel? column)
                || column.DataType != "timestamp" || dependencies.Contains(argument.Value, StringComparer.Ordinal))
            {
                throw new InvalidOperationException("current_schema_index_expression_argument_unavailable");
            }
            dependencies.Add(argument.Value);
        }
        return dependencies;
    }
}
