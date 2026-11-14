using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeRevisionHistoryAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        var hasRecoveryScope = await HasRelation(connection, tx, "public.authoring_recovery_site", ct);
        if (!await HasRelation(connection, tx, "public.article_rollback", ct))
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, hasRecoveryScope, requireRevisionHistory: false);
            await ApplySchemaAddition(connection, tx, "revision-rollback.sql", ct);
        }
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, hasRecoveryScope);
        if (hasRecoveryScope) await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified private article revision history schema.");
    }
}
