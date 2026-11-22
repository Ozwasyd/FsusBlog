namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static SchemaFacts Table(string columns, params string[] constraints)
    {
        var table = columns[..columns.IndexOf(' ')];
        return new([columns], constraints.Select(constraint => $"{table} {constraint}").ToArray());
    }

    private static SchemaFacts Tables(params SchemaFacts[] tables) =>
        new(tables.SelectMany(table => table.Columns).ToArray(), tables.SelectMany(table => table.Constraints).ToArray());
}
