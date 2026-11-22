using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static async Task<bool> HasRelationAsync(NpgsqlConnection db, NpgsqlTransaction? tx, string name, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("select pg_catalog.to_regclass($1) is not null", db, tx);
        query.Parameters.AddWithValue(name);
        return await query.ExecuteScalarAsync(ct) is true;
    }

    private static async Task<bool> HasCompleteRelationsAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        string incomplete, params string[] relations)
    {
        await using var query = new NpgsqlCommand("""
            select count(*)::integer from pg_catalog.unnest($1::text[]) as names(name)
            where pg_catalog.to_regclass(name) is not null
            """, db, tx);
        query.Parameters.AddWithValue(relations);
        return Complete(await query.ExecuteScalarAsync(ct), relations.Length, incomplete);
    }

    private static async Task<bool> HasColumnAndCheckAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        string relation, string column, string constraint, string incomplete, bool requireLocalValidated = false)
    {
        await using var query = new NpgsqlCommand("""
            select exists (
                select from pg_catalog.pg_attribute
                where attrelid=pg_catalog.to_regclass($1) and attname=$2 and attnum>0 and not attisdropped
            )::integer + exists (
                select from pg_catalog.pg_constraint
                where conrelid=pg_catalog.to_regclass($1) and conname=$3 and contype='c'
                  and (not $4 or (convalidated and conislocal))
            )::integer
            """, db, tx);
        query.Parameters.AddWithValue(relation);
        query.Parameters.AddWithValue(column);
        query.Parameters.AddWithValue(constraint);
        query.Parameters.AddWithValue(requireLocalValidated);
        return Complete(await query.ExecuteScalarAsync(ct), 2, incomplete);
    }

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
            await using var command = new NpgsqlCommand(sql, db, tx);
            if (await command.ExecuteScalarAsync(ct) is not true)
                throw new InvalidOperationException(failure);
        }
    }

    internal static bool Complete(object? count, int expected, string incomplete) => count switch
    {
        0 => false,
        int found when found == expected => true,
        _ => throw new InvalidOperationException(incomplete)
    };
}
