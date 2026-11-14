using System.Data;
using System.Reflection;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeRecoveryScopeAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        await ExecuteAsync(connection, tx, "SET LOCAL search_path TO pg_catalog", ct);
        await ExecuteAsync(connection, tx, BootstrapLock, ct);
        await using (var acquire = new NpgsqlCommand($"select pg_try_advisory_xact_lock({PublicationLocks.Ownership})", connection, tx))
            if (await acquire.ExecuteScalarAsync(ct) is not true)
                throw new InvalidOperationException("Stop the serving process before initializing its recovery site ID.");
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

        await using var relation = new NpgsqlCommand(
            "select to_regclass('public.authoring_recovery_site') is not null", connection, tx);
        if (await relation.ExecuteScalarAsync(ct) is not true)
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireRecoveryScope: false);
            await using var sql = Assembly.GetExecutingAssembly().GetManifestResourceStream(
                SchemaResourcePrefix + "recovery_scope.sql") ?? throw new InvalidOperationException("Recovery scope SQL is missing.");
            using var reader = new StreamReader(sql);
            await ExecuteAsync(connection, tx, await reader.ReadToEndAsync(ct), ct);
        }

        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the durable draft recovery site ID.");
    }
}
