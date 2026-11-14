using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeAdminInboxStatusAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        if (!await HasRelation(connection, tx, CurrentSchema.AdminInboxStatusRelation, ct))
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireAdminInboxStatus: false);
            await ApplySchemaAddition(connection, tx, "inbox-admin-status.sql", ct);
        }
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireAdminInboxStatus: true);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified administrator inbox status audit schema.");
    }
}
