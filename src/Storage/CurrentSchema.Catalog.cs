using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlogV2.Storage;

internal static class PropertyStorageJson
{
    internal const int SchemaByteBudget = 8 * 1024 * 1024;
    internal static readonly JsonSerializerOptions Options = new()
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        AllowOutOfOrderMetadataProperties = true,
        IgnoreReadOnlyProperties = true,
    };
}

internal static class PublicationLocks
{
    internal const long Ownership = 716729109726707501L;
    internal const int HandoffClass = 1179866434;
    internal const int HandoffObject = 1;
}

internal static class RequiredReaderRow
{
    internal static async Task ReadRequired(this NpgsqlDataReader reader, CancellationToken ct, Func<Exception> missing)
    {
        if (!await reader.ReadAsync(ct)) throw missing();
    }
}

internal static partial class CurrentSchema
{
    internal static Task<int> ExecuteAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        string sql, params object[] parameters) => DatabaseSql.ExecuteAsync(db, tx, ct, sql, parameters);

    private static Task<object?> ScalarAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        string sql, params object[] parameters) => DatabaseSql.ScalarAsync(db, tx, ct, sql, parameters);

    private static async Task<T> ProbeAsync<T>(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        string[] relations, string[] columns, string[] checks, Func<CatalogPresenceSnapshot, T> inspect) =>
        inspect(await CatalogPresenceSnapshot.LoadAsync(db, tx, new(relations, columns, checks), ct));

    private static Task<bool> HasRelationAsync(NpgsqlConnection db, NpgsqlTransaction? tx, string name, CancellationToken ct) =>
        ProbeAsync(db, tx, ct, [name], [], [], c => c.HasRelation(name));

    private static Task<bool> HasColumnAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct, string relation, string column) =>
        ProbeAsync(db, tx, ct, [], [relation], [], c => c.HasColumn(relation, column));

    private sealed class TableProbe(string name, string invalid)
    {
        internal Task<bool> IsPresentAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
            ProbeAsync(db, tx, ct, [name], [], [], IsPresent);

        internal bool IsPresent(CatalogPresenceSnapshot catalog) =>
            catalog.GetRelationKind(name) is { } kind && RequireMatch(kind == 'r', invalid);
    }

    private static bool RequireMatch(bool matches, string invalid) => matches ? true : throw new InvalidOperationException(invalid);

    private sealed class RelationGroup(string incomplete, params string[] names)
    {
        internal string[] Names { get; } = names;
        internal bool IsPresent(CatalogPresenceSnapshot catalog) => catalog.HasCompleteRelations(incomplete, Names);
        internal Task<bool> IsPresentAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
            ProbeAsync(db, tx, ct, Names, [], [], IsPresent);
    }

    private static RelationGroup Relations(SchemaFacts shape, string incomplete) =>
        new(incomplete, shape.Columns.Select(c => "public." + c[..c.IndexOf(' ')]).ToArray());

    private static bool CheckPresence(bool? required, bool found, string feature, bool prerequisitesMet = true)
    {
        if ((found && !prerequisitesMet) || (required.HasValue && required.Value != found))
            throw new InvalidOperationException($"{feature} schema presence does not match the requested operation.");
        return found;
    }

    private readonly struct CatalogInvariant(string sql, string failure)
    {
        internal async Task VerifyAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
        {
            if (await ScalarAsync(db, tx, ct, sql) is not true)
                throw new InvalidOperationException(failure);
        }
    }

    internal static bool Complete(object? count, int expected, string incomplete) => count switch
    {
        0 => false,
        int found when found == expected => true,
        _ => throw new InvalidOperationException(incomplete)
    };

    private readonly struct ConstraintRule(string[] items)
    {
        internal string[] Items { get; } = items;
        public static implicit operator ConstraintRule(string item) => new([item]);
        public static implicit operator ConstraintRule(string[] items) => new(items);
        public static implicit operator ConstraintRule(ConstraintRule[] items) => new(items.SelectMany(r => r.Items).ToArray());
    }

    private static string[] Bytes32(params string[] columns) =>
        columns.Select(c => $"c {c} octet_length({c})=32").ToArray();

    private static string[] Pos(params string[] columns) =>
        columns.Select(c => $"c {c} {c}>0").ToArray();

    private static string[] NonNeg(params string[] columns) =>
        columns.Select(c => $"c {c} {c}>=0").ToArray();

    private static string[] If(bool condition, params string[] items) => condition ? items : [];

    private static string[] Array1D(string col, int min, int max, string pgType) =>
    [
        $"c {col} cardinality({col})>={min}ANDcardinality({col})<={max}",
        $"c {col} array_ndims({col})=1",
        $"c {col} array_lower({col},1)=1",
        $"c {col} array_position({col},NULL::{pgType})ISNULL"
    ];

    private static SchemaFacts Singleton(string columns, params ConstraintRule[] constraints) =>
        Table(columns, ["p singleton", "c singleton singleton", .. constraints]);

    private static SchemaFacts Table(string columns, params ConstraintRule[] constraints)
    {
        var table = columns[..columns.IndexOf(' ')];
        return new([columns], constraints.SelectMany(r => r.Items).Select(constraint => $"{table} {constraint}").ToArray());
    }

    private static SchemaFacts Tables(params SchemaFacts[] tables) =>
        new(tables.SelectMany(table => table.Columns).ToArray(), tables.SelectMany(table => table.Constraints).ToArray());
}
