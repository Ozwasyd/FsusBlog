using System.Text.RegularExpressions;

using FsusBlog.Contracts.Schema;

namespace FsusBlog.Shared.Algorithms.Schema;

/// <summary>Original PostgreSQL syntax boundary for the neutral closed timestamp index-expression contract.</summary>
public static class PgCurrentSchemaIndexExpression
{
    /// <summary>Parses all source syntax and binds every timestamp operand; no expression fragment or cast is discarded.</summary>
    public static SchemaIndexExpression Parse(string sql, IReadOnlyDictionary<string, SchemaColumnModel> columns)
        => SchemaIndexExpressions.Bind(Convert(PgCurrentSchemaExpressionParser.Parse(sql, columns)), columns);

    /// <summary>Renders only validated neutral facts, using quoted bound columns and explicit timestamp cast precision.</summary>
    public static string Compile(SchemaIndexExpression expression, IReadOnlyDictionary<string, SchemaColumnModel> columns)
        => Render(SchemaIndexExpressions.Bind(expression, columns));

    /// <summary>Measures the native timestamp result representation without erasing meaningful precision.</summary>
    public static string ResultType(SchemaIndexExpression expression)
    {
        int? precision = Precision(expression);
        return precision is null or 6 ? "timestamp without time zone" : $"timestamp({precision}) without time zone";
    }

    private static int? Precision(SchemaIndexExpression node)
        => node.Kind == SchemaIndexExpressionKind.Cast ? node.Precision
            : node.Kind == SchemaIndexExpressionKind.Greatest
                && node.Arguments.Select(Precision).Distinct().ToArray() is { Length: 1 } values ? values[0] : null;

    private static SchemaIndexExpression Convert(SchemaExpressionNode node)
    {
        if (node.Kind == "column" && node.Arguments.Count == 0)
            return new(SchemaIndexExpressionKind.Column, node.Value, []);
        if (node.Kind == "call" && node.Value == "greatest" && node.Arguments.Count == 3)
            return new(SchemaIndexExpressionKind.Greatest, null, node.Arguments.Select(Convert).ToArray());
        if (node.Kind == "cast" && node.Arguments.Count == 1)
        {
            Match type = Regex.Match(node.Value, @"\Atimestamp(?:\((?<precision>[0-6])\))?(?: without time zone)?\z",
                RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
            if (type.Success)
                return new(SchemaIndexExpressionKind.Cast, null, [Convert(node.Arguments[0])],
                    type.Groups["precision"].Success ? int.Parse(type.Groups["precision"].Value, System.Globalization.CultureInfo.InvariantCulture) : null);
        }
        throw new InvalidOperationException("current_schema_pg_index_expression_unavailable");
    }

    private static string Render(SchemaIndexExpression node)
        => node.Kind switch
        {
            SchemaIndexExpressionKind.Column => "\"" + node.Column!.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"",
            SchemaIndexExpressionKind.Greatest => "GREATEST(" + string.Join(", ", node.Arguments.Select(Render)) + ")",
            SchemaIndexExpressionKind.Cast => "CAST(" + Render(node.Arguments[0]) + " AS timestamp"
                + (node.Precision is null ? "" : $"({node.Precision})") + " without time zone)",
            _ => throw new InvalidOperationException("current_schema_pg_index_expression_unavailable")
        };
}
