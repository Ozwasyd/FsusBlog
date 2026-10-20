namespace FsusBlog.Contracts.Schema;

/// <summary>The closed neutral timestamp expression vocabulary admitted by the original index owner.</summary>
public enum SchemaIndexExpressionKind
{
    Column,
    Greatest,
    Cast
}

/// <summary>Ordered timestamp-without-offset expression facts; precision belongs only to an explicit timestamp cast.</summary>
/// <remarks>This is neither provider SQL nor an issuance, execution or migration grant.</remarks>
public sealed record SchemaIndexExpression(SchemaIndexExpressionKind Kind, string? Column,
    IReadOnlyList<SchemaIndexExpression> Arguments, int? Precision = null);

/// <summary>Validates and copies the closed neutral expression shape against its actual table columns.</summary>
public static class SchemaIndexExpressions
{
    /// <summary>Returns a bounded copy preserving every ordered operand and cast; unsupported or unbound facts refuse.</summary>
    public static SchemaIndexExpression Bind(SchemaIndexExpression expression, IReadOnlyDictionary<string, SchemaColumnModel> columns)
    {
        int remaining = 64;
        return Copy(expression, 0);

        SchemaIndexExpression Copy(SchemaIndexExpression node, int depth)
        {
            if (node is null || node.Arguments is null || depth > 8 || --remaining < 0)
                throw Refused();
            switch (node.Kind)
            {
                case SchemaIndexExpressionKind.Column:
                    if (node.Column is null || node.Arguments.Count != 0 || node.Precision is not null
                        || !columns.TryGetValue(node.Column, out SchemaColumnModel? column) || column.DataType != "timestamp")
                        throw Refused();
                    return node with
                    {
                        Arguments = []
                    };
                case SchemaIndexExpressionKind.Greatest:
                    if (node.Column is not null || node.Arguments.Count != 3 || node.Precision is not null)
                        throw Refused();
                    return node with
                    {
                        Arguments = node.Arguments.Select(child => Copy(child, depth + 1)).ToArray()
                    };
                case SchemaIndexExpressionKind.Cast:
                    if (node.Column is not null || node.Arguments.Count != 1 || node.Precision is < 0 or > 6)
                        throw Refused();
                    return node with
                    {
                        Arguments = [Copy(node.Arguments[0], depth + 1)]
                    };
                default:
                    throw Refused();
            }
        }
    }

    /// <summary>Checks the disjoint key representation and returns a copied expression; no dummy table column is introduced.</summary>
    public static SchemaIndexExpression Require(SchemaIndexKeyModel key, IReadOnlyDictionary<string, SchemaColumnModel> columns)
    {
        if (key.Expression is null || key.Column != string.Empty || key.MySqlPhysical is not null)
            throw Refused();
        return Bind(key.Expression, columns);
    }

    /// <summary>Compares the complete ordered tree, rather than collection reference identity.</summary>
    public static bool Equal(SchemaIndexExpression? left, SchemaIndexExpression? right)
    {
        int remaining = 64;
        return Compare(left, right, 0);

        bool Compare(SchemaIndexExpression? first, SchemaIndexExpression? second, int depth)
        {
            if (first is null || second is null)
                return first is null && second is null;
            if (depth > 8 || --remaining < 0 || first.Arguments is null || second.Arguments is null
                || first.Kind != second.Kind || first.Column != second.Column || first.Precision != second.Precision
                || first.Arguments.Count != second.Arguments.Count)
                return false;
            return first.Arguments.Zip(second.Arguments).All(pair => Compare(pair.First, pair.Second, depth + 1));
        }
    }

    /// <summary>Returns all bound column occurrences in their original expression order.</summary>
    public static IEnumerable<string> Columns(SchemaIndexExpression expression)
        => expression.Kind == SchemaIndexExpressionKind.Column ? [expression.Column!]
            : expression.Arguments.SelectMany(Columns);

    private static InvalidOperationException Refused() => new("current_schema_index_expression_unavailable");
}
