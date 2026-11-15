using System.Data;
using System.Reflection;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeRecoveryScopeAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await BeginStoppedSchemaChangeAsync(connection, ct);
        await InstallPreviewSchemaAsync(connection, tx, PreviewSchema.Recovery, "recovery_scope.sql", ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the durable draft recovery site ID.");
    }

    private static async Task<NpgsqlTransaction> BeginStoppedSchemaChangeAsync(NpgsqlConnection db, CancellationToken ct)
    {
        var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        try
        {
            await PrepareSchemaAddition(db, tx, ct);
            return tx;
        }
        catch
        {
            await tx.DisposeAsync();
            throw;
        }
    }

    private static async Task PrepareSchemaAddition(NpgsqlConnection connection, NpgsqlTransaction tx, CancellationToken ct)
    {
        await ExecuteAsync(connection, tx, "SET LOCAL search_path TO pg_catalog", ct);
        await ExecuteAsync(connection, tx, BootstrapLock, ct);
        await using (var acquire = new NpgsqlCommand($"select pg_try_advisory_xact_lock({PublicationLocks.Ownership})", connection, tx))
            if (await acquire.ExecuteScalarAsync(ct) is not true)
                throw new InvalidOperationException("Stop the serving process before changing the database schema.");
        await using (var handoff = new NpgsqlCommand("select pg_catalog.pg_advisory_xact_lock($1,$2)", connection, tx))
        {
            handoff.Parameters.AddWithValue(PublicationLocks.HandoffClass);
            handoff.Parameters.AddWithValue(PublicationLocks.HandoffObject);
            await handoff.ExecuteNonQueryAsync(ct);
        }

        await using (var marker = new NpgsqlCommand("select version from public.v2_schema", connection, tx))
        await using (var reader = await marker.ExecuteReaderAsync(ct))
        {
            if (!await reader.ReadAsync(ct) || reader.GetInt32(0) != CurrentSchema.Version || await reader.ReadAsync(ct))
                throw new InvalidOperationException("The database is not on the expected v2 schema revision.");
        }
    }

    private static async Task<bool> HasRelation(NpgsqlConnection connection, NpgsqlTransaction tx, string name, CancellationToken ct)
    {
        await using var relation = new NpgsqlCommand("select to_regclass($1) is not null", connection, tx);
        relation.Parameters.Add(new NpgsqlParameter { Value = name });
        return await relation.ExecuteScalarAsync(ct) is true;
    }

    private static async Task ApplySchemaAddition(NpgsqlConnection connection, NpgsqlTransaction tx, string file, CancellationToken ct)
    {
        await using var sql = Assembly.GetExecutingAssembly().GetManifestResourceStream(SchemaResourcePrefix + file) ??
            throw new InvalidOperationException($"Schema addition SQL is missing: {file}.");
        using var reader = new StreamReader(sql);
        await ExecuteAsync(connection, tx, await reader.ReadToEndAsync(ct), ct);
    }
}
