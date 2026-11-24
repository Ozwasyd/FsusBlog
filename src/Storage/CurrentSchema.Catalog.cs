namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static async Task<object?> ScalarAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        string sql, params object[] parameters)
    {
        await using var query = new NpgsqlCommand(sql, db, tx);
        foreach (var parameter in parameters) query.Parameters.AddWithValue(parameter);
        return await query.ExecuteScalarAsync(ct);
    }

    private static async Task<bool> HasRelationAsync(NpgsqlConnection db, NpgsqlTransaction? tx, string name, CancellationToken ct) =>
        await ScalarAsync(db, tx, ct, "select pg_catalog.to_regclass($1) is not null", name) is true;

    private static async Task<bool> HasColumnAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        string relation, string column) =>
        await ScalarAsync(db, tx, ct, """
            select exists (select from pg_catalog.pg_attribute
                where attrelid=pg_catalog.to_regclass($1) and attname=$2 and attnum>0 and not attisdropped)
            """, relation, column) is true;

    private sealed class TableProbe(string name, string invalid)
    {
        private readonly string _sql = $"select relkind::text from pg_catalog.pg_class where oid=pg_catalog.to_regclass('{name}')";

        internal Task<bool> IsPresentAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
            MatchesOptionalScalarAsync(db, tx, _sql, "r", invalid, ct);

        internal bool IsPresent(CatalogPresenceSnapshot catalog) => MatchesOptional(catalog.GetRelationKind(name), 'r', invalid);
    }

    private static async Task<bool> MatchesOptionalScalarAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        string sql, object expected, string invalid, CancellationToken ct) =>
        MatchesOptional(await ScalarAsync(db, tx, ct, sql), expected, invalid);

    private static bool MatchesOptional(object? actual, object expected, string invalid) =>
        actual is not null && RequireMatch(actual.Equals(expected), invalid);

    private static bool RequireMatch(bool matches, string invalid) => matches ? true : throw new InvalidOperationException(invalid);

    private sealed class RelationGroup(string incomplete, params string[] names)
    {
        internal string[] Names { get; } = names;

        internal bool IsPresent(CatalogPresenceSnapshot catalog) => catalog.HasCompleteRelations(incomplete, Names);

        internal async Task<bool> IsPresentAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
            Complete(await ScalarAsync(db, tx, ct, """
                select count(*)::integer from pg_catalog.unnest($1::text[]) as names(name)
                where pg_catalog.to_regclass(name) is not null
                """, (object)Names), Names.Length, incomplete);
    }

    private static RelationGroup Relations(SchemaFacts shape, string incomplete) =>
        new(incomplete, shape.Columns.Select(c => "public." + c[..c.IndexOf(' ')]).ToArray());

    private static async Task<bool> HasColumnAndCheckAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        string relation, string column, string constraint, string incomplete, bool requireLocalValidated = false) =>
        Complete(await ScalarAsync(db, tx, ct, """
            select exists (
                select from pg_catalog.pg_attribute
                where attrelid=pg_catalog.to_regclass($1) and attname=$2 and attnum>0 and not attisdropped
            )::integer + exists (
                select from pg_catalog.pg_constraint
                where conrelid=pg_catalog.to_regclass($1) and conname=$3 and contype='c'
                  and (not $4 or (convalidated and conislocal))
            )::integer
            """, relation, column, constraint, requireLocalValidated), 2, incomplete);

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

    private static SchemaFacts Table(string columns, params string[] constraints)
    {
        var table = columns[..columns.IndexOf(' ')];
        return new([columns], constraints.Select(constraint => $"{table} {constraint}").ToArray());
    }

    private static SchemaFacts Tables(params SchemaFacts[] tables) =>
        new(tables.SelectMany(table => table.Columns).ToArray(), tables.SelectMany(table => table.Constraints).ToArray());
}
